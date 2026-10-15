import { describe, expect, test } from 'vitest';
import type { Direction, GameState } from '../../src/domain/types';
import { canonicalJson, hashJson } from '../../src/domain/hash';
import { createInitialState, hasMoves, moveClassic } from '../../src/engine/classic';
import { classicRule } from '../../src/presets/classic';
import { Pcg32, seedPcg32 } from '../../src/random/pcg32';
import vectors from '../../examples/contracts/pcg32-vector.json';

const seed = seedPcg32(42n, 54n);
function board(values: (string | null)[]): GameState {
  const state = createInitialState(classicRule, seed);
  state.world.board.cells = Array.from({ length: 16 }, (_, i) => ({ tile: values[i] ? { id: `tile-${i}`, value: values[i]!, attributes: {} } : null }));
  return state;
}
function step(state: GameState, direction: Direction) {
  const result = moveClassic(state, classicRule, { type: 'move', payload: { direction }, elapsedMs: 0 }, `parent-${state.ledger.effectiveActionCount}`);
  if (!result.accepted) throw new Error(result.reason);
  return result;
}
function settledValues(state: GameState): (string | null)[] {
  return state.world.board.cells.map(cell => cell.tile?.id.startsWith('t-s-') ? null : cell.tile?.value ?? null);
}

describe('PCG32 contract', () => {
  test('matches the six official reference outputs and warmup draw counts', () => {
    const rng = new Pcg32(seed);
    expect(seed.drawCount).toBe(0);
    const output = Array.from({ length: 6 }, () => rng.next().toString(16).padStart(8, '0'));
    expect(output).toEqual(vectors.expectedHex);
    expect(seed).toEqual(vectors.seededState);
    expect(rng.snapshot().drawCount).toBe(6);
  });
  test('singleton sampling consumes no entropy; bounds reject invalid inputs', () => {
    const rng = new Pcg32(seed);
    expect(rng.bounded(1)).toBe(0); expect(rng.snapshot()).toEqual(seed);
    for (const bound of [0, -1, 1.1, 0x100000001]) expect(() => rng.bounded(bound)).toThrow();
    expect(() => new Pcg32({ ...seed, increment: '2' })).toThrow();
    expect(() => new Pcg32({ ...seed, state: '18446744073709551616' })).toThrow();
  });
  test('serialized stream resumes identically and uses rejection rather than biased modulo', () => {
    const first = new Pcg32(seed); first.next();
    const second = new Pcg32(first.snapshot());
    expect(Array.from({ length: 50 }, () => first.next())).toEqual(Array.from({ length: 50 }, () => second.next()));
    // Old state 0 emits 0, below the rejection threshold for a bound of 10.
    const rng = new Pcg32({ ...seed, state: '0' });
    const value = rng.bounded(10);
    expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(10);
    expect(rng.snapshot().drawCount).toBeGreaterThan(1);
  });
});

describe('classic atomic engine', () => {
  test('initializes exactly two unique tiles with a serializable complete state', () => {
    const a = createInitialState(classicRule, seed), b = createInitialState(classicRule, seed);
    expect(a).toEqual(b); expect(a.world.board.cells.filter(cell => cell.tile)).toHaveLength(2);
    expect(a.ledger.effectiveActionCount).toBe(0); expect(a.world.score).toBe('0');
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
  test.each([
    [['2', '2', '2', '2'], ['4', '4', null, null], '8'],
    [['4', '4', '8', null], ['8', '8', null, null], '8'],
    [['2', '2', '4', '4'], ['4', '8', null, null], '12'],
    [[null, '2', null, '2'], ['4', null, null, null], '4'],
  ] as const)('settles %j once per tile', (input, output, score) => {
    const result = step(board([...input]), 'left');
    expect(settledValues(result.state).slice(0, 4)).toEqual(output); expect(result.state.world.score).toBe(score);
    expect(result.state.world.roundCount).toBe(1); expect(result.state.ledger.effectiveActionCount).toBe(1);
    expect(result.state.undoStack).toEqual(['parent-0']);
  });
  test.each(['up', 'right', 'down', 'left'] as const)('settles toward the %s edge with correct direction order', direction => {
    const state = board(['2', null, null, '2', ...Array<string | null>(8).fill(null), '2', null, null, '2']);
    const result = step(state, direction);
    const values = settledValues(result.state);
    const positions = { up: [0, 3], down: [12, 15], left: [0, 12], right: [3, 15] }[direction];
    expect(values.flatMap((value, index) => value ? [index] : [])).toEqual(positions);
    expect(positions.map(index => values[index])).toEqual(['4', '4']); expect(result.state.world.score).toBe('8');
  });
  test('invalid movement changes no input, counts, RNG or tiles', () => {
    const state = board(['2', '4', '8', '16']); const before = structuredClone(state);
    const result = moveClassic(state, classicRule, { type: 'move', payload: { direction: 'left' }, elapsedMs: 0 }, 'parent');
    expect(result.accepted).toBe(false); expect(state).toEqual(before);
  });
  test('accepted movement is immutable and deterministic, including tile IDs', () => {
    const state = board(['2', '2']); const before = structuredClone(state);
    expect(step(state, 'left')).toEqual(step(state, 'left')); expect(state).toEqual(before);
  });
  test('preserves exact score beyond Number safe integer range', () => {
    const value = (2n ** 60n).toString(); const state = board([value, value]);
    state.world.score = '9007199254740993';
    expect(step(state, 'left').state.world.score).toBe((9007199254740993n + 2n ** 61n).toString());
  });
  test('winning records the goal and allows further moves', () => {
    const result = step(board(['1024', '1024']), 'left');
    expect(result.state.world.outcome).toMatchObject({ status: 'won', canContinue: true });
    expect(result.state.world.goals).toEqual({ achieved: ['tile'], firstWinLogicalMs: 0 });
    expect(step(result.state, 'right').state.world.goals.achieved).toEqual(['tile']);
  });
  test('a full blocked checkerboard has no moves; an equal neighbor does', () => {
    const state = board(['2','4','2','4', '4','2','4','2', '2','4','2','4', '4','2','4','2']);
    expect(hasMoves(state.world.board.cells)).toBe(false);
    state.world.board.cells[0]!.tile!.value = '4'; expect(hasMoves(state.world.board.cells)).toBe(true);
  });
  test('a move filling the final gap saves a lost state, and later moves are rejected', () => {
    const state = board([null,'2','4','2', '4','2','4','2', '2','4','2','4', '4','2','4','2']);
    // Slide the first row left; a 4 in the only remaining gap blocks every direction.
    let final: GameState | null = null;
    for (let seedValue = 1n; seedValue < 50n; seedValue++) {
      state.rng = seedPcg32(seedValue, 54n);
      const result = step(state, 'left').state;
      if (result.world.outcome.status === 'lost') { final = result; break; }
    }
    expect(final).not.toBeNull();
    expect(moveClassic(final!, classicRule, { type: 'move', payload: { direction: 'right' }, elapsedMs: 0 }, 'next').accepted).toBe(false);
  });
  test('resource limits and unsupported rules fail atomically', () => {
    const value = (2n ** 850n).toString(); // 256 digits; doubling exceeds the tile budget.
    const state = board([value, value]); const before = structuredClone(state);
    expect(() => step(state, 'left')).toThrow(/位数/); expect(state).toEqual(before);
    const custom = structuredClone(classicRule); Reflect.set(custom.definition.merge, 'chain', true);
    expect(() => moveClassic(board(['2','2']), custom, { type: 'move', payload: { direction: 'left' }, elapsedMs: 0 }, 'p')).toThrow(/经典规则/);
  });
  test('exhaustive small rows conserve tile sum apart from exactly one spawn', () => {
    const options = [null, '2', '4', '8'];
    for (let encoded = 0; encoded < 256; encoded++) {
      const values = Array.from({ length: 4 }, (_, index) => options[(encoded >> (index * 2)) & 3]!);
      const state = board(values); const before = canonicalJson(state);
      for (const direction of ['left', 'right'] as const) {
        const result = moveClassic(state, classicRule, { type: 'move', payload: { direction }, elapsedMs: 0 }, 'parent');
        if (result.accepted) {
          const sum = (s: GameState) => s.world.board.cells.reduce((total, cell) => total + BigInt(cell.tile?.value ?? '0'), 0n);
          expect([2n, 4n]).toContain(sum(result.state) - sum(state));
          expect(result.state.world.board.cells.filter(cell => cell.tile?.id.startsWith('t-s-'))).toHaveLength(1);
          expect(result.state.world.mergeCount).toBe(result.merges);
        }
        expect(canonicalJson(state)).toBe(before);
      }
    }
  });
});

test('canonical hash matches the frozen classic preset and ignores key ordering', async () => {
  expect(await hashJson(classicRule.definition)).toBe(classicRule.definitionHash);
  expect(await hashJson({ b: 2, a: '1' })).toBe(await hashJson({ a: '1', b: 2 }));
  expect(() => canonicalJson({ bad: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
});
