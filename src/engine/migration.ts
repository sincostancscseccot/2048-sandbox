import { canonicalJson } from '../domain/hash';
import type { BoardEditAction, GameState, RuleSetVersion } from '../domain/types';
import { skillIds } from '../domain/types';
import { assertCoreState } from '../domain/validation';
import { assertSupportedRule } from '../presets/rules';
import { initialEvents } from './events';

export interface ResizePreview { state: GameState; overflow: { index: number; value: string }[]; moved: number; dropped: number }
export function migrateState(input: GameState, previous: RuleSetVersion, next: RuleSetVersion, policy: 'cancel' | 'drop' | 'pack'): ResizePreview {
  assertSupportedRule(next); assertCoreState(input, previous);
  if (next.definition.mode !== 'custom' || (next.id === previous.id && next.version <= previous.version)) throw new Error('修改规则必须派生新的自定义版本');
  const state = structuredClone(input), before = input.world.board, { rows, cols } = next.definition.board;
  const cells: GameState['world']['board']['cells'] = Array.from({ length: rows * cols }, () => ({ tile: null }));
  const overflow: ResizePreview['overflow'] = [];
  for (const [index, cell] of before.cells.entries()) {
    if (!cell.tile) continue;
    if (cell.tile.value.length > next.definition.numbers.maxDigits) throw new Error('现有数字超过新位数预算，请先编辑数字或提高预算');
    const row = Math.floor(index / before.cols), col = index % before.cols;
    if (row < rows && col < cols) cells[row * cols + col] = structuredClone(cell);
    else overflow.push({ index, value: cell.tile.value });
  }
  if (overflow.length && policy === 'cancel') throw new Error(`缩小棋盘会影响 ${overflow.length} 个数字，请选择搬移或明确丢弃`);
  if (policy === 'pack') {
    const empty = cells.flatMap((cell, index) => cell.tile === null ? [index] : []);
    if (empty.length < overflow.length) throw new Error('搬移空间不足，规则修改未提交');
    overflow.forEach((item, index) => { cells[empty[index]!] = structuredClone(before.cells[item.index]!); });
  }
  state.world.board = { rows, cols, cells };
  state.ruleRef = { id: next.id, version: next.version }; state.undoStack = [];
  for (const id of skillIds) {
    const config = next.definition.skills[id], resource = state.ledger.skills[id];
    resource.charges = config.unlimited ? null : resource.charges === null ? config.initialCharges : Math.min(resource.charges, config.maxCharges);
    resource.cooldownRemaining = Math.min(resource.cooldownRemaining, config.cooldownTurns);
    resource.rechargeProgress = config.rechargeEveryTurns === null ? 0 : resource.rechargeProgress % config.rechargeEveryTurns;
  }
  const oldEvents = state.world.events, events = initialEvents(next);
  for (const event of next.definition.events) if (Object.hasOwn(oldEvents.counters, event.id)) { events.counters[event.id] = oldEvents.counters[event.id]!; events.cooldowns![event.id] = Math.min(oldEvents.cooldowns?.[event.id] ?? 0, event.cooldownTurns); }
  for (const key of Object.keys(events.variables)) if (Object.hasOwn(oldEvents.variables, key)) events.variables[key] = oldEvents.variables[key]!;
  state.world.events = events;
  if (canonicalJson(previous.definition.goals) !== canonicalJson(next.definition.goals)) state.world.goals = { achieved: [], firstWinLogicalMs: null };
  assertCoreState(state, next);
  return { state, overflow, moved: policy === 'pack' ? overflow.length : 0, dropped: policy === 'drop' ? overflow.length : 0 };
}

export function applyBoardEdit(state: GameState, rule: RuleSetVersion, action: BoardEditAction, parentId: string): boolean {
  if (!rule.requiredCapabilities.includes('editing-v1')) throw new Error('编辑棋盘需要派生支持 editing-v1 的规则');
  const seen = new Set<number>(); let changed = false;
  for (const patch of action.payload.patches) {
    if (patch.index >= state.world.board.cells.length || seen.has(patch.index)) throw new Error('编辑格子越界或重复');
    seen.add(patch.index);
    if (patch.value !== null && (patch.value.length > rule.definition.numbers.maxDigits || (rule.definition.numbers.allowedValues !== null && !rule.definition.numbers.allowedValues.includes(patch.value)))) throw new Error('编辑数字超出预算或不在允许列表中');
    if ((state.world.board.cells[patch.index]!.tile?.value ?? null) === patch.value) continue;
    changed = true; state.world.board.cells[patch.index] = { tile: patch.value === null ? null : { id: `t-ed-${parentId.slice(-64)}-${state.ledger.effectiveActionCount + 1}-${patch.index}`, value: patch.value, attributes: {} } };
  }
  return changed;
}
