import { useState } from 'react';
import type { BoardEditAction, GameState, RuleSetVersion } from '../domain/types';
import { Modal } from './Modal';
import { Board } from './Board';
import { rectangleIndices } from '../domain/editor';

export function BoardEditor({ state, rule, onClose, onCommit }: { state: GameState; rule: RuleSetVersion; onClose: () => void; onCommit: (patches: BoardEditAction['payload']['patches']) => Promise<boolean> }) {
  const original = state.world.board.cells.map(cell => cell.tile?.value ?? null);
  const [versions, setVersions] = useState<(string | null)[][]>([original]), [cursor, setCursor] = useState(0);
  const [brush, setBrush] = useState('2'), [erase, setErase] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState('single'), [anchor, setAnchor] = useState<number | null>(null);
  const values = versions[cursor]!;
  const patches = values.flatMap((value, index) => value !== original[index] ? [{ index, value }] : []);
  function stage(next: (string | null)[]) {
    if (busy || next.every((value, index) => value === values[index])) return;
    const history = [...versions.slice(0, cursor + 1), next].slice(-50); setVersions(history); setCursor(history.length - 1); setError(null); setAnchor(null);
  }
  function paint(index: number) {
    const value = erase ? null : brush;
    if (value !== null && (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > rule.definition.numbers.maxDigits || (rule.definition.numbers.allowedValues !== null && !rule.definition.numbers.allowedValues.includes(value)))) { setError('画笔数字不是合法的非负整数、超过预算或不在允许列表中'); return; }
    if (range === 'rectangle' && anchor === null) { setAnchor(index); setError(null); return; }
    const indices = new Set(range === 'rectangle' ? rectangleIndices(state.world.board.rows, state.world.board.cols, anchor!, index) : [index]);
    setAnchor(null); stage(values.map((old, i) => indices.has(i) ? value : old));
  }
  async function commit() {
    if (busy || !patches.length) return; setBusy(true); setError(null);
    try { if (await onCommit(patches)) onClose(); else setError('编辑未提交，请关闭窗口查看保存提示。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  const preview = structuredClone(state); preview.world.board.cells = values.map((value, index) => ({ tile: value === null ? null : { id: `draft-${index}`, value, attributes: {} } }));
  return <Modal title="编辑本节点棋盘" className="board-editor-modal" busy={busy} onClose={onClose}>
    <p className="muted">点选格子绘制；矩形模式依次选择两个角，批量填入或擦除。草稿可撤销或取消，提交后创建新子节点。</p>
    {!rule.requiredCapabilities.includes('editing-v1') && <p className="migration-note">本次编辑同时派生自定义规则版本，清空技能撤销栈；旧规则和路径保留。</p>}
    <div className="board-edit-tools"><label className="field-label">绘制范围<select value={range} disabled={busy} onChange={event => { setRange(event.target.value); setAnchor(null); }}><option value="single">单格</option><option value="rectangle">矩形区域</option></select></label><label className="field-label">画笔数字<input inputMode="numeric" value={brush} disabled={busy || erase} onChange={event => setBrush(event.target.value)} /></label>
      <label className="check-label"><input type="checkbox" checked={erase} disabled={busy} onChange={event => setErase(event.target.checked)} />清空画笔</label>
      <button disabled={busy} onClick={() => stage(values.map(() => null))}>清空棋盘草稿</button></div>
    <p className="field-hint" role="status">{anchor === null ? range === 'rectangle' ? '请选择矩形的第一个角。' : '点击格子应用画笔。' : `已选起点：第 ${Math.floor(anchor / state.world.board.cols) + 1} 行，第 ${anchor % state.world.board.cols + 1} 列；请选择另一个角。`}{anchor !== null && <button className="text-button" onClick={() => setAnchor(null)}>取消区域</button>}</p>
    <Board state={preview} nodeId="draft" disabled onMove={() => {}} onSelect={busy ? undefined : paint} selectedIndices={[...patches.map(patch => patch.index), ...(anchor === null ? [] : [anchor])]} />
    <div className="button-row draft-actions"><button disabled={busy || cursor === 0} onClick={() => { setCursor(value => value - 1); setError(null); setAnchor(null); }}>撤销草稿</button><button disabled={busy || cursor === versions.length - 1} onClick={() => { setCursor(value => value + 1); setError(null); setAnchor(null); }}>重做草稿</button><button disabled={busy} onClick={() => stage(original)}>还原棋盘草稿</button></div>
    <p className="field-hint">已修改 {patches.length} 格 · 成绩保持 {state.world.score} · 不推进规则回合 · 成功提交增加一次有效操作。已配置的“编辑后”事件随后结算。</p>
    {error && <p role="alert" className="file-error">{error}</p>}
    <div className="board-editor-submit"><span data-testid="draft-change-count">草稿修改 {patches.length} 格</span><button className="primary" disabled={busy || !patches.length || anchor !== null} onClick={() => { void commit(); }}>{busy ? '正在保存…' : '提交棋盘编辑'}</button></div>
  </Modal>;
}
