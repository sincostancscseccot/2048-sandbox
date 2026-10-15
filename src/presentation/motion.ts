import type { Direction, GameState, RuleDefinition, Tile } from '../domain/types';
import { mergeValue } from '../domain/advanced';

export const slideDuration = 160;
export const maxAnimatedTiles = 128;
export interface SlideGroup { index: number; value: string; sources: { tile: Tile; index: number }[] }

/** Display-only lineage. It never changes game state, history or random input. */
export function traceSlide(state: GameState, definition: RuleDefinition, direction: Direction): SlideGroup[] {
  const { rows, cols, cells } = state.world.board, horizontal = direction === 'left' || direction === 'right';
  const groups: SlideGroup[] = [];
  for (let line = 0; line < (horizontal ? rows : cols); line++) {
    const indices = Array.from({ length: horizontal ? cols : rows }, (_, offset) => {
      if (direction === 'left') return line * cols + offset;
      if (direction === 'right') return line * cols + cols - 1 - offset;
      return direction === 'up' ? offset * cols + line : (rows - 1 - offset) * cols + line;
    });
    const stack: { value: string; merged: number; sources: SlideGroup['sources'] }[] = [];
    for (const index of indices) {
      const tile = cells[index]!.tile; if (!tile) continue;
      stack.push({ value: tile.value, merged: 0, sources: [{ tile, index }] });
      while (stack.length > 1) {
        const left = stack.at(-2)!, right = stack.at(-1)!;
        if ((!definition.merge.chain && (left.merged || right.merged)) || Math.max(left.merged, right.merged) >= definition.merge.maxMergesPerTile) break;
        const value = mergeValue(left.value, right.value, definition); if (value === null) break;
        stack.splice(-2, 2, { value, merged: Math.max(left.merged, right.merged) + 1, sources: [...left.sources, ...right.sources] });
      }
    }
    stack.forEach((group, offset) => groups.push({ index: indices[offset]!, value: group.value, sources: group.sources }));
  }
  return groups;
}

export function tileAppearance(value: string) {
  return {
    level: value !== '0' ? Math.max(0, Math.min(12, value.length > 4 ? 12 : Math.floor(Math.log2(Number(value))))) : 0,
    text: value.length > 10 ? `${value.slice(0, 5)}…${value.slice(-3)}` : value,
    small: value.length > 3,
  };
}
