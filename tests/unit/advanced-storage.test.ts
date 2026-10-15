import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { hashJson } from '../../src/domain/hash';
import type { CommitCandidate, RuleDefinition, RuleSetVersion } from '../../src/domain/types';
import { createCustomRule, createRuleRevision, sandboxDefinition } from '../../src/presets/rules';
import { prepareBoardEdit, prepareMove, prepareNewMatch, prepareRuleEdit, prepareSkill, ruleForState } from '../../src/history/candidates';
import { SandboxDatabase } from '../../src/persistence/database';
import { IntegrityError, Repository, RevisionConflict } from '../../src/persistence/repository';
import { createArchive, parseImport, prepareImportCopy } from '../../src/files/archive';
import { seedPcg32 } from '../../src/random/pcg32';

let db: SandboxDatabase, repo: Repository, rule: RuleSetVersion, root: CommitCandidate;
beforeEach(async () => {
  db = new SandboxDatabase(`m4-${crypto.randomUUID()}`); repo = new Repository(db);
  const d = sandboxDefinition(); d.board.rows = 2; d.board.cols = 4;
  d.spawn.initialCount = 0; d.spawn.perActionCount = 0; d.goals.lossWhenNoMoves = false;
  d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '2' }, { index: 2, value: '4' }];
  rule = await createCustomRule('M4 原版', d); root = await prepareNewMatch('M4 对局', seedPcg32(42n, 54n), rule); await repo.commit(root);
});
afterEach(async () => { db.close(); await db.delete(); });
function accepted(candidate: CommitCandidate | { reason: string }): CommitCandidate {
  if ('reason' in candidate) throw new Error(candidate.reason); return candidate;
}
async function revise(change: (definition: RuleDefinition) => void = () => {}) {
  const loaded = await repo.load(root.project.id), d = structuredClone(loaded.rule.definition); change(d);
  const nextRule = await createRuleRevision(loaded.rule, d, (await repo.readSnapshot()).rules, 'M4 修改');
  const candidate = accepted(await prepareRuleEdit(loaded, loaded.project.activeNodeId, nextRule, 'cancel'));
  await repo.commit(candidate); return candidate;
}

test('rule publication is immutable, clears undo and preserves old-rule continuations after reopening', async () => {
  const first = accepted(await prepareMove(await repo.load(root.project.id), root.node.id, 'left', 'reroll')); await repo.commit(first);
  const published = await revise(d => { d.board.cols = 5; });
  expect(published.state.undoStack).toEqual([]); expect(published.state.world.score).toBe('4');
  expect(published.state.ledger).toEqual({ ...first.state.ledger, effectiveActionCount: 2 });
  const loaded = await repo.load(root.project.id);
  const branched = accepted(await prepareMove(loaded, root.node.id, 'left', 'reproduce')); await repo.commit(branched);
  expect(branched.state.ruleRef).toEqual(root.state.ruleRef); expect(branched.state.world.board.cols).toBe(4);
  db.close(); await db.open(); const restored = await repo.load(root.project.id);
  expect(restored.rule).toEqual(rule); expect(restored.rules.size).toBe(2);
  expect(ruleForState(restored, restored.states.get(published.node.stateHash)!)).toEqual(published.rule);
  expect(restored.states.get(first.node.stateHash)).toEqual(first.state); expect(restored.nodes).toHaveLength(4);
});

test('board editing classic publishes custom capabilities and changes the board in a single atomic node', async () => {
  const classic = await prepareNewMatch('经典'); await repo.commit(classic);
  const loaded = await repo.load(classic.project.id), nextRule = await createRuleRevision(loaded.rule, loaded.rule.definition, (await repo.readSnapshot()).rules, '可编辑经典');
  const index = classic.state.world.board.cells.findIndex(cell => cell.tile === null);
  const edited = accepted(await prepareBoardEdit(loaded, classic.node.id, [{ index, value: '0' }], nextRule)); await repo.commit(edited);
  const restored = await repo.load(classic.project.id); expect(restored.nodes).toHaveLength(2);
  expect(edited.node.action).toMatchObject({ type: 'edit', payload: { nextRuleRef: edited.state.ruleRef } });
  expect(edited.rule.definition.mode).toBe('custom'); expect(edited.rule.requiredCapabilities).toContain('editing-v1');
  expect(edited.state.undoStack).toEqual([]); expect(restored.states.get(classic.node.stateHash)).toEqual(classic.state);
});

test('ordinary board edits can be undone without rewriting their old node or refunding effective actions', async () => {
  const edit = accepted(await prepareBoardEdit(await repo.load(root.project.id), root.node.id, [{ index: 7, value: '0' }])); await repo.commit(edit);
  const undo = accepted(await prepareSkill(await repo.load(root.project.id), edit.node.id, { skillId: 'undo', targetNodeId: root.node.id }, 'reroll')); await repo.commit(undo);
  expect(undo.state.world).toEqual(root.state.world); expect(undo.state.ledger.effectiveActionCount).toBe(2);
  expect(undo.state.ledger.skills.undo).toMatchObject({ charges: 2, usedCount: 1 });
  expect((await repo.load(root.project.id)).states.get(edit.node.stateHash)).toEqual(edit.state);
});

test('quota failure rolls back new rule, state and node together; the same publication retries once', async () => {
  const loaded = await repo.load(root.project.id), d = structuredClone(rule.definition); d.board.cols = 5;
  const nextRule = await createRuleRevision(rule, d, [rule], '扩展');
  const candidate = accepted(await prepareRuleEdit(loaded, root.node.id, nextRule, 'cancel')), before = await repo.readSnapshot();
  const fail = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  db.projects.hook('updating', fail); await expect(repo.commit(candidate)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(await repo.readSnapshot()).toEqual(before); db.projects.hook('updating').unsubscribe(fail);
  await repo.commit(candidate); await repo.commit(candidate); expect(await db.rules.count()).toBe(2); expect(await db.historyNodes.count()).toBe(2);
});

test('concurrent versions conflict safely and global revisions avoid imported-copy rule collisions', async () => {
  const source = await repo.readSnapshot(), plan = await prepareImportCopy(await parseImport((await createArchive(source, { kind: 'project', projectId: root.project.id })).bytes)); await repo.importCopy(plan);
  const loaded = await repo.load(root.project.id), d = structuredClone(rule.definition); d.board.cols = 5;
  const v2 = await createRuleRevision(rule, d, (await repo.readSnapshot()).rules, 'v2');
  const a = accepted(await prepareRuleEdit(loaded, root.node.id, v2, 'cancel')), b = accepted(await prepareBoardEdit(loaded, root.node.id, [{ index: 7, value: '4' }]));
  await repo.commit(a); await expect(repo.commit(b)).rejects.toBeInstanceOf(RevisionConflict);
  const copy = await repo.load(plan.record.projectIds[0]!), d3 = structuredClone(copy.rule.definition); d3.board.rows = 3;
  const v3 = await createRuleRevision(copy.rule, d3, (await repo.readSnapshot()).rules, 'v3'); expect(v3.version).toBe(3);
  await repo.commit(accepted(await prepareRuleEdit(copy, copy.project.activeNodeId, v3, 'cancel')));
  expect((await repo.load(root.project.id)).rule).toEqual(v2); expect((await repo.load(copy.project.id)).rule).toEqual(v3);
});

test('forged cross-version moves and missing rule versions are rejected without silently reinterpreting history', async () => {
  const published = await revise(d => { d.board.cols = 5; }); const loaded = await repo.load(root.project.id);
  const edited = accepted(await prepareBoardEdit(loaded, published.node.id, [{ index: 9, value: '4' }]));
  const forged = structuredClone(edited); forged.node.action = { type: 'move', payload: { direction: 'left' }, elapsedMs: 0 };
  forged.state.ruleRef = root.state.ruleRef; forged.node.stateHash = await hashJson(forged.state);
  const before = await repo.readSnapshot(); await expect(repo.commit(forged)).rejects.toThrow(); expect(await repo.readSnapshot()).toEqual(before);
  await db.rules.delete([rule.id, rule.version]); await expect(repo.load(root.project.id)).rejects.toBeInstanceOf(IntegrityError);
});

test('mixed-rule event and edit archives preserve all dependencies, full version boundaries and exact states', async () => {
  const published = await revise(d => { d.merge.chain = true; d.merge.maxMergesPerTile = 4; d.variables = { moves: '0' }; d.events = [{ id: 'count', name: '计数', trigger: 'after-round', condition: null, actions: [{ type: 'add-variable', name: 'moves', value: '1' }], priority: 0, maxExecutions: null, cooldownTurns: 0, allowReentry: false }]; });
  const moved = accepted(await prepareMove(await repo.load(root.project.id), published.node.id, 'left', 'reroll')); await repo.commit(moved);
  const edited = accepted(await prepareBoardEdit(await repo.load(root.project.id), moved.node.id, [{ index: 7, value: '0' }])); await repo.commit(edited);
  const source = await repo.readSnapshot();
  for (const kind of ['state', 'branch', 'project', 'library'] as const) {
    const exported = await createArchive(source, { kind, projectId: root.project.id, nodeId: edited.node.id });
    expect(exported.manifest!.requiredCapabilities).toEqual(expect.arrayContaining(['editing-v1', 'advanced-v1', 'events-v1']));
    expect(exported.manifest!.states.find(item => item.hash === published.node.stateHash)!.encoding).toBe('full');
    const parsed = await parseImport(exported.bytes); expect(parsed.snapshot.rules).toEqual(expect.arrayContaining(source.rules));
    const plan = await prepareImportCopy(parsed); await repo.importCopy(plan);
    const restored = await repo.load(plan.record.projectIds[0]!); expect(restored.rules.size).toBe(2); expect(restored.states.get(edited.node.stateHash)).toEqual(edited.state);
    expect(restored.states.get(moved.node.stateHash)!.world.events.variables.moves).toBe('1');
  }
});
