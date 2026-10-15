import type { Condition, GameState, RuleDefinition } from './types';

export function ordered<T extends { id: string; priority: number }>(items: T[], order: string[] = []): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return items.slice().sort((a, b) => b.priority - a.priority || (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function mergeValue(left: string, right: string, definition: RuleDefinition): string | null {
  if (definition.merge.kind === 'equal-sum') return left === right ? (BigInt(left) + BigInt(right)).toString() : null;
  if (definition.merge.kind === 'mapping') {
    const match = ordered(definition.merge.mappings, definition.merge.ruleOrder).find(item => (item.left === left && item.right === right) || (!item.directional && item.left === right && item.right === left));
    return match?.result ?? null;
  }
  const sequence = definition.numbers.customSequence, a = sequence.indexOf(left), b = sequence.indexOf(right);
  if (a === 0 && b === 0) return sequence[1] ?? null;
  return a >= 0 && b >= 0 && Math.abs(a - b) === 1 ? sequence[Math.max(a, b) + 1] ?? null : null;
}
export function conditionMatches(condition: Condition | null, state: GameState): boolean {
  if (condition === null) return true;
  if (condition.kind === 'all') return condition.children.every(child => conditionMatches(child, state));
  if (condition.kind === 'any') return condition.children.some(child => conditionMatches(child, state));
  if (condition.kind === 'not') return !conditionMatches(condition.child, state);
  let current: string | number;
  switch (condition.source) {
    case 'score': current = state.world.score; break;
    case 'round': current = state.world.roundCount; break;
    case 'effective-actions': current = state.ledger.effectiveActionCount; break;
    case 'merge-count': current = state.world.mergeCount; break;
    case 'empty-count': current = state.world.board.cells.filter(cell => cell.tile === null).length; break;
    case 'variable': current = state.world.events.variables[condition.reference!] ?? '0'; break;
    case 'event-count': current = state.world.events.counters[condition.reference!] ?? 0; break;
  }
  const a = BigInt(current), b = BigInt(condition.value);
  switch (condition.operator) {
    case 'eq': return a === b; case 'ne': return a !== b; case 'gt': return a > b; case 'gte': return a >= b; case 'lt': return a < b; case 'lte': return a <= b;
  }
}
