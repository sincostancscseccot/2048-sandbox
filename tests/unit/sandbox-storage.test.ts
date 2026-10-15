import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { canonicalJson, hashJson } from '../../src/domain/hash';
import type { CommitCandidate, RuleSetVersion, SkillPayload } from '../../src/domain/types';
import { createCustomRule, sandboxDefinition } from '../../src/presets/rules';
import { prepareMove, prepareNewMatch, prepareSkill } from '../../src/history/candidates';
import { SandboxDatabase } from '../../src/persistence/database';
import { IntegrityError, Repository, RevisionConflict } from '../../src/persistence/repository';
import { createArchive, parseImport, prepareImportCopy } from '../../src/files/archive';
import { seedPcg32 } from '../../src/random/pcg32';

let db: SandboxDatabase, repo: Repository, rule: RuleSetVersion, root: CommitCandidate;
beforeEach(async () => {
  db = new SandboxDatabase(`sandbox-${crypto.randomUUID()}`); repo = new Repository(db);
  const d = sandboxDefinition(); d.board.rows = 2; d.board.cols = 4; d.spawn.initialCount = 0; d.spawn.perActionCount = 0;
  d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '2' }, { index: 2, value: '4' }];
  d.skills.delete.enabled = true; d.goals.lossWhenNoMoves = false;
  rule = await createCustomRule('存储沙盒', d); root = await prepareNewMatch('沙盒对局', seedPcg32(42n, 54n), rule); await repo.commit(root);
});
afterEach(async () => { db.close(); await db.delete(); });
async function moved() {
  const loaded = await repo.load(root.project.id), candidate = await prepareMove(loaded, loaded.project.activeNodeId, 'left', 'reroll');
  if ('reason' in candidate) throw new Error(candidate.reason); await repo.commit(candidate); return candidate;
}
async function skilled(payload: SkillPayload, commit = true) {
  const loaded = await repo.load(root.project.id), candidate = await prepareSkill(loaded, loaded.project.activeNodeId, payload, 'reroll');
  if ('reason' in candidate) throw new Error(candidate.reason); if (commit) await repo.commit(candidate); return candidate;
}

test('custom rule, undo world and current ledger survive close/reopen exactly', async () => {
  const s1 = await moved(), s2 = await moved();
  const deleted = await skilled({ skillId: 'delete', index: 0 });
  const undo = await skilled({ skillId: 'undo', targetNodeId: s2.node.id });
  expect(undo.node.parentId).toBe(deleted.node.id); expect(undo.node.undoTargetId).toBe(s2.node.id);
  expect(undo.state.world).toEqual(s2.state.world); expect(undo.state.ledger.skills.delete.charges).toBe(2);
  expect(undo.state.ledger.skills.undo.charges).toBe(2); expect(undo.state.ledger.effectiveActionCount).toBe(4);
  db.close(); await db.open(); const loaded = await repo.load(root.project.id);
  expect(loaded.rule).toEqual(rule); expect(loaded.states.get(undo.node.stateHash)).toEqual(undo.state);
  expect(loaded.nodes.find(node => node.id === s1.node.id)).toEqual(s1.node);
});

test('undo quota failure rolls back resources and nodes, and retry confirms exactly one use', async () => {
  await moved(); const s2 = await moved(), before = await repo.readSnapshot();
  const undo = await skilled({ skillId: 'undo', targetNodeId: (await repo.load(root.project.id)).nodes.find(node => node.id === s2.node.parentId)!.id }, false);
  const fail = () => { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
  db.projects.hook('updating', fail); await expect(repo.commit(undo)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(await repo.readSnapshot()).toEqual(before); db.projects.hook('updating').unsubscribe(fail);
  await repo.commit(undo); await repo.commit(undo);
  expect(await db.historyNodes.count()).toBe(4); expect((await repo.load(root.project.id)).states.get(undo.node.stateHash)!.ledger.skills.undo).toMatchObject({ charges: 2, usedCount: 1 });
});

test('refunding undo charges or altering undo target is rejected before a write', async () => {
  const s1 = await moved(); await moved();
  const candidate = await skilled({ skillId: 'undo', targetNodeId: s1.node.id }, false), before = await repo.readSnapshot();
  const refund = structuredClone(candidate); refund.state.ledger.skills.undo.charges = 3; refund.node.stateHash = await hashJson(refund.state);
  await expect(repo.commit(refund)).rejects.toBeInstanceOf(IntegrityError);
  const forged = structuredClone(candidate); forged.node.undoTargetId = root.node.id;
  await expect(repo.commit(forged)).rejects.toBeInstanceOf(IntegrityError); expect(await repo.readSnapshot()).toEqual(before);
});

test('stale concurrent skills cannot overwrite a committed branch or charge twice', async () => {
  await moved(); const loaded = await repo.load(root.project.id);
  const a = await prepareSkill(loaded, loaded.project.activeNodeId, { skillId: 'delete', index: 0 }, 'reroll');
  const b = await prepareSkill(loaded, loaded.project.activeNodeId, { skillId: 'upgrade', index: 0 }, 'reroll');
  expect('reason' in b).toBe(true); // upgrade is disabled in this preset.
  if ('reason' in a) throw new Error(a.reason);
  const other = await prepareMove(loaded, loaded.project.activeNodeId, 'right', 'reroll'); if ('reason' in other) throw new Error(other.reason);
  await repo.commit(other); await expect(repo.commit(a)).rejects.toBeInstanceOf(RevisionConflict);
  expect(await db.historyNodes.count()).toBe(3);
});

test('project/branch/library archives roundtrip undo dependencies and preserve rule and state hashes in repeated copies', async () => {
  const s1 = await moved(); await moved(); const undo = await skilled({ skillId: 'undo', targetNodeId: s1.node.id });
  const source = await repo.readSnapshot();
  for (const kind of ['state', 'branch', 'project', 'library'] as const) {
    const exported = await createArchive(source, { kind, projectId: root.project.id, nodeId: undo.node.id });
    expect(exported.manifest!.requiredCapabilities).toEqual(expect.arrayContaining(['sandbox-v1', 'skills-v1']));
    expect(exported.manifest!.states.find(entry => entry.hash === undo.node.stateHash)!.encoding).toBe('full');
    const parsed = await parseImport(exported.bytes); expect(parsed.snapshot.states.map(item => item.hash).sort()).toEqual(source.states.map(item => item.hash).sort());
    const copy = await prepareImportCopy(parsed); await repo.importCopy(copy);
    const loaded = await repo.load(copy.record.projectIds[0]!); expect(loaded.rule).toEqual(rule);
    expect(loaded.states.get(undo.node.stateHash)).toEqual(undo.state); expect(loaded.nodes.find(node => node.id === undo.node.id)!.undoTargetId).toBe(s1.node.id);
  }
  expect(await db.projects.count()).toBe(5); expect(await db.states.count()).toBe(source.states.length);
});

test('exported custom rule JSON creates a new playable root, while a wrong rule hash never writes', async () => {
  const source = await repo.readSnapshot(), file = await createArchive(source, { kind: 'rules', projectId: root.project.id });
  expect(JSON.parse(new TextDecoder().decode(file.bytes))).toEqual(rule);
  const parsed = await parseImport(file.bytes); expect(parsed.kind).toBe('rules'); expect(parsed.snapshot.rules).toEqual([rule]);
  const copy = await prepareImportCopy(parsed); await repo.importCopy(copy); expect((await repo.load(copy.record.projectIds[0]!)).nodes).toHaveLength(1);
  const bad = structuredClone(rule); bad.definitionHash = `sha256:${'0'.repeat(64)}`;
  await expect(parseImport(new TextEncoder().encode(JSON.stringify(bad)))).rejects.toThrow(/摘要/);
  expect(await db.projects.count()).toBe(2);
});

test('shipped classic and custom archives keep their original state bytes and coexist with new matches', async () => {
  for (const name of ['m2-library-demo.2048backup', 'm1-legacy-demo.json', 'm3-mixed-demo.2048backup', 'm3-rules.json', 'm4-advanced-demo.2048backup', 'm4-mixed-versions-demo.2048backup', 'm4-advanced-rules.json']) {
    const parsed = await parseImport(new Uint8Array(await readFile(new URL(`../../examples/projects/${name}`, import.meta.url))));
    const before = canonicalJson(parsed.snapshot.states), plan = await prepareImportCopy(parsed); await repo.importCopy(plan);
    expect(canonicalJson(plan.snapshot.states)).toBe(before);
    for (const id of plan.record.projectIds) await expect(repo.load(id)).resolves.toBeDefined();
  }
  expect((await repo.load(root.project.id)).rule).toEqual(rule);
});
