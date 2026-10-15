import { expect, test } from 'vitest';
import type { Direction, GameAction, GameState, RuleDefinition, RuleSetVersion, SkillPayload } from '../../src/domain/types';
import { skillIds } from '../../src/domain/types';
import { canonicalJson } from '../../src/domain/hash';
import { assertSupportedRule, createCustomRule, sandboxDefinition, validateDefinition } from '../../src/presets/rules';
import { createInitialState, stepGame } from '../../src/engine/core';
import { seedPcg32 } from '../../src/random/pcg32';

const seed = seedPcg32(42n, 54n);
async function rule(change: (d: RuleDefinition) => void = () => {}): Promise<RuleSetVersion> {
  const d = sandboxDefinition(); d.board.rows = 1; d.board.cols = 4;
  d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '2' }, { index: 2, value: '4' }];
  d.spawn.initialCount = 0; d.spawn.perActionCount = 0; d.goals.lossWhenNoMoves = false;
  for (const id of skillIds) d.skills[id].enabled = true;
  change(d); return createCustomRule('测试沙盒', d);
}
const move = (direction: Direction): GameAction => ({ type: 'move', payload: { direction }, elapsedMs: 0 });
const skill = (payload: SkillPayload): GameAction => ({ type: 'skill', payload, elapsedMs: 0 });
function step(state: GameState, r: RuleSetVersion, action: GameAction, parent = 'S0', history = new Map<string, GameState>()) {
  const result = stepGame(state, r, action, parent, state.rng, id => history.get(id));
  if (!result.accepted) throw new Error(result.reason);
  return result.state;
}
const values = (state: GameState) => state.world.board.cells.map(cell => cell.tile?.value ?? null);

test.each([
  ['/board/rows', (d: RuleDefinition) => { d.board.rows = 65; }],
  ['/board/initialLayout', (d: RuleDefinition) => { d.board.initialLayout = [{ index: 0, value: '2' }, { index: 0, value: '4' }]; }],
  ['/spawn/initialWeights', (d: RuleDefinition) => { d.spawn.initialWeights = [{ value: '2', weight: 0 }]; }],
  ['/spawn/weights', (d: RuleDefinition) => { d.spawn.weights = [{ value: '2', weight: 0xffffffff }, { value: '4', weight: 1 }]; }],
  ['/spawn/weights', (d: RuleDefinition) => { d.spawn.weights.push({ value: '2', weight: 1 }); }],
  ['/skills/undo/initialCharges', (d: RuleDefinition) => { d.skills.undo.initialCharges = 4; }],
  ['/timer/mode', (d: RuleDefinition) => { d.timer.mode = 'elapsed'; }],
] as const)('configuration rejects invalid %s before a match exists', (path, change) => {
  const d = sandboxDefinition(); change(d);
  expect(validateDefinition(d).some(issue => issue.severity === 'error' && issue.path.startsWith(path))).toBe(true);
});

test('zero generation permits unused zero distributions and warnings do not prevent special play', async () => {
  const r = await rule(d => { d.spawn.initialWeights = []; d.spawn.weights = [{ value: '0', weight: 0 }]; d.movement.directions = []; d.goals.tileValue = null; });
  expect(validateDefinition(r.definition).filter(issue => issue.severity === 'error')).toEqual([]);
  expect(validateDefinition(r.definition).filter(issue => issue.severity === 'warning').length).toBeGreaterThan(0);
  expect(createInitialState(r, seed).world.board.cells).toHaveLength(4);
});

test('capability declarations stay enforced as custom sequences become available', async () => {
  const r = await rule(); r.requiredCapabilities = ['core-v1']; expect(() => assertSupportedRule(r)).toThrow(/声明/);
  r.requiredCapabilities.push('sandbox-v1', 'skills-v1', 'scripts-v99'); expect(() => assertSupportedRule(r)).toThrow(/scripts-v99/);
  const d = sandboxDefinition(); d.numbers.sequence = 'custom'; d.numbers.customSequence = ['1', '3'];
  expect(validateDefinition(d).some(issue => issue.severity === 'error')).toBe(false);
});

test('explicit initial placement is retained and only the missing count is generated', async () => {
  const r = await rule(d => { d.board.rows = 2; d.board.cols = 3; d.spawn.initialCount = 5; d.spawn.initialWeights = [{ value: '0', weight: 1 }]; });
  const state = createInitialState(r, seed);
  expect(state.world.board).toMatchObject({ rows: 2, cols: 3 });
  expect(values(state).slice(0, 3)).toEqual(['2', '2', '4']);
  expect(values(state).filter(value => value === '0')).toHaveLength(2);
  expect(state.ledger.effectiveActionCount).toBe(0);
});

test('fill-available and skip-batch limit actual generation, including a singleton with no RNG draws', async () => {
  const fill = await rule(d => { d.spawn.initialCount = 6; d.spawn.initialWeights = [{ value: '3', weight: 1 }]; });
  const a = createInitialState(fill, seed); expect(values(a)).toEqual(['2', '2', '4', '3']); expect(a.rng).toEqual(seed);
  const skip = await rule(d => { d.spawn.initialCount = 6; d.spawn.emptyStrategy = 'skip-batch'; d.spawn.initialWeights = []; });
  const b = createInitialState(skip, seed); expect(values(b)).toEqual(['2', '2', '4', null]); expect(b.rng).toEqual(seed);
});

test.each([
  ['left', ['4', '4', null, '8', null, null]], ['right', [null, '4', '4', null, null, '8']],
  ['up', ['2', '2', '8', '4', null, null]], ['down', ['2', null, null, '4', '2', '8']],
] as const)('rectangular movement settles %s in stable order', async (direction, expected) => {
  const r = await rule(d => { d.board.rows = 2; d.board.cols = 3; d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '2' }, { index: 2, value: '4' }, { index: 3, value: '4' }, { index: 5, value: '4' }]; });
  expect(values(step(createInitialState(r, seed), r, move(direction)))).toEqual(expected);
});

test('zero tiles are occupied and equal non-power values merge with exact multiplied scores', async () => {
  const r = await rule(d => { d.board.initialLayout = [{ index: 0, value: '0' }, { index: 1, value: '0' }, { index: 2, value: '3' }, { index: 3, value: '3' }]; d.score.multiplier = 7; });
  const next = step(createInitialState(r, seed), r, move('left'));
  expect(values(next)).toEqual(['0', '6', null, null]); expect(next.world.score).toBe('42'); expect(next.world.mergeCount).toBe(2);
});

test('allowed list constrains initial/manual values but does not truncate merge results', async () => {
  const r = await rule(d => { d.numbers.allowedValues = ['2', '4']; });
  const first = step(createInitialState(r, seed), r, move('left'));
  const next = step(first, r, move('left'), 'S1'); expect(values(next)[0]).toBe('8');
  expect(stepGame(next, r, skill({ skillId: 'spawn', index: 1, value: '3' }), 'S2').accepted).toBe(false);
});

test('disabled directions and ignored inputs preserve all state; advance-round explicitly charges and generates', async () => {
  const r = await rule(d => { d.board.initialLayout = [{ index: 0, value: '2' }]; d.movement.directions = ['left']; });
  const initial = createInitialState(r, seed), before = canonicalJson(initial);
  expect(stepGame(initial, r, move('right'), 'S0').accepted).toBe(false);
  expect(stepGame(initial, r, move('left'), 'S0').accepted).toBe(false); expect(canonicalJson(initial)).toBe(before);
  const advancing = await rule(d => { d.board.initialLayout = [{ index: 0, value: '2' }]; d.movement.invalidMovePolicy = 'advance-round'; d.spawn.perActionCount = 1; });
  const next = step(createInitialState(advancing, seed), advancing, move('left'));
  expect(next.ledger.effectiveActionCount).toBe(1); expect(next.world.roundCount).toBe(1); expect(values(next).filter(value => value !== null)).toHaveLength(2);
});

test('consecutive undo restores world while current charges, charged turns, usage and RNG never rewind', async () => {
  const r = await rule(), s0 = createInitialState(r, seed), s1 = step(s0, r, move('left'));
  const history = new Map([['S0', s0], ['S1', s1]]);
  const result = stepGame(s1, r, move('left'), 'S1', seedPcg32(99n, 77n), id => history.get(id));
  if (!result.accepted) throw new Error(result.reason); const s2 = result.state;
  history.set('S2', s2); const before = canonicalJson([...history]);
  const u1 = step(s2, r, skill({ skillId: 'undo', targetNodeId: 'S1' }), 'S2', history); history.set('U1', u1);
  expect(u1.world).toEqual(s1.world); expect(u1.ledger).toMatchObject({ effectiveActionCount: 3, chargedTurnCount: 2, skills: { undo: { charges: 2, usedCount: 1 } } });
  expect(u1.rng).toEqual(s2.rng); expect(u1.rng).not.toEqual(s1.rng); expect(u1.undoStack).toEqual(['S0']);
  const u2 = step(u1, r, skill({ skillId: 'undo', targetNodeId: 'S0' }), 'U1', history);
  expect(u2.world).toEqual(s0.world); expect(u2.ledger.effectiveActionCount).toBe(4); expect(u2.ledger.chargedTurnCount).toBe(2);
  expect(u2.ledger.skills.undo).toMatchObject({ charges: 1, usedCount: 2 }); expect(u2.undoStack).toEqual([]);
  history.delete('U1'); expect(canonicalJson([...history])).toBe(before);
});

test('undo checks cost against restored score and rejects a forged target without consuming resources', async () => {
  const r = await rule(d => { d.skills.undo.scoreCost = '5'; });
  const s0 = createInitialState(r, seed), s1 = step(s0, r, move('left')), s2 = step(s1, r, move('left'), 'S1');
  const history = new Map([['S0', s0], ['S1', s1]]), before = canonicalJson(s2);
  const rejected = stepGame(s2, r, skill({ skillId: 'undo', targetNodeId: 'S1' }), 'S2', seed, id => history.get(id));
  expect(rejected).toMatchObject({ accepted: false, reason: expect.stringContaining('恢复后') }); expect(canonicalJson(s2)).toBe(before);
  const free = await rule(); const a = createInitialState(free, seed), b = step(a, free, move('left'));
  expect(stepGame(b, free, skill({ skillId: 'undo', targetNodeId: 'other' }), 'S1', seed, id => id === 'S0' ? a : undefined).accepted).toBe(false);
});

test('cooldown and recharge use the current charged-turn ledger across world restoration', async () => {
  const r = await rule(d => { d.skills.undo.cooldownTurns = 2; d.skills.undo.rechargeEveryTurns = 2; });
  const s0 = createInitialState(r, seed), s1 = step(s0, r, move('left')), s2 = step(s1, r, move('left'), 'S1');
  const history = new Map([['S0', s0], ['S1', s1], ['S2', s2]]);
  const u = step(s2, r, skill({ skillId: 'undo', targetNodeId: 'S1' }), 'S2', history);
  expect(u.world.roundCount).toBe(1); expect(u.ledger.chargedTurnCount).toBe(2); expect(u.ledger.skills.undo).toMatchObject({ charges: 2, cooldownRemaining: 2, rechargeProgress: 0 });
  const n1 = step(u, r, move('right'), 'U1'); expect(n1.ledger.skills.undo.cooldownRemaining).toBe(1);
  const n2 = step(n1, r, move('left'), 'N1'); expect(n2.ledger.skills.undo).toMatchObject({ charges: 3, cooldownRemaining: 0, rechargeProgress: 0 });
  expect(n2.ledger.chargedTurnCount).toBe(4);
});

test.each([
  [{ skillId: 'delete', index: 0 }, [null, '2', '4', null]],
  [{ skillId: 'swap', firstIndex: 0, secondIndex: 3 }, [null, '2', '4', '2']],
  [{ skillId: 'upgrade', index: 2 }, ['2', '2', '8', null]],
  [{ skillId: 'downgrade', index: 2 }, ['2', '2', '2', null]],
  [{ skillId: 'spawn', index: 3, value: '0' }, ['2', '2', '4', '0']],
  [{ skillId: 'clear-line', axis: 'column', index: 1 }, ['2', null, '4', null]],
  [{ skillId: 'rotate', degrees: 180 }, [null, '4', '2', '2']],
] as const)('skill %j settles atomically, charges once and remains undoable', async (payload, expected) => {
  const r = await rule(), initial = createInitialState(r, seed), before = canonicalJson(initial);
  const next = step(initial, r, skill(payload)); expect(values(next)).toEqual(expected);
  expect(next.ledger.effectiveActionCount).toBe(1); expect(next.ledger.chargedTurnCount).toBe(1); expect(next.world.roundCount).toBe(1);
  expect(next.ledger.skills[payload.skillId]).toMatchObject({ charges: 2, usedCount: 1 }); expect(next.world.score).toBe('0');
  expect(next.undoStack).toEqual(['S0']); expect(canonicalJson(initial)).toBe(before);
  const undo = step(next, r, skill({ skillId: 'undo', targetNodeId: 'S0' }), 'S1', new Map([['S0', initial]]));
  expect(undo.world).toEqual(initial.world); expect(undo.ledger.skills[payload.skillId].charges).toBe(2);
});

test('shuffle is deterministic, preserves tiles and empty spaces, and identical results still charge', async () => {
  const r = await rule(), initial = createInitialState(r, seed), action = skill({ skillId: 'shuffle', indices: [0, 1, 2, 3] });
  const a = step(initial, r, action), b = step(initial, r, action);
  expect(a).toEqual(b); expect(values(a).slice().sort()).toEqual(values(initial).slice().sort()); expect(a.ledger.skills.shuffle.charges).toBe(2);
  const twin = await rule(d => { d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '2' }]; d.board.cols = 2; });
  const t0 = createInitialState(twin, seed), t1 = step(t0, twin, skill({ skillId: 'shuffle', indices: [0, 1] }));
  expect(values(t1)).toEqual(values(t0)); expect(t1.ledger.effectiveActionCount).toBe(1);
});

test.each([
  { skillId: 'delete', index: 3 }, { skillId: 'swap', firstIndex: 0, secondIndex: 0 },
  { skillId: 'upgrade', index: 10 }, { skillId: 'spawn', index: 0, value: '2' },
  { skillId: 'clear-line', axis: 'row', index: 5 }, { skillId: 'rotate', degrees: 90 },
  { skillId: 'shuffle', indices: [3] },
] as SkillPayload[])('illegal target %j leaves input, resource and RNG unchanged', async payload => {
  const r = await rule(), initial = createInitialState(r, seed), before = canonicalJson(initial);
  expect(stepGame(initial, r, skill(payload), 'S0').accepted).toBe(false); expect(canonicalJson(initial)).toBe(before);
});

test('unlimited charges still obey cooldown, costs and target restrictions', async () => {
  const r = await rule(d => { d.skills.delete.unlimited = true; d.skills.delete.cooldownTurns = 2; });
  const initial = createInitialState(r, seed), next = step(initial, r, skill({ skillId: 'delete', index: 0 }));
  expect(next.ledger.skills.delete).toMatchObject({ charges: null, usedCount: 1, cooldownRemaining: 2 });
  expect(stepGame(next, r, skill({ skillId: 'delete', index: 1 }), 'S1')).toMatchObject({ accepted: false, reason: expect.stringContaining('冷却') });
});

test('skill spawn-after-use and round triggers produce one batch and own new cooldown is retained', async () => {
  const r = await rule(d => { d.spawn.perActionCount = 1; d.spawn.triggerOn = ['round']; d.skills.delete.spawnAfterUse = true; d.skills.delete.cooldownTurns = 2; });
  const next = step(createInitialState(r, seed), r, skill({ skillId: 'delete', index: 0 }));
  expect(values(next).filter(value => value !== null)).toHaveLength(3); expect(next.ledger.skills.delete.cooldownRemaining).toBe(2);
});

test('failed-board rescue considers enabled resources, costs, legal targets and allow-after-loss', async () => {
  const r = await rule(d => { d.board.rows = 2; d.board.cols = 2; d.board.initialLayout = ['2', '4', '8', '16'].map((value, index) => ({ index, value })); d.goals.lossWhenNoMoves = true; d.skills.delete.allowAfterLoss = true; });
  const initial = createInitialState(r, seed); expect(initial.world.outcome).toEqual({ status: 'lost', reason: 'no-moves', canContinue: true });
  const rescued = step(initial, r, skill({ skillId: 'delete', index: 0 })); expect(rescued.world.outcome.status).toBe('playing');
  const locked = await rule(d => { Object.assign(d.board, r.definition.board); d.goals.lossWhenNoMoves = true; });
  expect(createInitialState(locked, seed).world.outcome.canContinue).toBe(false);
});

test('round limit allows a payable undo to lower world rounds without lowering charged turns', async () => {
  const r = await rule(d => { d.goals.roundLimit = 1; }), initial = createInitialState(r, seed), history = new Map([['S0', initial]]);
  const next = step(initial, r, move('left'), 'S0', history); history.set('S1', next);
  expect(next.world.outcome).toEqual({ status: 'lost', canContinue: true, reason: 'round-limit' });
  expect(stepGame(next, r, move('right'), 'S1').accepted).toBe(false);
  const undo = step(next, r, skill({ skillId: 'undo', targetNodeId: 'S0' }), 'S1', history);
  expect(undo.world.roundCount).toBe(0); expect(undo.ledger.chargedTurnCount).toBe(1); expect(undo.world.outcome.status).toBe('playing');
});

test('all goals, no goals and stop-after-win apply after settlement and retain first win', async () => {
  const r = await rule(d => { d.goals.tileValue = '8'; d.goals.scoreTarget = '4'; d.goals.winPolicy = 'all'; d.goals.continueAfterWin = false; });
  const a = step(createInitialState(r, seed), r, move('left')); expect(a.world.goals.achieved).toEqual(['score']); expect(a.world.outcome.status).toBe('playing');
  const b = step(a, r, move('left'), 'S1'); expect(b.world.goals.achieved).toEqual(['score', 'tile']); expect(b.world.outcome).toMatchObject({ status: 'won', canContinue: false });
  expect(b.world.goals.firstWinLogicalMs).toBe(0); expect(stepGame(b, r, skill({ skillId: 'delete', index: 0 }), 'S2').accepted).toBe(false);
  const endless = await rule(d => { d.goals.tileValue = null; d.goals.scoreTarget = null; }); expect(step(createInitialState(endless, seed), endless, move('left')).world.outcome.status).toBe('playing');
});

test('budget overflow rejects an entire operation before input changes', async () => {
  const r = await rule(d => { d.numbers.maxDigits = 1; d.board.initialLayout = [{ index: 0, value: '8' }, { index: 1, value: '8' }]; });
  const initial = createInitialState(r, seed), before = canonicalJson(initial);
  expect(() => step(initial, r, move('left'))).toThrow(/位数/); expect(canonicalJson(initial)).toBe(before);
  expect(stepGame(initial, r, skill({ skillId: 'upgrade', index: 0 }), 'S0').accepted).toBe(false);
});
