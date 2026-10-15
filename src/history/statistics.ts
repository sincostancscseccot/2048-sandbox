import type { GameState, LoadedProject } from '../domain/types';
import { actionLabel } from '../domain/actions';
import { ancestorPath } from './tree';

export function buildPathStatistics(loaded: LoadedProject, endId: string) {
  const byId = new Map(loaded.nodes.map(node => [node.id, node]));
  const path = ancestorPath(byId, endId), versions = new Set<string>(), skills: Record<string, number> = {};
  const actions = { move: 0, skill: 0, edit: 0, 'rule-edit': 0 };
  let highestScore = 0n, largestTile = 0n, positiveScoreChange = 0n, mergeOperations = 0, rerolls = 0, reproductions = 0;
  const rows = path.map((id, index) => {
    const node = byId.get(id)!; const state = loaded.states.get(node.stateHash)!;
    const previous = index ? loaded.states.get(byId.get(path[index - 1]!)!.stateHash)! : null;
    const score = BigInt(state.world.score), delta = score - BigInt(previous?.world.score ?? '0');
    if (score > highestScore) highestScore = score;
    for (const cell of state.world.board.cells) if (cell.tile && BigInt(cell.tile.value) > largestTile) largestTile = BigInt(cell.tile.value);
    if (delta > 0n) positiveScoreChange += delta;
    if (previous) mergeOperations += Math.max(0, state.world.mergeCount - previous.world.mergeCount);
    versions.add(`${state.ruleRef.id}/${state.ruleRef.version}`);
    if (node.action) { actions[node.action.type]++; if (node.action.type === 'skill') skills[node.action.payload.skillId] = (skills[node.action.payload.skillId] ?? 0) + 1; }
    if (node.randomContext?.mode === 'reroll') rerolls++;
    if (node.randomContext?.mode === 'reproduce') reproductions++;
    return { nodeId: id, depth: node.depth, action: index ? actionLabel(node.action) : '起点', actionType: node.action?.type ?? 'root', score: state.world.score, scoreDelta: delta.toString(),
      round: state.world.roundCount, effectiveActions: state.ledger.effectiveActionCount, ruleRef: { ...state.ruleRef }, stateHash: node.stateHash };
  });
  const children = new Map<string, number>(); for (const node of loaded.nodes) if (node.parentId) children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
  const pathIds = new Set(path);
  return { endId, rows, actions, skills, highestScore: highestScore.toString(), largestTile: largestTile.toString(), positiveScoreChange: positiveScoreChange.toString(),
    mergeOperations, ruleVersions: versions.size, rerolls, reproductions, pathCheckpoints: loaded.checkpoints.filter(checkpoint => pathIds.has(checkpoint.nodeId)).length,
    totalNodes: loaded.nodes.length, forkPoints: [...children.values()].filter(count => count > 1).length };
}
export type PathStatistics = ReturnType<typeof buildPathStatistics>;

/** Only small dimensionless ratios are converted to Number; saved integers stay exact. */
export function scoreTrend(rows: PathStatistics['rows'], selectedId: string) {
  if (!rows.length) return [];
  let peak = 0; rows.forEach((row, index) => { if (BigInt(row.score) > BigInt(rows[peak]!.score)) peak = index; });
  const selected = rows.findIndex(row => row.nodeId === selectedId);
  const indices = rows.length <= 200 ? rows.map((_, i) => i) : [...new Set([0, rows.length - 1, peak, ...(selected >= 0 ? [selected] : []),
    ...Array.from({ length: 196 }, (_, i) => Math.round(i * (rows.length - 1) / 195))])].sort((a, b) => a - b);
  const max = BigInt(rows[peak]!.score);
  return indices.map(index => ({ ...rows[index]!, x: rows.length < 2 ? 50 : index * 100 / (rows.length - 1), y: max === 0n ? 100 : 100 - Number(BigInt(rows[index]!.score) * 10000n / max) / 100 }));
}
export function compareBoards(a: GameState, b: GameState) {
  const rows = Math.max(a.world.board.rows, b.world.board.rows), cols = Math.max(a.world.board.cols, b.world.board.cols);
  const differences: { row: number; col: number; before: string; after: string }[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const inA = row < a.world.board.rows && col < a.world.board.cols, inB = row < b.world.board.rows && col < b.world.board.cols;
    const before = inA ? a.world.board.cells[row * a.world.board.cols + col]!.tile?.value ?? '空' : '无此格';
    const after = inB ? b.world.board.cells[row * b.world.board.cols + col]!.tile?.value ?? '空' : '无此格';
    if (before !== after) differences.push({ row: row + 1, col: col + 1, before, after });
  }
  return { total: rows * cols, differences, scoreDelta: (BigInt(b.world.score) - BigInt(a.world.score)).toString() };
}
