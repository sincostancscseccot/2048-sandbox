import { expect, test } from 'vitest';
import type { CommitCandidate, Condition, LoadedProject } from '../../src/domain/types';
import { copyEvent, describeCondition, rectangleIndices, renameVariable } from '../../src/domain/editor';
import { createCustomRule, sandboxDefinition } from '../../src/presets/rules';
import { prepareBoardEdit, prepareMove, prepareNewMatch, prepareRuleEdit, prepareSkill } from '../../src/history/candidates';
import { buildPathStatistics, compareBoards, scoreTrend } from '../../src/history/statistics';
import { createRuleRevision } from '../../src/presets/rules';
import { seedPcg32 } from '../../src/random/pcg32';

const comparison = (reference: string): Condition => ({ kind: 'compare', source: 'variable', reference, operator: 'eq', value: '0' });
function variableRule() {
  const d = sandboxDefinition(); d.variables = { a: '0', b: '1' };
  d.spawn.phaseRules = [{ id: 'phase', priority: 0, condition: { kind: 'not', child: comparison('a') }, weights: [{ value: '2', weight: 1 }], count: 1 }];
  d.events = [{ id: 'e', name: '事件', trigger: 'after-round', condition: { kind: 'all', children: [comparison('a'), { kind: 'any', children: [comparison('b')] }] }, actions: [{ type: 'add-variable', name: 'a', value: '2' }], priority: 0, maxExecutions: null, cooldownTurns: 0, allowReentry: false }]; return d;
}
test('rectangle editing is coordinate based in both directions, including zero-width spans and boundaries', () => {
  expect(rectangleIndices(3, 5, 1, 13)).toEqual([1,2,3,6,7,8,11,12,13]);
  expect(rectangleIndices(3, 5, 13, 1)).toEqual(rectangleIndices(3, 5, 1, 13));
  expect(rectangleIndices(3, 5, 4, 14)).toEqual([4,9,14]); expect(() => rectangleIndices(3,5,-1,2)).toThrow(/越界/);
});
test('variable rename updates nested phase/event/action references without changing the source or unrelated variables', () => {
  const d = variableRule(), before = structuredClone(d), renamed = renameVariable(d, 'a', 'moves');
  expect(d).toEqual(before); expect(renamed.variables).toEqual({ moves: '0', b: '1' });
  expect(JSON.stringify(renamed.events)).not.toContain('"a"'); expect(JSON.stringify(renamed.spawn.phaseRules)).toContain('"moves"');
  expect(describeCondition(renamed.events[0]!.condition, renamed)).toContain('变量 moves 等于 0');
  expect(describeCondition(renamed.events[0]!.condition, renamed)).toContain('变量 b 等于 0');
});
test.each(['b', '__proto__', 'constructor', '1bad', 'a b', ''])('invalid or colliding variable rename %s never loses either variable', name => {
  const d = variableRule(), before = structuredClone(d); expect(() => renameVariable(d, 'a', name)).toThrow(); expect(d).toEqual(before);
});
test('copying an event remaps its own count references and keeps other references and actions independent', () => {
  const d = variableRule(), original = d.events[0]!; original.condition = { kind: 'compare', source: 'event-count', reference: 'e', operator: 'gte', value: '2' };
  const copied = copyEvent(original, 'new'); expect(copied.condition).toMatchObject({ reference: 'new' }); expect(original.condition.reference).toBe('e');
  copied.actions[0] = { type: 'add-score', value: '9' }; expect(original.actions[0]).toMatchObject({ type: 'add-variable' });
});

async function fixture() {
  const d = sandboxDefinition(); d.board.rows = 1; d.board.cols = 5; d.board.initialLayout = [2,2,4].map((value,index) => ({ index, value: String(value) }));
  d.numbers.maxDigits = 4096;
  d.spawn.initialCount = 0; d.spawn.perActionCount = 0; d.goals.lossWhenNoMoves = false;
  const rule = await createCustomRule('统计', d), root = await prepareNewMatch('统计对局', seedPcg32(42n,54n), rule);
  const loaded: LoadedProject = { project: root.project, nodes: [root.node], states: new Map([[root.node.stateHash,root.state]]), rule, rules: new Map([[`${rule.id}/1`,rule]]), checkpoints: [], archivedRootIds: [] };
  function add(value: CommitCandidate | { reason: string }) { if ('reason' in value) throw new Error(value.reason); loaded.project = value.project; loaded.nodes.push(value.node); loaded.states.set(value.node.stateHash,value.state); loaded.rules.set(`${value.rule.id}/${value.rule.version}`,value.rule); loaded.rule = value.rule; return value; }
  return { loaded, root, add };
}
test('path statistics preserve undo drops and count actual actions, while unrelated branches stay separate', async () => {
  const { loaded, root, add } = await fixture(); const a = add(await prepareMove(loaded,root.node.id,'left','reroll')), b = add(await prepareMove(loaded,a.node.id,'left','reroll'));
  const undo = add(await prepareSkill(loaded,b.node.id,{skillId:'undo',targetNodeId:a.node.id},'reroll'));
  add(await prepareBoardEdit(loaded,root.node.id,[{index:4,value:'9'.repeat(300)}]));
  const stats = buildPathStatistics(loaded,undo.node.id);
  expect(stats.rows.map(row=>row.score)).toEqual(['0','4','12','4']); expect(stats.rows.at(-1)!.scoreDelta).toBe('-8');
  expect(stats).toMatchObject({ highestScore: '12', largestTile:'8', mergeOperations:2, totalNodes:5, forkPoints:1, actions:{move:2,skill:1,edit:0,'rule-edit':0},skills:{undo:1} });
  expect(buildPathStatistics(loaded,loaded.project.activeNodeId).largestTile).toBe('9'.repeat(300));
});
test('statistics include rule version boundaries and checkpoints without changing any saved state', async () => {
  const { loaded,root,add } = await fixture(), next = await createRuleRevision(loaded.rule,loaded.rule.definition,[loaded.rule]);
  const revised = add(await prepareRuleEdit(loaded,root.node.id,next,'cancel')); loaded.checkpoints.push({id:'cp',projectId:root.project.id,nodeId:revised.node.id,name:'检查点',createdAt:revised.node.createdAt});
  const before = structuredClone(loaded), stats = buildPathStatistics(loaded,revised.node.id);
  expect(stats.ruleVersions).toBe(2); expect(stats.pathCheckpoints).toBe(1); expect(stats.actions['rule-edit']).toBe(1); expect(loaded).toEqual(before);
});
test('trend sampling retains the peak, selected node and endpoints with huge exact scores', async () => {
  const { loaded,root } = await fixture(), template = buildPathStatistics(loaded,root.node.id).rows[0]!;
  const rows = Array.from({length:1000},(_,i)=>({...template,nodeId:`n${i}`,depth:i,score:i===337?'9'.repeat(4096):'0'}));
  const trend = scoreTrend(rows,'n777'); expect(trend.length).toBeLessThanOrEqual(200);
  expect(trend.map(point=>point.nodeId)).toEqual(expect.arrayContaining(['n0','n999','n337','n777']));
  expect(trend.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.y>=0&&point.y<=100)).toBe(true); expect(trend.find(point=>point.nodeId==='n337')!.y).toBe(0);
  expect(scoreTrend([], 'none')).toEqual([]); expect(scoreTrend([template],template.nodeId)[0]).toMatchObject({x:50,y:100});
});
test('board comparison distinguishes zeros, empty cells and missing geometry', async () => {
  const { root } = await fixture(), a = structuredClone(root.state), b = structuredClone(a);
  b.world.board = { rows: 2, cols: 3, cells: [{tile:a.world.board.cells[0]!.tile},{tile:null},{tile:null},{tile:null},{tile:null},{tile:{id:'zero',value:'0',attributes:{}}}] };
  const diff = compareBoards(a,b); expect(diff.total).toBe(10); expect(diff.differences).toContainEqual({row:2,col:3,before:'无此格',after:'0'});
  expect(diff.differences).toContainEqual({row:1,col:2,before:'2',after:'空'}); expect(compareBoards(a,a).differences).toEqual([]);
});
