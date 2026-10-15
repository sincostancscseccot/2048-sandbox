import { expect, test } from 'vitest';
import type { HistoryNode } from '../../src/domain/types';
import { ancestorPath, layoutTree, subtreeIds, visibleTree } from '../../src/history/tree';

function node(id: string, parentId: string | null, depth: number): HistoryNode {
  return { id, parentId, depth, matchId: 'match', action: null, randomContext: null, stateHash: 'sha256:' + '0'.repeat(64),
    createdAt: '2026-10-14T00:00:00Z', operationId: null, undoTargetId: null, tags: [] };
}
const tree = [node('root', null, 0), node('a', 'root', 1), node('b', 'root', 1), node('a2', 'a', 2), node('b2', 'b', 2)];
test('same-state branches are distinct, connected nodes; collapse hides descendants only', () => {
  const full = layoutTree(tree, new Set(), new Set()); expect(full.points).toHaveLength(5);
  expect(full.byId.get('a')!.y).not.toBe(full.byId.get('b')!.y);
  const collapsed = layoutTree(tree, new Set(['a']), new Set());
  expect(collapsed.byId.has('a2')).toBe(false); expect(collapsed.byId.has('b2')).toBe(true);
  expect(ancestorPath(tree, 'b2')).toEqual(['root', 'b', 'b2']);
});
test('archived subtrees filter without altering source nodes or ancestry', () => {
  const hidden = subtreeIds(tree, ['a']); expect([...hidden].sort()).toEqual(['a', 'a2']);
  expect(layoutTree(tree, new Set(), hidden).points).toHaveLength(3); expect(tree).toHaveLength(5);
  expect(() => ancestorPath([node('loop', 'loop', 1)], 'loop')).toThrow(/循环/);
});
test('ten thousand nodes in a deep path lay out without recursive stack overflow', () => {
  const nodes = Array.from({ length: 10000 }, (_, index) => node(`n${index}`, index ? `n${index - 1}` : null, index));
  const result = layoutTree(nodes, new Set(), new Set());
  expect(result.points).toHaveLength(10000); expect(result.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  expect(ancestorPath(nodes, 'n9999')).toHaveLength(10000);
});

test('indexed viewports query a deep ten-thousand-node tree without rendering all nodes', () => {
  const nodes = Array.from({ length: 10000 }, (_, index) => node(`n${index}`, index ? `n${index - 1}` : null, index));
  const layout = layoutTree(nodes,new Set(),new Set()), view = visibleTree(layout,{x:5000*170,y:0,width:760,height:410});
  expect(view.points.length).toBeGreaterThan(0); expect(view.points.length).toBeLessThan(12); expect(view.edges.length).toBeLessThan(12);
  expect(view.points.some(point=>point.node.id==='n5000')).toBe(true); expect(visibleTree(layout,{x:-10000,y:-10000,width:10,height:10}).points).toEqual([]);
});
test('wide fan-out caps dense crossing edges and retains correct viewport totals', () => {
  const nodes = [node('root',null,0),...Array.from({length:3000},(_,i)=>node(`c${i}`,'root',1))];
  const layout=layoutTree(nodes,new Set(),new Set()), root=layout.byId.get('root')!;
  const view=visibleTree(layout,{x:140,y:root.y,width:300,height:100},0);
  expect(view.edges).toHaveLength(2000); expect(view.edgeTotal).toBe(3000); expect(view.points.length).toBeLessThan(5);
});
