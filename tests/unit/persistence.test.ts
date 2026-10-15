import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommitCandidate, Direction, LoadedProject } from '../../src/domain/types';
import { prepareMove, prepareNewMatch } from '../../src/history/candidates';
import { SandboxDatabase } from '../../src/persistence/database';
import { IntegrityError, Repository, RevisionConflict } from '../../src/persistence/repository';
import { seedPcg32 } from '../../src/random/pcg32';
import { hashJson } from '../../src/domain/hash';

let db: SandboxDatabase, repo: Repository, initial: CommitCandidate;
beforeEach(async () => {
  db = new SandboxDatabase(`test-${crypto.randomUUID()}`); repo = new Repository(db);
  initial = await prepareNewMatch('测试对局', seedPcg32(42n, 54n)); await repo.commit(initial);
});
afterEach(async () => { db.close(); await db.delete(); });

async function next(loaded: LoadedProject, parentId = loaded.project.activeNodeId, policy: 'reroll' | 'reproduce' = 'reroll') {
  for (const direction of ['left', 'up', 'right', 'down'] as Direction[]) {
    const candidate = await prepareMove(loaded, parentId, direction, policy, () => seedPcg32(99n, 77n));
    if (!('reason' in candidate)) return candidate;
  }
  throw new Error('测试输入无可用移动');
}

describe('transactional history', () => {
  test('closes and reopens with the exact head, state, score and RNG', async () => {
    const candidate = await next(await repo.load(initial.project.id)); await repo.commit(candidate);
    db.close(); await db.open();
    const restored = await repo.load(initial.project.id);
    expect(restored.project.activeNodeId).toBe(candidate.node.id);
    expect(restored.states.get(candidate.node.stateHash)).toEqual(candidate.state);
    expect(restored.nodes).toHaveLength(2);
  });
  test('retrying the same operation ID is idempotent', async () => {
    const candidate = await next(await repo.load(initial.project.id));
    await repo.commit(candidate); await repo.commit(candidate);
    expect(await db.historyNodes.count()).toBe(2); expect((await repo.load(initial.project.id)).project.revision).toBe(2);
  });
  test('a structurally valid but incorrectly scored candidate is rejected before any writes', async () => {
    const candidate = await next(await repo.load(initial.project.id));
    candidate.state.world.score = '999'; candidate.node.stateHash = await hashJson(candidate.state);
    await expect(repo.commit(candidate)).rejects.toBeInstanceOf(IntegrityError);
    expect(await db.historyNodes.count()).toBe(1); expect(await db.states.count()).toBe(1);
    expect((await repo.load(initial.project.id)).project.activeNodeId).toBe(initial.node.id);
  });
  test('quota failure after node and state writes rolls back the entire transaction, then same candidate retries', async () => {
    const candidate = await next(await repo.load(initial.project.id));
    const fail = () => { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };
    db.projects.hook('updating', fail);
    await expect(repo.commit(candidate)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await db.historyNodes.count()).toBe(1); expect(await db.states.count()).toBe(1);
    expect((await repo.load(initial.project.id)).project.activeNodeId).toBe(initial.node.id);
    db.projects.hook('updating').unsubscribe(fail);
    await repo.commit(candidate);
    expect((await repo.load(initial.project.id)).project.activeNodeId).toBe(candidate.node.id);
  });
  test('two tabs computing against the same revision cannot overwrite each other', async () => {
    const loaded = await repo.load(initial.project.id);
    const a = await next(loaded), b = await next(loaded);
    const results = await Promise.allSettled([repo.commit(a), repo.commit(b)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toBeInstanceOf(RevisionConflict);
    expect(await db.historyNodes.count()).toBe(2);
  });
  test('identical reproduced states remain separate nodes; original branches retain their scores', async () => {
    let loaded = await repo.load(initial.project.id);
    const first = await next(loaded); await repo.commit(first);
    loaded = await repo.load(initial.project.id);
    if (first.node.action?.type !== 'move') throw new Error('Expected a move node');
    const copied = await prepareMove(loaded, initial.node.id, first.node.action!.payload.direction, 'reproduce');
    expect('reason' in copied).toBe(false);
    if ('reason' in copied) return;
    await repo.commit(copied);
    expect(copied.node.id).not.toBe(first.node.id); expect(copied.node.stateHash).toBe(first.node.stateHash);
    expect(copied.node.randomContext?.mode).toBe('reproduce');
    const restored = await repo.load(initial.project.id);
    expect(restored.nodes).toHaveLength(3); expect(await db.states.count()).toBe(2);
    expect(restored.states.get(first.node.stateHash)?.world.score).toBe(first.state.world.score);
    expect(restored.states.get(initial.node.stateHash)?.world.score).toBe('0');
  });
  test('branching defaults to a new recorded random context', async () => {
    const first = await next(await repo.load(initial.project.id)); await repo.commit(first);
    const rerolled = await next(await repo.load(initial.project.id), initial.node.id);
    expect(rerolled.node.randomContext?.mode).toBe('reroll');
    expect(rerolled.node.randomContext?.before).toEqual(seedPcg32(99n, 77n));
    await repo.commit(rerolled); await expect(repo.load(initial.project.id)).resolves.toBeDefined();
  });
  test('a rejected action does not request branch entropy or add nodes', async () => {
    const first = await next(await repo.load(initial.project.id)); await repo.commit(first);
    const loaded = await repo.load(initial.project.id); const rng = vi.fn(() => seedPcg32(1n, 1n));
    const active = loaded.states.get(first.node.stateHash)!;
    active.world.outcome.canContinue = false;
    const rejected = await prepareMove(loaded, first.node.id, 'left', 'reroll', rng);
    expect('reason' in rejected).toBe(true); expect(rng).not.toHaveBeenCalled(); expect(await db.historyNodes.count()).toBe(2);
  });
  test('checkpoint updates metadata, preserves head and does not charge an action', async () => {
    const loaded = await repo.load(initial.project.id);
    await repo.checkpoint(loaded, initial.node.id);
    const restored = await repo.load(initial.project.id);
    expect(restored.checkpoints).toHaveLength(1); expect(restored.project.revision).toBe(2);
    expect(restored.project.activeNodeId).toBe(initial.node.id); expect(restored.nodes).toHaveLength(1);
    expect(restored.states.get(initial.node.stateHash)?.ledger.effectiveActionCount).toBe(0);
    await repo.checkpoint(restored, initial.node.id); expect(await db.checkpoints.count()).toBe(1);
  });
  test.each(['checksum', 'missing-state', 'missing-parent', 'random-context'] as const)('detects %s corruption instead of starting a new match', async kind => {
    const candidate = await next(await repo.load(initial.project.id)); await repo.commit(candidate);
    if (kind === 'checksum') {
      const record = (await db.states.get(candidate.node.stateHash))!; record.state.world.score = '999'; await db.states.put(record);
    } else if (kind === 'missing-state') await db.states.delete(candidate.node.stateHash);
    else if (kind === 'missing-parent') await db.historyNodes.update([candidate.project.id, candidate.node.id], { parentId: 'absent' });
    else await db.historyNodes.update([candidate.project.id, candidate.node.id], { randomContext: { ...candidate.node.randomContext!, before: seedPcg32(12n, 7n) } });
    await expect(repo.load(initial.project.id)).rejects.toBeInstanceOf(IntegrityError);
    expect(await db.projects.count()).toBe(1);
  });
  test('a library backup consistently includes every match, branch, state, rule and checkpoint', async () => {
    const candidate = await next(await repo.load(initial.project.id)); await repo.commit(candidate);
    await repo.checkpoint(await repo.load(initial.project.id), candidate.node.id);
    const other = await prepareNewMatch('另一个对局'); await repo.commit(other);
    const backup = await repo.exportBackup() as { projects: unknown[]; nodes: unknown[]; states: unknown[]; rules: unknown[]; checkpoints: unknown[] };
    expect(backup.projects).toHaveLength(2); expect(backup.nodes).toHaveLength(3); expect(backup.states).toHaveLength(3);
    expect(backup.rules).toHaveLength(1); expect(backup.checkpoints).toHaveLength(1);
  });
});
