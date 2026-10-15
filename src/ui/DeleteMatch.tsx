import { useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from '../domain/types';
import { describeError, RevisionConflict } from '../persistence/repository';
import { Modal } from './Modal';

export function DeleteMatch({ record, busy, onDelete, onClose }: {
  record: ProjectRecord; busy: boolean; onDelete: (record: ProjectRecord) => Promise<void>; onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  async function confirm() {
    if (busy) return;
    setError(null);
    try { await onDelete(record); onClose(); }
    catch (cause) {
      setError(cause instanceof RevisionConflict
        ? '此对局已在另一页面更新，本次没有删除。请关闭窗口，在“我的对局”重新选择。'
        : describeError(cause));
    }
  }
  return <Modal title="删除对局" className="delete-modal" busy={busy} onClose={onClose}>
    <p>确定删除这局的全部记录？</p>
    <div className="delete-match-name"><strong>{record.project.name}</strong><small>包括全部历史分支与检查点</small></div>
    <p className="muted">删除后无法撤销。其他对局和已导出的备份仍会保留。</p>
    {error && <p className="file-error" role="alert">{error}</p>}
    <div className="delete-actions"><button ref={cancel} disabled={busy} onClick={onClose}>取消</button>
      <button className="danger-button" disabled={busy} onClick={() => { void confirm(); }}>{busy ? '删除中…' : '确认删除'}</button></div>
  </Modal>;
}
