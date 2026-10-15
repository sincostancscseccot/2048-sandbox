import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect, useState } from 'react';

export function OfflineStatus({ blocked }: { blocked: boolean }) {
  if (import.meta.env.MODE === 'android') return <div className="offline-status"><span><span className="status-dot ready" />离线资源已内置</span></div>;
  if (import.meta.env.MODE === 'standalone') return <div className="offline-status"><span><span className="status-dot ready" />单文件网页版 · 请定期导出备份</span></div>;
  return <WebOfflineStatus blocked={blocked} />;
}

function WebOfflineStatus({ blocked }: { blocked: boolean }) {
  const [cached, setCached] = useState(false);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const { offlineReady: [offlineReady], needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisterError() { setRegistrationFailed(true); },
  });
  useEffect(() => {
    let live = true;
    if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.ready.then(registration => { if (live && registration.active) setCached(true); });
    }
    return () => { live = false; };
  }, []);
  const ready = offlineReady || cached;
  return <div className="offline-status">
    <span><span className={`status-dot ${ready ? 'ready' : ''}`} />{import.meta.env.DEV ? '开发预览' : ready ? '离线资源已就绪' : registrationFailed ? '离线资源未就绪' : '正在准备离线资源'}</span>
    {needRefresh && <button className="text-button" disabled={blocked} onClick={() => { if (!blocked) void updateServiceWorker(true); }}>新版本就绪 · 保存后更新</button>}
  </div>;
}
