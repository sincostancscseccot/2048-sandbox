import validators from './validators';
import type { GameState, RngState, RuleSetVersion } from './types';

export function assertContract(name: string, value: unknown): void {
  const validator = validators[name];
  if (!validator || !validator(value)) {
    const first = validator?.errors?.[0];
    throw new Error(`${name} 数据校验失败：${first?.instancePath || '/'} ${first?.message ?? '未知契约'}`);
  }
}

export function contractErrors(name: string, value: unknown): { path: string; message: string }[] {
  const validator = validators[name];
  if (!validator) return [{ path: '/', message: '未知契约' }];
  if (validator(value)) return [];
  return (validator.errors ?? []).map(error => ({ path: error.instancePath || '/', message: error.message ?? '字段不合法' }));
}

export function assertRng(rng: RngState): void {
  const max = (1n << 64n) - 1n;
  if (rng.algorithm !== 'pcg32-xsh-rr-v1' || !/^(0|[1-9][0-9]*)$/.test(rng.state) ||
    !/^(0|[1-9][0-9]*)$/.test(rng.increment) || BigInt(rng.state) > max || BigInt(rng.increment) > max ||
    BigInt(rng.increment) % 2n !== 1n || !Number.isSafeInteger(rng.drawCount) || rng.drawCount < 0) {
    throw new Error('随机流损坏或算法版本不受支持');
  }
}

export function assertCoreState(state: GameState, rule?: RuleSetVersion): void {
  assertContract('GameState', state);
  assertRng(state.rng);
  const board = state.world.board;
  if (board.rows * board.cols > 4096 || board.cells.length !== board.rows * board.cols ||
    state.world.clock.mode !== 'none' || state.world.clock.logicalElapsedMs !== 0 ||
    state.world.clock.remainingMs !== null || state.world.clock.statusAtCommit !== 'paused') {
    throw new Error('棋盘尺寸不一致、超过 4096 格或包含尚未开放的计时配置');
  }
  const ids = new Set<string>();
  for (const { tile } of board.cells) {
    if (tile) {
      if (tile.value.length > (rule?.definition.numbers.maxDigits ?? 4096) || ids.has(tile.id)) {
        throw new Error('棋盘数字超过预算或方块 ID 重复');
      }
      if (rule?.definition.mode === 'normal' && (BigInt(tile.value) < 2n || (BigInt(tile.value) & (BigInt(tile.value) - 1n)) !== 0n)) throw new Error('经典棋盘含无效数字');
      ids.add(tile.id);
    }
  }
  if (rule) {
    if (state.ruleRef.id !== rule.id || state.ruleRef.version !== rule.version || board.rows !== rule.definition.board.rows || board.cols !== rule.definition.board.cols) throw new Error('状态与规则引用或尺寸不一致');
    for (const [id, config] of Object.entries(rule.definition.skills)) {
      const skill = state.ledger.skills[id as keyof typeof state.ledger.skills];
      if (config.unlimited ? skill.charges !== null : skill.charges === null || skill.charges > config.maxCharges) throw new Error('技能余量与规则不一致');
      if (skill.cooldownRemaining > config.cooldownTurns || (config.rechargeEveryTurns === null ? skill.rechargeProgress !== 0 : skill.rechargeProgress >= config.rechargeEveryTurns)) throw new Error('技能冷却或恢复进度与规则不一致');
    }
    const events = state.world.events, definitions = rule.definition.events;
    if (events.queue.length || Object.keys(events.counters).some(id => !definitions.some(event => event.id === id)) ||
      Object.keys(events.variables).some(id => !Object.hasOwn(rule.definition.variables, id)) || Object.keys(rule.definition.variables).some(id => !Object.hasOwn(events.variables, id)) ||
      definitions.some(event => events.counters[event.id] === undefined || events.cooldowns?.[event.id] === undefined) ||
      Object.entries(events.cooldowns ?? {}).some(([id, turns]) => !definitions.some(event => event.id === id && turns <= event.cooldownTurns))) throw new Error('事件计数、冷却或变量与规则不一致');
  }
}
