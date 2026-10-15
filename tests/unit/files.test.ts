import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { canonicalJson, hashBytes, hashJson } from '../../src/domain/hash';
import type { CommitCandidate, Direction, LibrarySnapshot } from '../../src/domain/types';
import { createArchive, parseImport, prepareImportCopy, selectSnapshot } from '../../src/files/archive';
import { applyDelta, createDelta } from '../../src/files/delta';
import { archiveLimits, extractZip, inspectZip } from '../../src/files/safeZip';
import type { ArchiveManifest } from '../../src/files/types';
import { prepareMove, prepareNewMatch } from '../../src/history/candidates';
import { SandboxDatabase } from '../../src/persistence/database';
import { Repository } from '../../src/persistence/repository';
import { seedPcg32 } from '../../src/random/pcg32';

let db: SandboxDatabase, repo: Repository, root: CommitCandidate, source: LibrarySnapshot;
beforeEach(async () => {
  db = new SandboxDatabase(`files-${crypto.randomUUID()}`); repo = new Repository(db);
  root = await prepareNewMatch('往返测试', seedPcg32(42n, 54n)); await repo.commit(root);
  for (let i = 0; i < 5; i++) await next();
  let loaded = await repo.load(root.project.id);
  const first = loaded.nodes.find(node => node.parentId === root.node.id)!;
  if (first.action?.type !== 'move') throw new Error('Expected a move node');
  const branch = await prepareMove(loaded, root.node.id, first.action!.payload.direction, 'reproduce');
  if ('reason' in branch) throw new Error(branch.reason);
  await repo.commit(branch); loaded = await repo.load(root.project.id);
  await repo.checkpoint(loaded, branch.node.id); loaded = await repo.load(root.project.id);
  await repo.archiveBranch(loaded, first.id, true);
  const other = await prepareNewMatch('另一局', seedPcg32(9n, 6n)); await repo.commit(other);
  source = await repo.readSnapshot();
});
afterEach(async () => { db.close(); await db.delete(); });

async function next() {
  const loaded = await repo.load(root.project.id);
  for (const direction of ['left', 'up', 'right', 'down'] as Direction[]) {
    const candidate = await prepareMove(loaded, loaded.project.activeNodeId, direction, 'reroll');
    if (!('reason' in candidate)) { await repo.commit(candidate); return candidate; }
  }
  throw new Error('Fixture has no valid direction');
}
async function mutateArchive(mutation: (manifest: ArchiveManifest, files: Record<string, Uint8Array>) => Promise<void> | void) {
  const result = await createArchive(source, { kind: 'library' });
  const files = unzipSync(result.bytes), manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as ArchiveManifest;
  await mutation(manifest, files);
  files['manifest.json'] = new TextEncoder().encode(canonicalJson(manifest));
  return zipSync(files, { level: 6 });
}

test('full ZIP library copies preserve every node, state hash, RNG, checkpoint and archived branch', async () => {
  const archive = await createArchive(source, { kind: 'library' });
  expect(archive.filename).toMatch(/\.2048backup$/);
  expect(archive.manifest?.states.some(state => state.encoding === 'delta')).toBe(true);
  for (const checkpoint of source.checkpoints) {
    const hash = source.nodes.find(node => node.id === checkpoint.nodeId && node.matchId === checkpoint.projectId)!.stateHash;
    expect(archive.manifest!.states.find(state => state.hash === hash)!.encoding).toBe('full');
  }
  expect(inspectZip(archive.bytes).size).toBe(archive.manifest!.entryCount + 1);
  const parsed = await parseImport(archive.bytes), plan = await prepareImportCopy(parsed);
  expect(plan.snapshot.states).toEqual(expect.arrayContaining(source.states));
  const counts = await db.projects.count();
  await repo.importCopy(plan); await repo.importCopy(plan);
  expect(await db.projects.count()).toBe(counts + 2);
  expect(await db.states.count()).toBe(source.states.length);
  for (let i = 0; i < source.projects.length; i++) {
    const original = source.projects[i]!, restored = await repo.load(plan.record.projectIds[i]!);
    const imported = plan.snapshot.projects[i]!;
    expect(imported.origin?.sourceProjectId).toBe(original.id);
    expect(restored.nodes.map(node => ({ ...node, matchId: original.id }))).toEqual((await repo.load(original.id)).nodes);
    expect(restored.archivedRootIds).toEqual(original.archivedRootIds ?? []);
    expect(restored.project.activeNodeId).toBe(original.project.activeNodeId);
    for (const node of restored.nodes) expect(restored.states.get(node.stateHash)).toEqual(source.states.find(state => state.hash === node.stateHash)?.state);
  }
  const restored = await repo.load(plan.record.projectIds[0]!);
  const candidate = await prepareMove(restored, restored.project.activeNodeId, 'right', 'reroll');
  if ('reason' in candidate) throw new Error(candidate.reason);
  await repo.commit(candidate); expect((await repo.load(restored.project.id)).nodes).toHaveLength(restored.nodes.length + 1);
  expect((await db.projects.get(restored.project.id))?.origin).toEqual(plan.snapshot.projects[0]!.origin);
});

test.each(['state', 'branch', 'project'] as const)('%s exports contain their dependency closure and no unrelated branch', async kind => {
  const project = source.projects.find(record => record.id === root.project.id)!;
  const selected = project.project.activeNodeId;
  const result = await createArchive(source, { kind, projectId: project.id, nodeId: selected });
  const parsed = await parseImport(result.bytes);
  expect(parsed.snapshot.projects).toHaveLength(1);
  expect(parsed.snapshot.projects[0]!.project.activeNodeId).toBe(selected);
  const fullCount = source.nodes.filter(node => node.matchId === project.id).length;
  expect(parsed.snapshot.nodes.length).toBe(kind === 'project' ? fullCount : 2);
  for (const state of parsed.snapshot.states) expect(source.states).toContainEqual(state);
  const plan = await prepareImportCopy(parsed); await repo.importCopy(plan);
  await expect(repo.load(plan.record.projectIds[0]!)).resolves.toBeDefined();
});

test('known M1 JSON migration preserves state hashes; unknown versions do not write', async () => {
  const legacy = await repo.exportBackup();
  const parsed = await parseImport(new TextEncoder().encode(JSON.stringify(legacy)));
  expect(parsed.sourceFormat).toBe('m1-json-v1'); expect(parsed.migrations).toHaveLength(1);
  const plan = await prepareImportCopy(parsed); await repo.importCopy(plan);
  expect(plan.snapshot.states).toEqual(source.states);
  const invalid = { ...(legacy as object), schemaVersion: 2 };
  await expect(parseImport(new TextEncoder().encode(JSON.stringify(invalid)))).rejects.toThrow(/版本/);
});

test('full-snapshot and delta exports restore identical complete states', async () => {
  const full = await createArchive(source, { kind: 'library', useDeltas: false });
  expect(full.manifest!.states.every(state => state.encoding === 'full')).toBe(true);
  const decoded = await parseImport(full.bytes);
  expect(decoded.snapshot.states).toEqual(expect.arrayContaining(source.states));
  expect(decoded.snapshot.states).toHaveLength(source.states.length);
});

test('rule JSON creates a fresh playable match only after import commit', async () => {
  const rule = await createArchive(source, { kind: 'rules' });
  const before = await db.projects.count();
  const parsed = await parseImport(rule.bytes), plan = await prepareImportCopy(parsed);
  expect(parsed.kind).toBe('rules'); expect(await db.projects.count()).toBe(before);
  await repo.importCopy(plan); expect(await db.projects.count()).toBe(before + 1);
});

test('quota failure halfway through library import rolls back every copy and the batch; retry is idempotent', async () => {
  const parsed = await parseImport((await createArchive(source, { kind: 'library' })).bytes), plan = await prepareImportCopy(parsed);
  let writes = 0;
  const fail = () => { if (++writes === 2) throw new DOMException('quota', 'QuotaExceededError'); };
  db.projects.hook('creating', fail);
  await expect(repo.importCopy(plan)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(await db.projects.count()).toBe(2); expect(await db.imports.count()).toBe(0);
  expect(await db.historyNodes.count()).toBe(source.nodes.length);
  db.projects.hook('creating').unsubscribe(fail);
  await repo.importCopy(plan); await repo.importCopy(plan); expect(await db.projects.count()).toBe(4);
});

test.each(['digest', 'missing-entry', 'unlisted-entry', 'unknown-version', 'unknown-capability', 'missing-base', 'cycle', 'prototype', 'bad-result', 'missing-node', 'root-mismatch'] as const)('rejects %s archives before any database mutation', async kind => {
  const bytes = await mutateArchive(async (manifest, files) => {
    if (kind === 'digest') { const path = manifest.entries[0]!.path; files[path] = new TextEncoder().encode('{}'); }
    if (kind === 'missing-entry') delete files[manifest.entries[0]!.path];
    if (kind === 'unlisted-entry') files['extra.json'] = new TextEncoder().encode('{}');
    if (kind === 'unknown-version') (manifest as unknown as { formatVersion: number }).formatVersion = 2;
    if (kind === 'unknown-capability') manifest.requiredCapabilities.push('scripts-v99');
    if (['missing-base', 'cycle', 'prototype', 'bad-result'].includes(kind)) {
      const state = manifest.states.find(state => state.encoding === 'delta')!;
      const delta = JSON.parse(new TextDecoder().decode(files[state.path]));
      if (kind === 'missing-base' || kind === 'cycle') delta.baseStateHash = state.baseHash = kind === 'cycle' ? state.hash : 'sha256:' + '0'.repeat(64);
      if (kind === 'prototype') delta.patches.push({ op: 'replace', path: ['__proto__', 'polluted'], value: true });
      if (kind === 'bad-result') delta.patches.push({ op: 'replace', path: ['world','score'], value: '999' });
      files[state.path] = new TextEncoder().encode(canonicalJson(delta));
      const entry = manifest.entries.find(entry => entry.path === state.path)!;
      entry.bytes = files[state.path]!.length; entry.hash = await hashBytes(files[state.path]!);
    }
    if (kind === 'root-mismatch') manifest.projects[0]!.rootNodeIds = ['absent'];
    if (kind === 'missing-node') {
      const part = manifest.entries.find(entry => entry.kind === 'node-part')!;
      const lines = new TextDecoder().decode(files[part.path]).trim().split('\n');
      lines.pop(); files[part.path] = new TextEncoder().encode(lines.join('\n') + '\n');
      part.bytes = files[part.path]!.length; part.hash = await hashBytes(files[part.path]!);
    }
  });
  const before = await repo.readSnapshot(); await expect(parseImport(bytes)).rejects.toThrow();
  expect(await repo.readSnapshot()).toEqual(before); expect(await db.imports.count()).toBe(0);
});

test('rejects traversal, duplicate paths, symlinks, encryption, truncated ZIP and decompression bombs', async () => {
  const encoder = new TextEncoder();
  await expect(extractZip(zipSync({ '../bad.json': encoder.encode('{}') }))).rejects.toThrow(/路径/);
  const zip = zipSync({ 'good.json': encoder.encode('{}') });
  expect(() => inspectZip(zip.subarray(0, zip.length - 1))).toThrow(/截断/);
  const encrypted = new Uint8Array(zip); encrypted[6] = encrypted[6]! | 1;
  const directory = new DataView(encrypted.buffer).getUint32(encrypted.length - 6, true); encrypted[directory + 8] = encrypted[directory + 8]! | 1;
  expect(() => inspectZip(encrypted)).toThrow(/加密/);
  const symlink = new Uint8Array(zip); new DataView(symlink.buffer).setUint32(directory + 38, 0xa0000000, true);
  expect(() => inspectZip(symlink)).toThrow(/符号链接/);
  const duplicate = zipSync({ 'a.json': encoder.encode('{}'), 'b.json': encoder.encode('{}') });
  for (let i = 0; i < duplicate.length - 6; i++) if (new TextDecoder().decode(duplicate.subarray(i, i + 6)) === 'b.json') duplicate[i] = 'a'.charCodeAt(0);
  expect(() => inspectZip(duplicate)).toThrow(/重复/);
  const bomb = zipSync({ 'large.json': new Uint8Array(2_000_000) }, { level: 9 });
  await expect(extractZip(bomb)).rejects.toThrow(/上限/);
  const lying = new Uint8Array(bomb), lyingView = new DataView(lying.buffer);
  const bombDirectory = lyingView.getUint32(lying.length - 6, true);
  lyingView.setUint32(22, 1000, true); lyingView.setUint32(bombDirectory + 24, 1000, true);
  await expect(extractZip(lying)).rejects.toThrow(/实际解压输出/);
  await expect(extractZip(zip, undefined, { ...archiveLimits, maxEntry: 1 })).rejects.toThrow(/上限/);
  const aborted = new AbortController(); aborted.abort(); await expect(extractZip(zip, aborted.signal)).rejects.toThrow();
});

test('delta format is lossless, rejects prototype writes and verifies supported operations', async () => {
  const original = root.state, changed = structuredClone(original);
  changed.world.score = '9007199254740993'; changed.undoStack.push('new-parent');
  const delta = createDelta(original, changed, await hashJson(original), await hashJson(changed));
  expect(applyDelta(original, delta)).toEqual(changed); expect(original.undoStack).toHaveLength(0);
  delta.patches.push({ op: 'replace', path: ['__proto__','polluted'], value: true });
  expect(() => applyDelta(original, delta)).toThrow(); expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test('M1 IndexedDB v1 upgrades through v2/v3 without losing state or active position', async () => {
  const name = `migration-${crypto.randomUUID()}`, old = new Dexie(name);
  old.version(1).stores({ projects: 'id,updatedAt', nodes: 'id,matchId,parentId,&operationId', states: 'hash', rules: '[id+version]', checkpoints: 'id,projectId,[projectId+nodeId]', settings: 'key' });
  await old.open();
  await old.table('projects').bulkAdd(source.projects); await old.table('nodes').bulkAdd(source.nodes);
  await old.table('states').bulkAdd(source.states); await old.table('rules').bulkAdd(source.rules);
  await old.table('checkpoints').bulkAdd(source.checkpoints); await old.table('settings').bulkAdd(source.settings); old.close();
  const upgraded = new SandboxDatabase(name), repository = new Repository(upgraded);
  try {
    expect(await upgraded.historyNodes.count()).toBe(source.nodes.length);
    const loaded = await repository.load(root.project.id); expect(loaded.project.activeNodeId).toBe(source.projects.find(record => record.id === root.project.id)!.project.activeNodeId);
    expect(upgraded.tables.map(table => table.name)).not.toContain('nodes');
  } finally { upgraded.close(); await upgraded.delete(); }
});

test('selected snapshot only includes states that belong to its reference closure', () => {
  const selected = selectSnapshot(source, { kind: 'branch', projectId: root.project.id });
  expect(selected.projects).toHaveLength(1);
  expect(new Set(selected.nodes.map(node => node.stateHash)).size).toBe(selected.states.length);
});
