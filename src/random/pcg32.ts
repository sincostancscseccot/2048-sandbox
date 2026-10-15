import type { RngState } from '../domain/types';
import { assertRng } from '../domain/validation';

const mask64 = (1n << 64n) - 1n;
const multiplier = 6364136223846793005n;

/** PCG XSH RR 64/32. No hidden entropy; all draws are serialized. */
export class Pcg32 {
  private state: bigint;
  private readonly increment: bigint;
  private drawCount: number;

  constructor(input: RngState) {
    assertRng(input);
    this.state = BigInt(input.state); this.increment = BigInt(input.increment); this.drawCount = input.drawCount;
  }
  next(): number {
    if (this.drawCount === Number.MAX_SAFE_INTEGER) throw new Error('随机抽取计数达到上限');
    const old = this.state;
    this.state = (old * multiplier + this.increment) & mask64;
    const shifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn) >>> 0;
    const rotation = Number(old >> 59n);
    this.drawCount++;
    return ((shifted >>> rotation) | (shifted << ((-rotation) & 31))) >>> 0;
  }
  bounded(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1 || bound > 0x100000000) throw new Error('随机范围无效');
    if (bound === 1) return 0;
    const threshold = 0x100000000 % bound;
    let draw: number;
    do { draw = this.next(); } while (draw < threshold);
    return draw % bound;
  }
  snapshot(): RngState {
    return { algorithm: 'pcg32-xsh-rr-v1', state: this.state.toString(), increment: this.increment.toString(), drawCount: this.drawCount };
  }
}

export function seedPcg32(seed: bigint, sequence: bigint): RngState {
  const rng = new Pcg32({ algorithm: 'pcg32-xsh-rr-v1', state: '0', increment: (((sequence & mask64) << 1n | 1n) & mask64).toString(), drawCount: 0 });
  rng.next();
  const warm = rng.snapshot();
  const seeded = new Pcg32({ ...warm, state: ((BigInt(warm.state) + (seed & mask64)) & mask64).toString() });
  seeded.next();
  return { ...seeded.snapshot(), drawCount: 0 };
}

/** Entropy is sampled only in the application layer and then recorded. */
export function freshRng(): RngState {
  const words = crypto.getRandomValues(new Uint32Array(4));
  return seedPcg32((BigInt(words[0]!) << 32n) | BigInt(words[1]!), (BigInt(words[2]!) << 32n) | BigInt(words[3]!));
}
