import type { HistoryNode } from '../domain/types';

export interface TreePoint { node: HistoryNode; x: number; y: number; children: number; collapsed: boolean }
export interface TreeEdge { parent: TreePoint; child: TreePoint; low: number; high: number }
export interface TreeLayout {
  points: TreePoint[]; byId: Map<string, TreePoint>; width: number; height: number;
  columns: Map<number, TreePoint[]>; edges: Map<number, { items: TreeEdge[]; prefixHigh: number[] }>;
}

export function ancestorPath(nodes: HistoryNode[] | Map<string, HistoryNode>, endId: string): string[] {
  const byId = Array.isArray(nodes) ? new Map(nodes.map(node => [node.id, node])) : nodes, path: string[] = [], seen = new Set<string>();
  let id: string | null = endId;
  while (id) {
    const node = byId.get(id); if (!node || seen.has(id)) throw new Error('路径引用缺失或循环');
    seen.add(id); path.push(id); id = node.parentId;
  }
  return path.reverse();
}

export function subtreeIds(nodes: HistoryNode[], roots: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) if (node.parentId) { const list = children.get(node.parentId) ?? []; list.push(node.id); children.set(node.parentId, list); }
  const result = new Set<string>(), stack = roots.slice();
  while (stack.length) {
    const id = stack.pop()!; if (result.has(id)) continue;
    result.add(id); for (const child of children.get(id) ?? []) stack.push(child);
  }
  return result;
}

/** Iterative layout avoids stack overflow on long single paths. */
export function layoutTree(nodes: HistoryNode[], collapsed: Set<string>, hidden: Set<string>): TreeLayout {
  const children = new Map<string, HistoryNode[]>(), roots: HistoryNode[] = [];
  for (const node of nodes) {
    if (node.parentId === null) roots.push(node);
    else { const list = children.get(node.parentId) ?? []; list.push(node); children.set(node.parentId, list); }
  }
  const compare = (a: HistoryNode, b: HistoryNode) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  roots.sort(compare); for (const list of children.values()) list.sort(compare);
  const visible: HistoryNode[] = [], stack = roots.slice().reverse(), seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node.id)) throw new Error('树中存在重复节点'); seen.add(node.id);
    if (hidden.has(node.id)) continue;
    visible.push(node);
    if (!collapsed.has(node.id)) for (const child of (children.get(node.id) ?? []).slice().reverse()) stack.push(child);
  }
  const visibleIds = new Set(visible.map(node => node.id));
  const byId = new Map<string, TreePoint>(); let leaf = 0;
  for (const node of visible.slice().reverse()) {
    const descendants = (children.get(node.id) ?? []).filter(child => visibleIds.has(child.id));
    const positions = descendants.map(child => byId.get(child.id)!.y);
    const y = positions.length ? (positions.reduce((min, y) => Math.min(min, y), Infinity) + positions.reduce((max, y) => Math.max(max, y), -Infinity)) / 2 : 28 + leaf++ * 84;
    byId.set(node.id, { node, x: 28 + node.depth * 170, y, children: children.get(node.id)?.length ?? 0, collapsed: collapsed.has(node.id) });
  }
  const points = visible.map(node => byId.get(node.id)!);
  const columns = new Map<number, TreePoint[]>(), edgeColumns = new Map<number, TreeEdge[]>();
  for (const point of points) {
    const list = columns.get(point.node.depth) ?? []; list.push(point); columns.set(point.node.depth, list);
    const parent = point.node.parentId ? byId.get(point.node.parentId) : undefined;
    if (parent) { const edges = edgeColumns.get(point.node.depth) ?? []; edges.push({ parent, child: point, low: Math.min(parent.y, point.y), high: Math.max(parent.y + 54, point.y + 54) }); edgeColumns.set(point.node.depth, edges); }
  }
  for (const list of columns.values()) list.sort((a, b) => a.y - b.y);
  const edges = new Map<number, { items: TreeEdge[]; prefixHigh: number[] }>();
  for (const [depth, items] of edgeColumns) { items.sort((a, b) => a.low - b.low); let highest = -Infinity; edges.set(depth, { items, prefixHigh: items.map(item => highest = Math.max(highest, item.high)) }); }
  return { points, byId, columns, edges, width: points.reduce((max, point) => Math.max(max, point.x + 156), 240), height: Math.max(140, leaf * 84 + 50) };
}

function upperBound<T>(items: T[], value: number, get: (item: T) => number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (get(items[mid]!) <= value) lo = mid + 1; else hi = mid; }
  return lo;
}
export function visibleTree(layout: TreeLayout, view: { x: number; y: number; width: number; height: number }, buffer = 180) {
  const left = view.x - buffer, right = view.x + view.width + buffer, top = view.y - buffer, bottom = view.y + view.height + buffer;
  const first = Math.max(0, Math.floor((left - 156) / 170)), last = Math.min(Math.ceil(layout.width / 170), Math.ceil(right / 170) + 1);
  const points: TreePoint[] = [], edges: TreeEdge[] = []; let edgeTotal = 0;
  for (let depth = first; depth <= last; depth++) {
    const column = layout.columns.get(depth) ?? [];
    for (let index = upperBound(column, top - 55, point => point.y); index < column.length && column[index]!.y <= bottom; index++) {
      const point = column[index]!; if (point.x + 128 >= left && point.x <= right) points.push(point);
    }
    const band = layout.edges.get(depth); if (!band) continue;
    for (let index = upperBound(band.items, bottom, edge => edge.low) - 1; index >= 0 && band.prefixHigh[index]! >= top; index--) {
      const edge = band.items[index]!;
      if (edge.high >= top && edge.child.x >= left && edge.parent.x + 128 <= right) { edgeTotal++; if (edges.length < 2000) edges.push(edge); }
    }
  }
  return { points, edges, edgeTotal };
}
