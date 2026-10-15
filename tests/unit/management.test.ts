import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { CommitCandidate, LoadedProject } from '../../src/domain/types';
import { parseImport, prepareImportCopy, createArchive } from '../../src/files/archive';
import { prepareMove, prepareNewMatch, prepareRuleEdit } from '../../src/history/candidates';
import { createRuleRevision } from '../../src/presets/rules';
import { SandboxDatabase } from '../../src/persistence/database';
import { Repository, RevisionConflict } from '../../src/persistence/repository';
import { seedPcg32 } from '../../src/random/pcg32';

let db: SandboxDatabase, repo: Repository, root: CommitCandidate;
beforeEach(async () => {
  db = new SandboxDatabase(`management-${crypto.randomUUID()}`); repo = new Repository(db);
  root = await prepareNewMatch('待删除对局', seedPcg32(42n, 54n)); await repo.commit(root);
});
afterEach(async () => { db.close(); await db.delete(); });

async function next(loaded: LoadedProject, parentId = loaded.project.activeNodeId) {
  for (const direction of ['left', 'up', 'right', 'down'] as const) {
    const candidate = await prepareMove(loaded, parentId, direction, 'reproduce');
    if (!('reason' in candidate)) return candidate;
  }
  throw new Error('No valid fixture move');
}
async function copy() {
  const parsed = await parseImport((await createArchive(await repo.readSnapshot(), { kind: 'project', projectId: root.project.id })).bytes);
  const plan = await prepareImportCopy(parsed); await repo.importCopy(plan); return plan;
}

test('deleting a match removes every branch and checkpoint, repairs the last position and leaves the other match playable and exportable', async () => {
  const first = await next(await repo.load(root.project.id)); await repo.commit(first);
  const branch = await next(await repo.load(root.project.id), root.node.id); await repo.commit(branch);
  await repo.checkpoint(await repo.load(root.project.id), first.node.id);
  const other = await prepareNewMatch('保留对局', seedPcg32(9n, 6n)); await repo.commit(other);
  const loaded = await repo.load(root.project.id), survivor = await repo.load(other.project.id);
  await db.settings.put({ key: 'lastProjectId', value: root.project.id });
  const records = await repo.deleteProject(root.project.id, loaded.project.revision);
  expect(records.map(record => record.id)).toEqual([other.project.id]);
  expect(await repo.lastProjectId()).toBe(other.project.id);
  expect(await db.historyNodes.where('matchId').equals(root.project.id).count()).toBe(0);
  expect(await db.checkpoints.count()).toBe(0);
  expect(await repo.load(other.project.id)).toEqual(survivor);
  const saved = await repo.readSnapshot();
  expect(saved.states.map(state => state.hash)).toEqual([other.node.stateHash]); expect(saved.rules).toHaveLength(1);
  const parsed = await parseImport((await createArchive(saved, { kind: 'library' })).bytes);
  expect(parsed.snapshot.projects.map(record => record.id)).toEqual([other.project.id]);
  await repo.commit(await next(survivor));
});

test('deleting the final match leaves an empty recoverable library and repeated confirmation is harmless', async () => {
  await repo.checkpoint(await repo.load(root.project.id), root.node.id);
  const revision = (await repo.load(root.project.id)).project.revision;
  expect(await repo.deleteProject(root.project.id, revision)).toEqual([]);
  expect(await repo.deleteProject(root.project.id, revision)).toEqual([]);
  expect(await repo.readSnapshot()).toEqual({ projects: [], nodes: [], states: [], rules: [root.rule], checkpoints: [], settings: [] });
  expect(await repo.lastProjectId()).toBeUndefined();
  expect((await parseImport((await createArchive(await repo.readSnapshot(), { kind: 'library' })).bytes)).snapshot.projects).toEqual([]);
});

test('shared snapshots survive deletion of an original or copy and are collected after the last reference; rule versions stay reserved', async () => {
  await repo.commit(await next(await repo.load(root.project.id)));
  const plan = await copy(), copyId = plan.record.projectIds[0]!;
  const original = await repo.load(root.project.id), imported = await repo.load(copyId);
  const count = await db.states.count();
  await repo.deleteProject(root.project.id, original.project.revision);
  expect(await repo.load(copyId)).toEqual(imported); expect(await db.states.count()).toBe(count); expect(await db.rules.count()).toBe(1);
  await repo.commit(await next(imported));
  await repo.deleteProject(copyId, (await repo.load(copyId)).project.revision);
  expect(await db.states.count()).toBe(0); expect(await db.rules.count()).toBe(1);
});

test('an old import retry cannot resurrect a deleted copy; explicitly importing the file again creates a fresh copy', async () => {
  const plan = await copy(), copyId = plan.record.projectIds[0]!;
  await repo.deleteProject(copyId, (await repo.load(copyId)).project.revision);
  const after = await repo.readSnapshot();
  await expect(repo.importCopy(plan)).rejects.toThrow(/已被删除/);
  expect(await repo.readSnapshot()).toEqual(after);
  const fresh = await copy(); expect(fresh.record.projectIds[0]).not.toBe(copyId);
  await expect(repo.load(fresh.record.projectIds[0]!)).resolves.toBeDefined();
});

test('stale deletion is rejected without touching newly saved progress', async () => {
  const stale = await repo.load(root.project.id);
  await repo.commit(await next(stale)); const before = await repo.readSnapshot();
  await expect(repo.deleteProject(root.project.id, stale.project.revision)).rejects.toBeInstanceOf(RevisionConflict);
  expect(await repo.readSnapshot()).toEqual(before);
});

test('a failure after deleting nodes, snapshots and project rolls back the whole deletion and can retry', async () => {
  await repo.checkpoint(await repo.load(root.project.id), root.node.id);
  const loaded = await repo.load(root.project.id), before = await repo.readSnapshot();
  const fail = () => { throw new DOMException('Injected storage failure', 'UnknownError'); };
  db.settings.hook('deleting', fail);
  await expect(repo.deleteProject(root.project.id, loaded.project.revision)).rejects.toThrow(/Injected storage failure/);
  expect(await repo.readSnapshot()).toEqual(before);
  db.settings.hook('deleting').unsubscribe(fail);
  await repo.deleteProject(root.project.id, loaded.project.revision); expect(await db.projects.count()).toBe(0);
});

test('a move prepared before deletion cannot recreate the deleted match', async () => {
  const staleMove = await next(await repo.load(root.project.id));
  await repo.deleteProject(root.project.id, root.project.revision);
  await expect(repo.commit(staleMove)).rejects.toThrow();
  expect(await db.projects.count()).toBe(0); expect(await db.historyNodes.count()).toBe(0);
});

test('a damaged match with a missing snapshot can still be deleted without damaging another match', async () => {
  const other = await prepareNewMatch('保留对局', seedPcg32(9n, 6n)); await repo.commit(other);
  await db.states.delete(root.node.stateHash);
  await repo.deleteProject(root.project.id, root.project.revision);
  await expect(repo.load(other.project.id)).resolves.toBeDefined();
});

test('deletion keeps rule versions reserved so editing an older copy cannot collide with a deleted version or its backup', async () => {
  const publish = async (loaded: LoadedProject, tileValue: string) => {
    const definition = structuredClone(loaded.rule.definition); definition.goals.tileValue = tileValue;
    const rule = await createRuleRevision(loaded.rule, definition, (await repo.readSnapshot()).rules);
    const candidate = await prepareRuleEdit(loaded, loaded.project.activeNodeId, rule, 'cancel');
    if ('reason' in candidate) throw new Error(candidate.reason);
    await repo.commit(candidate); return rule;
  };
  const v1 = await publish(await repo.load(root.project.id), '2048');
  const plan = await copy(), copyId = plan.record.projectIds[0]!;
  const v2 = await publish(await repo.load(root.project.id), '4096');
  expect(v2.id).toBe(v1.id); expect(v2.version).toBe(2);
  const oldBackup = await createArchive(await repo.readSnapshot(), { kind: 'project', projectId: root.project.id });
  await repo.deleteProject(root.project.id, (await repo.load(root.project.id)).project.revision);
  const v3 = await publish(await repo.load(copyId), '8192');
  expect(v3.id).toBe(v1.id); expect(v3.version).toBe(3);
  const currentBackup = await parseImport((await createArchive(await repo.readSnapshot(), { kind: 'library' })).bytes);
  expect(currentBackup.snapshot.rules.filter(rule => rule.id === v1.id).map(rule => rule.version).sort()).toEqual([1, 3]);
  const restored = await prepareImportCopy(await parseImport(oldBackup.bytes));
  await repo.importCopy(restored); await expect(repo.load(restored.record.projectIds[0]!)).resolves.toBeDefined();
});
