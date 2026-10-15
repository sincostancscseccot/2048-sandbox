import { useEffect, useMemo, useState } from 'react';
import type { LoadedProject } from '../domain/types';
import { actionLabel } from '../domain/actions';

interface Props { loaded: LoadedProject; selectedId: string; busy: boolean; onPreview: (id: string) => void; onOpenTree: () => void }

export function History({ loaded, selectedId, busy, onPreview, onOpenTree }: Props) {
  const [page, setPage] = useState(0);
  const all = useMemo(() => [...loaded.nodes].reverse(), [loaded.nodes]);
  const selectedIndex = all.findIndex(node => node.id === selectedId);
  useEffect(() => { setPage(current => selectedIndex >= current * 60 && selectedIndex < (current + 1) * 60 ? current : Math.max(0, Math.floor(selectedIndex / 60))); }, [selectedIndex]);
  const visible = all.slice(page * 60, (page + 1) * 60);
  const checkpointNodes = new Set(loaded.checkpoints.map(item => item.nodeId));
  const children = new Map<string, number>();
  for (const node of loaded.nodes) if (node.parentId) children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
  return <section className="history-panel" aria-labelledby="history-title">
    <div className="panel-title"><h2 id="history-title">每一步的来处</h2><span className="count">{all.length} 个节点</span></div>
    <p className="muted history-intro">点选回看。成绩属于当时的节点。</p>
    <button className="open-tree" disabled={busy} onClick={onOpenTree}>打开完整历史树 ↗</button>
    <div className="history-list">
      {visible.map(node => {
        const state = loaded.states.get(node.stateHash)!;
        const active = node.id === loaded.project.activeNodeId;
        const checkpoint = checkpointNodes.has(node.id);
        const branched = node.parentId && (children.get(node.parentId) ?? 0) > 1;
        return <button key={node.id} className={`history-item ${node.id === selectedId ? 'selected' : ''}`} disabled={busy}
          onClick={() => onPreview(node.id)} aria-pressed={node.id === selectedId} data-node-id={node.id}>
          <span className="history-glyph" aria-hidden="true">{actionLabel(node.action)}</span>
          <span className="history-copy"><strong>{node.depth === 0 ? '起点' : `第 ${node.depth} 步`}{checkpoint && ' · ★'}{branched && ' · 分支'}</strong>
            <small>{active ? '当前保存位置' : `节点 ${node.id.slice(-6)}`}{node.randomContext?.mode === 'reproduce' ? ' · 复现' : ''}</small></span>
          <span className="history-score">{state.world.score}<small>分</small></span>
        </button>;
      })}
    </div>
    {all.length > 60 && <div className="history-pages"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>更新 60 条</button><span>{page + 1} / {Math.ceil(all.length / 60)}</span><button disabled={(page + 1) * 60 >= all.length} onClick={() => setPage(value => value + 1)}>更早 60 条</button></div>}
    <p className="history-note">回看免费，不增加有效操作数。<br />原有路径会一直保留。</p>
  </section>;
}
