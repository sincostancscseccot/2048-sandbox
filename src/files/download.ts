import type { ExportResult } from './types';

interface AndroidFiles {
  begin(id: string, filename: string, mime: string, size: number): boolean;
  append(id: string, base64: string): boolean;
  finish(id: string): boolean;
  abort(id: string): void;
}
declare global { interface Window { AndroidFiles?: AndroidFiles } }

async function saveAndroid(bridge: AndroidFiles, file: Pick<ExportResult, 'bytes' | 'filename'>, mime: string): Promise<void> {
  const id = crypto.randomUUID();
  if (!bridge.begin(id, file.filename, mime, file.bytes.length)) throw new Error('暂时无法准备导出文件，请等待上一份文件保存完成后重试。');
  try {
    for (let offset = 0; offset < file.bytes.length; offset += 32768) {
      const base64 = btoa(String.fromCharCode(...file.bytes.subarray(offset, offset + 32768)));
      if (!bridge.append(id, base64)) throw new Error('导出文件传输失败，请重试。');
      // Yield between chunks so large backups do not freeze the game.
      if (offset % (32768 * 8) === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    await new Promise<void>((resolve, reject) => {
      const complete = (event: Event) => {
        const detail = (event as CustomEvent<{ id: string; status: string; message?: string }>).detail;
        if (detail?.id !== id) return;
        cleanup();
        if (detail.status === 'saved') resolve();
        else reject(new Error(detail.message ?? '已取消保存文件。'));
      };
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('sandbox-native-download', complete); };
      const timer = setTimeout(() => { cleanup(); bridge.abort(id); reject(new Error('文件保存等待超时，请重试。')); }, 10 * 60 * 1000);
      window.addEventListener('sandbox-native-download', complete);
      if (!bridge.finish(id)) { cleanup(); reject(new Error('无法打开文件保存窗口，请重试。')); }
    });
  } catch (cause) { bridge.abort(id); throw cause; }
}

export async function downloadFile(file: Pick<ExportResult, 'bytes' | 'filename'>): Promise<void> {
  const mime = file.filename.endsWith('.json') ? 'application/json' : 'application/zip';
  if (window.AndroidFiles) { await saveAndroid(window.AndroidFiles, file, mime); return; }
  const url = URL.createObjectURL(new Blob([file.bytes], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
