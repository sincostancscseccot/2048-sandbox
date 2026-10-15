import type { Cell, Direction, GameAction, GameState, RngState, RuleSetVersion, SkillId, SkillPayload, SkillState, StateLookup, Tile, Weight } from '../domain/types';
import { skillIds } from '../domain/types';
import { assertContract, assertCoreState } from '../domain/validation';
import { assertSupportedRule } from '../presets/rules';
import { Pcg32 } from '../random/pcg32';
import { canonicalJson } from '../domain/hash';
import { conditionMatches, mergeValue, ordered } from '../domain/advanced';
import { EventSettlement, initialEvents } from './events';
import { applyBoardEdit, migrateState } from './migration';

export type StepResult = { accepted: true; state: GameState; scoreDelta: string; merges: number } | { accepted: false; reason: string };
const directions: Direction[] = ['up', 'right', 'down', 'left'];
export function increment(value: number): number {
  if (!Number.isSafeInteger(value + 1)) throw new Error('操作计数达到上限，本步未提交');
  return value + 1;
}
function lineIndices(direction: Direction, line: number, rows: number, cols: number): number[] {
  return Array.from({ length: direction === 'left' || direction === 'right' ? cols : rows }, (_, offset) => {
    if (direction === 'left') return line * cols + offset;
    if (direction === 'right') return line * cols + cols - 1 - offset;
    if (direction === 'up') return offset * cols + line;
    return (rows - 1 - offset) * cols + line;
  });
}
export function hasMoves(cells: Cell[], rows = 4, cols = 4, allowed = directions, rule?: RuleSetVersion): boolean {
  for (const direction of allowed) {
    for (let line = 0; line < (direction === 'left' || direction === 'right' ? rows : cols); line++) {
      const indices = lineIndices(direction, line, rows, cols), occupied = indices.filter(index => cells[index]?.tile);
      if (occupied.some((index, i) => index !== indices[i])) return true;
      if (occupied.some((index, i) => i > 0 && (rule ? mergeValue(cells[occupied[i - 1]!]!.tile!.value, cells[index]!.tile!.value, rule.definition) !== null : cells[index]!.tile!.value === cells[occupied[i - 1]!]!.tile!.value))) return true;
    }
  }
  return false;
}
function spawn(cells: Cell[], rng: Pcg32, count: number, weights: Weight[], strategy: string, key: string, rule: RuleSetVersion): void {
  const weighted = rule.definition.spawn.positionStrategy === 'weighted';
  const positions = new Map(rule.definition.spawn.positionWeights.map(item => [item.index, item.weight]));
  const empty = cells.flatMap((cell, index) => cell.tile === null && (!weighted || (positions.get(index) ?? 0) > 0) ? [index] : []);
  if (strategy === 'skip-batch' && empty.length < count) return;
  const amount = Math.min(count, empty.length);
  if (!amount) return;
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  if (!total || total > 0xffffffff) throw new Error('生成权重无效，本步未提交');
  for (let i = 0; i < amount; i++) {
    let choice = rng.bounded(total), value = '';
    for (const item of weights) { if (choice < item.weight) { value = item.value; break; } choice -= item.weight; }
    let position: number;
    if (!weighted) position = rng.bounded(empty.length);
    else { let sample = rng.bounded(empty.reduce((sum, index) => sum + positions.get(index)!, 0)); position = 0; while (sample >= positions.get(empty[position]!)!) { sample -= positions.get(empty[position]!)!; position++; } }
    const index = empty[position]!;
    empty.splice(position, 1);
    cells[index] = { tile: { id: `t-s-${key}-${i}-${index}`, value, attributes: {} } };
  }
}
export function createInitialState(rule: RuleSetVersion, randomInput: RngState): GameState {
  assertSupportedRule(rule);
  const d = rule.definition, rng = new Pcg32(randomInput);
  const cells: Cell[] = Array.from({ length: d.board.rows * d.board.cols }, () => ({ tile: null }));
  for (const item of d.board.initialLayout) cells[item.index] = { tile: { id: `t-i-${item.index}`, value: item.value, attributes: {} } };
  spawn(cells, rng, Math.max(0, d.spawn.initialCount - d.board.initialLayout.length), d.spawn.initialWeights, d.spawn.emptyStrategy, `root-${randomInput.state}-${randomInput.increment}`, rule);
  const skills = Object.fromEntries(skillIds.map(id => [id, {
    charges: d.skills[id].unlimited ? null : d.skills[id].initialCharges, cooldownRemaining: 0, usedCount: 0, rechargeProgress: 0,
  } satisfies SkillState])) as GameState['ledger']['skills'];
  const state: GameState = {
    schemaVersion: 1, ruleRef: { id: rule.id, version: rule.version },
    world: {
      board: { rows: d.board.rows, cols: d.board.cols, cells }, score: '0', roundCount: 0, mergeCount: 0,
      goals: { achieved: [], firstWinLogicalMs: null }, outcome: { status: 'playing', canContinue: true, reason: null },
      events: initialEvents(rule),
      clock: { mode: 'none', logicalElapsedMs: 0, remainingMs: null, statusAtCommit: 'paused' },
    }, ledger: { effectiveActionCount: 0, chargedTurnCount: 0, skills }, rng: rng.snapshot(), undoStack: [],
  };
  updateOutcome(state, rule);
  assertCoreState(state, rule); return state;
}

export function assertRootState(state: GameState, rule: RuleSetVersion): void {
  assertCoreState(state, rule);
  const d = rule.definition, placed = d.board.initialLayout.length, placements = new Set(d.board.initialLayout.map(item => item.index));
  const available = state.world.board.cells.reduce((count, _, index) => count + Number(!placements.has(index) && (d.spawn.positionStrategy !== 'weighted' || d.spawn.positionWeights.some(item => item.index === index && item.weight > 0))), 0);
  const requested = Math.max(0, d.spawn.initialCount - placed);
  const generated = d.spawn.emptyStrategy === 'skip-batch' && requested > available ? 0 : Math.min(requested, available);
  if (state.world.score !== '0' || state.world.roundCount !== 0 || state.world.mergeCount !== 0 || state.ledger.effectiveActionCount !== 0 || state.ledger.chargedTurnCount !== 0 || state.undoStack.length || state.world.board.cells.filter(cell => cell.tile).length !== placed + generated) throw new Error('根节点状态无效');
  for (const item of d.board.initialLayout) if (state.world.board.cells[item.index]!.tile?.value !== item.value) throw new Error('根节点与初始布局不一致');
  for (const [index, cell] of state.world.board.cells.entries()) if (cell.tile && !placements.has(index) && !d.spawn.initialWeights.some(item => item.value === cell.tile!.value && item.weight > 0)) throw new Error('根节点包含分布外的初始数字');
  if (d.spawn.positionStrategy === 'weighted' && state.world.board.cells.some((cell, index) => cell.tile && !placements.has(index) && !d.spawn.positionWeights.some(item => item.index === index && item.weight > 0))) throw new Error('根节点数字不在允许的生成位置');
  for (const id of skillIds) {
    const resource = state.ledger.skills[id], config = d.skills[id];
    if (resource.charges !== (config.unlimited ? null : config.initialCharges) || resource.usedCount !== 0 || resource.cooldownRemaining !== 0 || resource.rechargeProgress !== 0) throw new Error('根节点技能资源无效');
  }
  if (canonicalJson(state.world.events) !== canonicalJson(initialEvents(rule))) throw new Error('根节点事件状态无效');
  const copy = structuredClone(state); copy.world.goals = { achieved: [], firstWinLogicalMs: null }; updateOutcome(copy, rule);
  if (canonicalJson(copy.world.goals) !== canonicalJson(state.world.goals) || canonicalJson(copy.world.outcome) !== canonicalJson(state.world.outcome)) throw new Error('根节点目标或结局无效');
}
export function skillResourceReason(state: GameState, rule: RuleSetVersion, id: SkillId, lookup: StateLookup = () => undefined): string | null {
  const config = rule.definition.skills[id], resource = state.ledger.skills[id];
  if (!config.enabled) return '此技能未启用';
  if (state.world.outcome.status === 'won' && !rule.definition.goals.continueAfterWin) return '本局已达成目标并结束';
  if (state.world.outcome.status === 'lost' && (!config.allowAfterLoss || !rule.definition.goals.allowRescueSkills)) return '本局结束后不允许使用此技能';
  if (!config.unlimited && (resource.charges ?? 0) <= 0) return '技能次数不足';
  if (resource.cooldownRemaining > 0) return `还需 ${resource.cooldownRemaining} 个计费回合冷却`;
  const target = id === 'undo' ? lookup(state.undoStack.at(-1) ?? '') : state;
  if (!target) return '没有可撤销的操作';
  if (id === 'undo' && (target.ruleRef.id !== state.ruleRef.id || target.ruleRef.version !== state.ruleRef.version)) return '不能跨规则版本撤销';
  const limit = rule.definition.goals.roundLimit;
  if (limit !== null && state.world.roundCount >= limit && (id !== 'undo' || target.world.roundCount + Number(config.advanceRound) >= limit)) return '已到回合上限，只有恢复到上限前的撤销可继续';
  if (BigInt(target.world.score) < BigInt(config.scoreCost)) return id === 'undo' ? '恢复后的成绩不足以支付撤销成本' : '成绩不足以支付技能成本';
  return null;
}
function effect(state: GameState, rule: RuleSetVersion, payload: SkillPayload, rng: Pcg32, key: string, lookup: StateLookup): string | null {
  const board = state.world.board, cells = board.cells;
  const validIndex = (index: number) => Number.isInteger(index) && index >= 0 && index < cells.length;
  switch (payload.skillId) {
    case 'undo': {
      if (state.undoStack.at(-1) !== payload.targetNodeId) return '撤销目标必须是最近的可撤销操作';
      const target = lookup(payload.targetNodeId);
      if (!target || target.ruleRef.id !== state.ruleRef.id || target.ruleRef.version !== state.ruleRef.version) return '撤销目标缺失或规则版本不同';
      state.world = structuredClone(target.world); state.undoStack.pop(); return null;
    }
    case 'delete':
      if (!validIndex(payload.index) || !cells[payload.index]!.tile) return '请选择一个非空格';
      cells[payload.index] = { tile: null }; return null;
    case 'swap': {
      const { firstIndex: a, secondIndex: b } = payload;
      if (!validIndex(a) || !validIndex(b) || a === b || (!cells[a]!.tile && !cells[b]!.tile)) return '请选择两个不同格子，至少一个有数字';
      [cells[a], cells[b]] = [cells[b]!, cells[a]!]; return null;
    }
    case 'upgrade': case 'downgrade': {
      if (!validIndex(payload.index) || !cells[payload.index]!.tile) return '请选择一个非空格';
      const tile = cells[payload.index]!.tile!, value = BigInt(tile.value);
      const sequence = rule.definition.numbers.sequence === 'custom' ? rule.definition.numbers.customSequence : null;
      if (!sequence && payload.skillId === 'upgrade' && value === 0n) return '0 无法通过乘 2 升级';
      if (!sequence && payload.skillId === 'downgrade' && (value < 2n || value % 2n !== 0n)) return '降级要求不小于 2 的偶数';
      const cursor = sequence?.indexOf(tile.value) ?? -1;
      const next = sequence ? cursor < 0 ? undefined : sequence[cursor + (payload.skillId === 'upgrade' ? 1 : -1)] : (payload.skillId === 'upgrade' ? value * 2n : value / 2n).toString();
      if (next === undefined) return '当前数字在数列中没有合法前项或后项';
      if (next.length > rule.definition.numbers.maxDigits) return '升级结果超过数字位数预算';
      cells[payload.index] = { tile: { ...tile, id: `t-k-${key}-${payload.index}`, value: next } }; return null;
    }
    case 'shuffle': {
      const indices = payload.indices;
      if (indices.length < 2 || new Set(indices).size !== indices.length || indices.some(index => !validIndex(index)) || !indices.some(index => cells[index]!.tile)) return '洗牌需至少两个合法格子，且包含一个数字';
      for (let i = indices.length - 1; i > 0; i--) {
        const a = indices[i]!, b = indices[rng.bounded(i + 1)]!;
        [cells[a], cells[b]] = [cells[b]!, cells[a]!];
      }
      return null;
    }
    case 'spawn': {
      if (!validIndex(payload.index) || cells[payload.index]!.tile) return '请选择一个空格';
      const numbers = rule.definition.numbers;
      if (!/^(0|[1-9][0-9]*)$/.test(payload.value) || payload.value.length > numbers.maxDigits || (numbers.allowedValues !== null && !numbers.allowedValues.includes(payload.value))) return '放置数字超出预算或不在允许列表中';
      cells[payload.index] = { tile: { id: `t-k-${key}-${payload.index}`, value: payload.value, attributes: {} } }; return null;
    }
    case 'clear-line': {
      const limit = payload.axis === 'row' ? board.rows : board.cols;
      if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index >= limit) return '行列索引越界';
      const indices = cells.flatMap((_, index) => (payload.axis === 'row' ? Math.floor(index / board.cols) : index % board.cols) === payload.index ? [index] : []);
      if (!indices.some(index => cells[index]!.tile)) return '这一行或列已经为空';
      for (const index of indices) cells[index] = { tile: null }; return null;
    }
    case 'rotate': {
      if (payload.degrees !== 180 && board.rows !== board.cols) return '非方形棋盘本阶段仅支持旋转 180°';
      if (!cells.some(cell => cell.tile) || cells.length === 1) return '当前棋盘没有可旋转的内容';
      const before = cells.slice();
      for (let index = 0; index < cells.length; index++) {
        const row = Math.floor(index / board.cols), col = index % board.cols;
        const target = payload.degrees === 180 ? cells.length - 1 - index : payload.degrees === 90 ? col * board.cols + board.cols - 1 - row : (board.rows - 1 - col) * board.cols + row;
        cells[target] = before[index]!;
      }
      return null;
    }
  }
}
function rescuePayload(state: GameState, rule: RuleSetVersion, id: SkillId): SkillPayload | null {
  const cells = state.world.board.cells, occupied = cells.findIndex(cell => cell.tile !== null), empty = cells.findIndex(cell => cell.tile === null);
  switch (id) {
    case 'undo': return state.undoStack.length ? { skillId: id, targetNodeId: state.undoStack.at(-1)! } : null;
    case 'delete': return occupied >= 0 ? { skillId: id, index: occupied } : null;
    case 'upgrade': case 'downgrade': {
      const sequence = rule.definition.numbers.sequence === 'custom' ? rule.definition.numbers.customSequence : null;
      const index = cells.findIndex(cell => cell.tile && (sequence ? sequence.indexOf(cell.tile.value) >= 0 && sequence[sequence.indexOf(cell.tile.value) + (id === 'upgrade' ? 1 : -1)] !== undefined : id === 'upgrade' ? BigInt(cell.tile.value) > 0n && (BigInt(cell.tile.value) * 2n).toString().length <= rule.definition.numbers.maxDigits : BigInt(cell.tile.value) >= 2n && BigInt(cell.tile.value) % 2n === 0n));
      return index >= 0 ? { skillId: id, index } : null;
    }
    case 'swap': return occupied >= 0 && cells.length > 1 ? { skillId: id, firstIndex: occupied, secondIndex: (occupied + 1) % cells.length } : null;
    case 'shuffle': return occupied >= 0 && cells.length > 1 ? { skillId: id, indices: cells.map((_, index) => index) } : null;
    case 'spawn': { const value = rule.definition.numbers.allowedValues?.[0] ?? '2'; return empty >= 0 ? { skillId: id, index: empty, value } : null; }
    case 'clear-line': return occupied >= 0 ? { skillId: id, axis: 'row', index: Math.floor(occupied / state.world.board.cols) } : null;
    case 'rotate': return occupied >= 0 && cells.length > 1 ? { skillId: id, degrees: 180 } : null;
  }
}
function hasRescue(state: GameState, rule: RuleSetVersion, lookup: StateLookup, roundLimit: boolean): boolean {
  if (!rule.definition.goals.allowRescueSkills) return false;
  for (const id of skillIds) {
    if (roundLimit && id !== 'undo') continue;
    if (skillResourceReason(state, rule, id, lookup)) continue;
    const payload = rescuePayload(state, rule, id); if (!payload) continue;
    const copy = structuredClone(state);
    if (effect(copy, rule, payload, new Pcg32(state.rng), 'rescue', lookup)) continue;
    if (roundLimit && copy.world.roundCount + Number(rule.definition.skills[id].advanceRound) >= rule.definition.goals.roundLimit!) continue;
    return true;
  }
  return false;
}
function updateOutcome(state: GameState, rule: RuleSetVersion, lookup: StateLookup = () => undefined): void {
  const d = rule.definition, goals = state.world.goals;
  if (d.goals.tileValue !== null && state.world.board.cells.some(cell => cell.tile && BigInt(cell.tile.value) >= BigInt(d.goals.tileValue!)) && !goals.achieved.includes('tile')) goals.achieved.push('tile');
  if (d.goals.scoreTarget !== null && BigInt(state.world.score) >= BigInt(d.goals.scoreTarget) && !goals.achieved.includes('score')) goals.achieved.push('score');
  const enabled = [d.goals.tileValue === null ? null : 'tile', d.goals.scoreTarget === null ? null : 'score'].filter((id): id is 'tile' | 'score' => id !== null);
  const won = enabled.length > 0 && (d.goals.winPolicy === 'all' ? enabled.every(id => goals.achieved.includes(id)) : enabled.some(id => goals.achieved.includes(id)));
  if (won && goals.firstWinLogicalMs === null) goals.firstWinLogicalMs = state.world.clock.logicalElapsedMs;
  const limited = d.goals.roundLimit !== null && state.world.roundCount >= d.goals.roundLimit;
  const movable = hasMoves(state.world.board.cells, state.world.board.rows, state.world.board.cols, d.movement.directions, rule) || (d.movement.invalidMovePolicy === 'advance-round' && d.movement.directions.length > 0);
  if (limited || (d.goals.lossWhenNoMoves && !movable)) {
    state.world.outcome = { status: 'lost', canContinue: false, reason: limited ? 'round-limit' : 'no-moves' };
    state.world.outcome.canContinue = hasRescue(state, rule, lookup, limited);
  } else state.world.outcome = { status: won ? 'won' : 'playing', canContinue: !won || d.goals.continueAfterWin, reason: won ? (goals.achieved.includes('tile') ? 'tile-goal' : 'score-goal') : null };
}
function chargeTurn(state: GameState, rule: RuleSetVersion, used: SkillId | null): void {
  state.world.roundCount = increment(state.world.roundCount);
  state.ledger.chargedTurnCount = increment(state.ledger.chargedTurnCount);
  for (const key of Object.keys(state.world.events.cooldowns ?? {})) state.world.events.cooldowns![key] = Math.max(0, state.world.events.cooldowns![key]! - 1);
  for (const id of skillIds) {
    const config = rule.definition.skills[id], resource = state.ledger.skills[id];
    if (!config.enabled) continue;
    if (id !== used) resource.cooldownRemaining = Math.max(0, resource.cooldownRemaining - 1);
    if (!config.unlimited && config.rechargeEveryTurns !== null) {
      resource.rechargeProgress = increment(resource.rechargeProgress);
      if (resource.rechargeProgress >= config.rechargeEveryTurns) {
        resource.rechargeProgress = 0;
        resource.charges = resource.charges! + Math.min(config.rechargeAmount, config.maxCharges - resource.charges!);
      }
    }
  }
}
/** Pure atomic settlement; history, entropy, IDs and persistence belong to the caller. */
export function stepGame(input: GameState, rule: RuleSetVersion, action: GameAction, parentNodeId: string,
  randomInput = input.rng, lookup: StateLookup = () => undefined, nextRule?: RuleSetVersion): StepResult {
  assertSupportedRule(rule);
  return settleGame(input, rule, action, parentNodeId, randomInput, lookup, nextRule);
}

/** One immutable rule per verification pass; every state and action is still checked. */
export function createGameStepper(source: RuleSetVersion) {
  const rule = structuredClone(source);
  assertSupportedRule(rule);
  return (input: GameState, action: GameAction, parentNodeId: string, randomInput: RngState = input.rng,
    lookup: StateLookup = () => undefined, nextRule?: RuleSetVersion): StepResult =>
    settleGame(input, rule, action, parentNodeId, randomInput, lookup, nextRule);
}

function settleGame(input: GameState, rule: RuleSetVersion, action: GameAction, parentNodeId: string,
  randomInput: RngState, lookup: StateLookup, nextRule?: RuleSetVersion): StepResult {
  assertCoreState(input, rule); assertContract('Action', action);
  if (action.elapsedMs !== 0) throw new Error('本阶段不支持计时输入');
  if (action.type === 'edit' || action.type === 'rule-edit') {
    const ref = action.payload.nextRuleRef;
    if (ref && (!nextRule || nextRule.id !== ref.id || nextRule.version !== ref.version)) throw new Error('规则修改引用缺失或不一致');
    if (!ref && nextRule) throw new Error('编辑动作缺少新规则引用');
    const targetRule = nextRule ?? rule;
    if (!targetRule.requiredCapabilities.includes('editing-v1')) throw new Error('编辑需要发布支持 editing-v1 的自定义规则');
    const edited = nextRule ? migrateState(input, rule, nextRule, action.type === 'rule-edit' ? action.payload.overflowPolicy : 'cancel').state : structuredClone(input);
    if (action.type === 'edit') {
      if (!applyBoardEdit(edited, targetRule, action, parentNodeId)) return { accepted: false, reason: '棋盘没有变化，未创建节点' };
      if (!nextRule) edited.undoStack.push(parentNodeId);
    }
    edited.ledger.effectiveActionCount = increment(input.ledger.effectiveActionCount);
    new EventSettlement(edited, targetRule, `edit-${edited.ledger.effectiveActionCount}`).dispatch('after-edit');
    updateOutcome(edited, targetRule, lookup); assertCoreState(edited, targetRule);
    return { accepted: true, state: edited, scoreDelta: (BigInt(edited.world.score) - BigInt(input.world.score)).toString(), merges: 0 };
  }
  if (nextRule) throw new Error('普通动作不能更换规则');
  const state = structuredClone(input), count = increment(input.ledger.effectiveActionCount);
  const skill = action.type === 'skill' ? action.payload.skillId : null;
  const before = skill === 'undo' ? input.rng : randomInput, rng = new Pcg32(before);
  const key = `${count}-${action.type === 'move' ? action.payload.direction : skill}-${before.state}-${before.increment}`;
  let merges = 0, score = 0n, advances = true;
  if (action.type === 'move') {
    if (!input.world.outcome.canContinue) return { accepted: false, reason: '这局已结束，可以查看历史或开始新对局' };
    if (input.world.outcome.status === 'lost' && input.world.outcome.reason === 'round-limit') return { accepted: false, reason: '已到回合上限，可使用允许的撤销技能或查看历史' };
    const direction = action.payload.direction, d = rule.definition;
    if (!d.movement.directions.includes(direction)) return { accepted: false, reason: '规则未启用这个移动方向' };
    const { rows, cols } = input.world.board, cells: Cell[] = Array.from({ length: rows * cols }, () => ({ tile: null }));
    for (let line = 0; line < (direction === 'left' || direction === 'right' ? rows : cols); line++) {
      const indices = lineIndices(direction, line, rows, cols), tiles = indices.flatMap(index => input.world.board.cells[index]!.tile ? [input.world.board.cells[index]!.tile!] : []);
      const settled: { tile: Tile; merged: number }[] = [];
      for (let i = 0; i < tiles.length; i++) {
        settled.push({ tile: { ...tiles[i]!, attributes: {} }, merged: 0 });
        while (settled.length > 1) {
          const right = settled.at(-1)!, left = settled.at(-2)!;
          if ((!d.merge.chain && (left.merged || right.merged)) || Math.max(left.merged, right.merged) >= d.merge.maxMergesPerTile) break;
          const value = mergeValue(left.tile.value, right.tile.value, d);
          if (value === null) break;
          if (value.length > d.numbers.maxDigits) throw new Error('数字位数达到上限，本步未提交');
          score += BigInt(value) * BigInt(d.score.multiplier); merges++;
          if (merges > 10000) throw new Error('合并预算已耗尽，本步全部回滚');
          settled.splice(-2, 2, { tile: { id: `t-m-${key}-${indices[settled.length - 2]}`, value, attributes: {} }, merged: Math.max(left.merged, right.merged) + 1 });
        }
      }
      settled.forEach(({ tile }, offset) => { cells[indices[offset]!] = { tile }; });
    }
    const changed = cells.some((cell, i) => cell.tile?.id !== input.world.board.cells[i]!.tile?.id);
    if (!changed && d.movement.invalidMovePolicy === 'ignore') return { accepted: false, reason: '这个方向没有可移动的方块' };
    state.world.board.cells = cells;
    state.world.score = (BigInt(state.world.score) + score).toString(); state.world.mergeCount += merges;
    if (!Number.isSafeInteger(state.world.mergeCount)) throw new Error('合并计数达到上限，本步未提交');
    state.undoStack.push(parentNodeId);
  } else {
    const reason = skillResourceReason(input, rule, action.payload.skillId, lookup);
    if (reason) return { accepted: false, reason };
    const failed = effect(state, rule, action.payload, rng, key, lookup);
    if (failed) return { accepted: false, reason: failed };
    const config = rule.definition.skills[action.payload.skillId], resource = state.ledger.skills[action.payload.skillId];
    state.world.score = (BigInt(state.world.score) - BigInt(config.scoreCost)).toString();
    if (!config.unlimited) resource.charges = resource.charges! - 1;
    resource.usedCount = increment(resource.usedCount);
    advances = config.advanceRound;
    if (skill !== 'undo') state.undoStack.push(parentNodeId);
  }
  state.ledger.effectiveActionCount = count;
  if (advances) chargeTurn(state, rule, skill);
  if (skill) state.ledger.skills[skill].cooldownRemaining = rule.definition.skills[skill].cooldownTurns;
  const events = new EventSettlement(state, rule, key);
  events.dispatch(action.type === 'move' ? 'after-move' : 'after-skill');
  if (merges) events.dispatch('after-merge', merges);
  const triggers = rule.definition.spawn.triggerOn;
  if (action.type === 'move' ? triggers.includes('move') || triggers.includes('round') : rule.definition.skills[action.payload.skillId].spawnAfterUse || (advances && triggers.includes('round'))) {
    events.dispatch('before-spawn');
    const phase = ordered(rule.definition.spawn.phaseRules).find(phase => conditionMatches(phase.condition, state));
    spawn(state.world.board.cells, rng, phase?.count ?? rule.definition.spawn.perActionCount, phase?.weights ?? rule.definition.spawn.weights, rule.definition.spawn.emptyStrategy, key, rule);
    events.dispatch('after-spawn');
  }
  if (advances) events.dispatch('after-round');
  if (state.world.score.length > 4096) throw new Error('成绩位数达到上限，本步未提交');
  state.rng = rng.snapshot(); updateOutcome(state, rule, lookup); assertCoreState(state, rule);
  return { accepted: true, state, scoreDelta: (BigInt(state.world.score) - BigInt(input.world.score)).toString(), merges };
}
