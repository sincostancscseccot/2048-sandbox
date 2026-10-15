import { canonicalJson } from '../domain/hash';
import type { GameState } from '../domain/types';
import { assertContract, assertCoreState } from '../domain/validation';
import type { Patch, StateDelta } from './types';
import { ArchiveError } from './types';

export function createDelta(base: GameState, result: GameState, baseHash: string, resultHash: string): StateDelta {
  const patches: Patch[] = [];
  function visit(a: unknown, b: unknown, path: string[]): void {
    if (canonicalJson(a) === canonicalJson(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (b.length === a.length || (b.length === a.length + 1 && a.every((value, i) => canonicalJson(value) === canonicalJson(b[i])))) {
        a.forEach((value, i) => visit(value, b[i], [...path, String(i)]));
        if (b.length > a.length) patches.push({ op: 'add', path: [...path, '-'], value: b[b.length - 1] });
      } else patches.push({ op: 'replace', path, value: b });
    } else if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) &&
      canonicalJson(Object.keys(a).sort()) === canonicalJson(Object.keys(b).sort())) {
      for (const key of Object.keys(a)) visit((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], [...path, key]);
    } else patches.push({ op: 'replace', path, value: b });
  }
  visit(base, result, []);
  return { deltaVersion: 1, baseStateHash: baseHash, resultStateHash: resultHash, patches };
}

export function applyDelta(base: GameState, delta: StateDelta): GameState {
  assertContract('Delta', delta);
  const result = structuredClone(base);
  for (const patch of delta.patches) {
    if (patch.path.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new ArchiveError('增量含不允许的字段路径');
    let target: unknown = result;
    for (const part of patch.path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) throw new ArchiveError('增量路径不存在');
      target = (target as Record<string, unknown>)[part];
    }
    const key = patch.path.at(-1)!;
    if (Array.isArray(target)) {
      if (patch.op === 'add' && key === '-') target.push(structuredClone(patch.value));
      else if (patch.op === 'replace' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < target.length) target[Number(key)] = structuredClone(patch.value);
      else throw new ArchiveError('增量数组操作无效');
    } else if (target && typeof target === 'object' && patch.op === 'replace' && Object.hasOwn(target, key)) {
      (target as Record<string, unknown>)[key] = structuredClone(patch.value);
    } else throw new ArchiveError('增量对象操作无效');
  }
  assertCoreState(result); return result;
}
