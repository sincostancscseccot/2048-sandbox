import type { GameState, MoveAction, RuleSetVersion } from '../domain/types';
import { assertClassicRule } from '../presets/classic';
import { stepGame } from './core';

export { createInitialState, hasMoves } from './core';
export type { StepResult as MoveResult } from './core';

/** Strict classic API retained for version-one replays. */
export function moveClassic(input: GameState, rule: RuleSetVersion, action: MoveAction, parentNodeId: string, randomInput = input.rng) {
  assertClassicRule(rule);
  return stepGame(input, rule, action, parentNodeId, randomInput);
}
