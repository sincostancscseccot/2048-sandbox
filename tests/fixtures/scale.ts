import type { LibrarySnapshot, LoadedProject } from '../../src/domain/types';
import { createCustomRule, sandboxDefinition } from '../../src/presets/rules';
import { prepareMove, prepareNewMatch } from '../../src/history/candidates';
import { seedPcg32 } from '../../src/random/pcg32';

export async function scaleFixture(count: number, shape: 'chain' | 'fan' | 'balanced' = 'chain'): Promise<LibrarySnapshot> {
  const d = sandboxDefinition(); d.board.rows = 1; d.board.cols = 3; d.board.initialLayout = [{ index: 0, value: '2' }];
  d.spawn.initialCount = 0; d.spawn.perActionCount = 0; d.goals.lossWhenNoMoves = false;
  const rule = await createCustomRule(`规模验证 ${shape}`, d), root = await prepareNewMatch(`${shape} ${count} 步`, seedPcg32(42n, 54n), rule);
  const loaded: LoadedProject = { project: root.project, nodes: [root.node], states: new Map([[root.node.stateHash, root.state]]), rule,
    rules: new Map([[`${rule.id}/1`, rule]]), checkpoints: [], archivedRootIds: [] };
  for (let i = 1; i <= count; i++) {
    const parent = loaded.nodes[shape === 'chain' ? i - 1 : shape === 'fan' ? 0 : Math.floor((i - 1) / 4)]!;
    const next = await prepareMove(loaded, parent.id, parent.depth % 2 ? 'left' : 'right', 'reroll', () => seedPcg32(BigInt(i) + 100n, 54n));
    if ('reason' in next) throw new Error(next.reason);
    loaded.project = next.project; loaded.nodes.push(next.node); loaded.states.set(next.node.stateHash, next.state);
  }
  return { projects: [{ id: loaded.project.id, project: loaded.project, updatedAt: loaded.nodes.at(-1)!.createdAt }], nodes: loaded.nodes,
    states: [...loaded.states].map(([hash, state]) => ({ hash, state })), rules: [rule], checkpoints: [], settings: [{ key: 'lastProjectId', value: loaded.project.id }] };
}
