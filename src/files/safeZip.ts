import { Unzip, UnzipInflate, zip, type Zippable } from 'fflate';
import { ArchiveError } from './types';

export interface ArchiveLimits { maxCompressed: number; maxTotal: number; maxEntry: number; maxEntries: number; maxRatio: number }
export const archiveLimits: ArchiveLimits = { maxCompressed: 64 * 1024 * 1024, maxTotal: 256 * 1024 * 1024, maxEntry: 32 * 1024 * 1024, maxEntries: 50_000, maxRatio: 200 };
interface ZipMeta { name: string; compressed: number; size: number; crc: number; start: number; end: number }

export function assertSafePath(path: string): void {
  if (path.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || /\.(zip|2048lab|2048state|2048backup)$/i.test(path)) {
    throw new ArchiveError(`容器路径无效：${path.slice(0, 100)}`);
  }
}

/** ZIP central and local headers must agree before any decompression starts. */
export function inspectZip(bytes: Uint8Array, limits = archiveLimits): Map<string, ZipMeta> {
  if (bytes.length > limits.maxCompressed) throw new ArchiveError('压缩文件超过 64 MiB 导入上限');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true), u32 = (offset: number) => view.getUint32(offset, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('ZIP 目录缺失或文件被截断');
  const count = u16(eocd + 10), directorySize = u32(eocd + 12), directoryStart = u32(eocd + 16);
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count || count === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff) throw new ArchiveError('不支持分卷或 ZIP64 容器');
  if (count > limits.maxEntries || directoryStart + directorySize !== eocd) throw new ArchiveError('ZIP 条目数或目录范围无效');
  const entries = new Map<string, ZipMeta>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let cursor = directoryStart, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || u32(cursor) !== 0x02014b50) throw new ArchiveError('ZIP 目录条目损坏');
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16), compressed = u32(cursor + 20), size = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), start = u32(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd || start + 30 > directoryStart || u16(cursor + 34)) throw new ArchiveError('ZIP 条目范围无效');
    if (flags & ~(0x800 | 8 | 6) || ![0, 8].includes(method)) throw new ArchiveError('拒绝加密或不支持的 ZIP 压缩方式');
    if ((u32(cursor + 38) >>> 16 & 0xf000) === 0xa000) throw new ArchiveError('拒绝 ZIP 符号链接');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    assertSafePath(name);
    if (entries.has(name)) throw new ArchiveError(`ZIP 路径重复：${name}`);
    if (u32(start) !== 0x04034b50 || u16(start + 6) !== flags || u16(start + 8) !== method) throw new ArchiveError('ZIP 本地头与目录不一致');
    const localNameLength = u16(start + 26), localExtraLength = u16(start + 28);
    const dataStart = start + 30 + localNameLength + localExtraLength;
    if (dataStart > directoryStart || decoder.decode(bytes.subarray(start + 30, start + 30 + localNameLength)) !== name) throw new ArchiveError('ZIP 本地路径不一致');
    let end = dataStart + compressed;
    if (flags & 8) {
      if (end + 12 > directoryStart) throw new ArchiveError('ZIP 数据描述符被截断');
      const offset = u32(end) === 0x08074b50 ? 4 : 0;
      if (end + offset + 12 > directoryStart || u32(end + offset) !== crc || u32(end + offset + 4) !== compressed || u32(end + offset + 8) !== size) throw new ArchiveError('ZIP 数据描述符不一致');
      end += offset + 12;
    } else if (u32(start + 14) !== crc || u32(start + 18) !== compressed || u32(start + 22) !== size) throw new ArchiveError('ZIP 长度或校验头不一致');
    total += size;
    if (end > directoryStart || size > limits.maxEntry || total > limits.maxTotal || size > Math.max(1, compressed) * limits.maxRatio) throw new ArchiveError('ZIP 解压大小或压缩比超过上限');
    entries.set(name, { name, compressed, size, crc, start, end });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== eocd) throw new ArchiveError('ZIP 目录包含未识别内容');
  let end = 0;
  for (const entry of [...entries.values()].sort((a, b) => a.start - b.start)) {
    if (entry.start !== end) throw new ArchiveError('ZIP 数据重叠或包含额外本地条目');
    end = entry.end;
  }
  if (end !== directoryStart) throw new ArchiveError('ZIP 数据范围不完整');
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export async function extractZip(bytes: Uint8Array, signal?: AbortSignal, limits = archiveLimits): Promise<Map<string, Uint8Array>> {
  const metadata = inspectZip(bytes, limits), result = new Map<string, Uint8Array>();
  let failure: Error | null = null, total = 0;
  const unzip = new Unzip(file => {
    const meta = metadata.get(file.name);
    if (!meta || failure) { file.terminate(); return; }
    let size = 0, crc = 0xffffffff; const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) { failure = error; return; }
      if (failure) return;
      size += chunk.length; total += chunk.length;
      if (size > meta.size || size > limits.maxEntry || total > limits.maxTotal || size > Math.max(1, meta.compressed) * limits.maxRatio) {
        failure = new ArchiveError('实际解压输出超过上限'); file.terminate(); return;
      }
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
      chunks.push(chunk);
      if (final) {
        if (size !== meta.size || (crc ^ 0xffffffff) >>> 0 !== meta.crc) { failure = new ArchiveError(`ZIP 条目长度或 CRC 损坏：${file.name}`); return; }
        const content = new Uint8Array(size); let offset = 0;
        for (const part of chunks) { content.set(part, offset); offset += part.length; }
        result.set(file.name, content);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    signal?.throwIfAborted();
    unzip.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length);
    if (failure) throw failure;
    if (offset % (16384 * 8) === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (result.size !== metadata.size) throw new ArchiveError('ZIP 条目解压不完整');
  return result;
}

export async function compressZip(entries: Record<string, Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const files: Zippable = {};
  for (const [path, bytes] of Object.entries(entries)) {
    assertSafePath(path);
    files[path] = [bytes, { level: path === 'manifest.json' ? 0 : 6 }];
  }
  return new Promise((resolve, reject) => { zip(files, { level: 6 }, (error, bytes) => error ? reject(error) : resolve(new Uint8Array(bytes))); });
}
