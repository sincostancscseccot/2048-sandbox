import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { LoadedProject } from '../domain/types';
import { actionLabel } from '../domain/actions';
import { ancestorPath, layoutTree, subtreeIds, visibleTree } from '../history/tree';
import { compareBoards } from '../history/statistics';
import type { ExportKind } from '../files/types';
import { Board } from './Board';
import { Modal } from './Modal';
import { TreeOverview } from './TreeOverview';

interface Props {
  loaded: LoadedProject; selectedId: string; busy: boolean; canContinue: boolean;
  onPreview: (id: string) => void; onContinue: (id: string) => void; onClose: () => void;
  onExport: (kind: ExportKind, nodeId: string) => void; onArchive: (id: string, archived: boolean) => Promise<void>;
  onStatistics: () => void;
}

export function HistoryTree({ loaded, selectedId, busy, canContinue, onPreview, onContinue, onClose, onExport, onArchive, onStatistics }: Props) {
  const [collapsed, setCollapsed] = useState(new Set<string>()), [showArchived, setShowArchived] = useState(true);
  const archived = useMemo(() => subtreeIds(loaded.nodes, loaded.archivedRootIds), [loaded.nodes, loaded.archivedRootIds]);
  const layout = useMemo(() => layoutTree(loaded.nodes, collapsed, showArchived ? new Set<string>() : archived), [loaded.nodes, collapsed, showArchived, archived]);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState({ width: 760, height: 380 });
  const container = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ camera: typeof camera; x: number; y: number; distance: number } | null>(null);
  const cameraRef = useRef(camera); useEffect(() => { cameraRef.current = camera; }, [camera]);
  const [follow, setFollow] = useState(false), [revealId, setRevealId] = useState<string | null>(null);
  const focusRequest = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState(() => ancestorPath(loaded.nodes, selectedId));
  const [cursor, setCursor] = useState(path.length - 1), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(700);
  const preview = useRef(onPreview); useEffect(() => { preview.current = onPreview; }, [onPreview]);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(loaded.nodes.map(item => [item.id, item])), [loaded.nodes]);
  const node = byId.get(selectedId)!, state = loaded.states.get(node.stateHash)!;
  const active = byId.get(loaded.project.activeNodeId)!, activeState = loaded.states.get(active.stateHash)!;
  const checkpoints = useMemo(() => new Set(loaded.checkpoints.map(checkpoint => checkpoint.nodeId)), [loaded.checkpoints]);
  const siblings = useMemo(() => { const map = new Map<string | null, string[]>(); for (const item of loaded.nodes) { const list = map.get(item.parentId) ?? []; list.push(item.id); map.set(item.parentId, list); } return map; }, [loaded.nodes]);
  const selectedPath = useMemo(() => ancestorPath(byId, selectedId), [byId, selectedId]);
  const highlighted = useMemo(() => new Set(selectedPath), [selectedPath]);

  useEffect(() => {
    const element = container.current; if (!element) return;
    const observer = new ResizeObserver(entries => { const rect = entries[0]!.contentRect; setSize({ width: rect.width, height: rect.height }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const zoom = Math.max(.08, Math.min(1, (size.width - 30) / layout.width, (size.height - 30) / layout.height));
    const selected = layout.byId.get(selectedId);
    setCamera(loaded.nodes.length > 120 && selected ? { x: selected.x + 64 - size.width / 2, y: selected.y + 27 - size.height / 2, zoom: 1 } : { x: -(size.width / zoom - layout.width) / 2, y: -(size.height / zoom - layout.height) / 2, zoom });
  }, [layout.width, layout.height, size.width, size.height]);
  useEffect(() => {
    const id = revealId ?? (follow ? selectedId : null), point = id ? layout.byId.get(id) : undefined;
    if (point) { setCamera(current => ({ ...current, x: point.x + 64 - size.width / current.zoom / 2, y: point.y + 27 - size.height / current.zoom / 2 })); if (revealId) setRevealId(null); }
  }, [layout, revealId, follow, selectedId, size]);
  useEffect(() => {
    const element = svg.current; if (!element) return;
    function wheel(event: WheelEvent) {
      event.preventDefault(); const rect = element!.getBoundingClientRect(), x = event.clientX - rect.x, y = event.clientY - rect.y;
      setCamera(current => { const zoom = Math.max(.08, Math.min(2.5, current.zoom * Math.exp(-event.deltaY * .0015)));
        return { x: current.x + x / current.zoom - x / zoom, y: current.y + y / current.zoom - y / zoom, zoom }; });
    }
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    if (!playing) return;
    if (cursor >= path.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => { const next = cursor + 1; setCursor(next); preview.current(path[next]!); }, speed);
    return () => clearTimeout(timer);
  }, [playing, cursor, path, speed]);

  function select(id: string) {
    const next = ancestorPath(byId, id); setPlaying(false); setPath(next); setCursor(next.length - 1); onPreview(id);
  }
  function step(index: number) { const next = Math.max(0, Math.min(path.length - 1, index)); setPlaying(false); setCursor(next); onPreview(path[next]!); }
  function play() {
    if (playing) { setPlaying(false); return; }
    if (cursor === path.length - 1) { setCursor(0); onPreview(path[0]!); }
    setPlaying(true);
  }
  function center(id: string) { const point = layout.byId.get(id); if (point) setCamera(current => ({ ...current, x: point.x + 64 - size.width / current.zoom / 2, y: point.y + 27 - size.height / current.zoom / 2 })); }
  function fit() { const zoom = Math.max(.08, Math.min(1, (size.width - 30) / layout.width, (size.height - 30) / layout.height)); setCamera({ x: -(size.width / zoom - layout.width) / 2, y: -(size.height / zoom - layout.height) / 2, zoom }); }
  function resetGesture() {
    const points = [...pointers.current.values()].slice(0, 2), rect = svg.current?.getBoundingClientRect();
    if (!rect || !points.length) { gesture.current = null; return; }
    gesture.current = { camera: cameraRef.current, x: points.reduce((sum, point) => sum + point.x, 0) / points.length - rect.x,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length - rect.y, distance: points.length === 2 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0 };
  }
  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if ((event.target as Element).closest('[data-tree-node]') || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); resetGesture();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()].slice(0, 2), rect = event.currentTarget.getBoundingClientRect(), start = gesture.current;
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length - rect.x, y = points.reduce((sum, point) => sum + point.y, 0) / points.length - rect.y;
    const distance = points.length === 2 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0;
    const zoom = start.distance > 0 ? Math.max(.08, Math.min(2.5, start.camera.zoom * distance / start.distance)) : start.camera.zoom;
    const next = { zoom, x: start.camera.x + start.x / start.camera.zoom - x / zoom, y: start.camera.y + start.y / start.camera.zoom - y / zoom };
    cameraRef.current = next; setCamera(next);
  }
  function pointerEnd(event: PointerEvent<SVGSVGElement>) { pointers.current.delete(event.pointerId); resetGesture(); }
  function reveal(id: string) { setShowArchived(true); setCollapsed(new Set()); setRevealId(id); }
  function nodeKey(event: React.KeyboardEvent, id: string) {
    const current = byId.get(id)!, list = siblings.get(current.parentId) ?? [], index = list.indexOf(id);
    const target = event.key === 'ArrowLeft' ? current.parentId : event.key === 'ArrowRight' ? siblings.get(id)?.[0] : event.key === 'ArrowUp' ? list[index - 1] : event.key === 'ArrowDown' ? list[index + 1] : null;
    if (event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); }
    if (target) { focusRequest.current = target; select(target); reveal(target); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(id); }
  }
  const viewport = useMemo(() => visibleTree(layout, { x: camera.x, y: camera.y, width: size.width / camera.zoom, height: size.height / camera.zoom }), [layout, camera, size]);
  const visible = viewport.points;
  useEffect(() => { const target = focusRequest.current; if (!target) return; const element = svg.current?.querySelector<SVGGElement>(`[data-tree-node="${CSS.escape(target)}"]`); if (element) { element.focus({ preventScroll: true }); focusRequest.current = null; } }, [camera, selectedId, visible]);
  const scoreDifference = BigInt(state.world.score) - BigInt(activeState.world.score);
  const archiveOwner = selectedPath.find(id => loaded.archivedRootIds.includes(id));
  const comparison = useMemo(() => compareBoards(state, activeState), [state, activeState]);
  const boardDifference = comparison.differences.length, comparisonCells = comparison.total;
  const searchMatches = useMemo(() => {
    const text = query.trim(); if (!text) return [];
    const exact = byId.get(text); if (exact) return [exact];
    const matches = loaded.nodes.filter(item => String(item.depth) === text).slice(0, 30);
    for (const item of loaded.nodes) { if (matches.length >= 30) break; if (String(item.depth) !== text && item.id.includes(text)) matches.push(item); }
    return matches;
  }, [query, loaded.nodes, byId]);

  return <Modal title="历史树与回放" className="tree-modal" onClose={onClose} busy={busy}>
    <div className="tree-toolbar"><span>{loaded.nodes.length} 个节点 · {loaded.checkpoints.length} 个检查点</span>
      <div className="button-row"><button onClick={fit}>适应全树</button><button onClick={() => center(selectedId)}>定位所选</button><button onClick={() => { reveal(active.id); select(active.id); }}>定位保存节点</button>
        <button onClick={() => setCamera(current => ({ ...current, zoom: Math.min(2.5, current.zoom * 1.25) }))} aria-label="放大历史树">＋</button>
        <button onClick={() => setCamera(current => ({ ...current, zoom: Math.max(.08, current.zoom / 1.25) }))} aria-label="缩小历史树">−</button>
        <label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} /> 显示归档</label><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />跟随所选</label></div></div>
    <div className="tree-workspace">
      <div className="tree-main"><div className="tree-canvas" ref={container}>
        <svg ref={svg} viewBox={`${camera.x} ${camera.y} ${size.width / camera.zoom} ${size.height / camera.zoom}`} aria-label="完整历史树，可拖动和缩放" aria-describedby="tree-gesture-help" role="group" tabIndex={0} data-testid="history-tree" data-visible-nodes={visible.length}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
          onKeyDown={event => { if (event.target !== event.currentTarget) return; const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const)[event.key as 'ArrowLeft']; if (direction) { event.preventDefault(); setCamera(current => ({ ...current, x: current.x + direction[0] * 80 / current.zoom, y: current.y + direction[1] * 80 / current.zoom })); } else if (event.key === 'Home') { event.preventDefault(); fit(); } }}>
          {viewport.edges.map(({ parent, child: point }) => {
            return <path key={`edge-${point.node.id}`} className={`tree-edge ${highlighted.has(point.node.id) ? 'on-path' : ''}`} d={`M${parent.x + 128},${parent.y + 27} C${parent.x + 150},${parent.y + 27} ${point.x - 25},${point.y + 27} ${point.x},${point.y + 27}`} />;
          })}
          {visible.map(point => <g key={point.node.id} transform={`translate(${point.x},${point.y})`} data-tree-node={point.node.id}
            className={`tree-node ${highlighted.has(point.node.id) ? 'on-path' : ''} ${point.node.id === selectedId ? 'selected' : ''} ${point.node.id === active.id ? 'active' : ''} ${archived.has(point.node.id) ? 'archived' : ''}`}
            role="button" tabIndex={0} aria-label={`${point.node.depth === 0 ? '起点' : `第 ${point.node.depth} 步`}，节点 ${point.node.id.slice(-6)}，${loaded.states.get(point.node.stateHash)!.world.score} 分`}
            onClick={() => select(point.node.id)} onKeyDown={event => nodeKey(event, point.node.id)}>
            <rect width="128" height="54" rx="8" /><text x="12" y="22">{actionLabel(point.node.action)} {point.node.depth === 0 ? '起点' : `第 ${point.node.depth} 步`}{checkpoints.has(point.node.id) ? ' ★' : ''}</text>
            <text x="12" y="41" className="tree-node-detail">{loaded.states.get(point.node.stateHash)!.world.score} 分 · {point.node.id.slice(-4)}</text>
            {point.collapsed && <text x="112" y="22" textAnchor="end">＋</text>}
          </g>)}
        </svg><TreeOverview layout={layout} camera={camera} size={size} onCenter={(x, y) => setCamera(current => ({ ...current, x: x - size.width / current.zoom / 2, y: y - size.height / current.zoom / 2 }))} /><span className="canvas-hint">{Math.round(camera.zoom * 100)}% · 显示 {visible.length} / {layout.points.length} 节点</span></div>
        <p className="field-hint" id="tree-gesture-help">空白处拖动平移、双指缩放；点总览定位。画布方向键平移，节点左右键前后、上下键切换同级。{viewport.edgeTotal > viewport.edges.length && '密集连线仅显示前 2000 条。'}</p>
        <div className="replay-controls"><strong>路径回放</strong><button disabled={path.length < 2 || busy} onClick={play}>{playing ? '暂停回放' : '播放路径'}</button>
          <button disabled={cursor === 0 || busy} onClick={() => step(cursor - 1)}>上一步</button><button disabled={cursor === path.length - 1 || busy} onClick={() => step(cursor + 1)}>下一步</button>
          <label>速度<select value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={1400}>慢速</option><option value={700}>正常</option><option value={250}>快速</option></select></label>
          <input type="range" aria-label="回放位置" min={0} max={path.length - 1} value={cursor} onChange={event => step(Number(event.target.value))} />
          <small data-testid="replay-position">{cursor + 1} / {path.length} · 只读回放，不改变保存位置</small></div>
      </div>
      <aside className="tree-inspector"><label className="field-label">查找步数或节点 ID<input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如 12 或 ID 末尾" /></label>
        {query && <div className="tree-search">{searchMatches.length ? searchMatches.map(item => <button key={item.id} onClick={() => { reveal(item.id); select(item.id); setQuery(''); }}>第 {item.depth} 步 · {item.id.slice(-6)}</button>) : <p>未找到节点</p>}</div>}
        <div className="mini-board"><Board state={state} nodeId={node.id} disabled onMove={() => {}} /></div>
        <div className="panel-title"><h3>{node.depth === 0 ? '起点' : `第 ${node.depth} 步`}</h3><span className="count">{archived.has(node.id) ? '已归档' : node.id === active.id ? '当前保存' : '历史预览'}</span></div>
        <dl className="inspector-data"><div><dt>节点成绩</dt><dd data-testid="tree-score">{state.world.score}</dd></div><div><dt>有效操作</dt><dd>{state.ledger.effectiveActionCount}</dd></div>
          <div><dt>随机策略</dt><dd>{node.randomContext?.mode === 'reroll' ? '重新抽取' : node.randomContext?.mode === 'reproduce' ? '复现' : node.parentId ? '延续' : '初始'}</dd></div>
          <div><dt>父节点</dt><dd>{node.parentId ? <button className="text-button" onClick={() => select(node.parentId!)}>{node.parentId.slice(-8)} ↑</button> : '无'}</dd></div>
          <div><dt>与当前分差</dt><dd>{scoreDifference > 0n ? '+' : ''}{scoreDifference.toString()}</dd></div><div><dt>棋盘差异</dt><dd>{boardDifference} / {comparisonCells} 格</dd></div><div><dt>规则版本</dt><dd>v{state.ruleRef.version}</dd></div></dl>
        <code className="hash-label" title={node.stateHash}>{node.stateHash.slice(0, 22)}…</code>
        <div className="inspector-actions"><button className="primary" disabled={busy || !canContinue || !state.world.outcome.canContinue} onClick={() => { setPlaying(false); onContinue(node.id); onClose(); }}>从所选节点继续</button>
          <button disabled={!layout.byId.get(node.id)?.children} onClick={() => { setPlaying(false); setCollapsed(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; }); }}>{collapsed.has(node.id) ? '展开后续分支' : '折叠后续分支'}</button>
          <div className="button-row"><button onClick={() => onExport('state', node.id)}>导出此节点</button><button onClick={() => onExport('branch', node.id)}>导出此路径</button></div>
          <button disabled={busy} onClick={onStatistics}>查看路径统计</button>
          <button disabled={busy} onClick={() => { setPlaying(false); setArchiveError(null); void onArchive(archiveOwner ?? node.id, !archiveOwner).catch(error => setArchiveError(String(error))); }}>{archiveOwner ? '恢复此归档分支' : '归档此分支'}</button></div>
        {archiveError && <p role="alert">{archiveError}</p>}
        <p className="muted">回放使用已保存结果。归档只改变标记，所有节点仍可恢复，完整备份包含归档分支。</p>
      </aside>
    </div>
  </Modal>;
}
