import type { GameAction, GameState, RuleSetVersion } from '../domain/types';

export type SoundKind = 'move' | 'merge' | 'undo' | 'skill' | 'edit' | 'start' | 'win' | 'loss' | 'blocked';
export interface CommittedTurn {
  projectId: string; fromNodeId: string | null; toNodeId: string;
  before: GameState | null; after: GameState; rule: RuleSetVersion; action: GameAction | null;
}
export interface GameFeedback { sequence: number; kind: SoundKind; turn: CommittedTurn | null }

export function soundForTurn(turn: CommittedTurn): SoundKind {
  const { before, after, action } = turn;
  if (!before || !action) return 'start';
  if (after.world.outcome.status === 'won' && before.world.outcome.status !== 'won') return 'win';
  if (after.world.outcome.status === 'lost' && before.world.outcome.status !== 'lost') return 'loss';
  if (action.type === 'skill') return action.payload.skillId === 'undo' ? 'undo' : 'skill';
  if (action.type !== 'move') return 'edit';
  return after.world.mergeCount > before.world.mergeCount ? 'merge' : 'move';
}

export function scoreChange(turn: CommittedTurn): string {
  const delta = BigInt(turn.after.world.score) - BigInt(turn.before?.world.score ?? '0');
  return delta > 0n ? `+${delta}` : delta.toString();
}
