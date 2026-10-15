import type { LibrarySnapshot } from '../domain/types';

export type ExportKind = 'state' | 'branch' | 'project' | 'library' | 'rules';
export interface ExportSelection { kind: ExportKind; projectId?: string; nodeId?: string; useDeltas?: boolean }
export interface ArchiveEntry { path: string; kind: 'project' | 'rule' | 'node-index' | 'node-part' | 'state' | 'delta'; bytes: number; hash: string }
export interface StateEntry { hash: string; path: string; encoding: 'full' | 'delta'; baseHash: string | null }
export interface ArchiveManifest {
  format: '2048-sandbox'; formatVersion: 1; exportKind: Exclude<ExportKind, 'rules'>; exportedAt: string;
  requiredCapabilities: string[]; entryCount: number; nodeCount: number; stateCount: number; entries: ArchiveEntry[];
  projects: { sourceProjectId: string; documentPath: string; indexPath: string; selectedNodeIds: string[]; rootNodeIds: string[] }[];
  states: StateEntry[]; settings: LibrarySnapshot['settings'];
}
export interface Patch { op: 'replace' | 'add'; path: string[]; value: unknown }
export interface StateDelta { deltaVersion: 1; baseStateHash: string; resultStateHash: string; patches: Patch[] }
export interface ParsedImport {
  snapshot: LibrarySnapshot; sourceHash: string; sourceFormat: string; kind: ExportKind; migrations: string[];
  compressedBytes: number; expandedBytes: number; deltaCount: number;
}
export interface ExportResult { bytes: Uint8Array<ArrayBuffer>; filename: string; manifest: ArchiveManifest | null }
export class ArchiveError extends Error { constructor(message: string) { super(message); this.name = 'ArchiveError'; } }
