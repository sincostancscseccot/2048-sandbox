import { conditionMatches, ordered } from '../domain/advanced';
import type { EventAction, EventTrigger, GameState, RuleSetVersion } from '../domain/types';

export const eventBudget = 10000;
export function initialEvents(rule: RuleSetVersion): GameState['world']['events'] {
  if (!rule.definition.events.length && !Object.keys(rule.definition.variables).length) return { queue: [], counters: {}, variables: {} };
  return { queue: [], counters: Object.fromEntries(rule.definition.events.map(event => [event.id, 0])),
    variables: { ...rule.definition.variables }, cooldowns: Object.fromEntries(rule.definition.events.map(event => [event.id, 0])) };
}
export class EventSettlement {
  private spent = 0;
  private readonly fired = new Set<string>();
  private readonly rules;
  constructor(private readonly state: GameState, private readonly rule: RuleSetVersion, private readonly key: string) { this.rules = ordered(rule.definition.events); }
  private budget() { if (++this.spent > eventBudget) throw new Error(`事件执行预算 ${eventBudget} 已耗尽，本步全部回滚`); }
  dispatch(trigger: EventTrigger, repeat = 1): void {
    if (!this.rules.length) return;
    const queue: EventTrigger[] = [];
    for (let i = 0; i < repeat; i++) { this.budget(); queue.push(trigger); }
    let cursor = 0;
    while (cursor < queue.length) {
      this.budget(); const hook = queue[cursor++]!;
      for (const event of this.rules) {
        if (event.trigger !== hook || (!event.allowReentry && this.fired.has(event.id)) || (this.state.world.events.cooldowns?.[event.id] ?? 0) > 0 ||
          (event.maxExecutions !== null && this.state.world.events.counters[event.id]! >= event.maxExecutions) || !conditionMatches(event.condition, this.state)) continue;
        this.budget(); this.fired.add(event.id);
        const count = this.state.world.events.counters[event.id]! + 1;
        if (!Number.isSafeInteger(count)) throw new Error('事件计数达到上限，本步全部回滚');
        this.state.world.events.counters[event.id] = count;
        this.state.world.events.cooldowns![event.id] = event.cooldownTurns;
        for (const action of event.actions) {
          this.budget(); this.apply(action);
          if (action.type === 'emit') { if (queue.length - cursor >= 1024) throw new Error('事件队列超过 1024，本步全部回滚'); queue.push(action.trigger); }
        }
      }
    }
  }
  private apply(action: EventAction): void {
    const state = this.state;
    switch (action.type) {
      case 'set-cell': {
        if (action.index >= state.world.board.cells.length) throw new Error('事件格索引越界');
        // The operation sequence and event counters make identity deterministic without long user IDs.
        state.world.board.cells[action.index] = { tile: action.value === null ? null : { id: `t-e-${this.key}-${this.spent}-${action.index}`, value: action.value, attributes: {} } }; break;
      }
      case 'add-score': state.world.score = (BigInt(state.world.score) + BigInt(action.value)).toString(); if (state.world.score.length > 4096) throw new Error('事件成绩超过位数预算'); break;
      case 'set-variable': case 'add-variable': {
        if (!Object.hasOwn(state.world.events.variables, action.name)) throw new Error('事件变量缺失');
        const value = action.type === 'set-variable' ? action.value : (BigInt(state.world.events.variables[action.name]!) + BigInt(action.value)).toString();
        if (value.length > 4096) throw new Error('事件变量超过位数预算'); state.world.events.variables[action.name] = value; break;
      }
      case 'add-charge': {
        const resource = state.ledger.skills[action.skillId], config = this.rule.definition.skills[action.skillId];
        if (resource.charges !== null) resource.charges += Math.min(action.amount, config.maxCharges - resource.charges); break;
      }
      case 'emit': break;
    }
  }
}
