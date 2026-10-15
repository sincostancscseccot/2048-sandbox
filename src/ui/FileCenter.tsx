import { useEffect, useRef, useState } from 'react';
import type { ImportPlan, LoadedProject, ProjectRecord } from '../domain/types';
import { createArchive, parseImport, prepareImportCopy } from '../files/archive';
import { downloadFile } from '../files/download';
import { archiveLimits } from '../files/safeZip';
import type { ExportKind, ParsedImport } from '../files/types';
import { describeError, repository } from '../persistence/repository';
import { Modal } from './Modal';

interface Props {
  loaded: LoadedProject | null; library: ProjectRecord[]; initialTab: 'export' | 'import'; initialKind: ExportKind;
  selectedNodeId: string | null; canImport: boolean; onClose: () => void; onImported: (id: string) => Promise<void>;
  onBusy: (busy: boolean) => void;
}
const kindNames: Record<ExportKind, string> = { library: '项目库完整备份', project: '完整对局', branch: '到所选节点的路径', state: '所选节点与恢复依赖', rules: '所选对局规则配置' };
const formatSize = (size: number) => size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1048576).toFixed(1)} MiB`;

export function FileCenter({ loaded, library, initialTab, initialKind, selectedNodeId, canImport, onClose, onImported, onBusy }: Props) {
  const [tab, setTab] = useState(initialTab), [kind, setKind] = useState(initialKind);
  const [projectId, setProjectId] = useState(loaded?.project.id ?? library[0]?.id ?? '');
  const [exportProject, setExportProject] = useState(loaded), [nodeId, setNodeId] = useState(selectedNodeId ?? loaded?.project.activeNodeId ?? '');
  const [deltas, setDeltas] = useState(true), [processing, setProcessing] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null), [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null), [plan, setPlan] = useState<ImportPlan | null>(null);
  const [attempted, setAttempted] = useState(false), [imported, setImported] = useState(false), [exportMessage, setExportMessage] = useState('');
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const busy = processing || saving;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    let live = true;
    if (!projectId || loaded?.project.id === projectId) { setExportProject(loaded); return; }
    void repository.load(projectId).then(project => { if (live) { setExportProject(project); setNodeId(project.project.activeNodeId); } })
      .catch(cause => { if (live) setError(describeError(cause)); });
    return () => { live = false; };
  }, [projectId, loaded]);

  async function choose(file: File) {
    if (saving) return;
    const token = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setProcessing(true); setParsed(null); setPlan(null); setError(null); setImported(false); setAttempted(false); setFileName(file.name);
    try {
      if (file.size > archiveLimits.maxCompressed) throw new Error('文件超过 64 MiB 导入上限');
      const content = await parseImport(new Uint8Array(await file.arrayBuffer()), abort.signal);
      const candidate = await prepareImportCopy(content, abort.signal); abort.signal.throwIfAborted();
      if (token === generation.current) { setParsed(content); setPlan(candidate); }
    } catch (cause) { if (token === generation.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (token === generation.current) setProcessing(false); }
  }
  async function importFile() {
    if (!plan || busy || !canImport || imported) return;
    setSaving(true); setError(null); setAttempted(true);
    try {
      const ids = await repository.importCopy(plan);
      const preferred = plan.snapshot.settings.find(setting => setting.key === 'lastProjectId')?.value ?? ids[0]!;
      await onImported(preferred); setImported(true);
    } catch (cause) { setError(describeError(cause)); } finally { setSaving(false); }
  }
  async function exportFile() {
    if (busy) return;
    setSaving(true); setError(null); setExportMessage('');
    try {
      const snapshot = await repository.readSnapshot();
      const result = await createArchive(snapshot, { kind, projectId, nodeId, useDeltas: deltas });
      await downloadFile(result);
      setExportMessage(result.manifest ? `已导出 ${result.manifest.projects.length} 个项目、${result.manifest.nodeCount} 个节点，文件 ${formatSize(result.bytes.length)}。` : '规则配置已导出，可用于新开对局。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); }
  }
  const nodes = exportProject?.nodes ?? [];
  const nodeOptions = [...new Map([...nodes.filter(node => node.id === nodeId), ...nodes.slice(-1000).reverse()].map(node => [node.id, node])).values()];

  return <Modal title="文件与备份" className="files-modal" onClose={onClose} busy={busy}>
    <div className="file-tabs" role="tablist" aria-label="文件操作"><button role="tab" aria-selected={tab === 'export'} disabled={busy} onClick={() => { setTab('export'); setError(null); }}>导出文件</button>
      <button role="tab" aria-selected={tab === 'import'} disabled={busy} onClick={() => { setTab('import'); setError(null); }}>导入与恢复</button></div>
    {tab === 'export' ? <section className="file-export" role="tabpanel" aria-label="导出文件">
      <p className="muted">导出保存过的进度。完整备份包含所有对局、分支、检查点与归档标记。</p>
      <label className="field-label">导出范围<select value={kind} disabled={busy} onChange={event => setKind(event.target.value as ExportKind)}>{Object.entries(kindNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      {kind !== 'library' && library.length > 0 && <label className="field-label">对局<select value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}>{library.map(record => <option key={record.id} value={record.id}>{record.project.name}</option>)}</select></label>}
      {(kind === 'state' || kind === 'branch') && <label className="field-label">选择节点<select value={nodeId} disabled={busy} onChange={event => setNodeId(event.target.value)}>{nodeOptions.map(node => <option key={node.id} value={node.id}>第 {node.depth} 步 · {node.id.slice(-6)} · {exportProject?.states.get(node.stateHash)?.world.score} 分</option>)}</select></label>}
      <div className="file-scope"><strong>{kindNames[kind]}</strong><p>{kind === 'library' ? `${library.length} 个对局，所有历史与归档分支。` : kind === 'project' ? '保留这一局的全部路径与检查点。' : kind === 'rules' ? '导入此规则后可创建新的对局。' : '附带父链、规则与恢复依赖；不包含无关分支。'}{kind === 'state' && '单节点文件仍包含完整恢复所需的依赖节点。'}</p></div>
      {kind !== 'rules' && <label className="check-label"><input type="checkbox" checked={deltas} disabled={busy} onChange={event => setDeltas(event.target.checked)} /> 使用增量快照减小文件体积</label>}
      <p className="muted">默认无损压缩与快照去重，导出不改变当前对局。{nodes.length > 1000 && '较早节点请先在历史树选中，再从节点详情导出。'}</p>
      <button className="primary" disabled={busy || (kind !== 'library' && kind !== 'rules' && !projectId)} onClick={() => { void exportFile(); }}>{saving ? '正在准备文件…' : '下载导出文件'}</button>
      {exportMessage && <p className="file-success" role="status">{exportMessage}</p>}
    </section> : <section className="file-import" role="tabpanel" aria-label="导入与恢复">
      <label className={`dropzone ${busy ? 'busy' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && !busy) void choose(file); }}>
        <span className="drop-symbol" aria-hidden="true">↥</span><strong>{fileName || '选择文件，或拖到这里'}</strong>
        <small>.2048backup / .2048lab / .2048state / 规则 JSON / M1 JSON</small>
        <span className="file-choose-button">{fileName ? '重新选择文件' : '选择文件'}</span>
        <input className="file-input" aria-label="选择存档文件" type="file" accept=".2048backup,.2048lab,.2048state,.json,.zip" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void choose(file); event.target.value = ''; }} />
      </label>
      {processing && <div className="file-processing" role="status">正在检查文件、解压和验证回放…<button className="text-button" onClick={() => { generation.current++; controller.current?.abort(); setProcessing(false); }}>取消检查</button></div>}
      {parsed && plan && <div className="import-preview" data-testid="import-preview"><div className="panel-title"><h3>文件已验证</h3><span className="count">{kindNames[parsed.kind]}</span></div>
        <dl className="import-counts"><div><dt>对局</dt><dd>{parsed.snapshot.projects.length}</dd></div><div><dt>节点</dt><dd>{parsed.snapshot.nodes.length}</dd></div><div><dt>完整状态</dt><dd>{parsed.snapshot.states.length}</dd></div><div><dt>检查点</dt><dd>{parsed.snapshot.checkpoints.length}</dd></div></dl>
        <p className="muted">文件 {formatSize(parsed.compressedBytes)} · 展开 {formatSize(parsed.expandedBytes)}{parsed.deltaCount ? ` · 已还原 ${parsed.deltaCount} 份增量` : ''}</p>
        {parsed.snapshot.projects.map(record => <div className="import-project" key={record.id}><strong>{record.project.name}</strong><small>{parsed.snapshot.nodes.filter(node => node.matchId === record.id).length} 个节点 · {(record.archivedRootIds ?? []).length} 个归档分支</small></div>)}
        {parsed.migrations.map(message => <p className="migration-note" key={message}>兼容迁移：{message}</p>)}
        <p>{parsed.kind === 'rules' ? '使用此规则创建新的对局。' : `导入后创建 ${plan.snapshot.projects.length} 个独立副本。`}原有对局保留，节点 ID、成绩、随机流与状态摘要保持一致。</p>
        {imported ? <div className="file-success" role="status"><strong>已完成导入</strong><p>副本已自动保存，可以开始查看。</p><button className="primary" onClick={onClose}>开始查看</button></div> : <button className="primary" disabled={busy || !canImport} onClick={() => { void importFile(); }}>{saving ? '正在保存副本…' : attempted ? '重试同一批导入' : parsed.kind === 'rules' ? '使用规则新建' : '导入副本'}</button>}
        {!canImport && <p className="muted">请先处理尚未确认的游戏保存，再导入副本。</p>}
      </div>}
      {!parsed && !processing && <p className="muted">先检查并预览，再写入副本。格式未知、摘要损坏或依赖缺失的文件不会修改本地对局。</p>}
    </section>}
    {error && <div className="file-error" role="alert">{error}{attempted && plan && <p>导入批次已保留；重试不会再次创建同一批副本。</p>}</div>}
  </Modal>;
}
