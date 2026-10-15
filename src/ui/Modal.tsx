import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, children, onClose, busy = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={`modal ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal-inner"><div className="modal-heading"><div><div className="eyebrow">2048 SANDBOX</div><h2>{title}</h2></div>
      <button className="text-button modal-close" disabled={busy} aria-label="关闭窗口" onClick={onClose}>×</button></div>{children}</div>
  </dialog>;
}
