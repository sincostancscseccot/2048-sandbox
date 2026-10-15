import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../../src/files/download';

afterEach(() => vi.unstubAllGlobals());

function native(status: 'saved' | 'cancelled' = 'saved', appendFails = false) {
  const target = new EventTarget();
  const chunks: string[] = [];
  const bridge = {
    begin: vi.fn(() => true),
    append: vi.fn((_id: string, chunk: string) => { chunks.push(chunk); return !appendFails; }),
    finish: vi.fn((id: string) => { queueMicrotask(() => target.dispatchEvent(new CustomEvent('sandbox-native-download', { detail: { id, status } }))); return true; }),
    abort: vi.fn(),
  };
  vi.stubGlobal('window', Object.assign(target, { AndroidFiles: bridge }));
  return { bridge, chunks };
}

describe('Android backup download', () => {
  it('preserves every byte through bounded chunks and waits for save completion', async () => {
    const { bridge, chunks } = native();
    const bytes = Uint8Array.from({ length: 100003 }, (_, index) => index % 256);
    await downloadFile({ filename: '2048-library.2048backup', bytes });
    expect(bridge.begin).toHaveBeenCalledWith(expect.any(String), '2048-library.2048backup', 'application/zip', bytes.length);
    expect(chunks).toHaveLength(4);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(Buffer.from(bytes));
    expect(bridge.finish).toHaveBeenCalledOnce();
    expect(bridge.abort).not.toHaveBeenCalled();
  });
  it('reports cancellation and releases the transfer instead of claiming success', async () => {
    const { bridge } = native('cancelled');
    await expect(downloadFile({ filename: 'rules.json', bytes: new Uint8Array([1, 2]) })).rejects.toThrow('已取消保存');
    expect(bridge.abort).toHaveBeenCalledOnce();
  });
  it('stops and releases a failed chunk before opening a save picker', async () => {
    const { bridge } = native('saved', true);
    await expect(downloadFile({ filename: 'rules.json', bytes: new Uint8Array([1, 2]) })).rejects.toThrow('传输失败');
    expect(bridge.finish).not.toHaveBeenCalled();
    expect(bridge.abort).toHaveBeenCalledOnce();
  });
  it('does not abort another pending export when the native bridge is busy', async () => {
    const { bridge } = native(); bridge.begin.mockReturnValue(false);
    await expect(downloadFile({ filename: 'rules.json', bytes: new Uint8Array([1]) })).rejects.toThrow('上一份文件');
    expect(bridge.append).not.toHaveBeenCalled();
    expect(bridge.abort).not.toHaveBeenCalled();
  });
});
