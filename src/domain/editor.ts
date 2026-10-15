import type { Condition, EventRule, RuleDefinition } from './types';

export function rectangleIndices(rows: number, cols: number, first: number, last: number): number[] {
  if (![rows, cols].every(value => Number.isSafeInteger(value) && value > 0) || ![first, last].every(value => Number.isSafeInteger(value) && value >= 0 && value < rows * cols)) throw new Error('编辑区域越界');
  const top = Math.min(Math.floor(first / cols), Math.floor(last / cols)), bottom = Math.max(Math.floor(first / cols), Math.floor(last / cols));
  const left = Math.min(first % cols, last % cols), right = Math.max(first % cols, last % cols), indices: number[] = [];
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) indices.push(row * cols + col);
  return indices;
}

function mapCondition(condition: Condition | null, source: 'variable' | 'event-count', from: string, to: string): void {
  if (!condition) return;
  if (condition.kind === 'all' || condition.kind === 'any') condition.children.forEach(child => mapCondition(child, source, from, to));
  else if (condition.kind === 'not') mapCondition(condition.child, source, from, to);
  else if (condition.source === source && condition.reference === from) condition.reference = to;
}
export function renameVariable(input: RuleDefinition, from: string, to: string): RuleDefinition {
  if (!Object.hasOwn(input.variables, from)) throw new Error('变量不存在');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(to) || ['constructor', 'prototype', '__proto__'].includes(to)) throw new Error('变量名需为 1–64 个字母、数字或下划线，首位不能为数字，且不能使用保留名');
  if (from !== to && Object.hasOwn(input.variables, to)) throw new Error('变量名称已存在，原变量和引用均未修改');
  const copy = structuredClone(input);
  copy.variables = Object.fromEntries(Object.entries(copy.variables).map(([key, value]) => [key === from ? to : key, value]));
  for (const phase of copy.spawn.phaseRules) mapCondition(phase.condition, 'variable', from, to);
  for (const event of copy.events) {
    mapCondition(event.condition, 'variable', from, to);
    for (const action of event.actions) if ((action.type === 'set-variable' || action.type === 'add-variable') && action.name === from) action.name = to;
  }
  return copy;
}
export function copyEvent(input: EventRule, id: string): EventRule {
  const copy = structuredClone(input); copy.id = id; copy.name += '副本';
  mapCondition(copy.condition, 'event-count', input.id, id); return copy;
}
export const conditionSources = { score: '节点成绩', round: '世界回合', 'effective-actions': '有效操作数', 'merge-count': '合并次数', 'empty-count': '空格数量', variable: '变量', 'event-count': '事件执行次数' };
export const conditionOperators = { eq: '等于', ne: '不等于', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于' };
export function describeCondition(condition: Condition | null, definition: RuleDefinition): string {
  if (!condition) return '总是满足';
  if (condition.kind === 'all' || condition.kind === 'any') return `（${condition.children.map(child => describeCondition(child, definition)).join(condition.kind === 'all' ? ' 且 ' : ' 或 ')}）`;
  if (condition.kind === 'not') return `非（${describeCondition(condition.child, definition)}）`;
  const reference = condition.source === 'event-count' ? definition.events.find(event => event.id === condition.reference)?.name ?? '未选事件' : condition.reference ?? '';
  return `${conditionSources[condition.source]}${reference ? ` ${reference}` : ''} ${conditionOperators[condition.operator]} ${condition.value}`;
}
