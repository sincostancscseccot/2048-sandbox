import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { scaleFixture } from '../fixtures/scale';
import { createGameStepper, stepGame } from '../../src/engine/core';
import { verifyLibrary, verifyProject } from '../../src/history/verify';
import { createArchive, parseImport, prepareImportCopy } from '../../src/files/archive';
import type { ArchiveManifest } from '../../src/files/types';
import { SandboxDatabase } from '../../src/persistence/database';
import { Repository } from '../../src/persistence/repository';
import { prepareMove } from '../../src/history/candidates';
import { sandboxPresets } from '../../src/presets/catalog';
import { assertSupportedRule, createCustomRule } from '../../src/presets/rules';
import { createInitialState } from '../../src/engine/core';
import { seedPcg32 } from '../../src/random/pcg32';
import { hashJson } from '../../src/domain/hash';

const databases: SandboxDatabase[] = [];
afterEach(async () => { for (const db of databases.splice(0)) { db.close(); await db.delete(); } });

test('prepared replay owns its rule and continues validating state and action inputs', async () => {
  const source = await scaleFixture(1), rule = source.rules[0]!, root = source.states[0]!.state;
  const original = structuredClone(rule), replay = createGameStepper(rule);
  rule.definition.movement.directions = [];
  const action = { type: 'move', payload: { direction: 'right' }, elapsedMs: 0 } as const;
  expect(replay(root, action, 'parent')).toEqual(stepGame(root, original, action, 'parent'));
  const invalid = structuredClone(root); invalid.world.board.cells.pop();
  expect(() => replay(invalid, action, 'parent')).toThrow();
  expect(() => replay(root, { ...action, elapsedMs: 1 }, 'parent')).toThrow('计时');
});

test('pooled verification checks unused payloads and rejects duplicate rule records', async () => {
  const source = await scaleFixture(3), extra = structuredClone(source.states[0]!);
  extra.state.rng.drawCount++; extra.hash = await hashJson(extra.state); source.states.push(extra);
  await verifyLibrary(source);
  extra.state.world.score = '9'; await expect(verifyLibrary(source)).rejects.toThrow('摘要');
  await expect(verifyProject(source.projects[0]!, source.nodes, source.states.slice(0, -1), [source.rules[0], source.rules[0]], [])).rejects.toThrow('重复');
});

test('pooled replay still checks every namespace and detects an action mismatch in an imported copy', async () => {
  const source = await scaleFixture(8), parsed = await parseImport((await createArchive(source, { kind: 'library' })).bytes);
  const copy = (await prepareImportCopy(parsed)).snapshot;
  const combined = { ...source, projects: [...source.projects, ...copy.projects], nodes: [...source.nodes, ...copy.nodes] };
  await verifyLibrary(combined);
  const progress: number[] = [];
  await verifyLibrary(combined, { onProgress: value => progress.push(value.completed) });
  expect(progress.at(-1)).toBe(combined.rules.length + combined.states.length + combined.nodes.length);
  copy.nodes[4]!.action = { type: 'move', payload: { direction: 'up' }, elapsedMs: 0 };
  await expect(verifyLibrary(combined)).rejects.toThrow('回放');
});

test('verification yields for cancellation and reports bounded progress before finishing', async () => {
  const source = await scaleFixture(80), abort = new AbortController(); let completed = 0;
  await expect(verifyLibrary(source, { signal: abort.signal, onProgress: progress => {
    completed = progress.completed; if (completed === 64) setTimeout(() => abort.abort(), 0);
  } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(completed).toBe(64);
});

test('JSON parsing and import-copy preparation honor aborted checks without a database write', async () => {
  const source = await scaleFixture(2), bytes = new TextEncoder().encode(JSON.stringify({ format: '2048-sandbox-m1-backup', schemaVersion: 1, exportedAt: '2026-10-14T00:00:00Z', ...source }));
  const parsed = await parseImport(bytes), abort = new AbortController(); abort.abort();
  await expect(parseImport(bytes, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(prepareImportCopy(parsed, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(parsed.snapshot.projects[0]!.project).toEqual(source.projects[0]!.project);
});

test('manifest selection must include the saved active node even if another selected node is valid', async () => {
  const source = await scaleFixture(2), files = unzipSync((await createArchive(source, { kind: 'library' })).bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as ArchiveManifest;
  manifest.projects[0]!.selectedNodeIds = [source.nodes[0]!.id];
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  await expect(parseImport(zipSync(files))).rejects.toThrow('选择位置');
});

test('commit reads a bounded dependency set in a long history while reload still detects old corruption', async () => {
  const source = await scaleFixture(80), db = new SandboxDatabase(`m6-index-${crypto.randomUUID()}`); databases.push(db);
  await db.projects.bulkAdd(source.projects); await db.historyNodes.bulkAdd(source.nodes); await db.states.bulkAdd(source.states); await db.rules.bulkAdd(source.rules);
  const repo = new Repository(db), loaded = await repo.load(source.projects[0]!.id);
  const next = await prepareMove(loaded, loaded.project.activeNodeId, 'right', 'reroll'); if ('reason' in next) throw new Error(next.reason);
  let readNodes = 0; db.historyNodes.hook('reading', value => { readNodes++; return value; });
  await repo.commit(next); expect(readNodes).toBeLessThanOrEqual(6);
  expect((await repo.load(loaded.project.id)).project.activeNodeId).toBe(next.node.id);
  const unusedOldState = structuredClone(source.states[10]!); unusedOldState.state.world.score = '77'; await db.states.put(unusedOldState);
  await expect(repo.load(loaded.project.id)).rejects.toThrow('摘要');
});

test('commit refuses a corrupted parent rule before advancing the project head', async () => {
  const source = await scaleFixture(2), db = new SandboxDatabase(`m6-rule-${crypto.randomUUID()}`); databases.push(db);
  await db.projects.bulkAdd(source.projects); await db.historyNodes.bulkAdd(source.nodes); await db.states.bulkAdd(source.states); await db.rules.bulkAdd(source.rules);
  const repo = new Repository(db), loaded = await repo.load(source.projects[0]!.id);
  const next = await prepareMove(loaded, loaded.project.activeNodeId, 'right', 'reroll'); if ('reason' in next) throw new Error(next.reason);
  const corrupted = structuredClone(source.rules[0]!); corrupted.definition.spawn.perActionCount = 1; await db.rules.put(corrupted);
  await expect(repo.commit(next)).rejects.toThrow('规则摘要');
  expect((await db.projects.get(loaded.project.id))!.project).toEqual(loaded.project); expect(await db.historyNodes.count()).toBe(3);
});

for (const preset of sandboxPresets) test(`preset ${preset.id} has an independent definition, meaningful first move and portable JSON`, async () => {
  const rule = await createCustomRule(preset.name, preset.definition()); assertSupportedRule(rule);
  const state = createInitialState(rule, seedPcg32(42n,54n));
  const result = stepGame(state, rule, { type:'move', payload:{ direction:'left' }, elapsedMs:0 }, 'root');
  expect(result.accepted).toBe(true); if (!result.accepted) return;
  if (preset.id === 'chain') { expect(result.state.world.board.cells[0]!.tile!.value).toBe('16'); expect(result.state.world.score).toBe('28'); expect(result.merges).toBe(3); }
  if (preset.id === 'fibonacci') { expect(result.state.world.board.cells[0]!.tile!.value).toBe('2'); expect(result.state.world.score).toBe('2'); }
  if (preset.id === 'skills') expect(Object.values(result.state.ledger.skills).every(skill => skill.charges === 3)).toBe(true);
  if (preset.id === 'stages') { expect(result.state.world.score).toBe('14'); expect(result.state.world.events.variables.bonuses).toBe('1'); }
  const changed = preset.definition(); changed.board.rows = 64; expect(preset.definition()).toEqual(rule.definition);
  const example = JSON.parse(await readFile(`examples/presets/m6/${preset.id}.json`, 'utf8'));
  const parsed = await parseImport(new TextEncoder().encode(JSON.stringify(example)));
  expect(parsed.snapshot.rules[0]!.definition).toEqual(rule.definition);
});

test('stage preset starts generating only 4 from the third round', async () => {
  const definition = sandboxPresets.find(item => item.id === 'stages')!.definition(), rule = await createCustomRule('阶段验证', definition);
  const state = createInitialState(rule, seedPcg32(42n,54n)); state.world.roundCount = 2;
  const result = stepGame(state, rule, { type:'move', payload:{ direction:'left' }, elapsedMs:0 }, 'root');
  if (!result.accepted) throw new Error(result.reason);
  expect(result.state.world.roundCount).toBe(3);
  expect(result.state.world.board.cells.flatMap(cell => cell.tile?.id.startsWith('t-s-') ? [cell.tile.value] : [])).toEqual(['4']);
});
