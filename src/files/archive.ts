import { canonicalJson, hashBytes, hashJson, newId, timestamp } from '../domain/hash';
import type { GameState, HistoryNode, ImportPlan, LibrarySnapshot, RuleSetVersion } from '../domain/types';
import { assertContract, assertCoreState } from '../domain/validation';
import { prepareNewMatch } from '../history/candidates';
import { verifyLibrary } from '../history/verify';
import { classicRule } from '../presets/classic';
import { assertSupportedRule, ruleCapabilities } from '../presets/rules';
import { applyDelta, createDelta } from './delta';
import { archiveLimits, assertSafePath, compressZip, extractZip } from './safeZip';
import { ArchiveError, type ArchiveManifest, type ExportResult, type ExportSelection, type ParsedImport, type StateDelta, type StateEntry } from './types';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const supportedCapabilities = new Set([...ruleCapabilities, 'archive-v1', 'pcg32-xsh-rr-v1', 'state-delta-v1']);
const jsonBytes = (value: unknown) => encoder.encode(canonicalJson(value));

function parseJson(bytes: Uint8Array, label: string): unknown {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { throw new ArchiveError(`JSON 或 UTF-8 损坏：${label}`); }
  const stack = [{ value, depth: 0 }]; let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > 2_000_000 || current.depth > 64) throw new ArchiveError(`JSON 结构超过解析预算：${label}`);
    if (current.value && typeof current.value === 'object') {
      for (const [key, child] of Object.entries(current.value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ArchiveError(`不允许的 JSON 字段：${key}`);
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

export function selectSnapshot(source: LibrarySnapshot, selection: ExportSelection): LibrarySnapshot {
  const selectedProjects = selection.kind === 'library' ? source.projects : source.projects.filter(record => record.id === selection.projectId);
  if (selection.kind !== 'library' && !selectedProjects.length) throw new ArchiveError('请先选择一个对局');
  const result: LibrarySnapshot = { projects: [], nodes: [], states: [], rules: [], checkpoints: [], settings: [] };
  const states = new Map(source.states.map(record => [record.hash, record]));
  for (const record of selectedProjects) {
    const nodes = source.nodes.filter(node => node.matchId === record.id), byId = new Map(nodes.map(node => [node.id, node]));
    const partial = selection.kind === 'state' || selection.kind === 'branch';
    const selected = selection.nodeId ?? record.project.activeNodeId;
    const included = new Set<string>(); const pending = partial ? [selected] : nodes.map(node => node.id);
    const queued = new Set(pending);
    function enqueue(id: string) { if (!queued.has(id)) { queued.add(id); pending.push(id); } }
    while (pending.length) {
      const id = pending.pop()!;
      if (included.has(id)) continue;
      const node = byId.get(id); if (!node) throw new ArchiveError(`导出依赖节点缺失：${id}`);
      const state = states.get(node.stateHash)?.state; if (!state) throw new ArchiveError('导出依赖快照缺失');
      included.add(id);
      if (node.parentId) enqueue(node.parentId);
      if (node.undoTargetId) enqueue(node.undoTargetId);
      for (const target of state.undoStack) enqueue(target);
    }
    result.projects.push({ ...structuredClone(record),
      archivedRootIds: (record.archivedRootIds ?? []).filter(id => included.has(id)),
      project: { ...structuredClone(record.project), activeNodeId: partial ? selected : record.project.activeNodeId,
        rootNodeIds: record.project.rootNodeIds.filter(id => included.has(id)) } });
    result.nodes.push(...nodes.filter(node => included.has(node.id)));
    result.checkpoints.push(...source.checkpoints.filter(checkpoint => checkpoint.projectId === record.id && included.has(checkpoint.nodeId)));
  }
  const hashes = new Set(result.nodes.map(node => node.stateHash));
  result.states = source.states.filter(record => hashes.has(record.hash));
  const ruleKeys = new Set(result.states.map(record => `${record.state.ruleRef.id}/${record.state.ruleRef.version}`));
  result.rules = source.rules.filter(rule => ruleKeys.has(`${rule.id}/${rule.version}`));
  const preferred = source.settings.find(setting => setting.key === 'lastProjectId')?.value;
  const lastId = result.projects.some(record => record.id === preferred) ? preferred : result.projects[0]?.id;
  if (lastId) result.settings = [{ key: 'lastProjectId', value: lastId }];
  return result;
}

export async function createArchive(source: LibrarySnapshot, selection: ExportSelection): Promise<ExportResult> {
  if (selection.kind === 'rules') {
    const record = source.projects.find(item => item.id === selection.projectId);
    if (selection.projectId && !record) throw new ArchiveError('所选对局不存在');
    const node = record ? source.nodes.find(item => item.matchId === record.id && item.id === record.project.activeNodeId) : undefined;
    const ref = source.states.find(item => item.hash === node?.stateHash)?.state.ruleRef;
    if (record && !ref) throw new ArchiveError('所选对局的活跃节点或状态缺失');
    const rule = ref ? source.rules.find(item => item.id === ref.id && item.version === ref.version) : classicRule;
    if (!rule) throw new ArchiveError('所选对局的规则缺失');
    assertSupportedRule(rule);
    if (await hashJson(rule.definition) !== rule.definitionHash) throw new ArchiveError('规则摘要不匹配');
    return { bytes: jsonBytes(rule), filename: `${rule.id}-v${rule.version}.json`, manifest: null };
  }
  const snapshot = selectSnapshot(source, selection);
  assertContract('LibrarySnapshot', snapshot); await verifyLibrary(snapshot);
  const manifest: ArchiveManifest = {
    format: '2048-sandbox', formatVersion: 1, exportKind: selection.kind, exportedAt: timestamp(),
    requiredCapabilities: [...new Set(['archive-v1', 'core-v1', 'pcg32-xsh-rr-v1', ...snapshot.rules.flatMap(rule => rule.requiredCapabilities)])], entryCount: 0,
    nodeCount: snapshot.nodes.length, stateCount: snapshot.states.length, entries: [], projects: [], states: [], settings: snapshot.settings,
  };
  const files: Record<string, Uint8Array> = {};
  let uncompressedTotal = 0;
  async function add(path: string, kind: ArchiveManifest['entries'][number]['kind'], bytes: Uint8Array) {
    assertSafePath(path);
    if (Object.hasOwn(files, path) || bytes.length > archiveLimits.maxEntry) throw new ArchiveError('导出条目重复或超过单项大小上限');
    uncompressedTotal += bytes.length;
    if (uncompressedTotal > archiveLimits.maxTotal || manifest.entries.length + 2 > archiveLimits.maxEntries) throw new ArchiveError('导出总大小或条目数超过当前容器上限');
    files[path] = bytes; manifest.entries.push({ path, kind, bytes: bytes.length, hash: await hashBytes(bytes) });
  }
  for (const record of snapshot.projects) {
    const prefix = selection.kind === 'library' ? `projects/${record.id}/` : '';
    const documentPath = `${prefix}project.json`, indexPath = `${prefix}nodes/${record.id}/index.json`;
    manifest.projects.push({ sourceProjectId: record.id, documentPath, indexPath,
      rootNodeIds: record.project.rootNodeIds, selectedNodeIds: [record.project.activeNodeId] });
    await add(documentPath, 'project', jsonBytes({ record, checkpoints: snapshot.checkpoints.filter(checkpoint => checkpoint.projectId === record.id) }));
    const nodes = snapshot.nodes.filter(node => node.matchId === record.id).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
    const parts: { path: string; count: number }[] = [];
    for (let offset = 0; offset < nodes.length; offset += 512) {
      const group = nodes.slice(offset, offset + 512), path = `${prefix}nodes/${record.id}/part-${String(parts.length + 1).padStart(6, '0')}.jsonl`;
      await add(path, 'node-part', encoder.encode(group.map(canonicalJson).join('\n') + '\n'));
      parts.push({ path, count: group.length });
    }
    await add(indexPath, 'node-index', jsonBytes({ matchId: record.id, count: nodes.length, parts }));
  }
  for (const rule of snapshot.rules) await add(`rules/${rule.id}/${rule.version}.json`, 'rule', jsonBytes(rule));
  const stateMap = new Map(snapshot.states.map(record => [record.hash, record.state]));
  const encoded = new Map<string, { depth: number }>();
  const nodes = snapshot.nodes.slice().sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const nodeMap = new Map(nodes.map(node => [`${node.matchId}/${node.id}`, node]));
  const checkpointHashes = new Set(snapshot.checkpoints.map(checkpoint => nodeMap.get(`${checkpoint.projectId}/${checkpoint.nodeId}`)!.stateHash));
  for (const node of nodes) {
    if (encoded.has(node.stateHash)) continue;
    const state = stateMap.get(node.stateHash)!, full = jsonBytes(state);
    const parent = node.parentId ? nodeMap.get(`${node.matchId}/${node.parentId}`) : undefined;
    const base = parent ? stateMap.get(parent.stateHash) : undefined;
    const baseDepth = parent ? encoded.get(parent.stateHash)?.depth : undefined;
    let delta: StateDelta | null = null;
    if (selection.useDeltas !== false && base && parent && baseDepth !== undefined && baseDepth < 31 && node.depth % 32 !== 0 && !checkpointHashes.has(node.stateHash) && node.action?.type !== 'rule-edit' && !(node.action?.type === 'edit' && node.action.payload.nextRuleRef) && !(node.action?.type === 'skill' && node.action.payload.skillId === 'undo')) {
      const candidate = createDelta(base, state, parent.stateHash, node.stateHash);
      if (jsonBytes(candidate).length < full.length) delta = candidate;
    }
    const path = `${delta ? 'deltas' : 'states'}/${node.stateHash.slice(7)}.json`;
    await add(path, delta ? 'delta' : 'state', delta ? jsonBytes(delta) : full);
    manifest.states.push({ hash: node.stateHash, path, encoding: delta ? 'delta' : 'full', baseHash: delta?.baseStateHash ?? null });
    encoded.set(node.stateHash, { depth: delta ? baseDepth! + 1 : 0 });
  }
  if (manifest.states.some(state => state.encoding === 'delta')) manifest.requiredCapabilities.push('state-delta-v1');
  manifest.entryCount = manifest.entries.length;
  assertContract('Manifest', manifest);
  files['manifest.json'] = jsonBytes(manifest);
  if (files['manifest.json'].length > archiveLimits.maxEntry || uncompressedTotal + files['manifest.json'].length > archiveLimits.maxTotal) throw new ArchiveError('导出清单或总大小超过当前容器上限');
  const bytes = await compressZip(files);
  // Do not generate files this application would refuse to recover.
  await extractZip(bytes);
  const extension = selection.kind === 'library' ? '2048backup' : selection.kind === 'state' ? '2048state' : '2048lab';
  return { bytes, filename: `2048-${selection.kind}-${timestamp().slice(0, 10)}.${extension}`, manifest };
}

async function readContainer(bytes: Uint8Array, signal?: AbortSignal): Promise<Omit<ParsedImport, 'sourceHash' | 'compressedBytes'>> {
  const files = await extractZip(bytes, signal), manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new ArchiveError('缺少 manifest.json');
  const raw = parseJson(manifestBytes, 'manifest.json') as Partial<ArchiveManifest>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArchiveError('容器清单必须为对象');
  if (raw.formatVersion !== 1) throw new ArchiveError(`不支持的容器版本：${String(raw.formatVersion)}，没有可用迁移器`);
  assertContract('Manifest', raw); const manifest = raw as ArchiveManifest;
  const unsupported = manifest.requiredCapabilities.filter(capability => !supportedCapabilities.has(capability));
  if (unsupported.length) throw new ArchiveError(`此版本不支持这些能力：${unsupported.join('、')}`);
  if (['archive-v1', 'core-v1', 'pcg32-xsh-rr-v1'].some(capability => !manifest.requiredCapabilities.includes(capability))) throw new ArchiveError('清单缺少必要的能力声明');
  if (manifest.entryCount !== manifest.entries.length || files.size !== manifest.entries.length + 1) throw new ArchiveError('清单条目数不一致');
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  if (entries.size !== manifest.entries.length || entries.has('manifest.json')) throw new ArchiveError('清单路径重复或自引用');
  let expandedBytes = manifestBytes.length;
  for (const entry of entries.values()) {
    signal?.throwIfAborted(); assertSafePath(entry.path);
    const content = files.get(entry.path);
    if (!content || content.length !== entry.bytes || await hashBytes(content) !== entry.hash) throw new ArchiveError(`条目摘要或长度不匹配：${entry.path}`);
    expandedBytes += content.length;
  }
  const consumed = new Set<string>();
  function take(path: string, kind: string): Uint8Array {
    if (entries.get(path)?.kind !== kind || consumed.has(path)) throw new ArchiveError(`条目类型、引用或重复使用无效：${path}`);
    consumed.add(path); return files.get(path)!;
  }
  const snapshot: LibrarySnapshot = { projects: [], nodes: [], states: [], rules: [], checkpoints: [], settings: manifest.settings };
  if (manifest.exportKind !== 'library' && manifest.projects.length !== 1) throw new ArchiveError('单项目容器的项目数无效');
  for (const descriptor of manifest.projects) {
    signal?.throwIfAborted();
    const prefix = manifest.exportKind === 'library' ? `projects/${descriptor.sourceProjectId}/` : '';
    if (descriptor.documentPath !== `${prefix}project.json` || descriptor.indexPath !== `${prefix}nodes/${descriptor.sourceProjectId}/index.json`) throw new ArchiveError('项目命名空间不一致');
    const payload = parseJson(take(descriptor.documentPath, 'project'), descriptor.documentPath) as { record: LibrarySnapshot['projects'][number]; checkpoints: LibrarySnapshot['checkpoints'] };
    assertContract('ProjectPayload', payload);
    if (payload.record.id !== descriptor.sourceProjectId || canonicalJson(payload.record.project.rootNodeIds) !== canonicalJson(descriptor.rootNodeIds)) throw new ArchiveError('项目根清单不一致');
    snapshot.projects.push(payload.record); snapshot.checkpoints.push(...payload.checkpoints);
    const index = parseJson(take(descriptor.indexPath, 'node-index'), descriptor.indexPath) as { matchId: string; count: number; parts: { path: string; count: number }[] };
    assertContract('NodeIndex', index);
    if (index.matchId !== descriptor.sourceProjectId) throw new ArchiveError('节点索引所属项目不一致');
    const projectNodes: HistoryNode[] = [];
    for (const part of index.parts) {
      signal?.throwIfAborted();
      if (!part.path.startsWith(`${prefix}nodes/${descriptor.sourceProjectId}/part-`) || !/part-[0-9]{6}\.jsonl$/.test(part.path)) throw new ArchiveError('节点分段路径不一致');
      const lines = decoder.decode(take(part.path, 'node-part')).split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (lines.length !== part.count || lines.length > 512 || lines.some(line => !line) || projectNodes.length + lines.length > 100000) throw new ArchiveError('节点分段数量无效');
      projectNodes.push(...lines.map(line => parseJson(encoder.encode(line), part.path) as HistoryNode));
    }
    if (projectNodes.length !== index.count || !descriptor.selectedNodeIds.includes(payload.record.project.activeNodeId) || descriptor.selectedNodeIds.some(id => !projectNodes.some(node => node.id === id)) || projectNodes.some(node => node.matchId !== descriptor.sourceProjectId)) throw new ArchiveError('节点索引数量或选择位置不一致');
    snapshot.nodes.push(...projectNodes);
  }
  for (const entry of entries.values()) if (entry.kind === 'rule') {
    const rule = parseJson(take(entry.path, 'rule'), entry.path) as RuleSetVersion;
    assertContract('RuleSetVersion', rule);
    if (entry.path !== `rules/${rule.id}/${rule.version}.json`) throw new ArchiveError('规则条目路径不一致');
    assertSupportedRule(rule);
    if (rule.requiredCapabilities.some(capability => !manifest.requiredCapabilities.includes(capability))) throw new ArchiveError('清单缺少规则所需能力声明');
    snapshot.rules.push(rule);
  }
  const references = new Map(manifest.states.map(entry => [entry.hash, entry]));
  if (references.size !== manifest.states.length) throw new ArchiveError('状态清单重复');
  const decoded = new Map<string, GameState>(), deltas = new Map<string, StateDelta>();
  for (const entry of manifest.states) {
    signal?.throwIfAborted();
    const expected = `${entry.encoding === 'full' ? 'states' : 'deltas'}/${entry.hash.slice(7)}.json`;
    if (entry.path !== expected) throw new ArchiveError('状态地址不一致');
    const value = parseJson(take(entry.path, entry.encoding === 'full' ? 'state' : 'delta'), entry.path);
    if (entry.encoding === 'full') {
      if (entry.baseHash !== null) throw new ArchiveError('完整快照不能引用增量基础');
      assertCoreState(value as GameState);
      if (await hashJson(value) !== entry.hash) throw new ArchiveError('完整状态摘要不匹配');
      decoded.set(entry.hash, value as GameState);
    } else {
      assertContract('Delta', value); const delta = value as StateDelta;
      if (delta.resultStateHash !== entry.hash || delta.baseStateHash !== entry.baseHash) throw new ArchiveError('增量清单与内容不一致');
      deltas.set(entry.hash, delta);
    }
  }
  const depths = new Map([...decoded.keys()].map(hash => [hash, 0]));
  for (const entry of manifest.states) {
    signal?.throwIfAborted();
    const chain: StateEntry[] = [], visiting = new Set<string>(); let cursor = entry;
    while (!decoded.has(cursor.hash)) {
      if (visiting.has(cursor.hash) || chain.length >= 32 || !cursor.baseHash) throw new ArchiveError('增量循环、缺少基础或链长超过 32');
      visiting.add(cursor.hash); chain.push(cursor);
      const base = references.get(cursor.baseHash); if (!base) throw new ArchiveError('增量基础快照缺失'); cursor = base;
    }
    for (const current of chain.reverse()) {
      signal?.throwIfAborted();
      const depth = depths.get(current.baseHash!)! + 1;
      if (depth > 32) throw new ArchiveError('增量链长超过 32');
      const state = applyDelta(decoded.get(current.baseHash!)!, deltas.get(current.hash)!);
      if (await hashJson(state) !== current.hash) throw new ArchiveError('增量结果摘要不匹配');
      decoded.set(current.hash, state); depths.set(current.hash, depth);
    }
  }
  snapshot.states = [...decoded].map(([hash, state]) => ({ hash, state }));
  if (deltas.size && !manifest.requiredCapabilities.includes('state-delta-v1')) throw new ArchiveError('清单缺少增量格式能力声明');
  if (consumed.size !== entries.size || snapshot.nodes.length !== manifest.nodeCount || snapshot.states.length !== manifest.stateCount) throw new ArchiveError('存在未引用条目或节点/状态计数不一致');
  assertContract('LibrarySnapshot', snapshot); await verifyLibrary(snapshot, { signal });
  return { snapshot, sourceFormat: 'archive-v1', kind: manifest.exportKind, migrations: [], expandedBytes, deltaCount: deltas.size };
}

export async function parseImport(bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedImport> {
  if (bytes.length > archiveLimits.maxCompressed) throw new ArchiveError('文件超过 64 MiB 导入上限');
  signal?.throwIfAborted(); const sourceHash = await hashBytes(bytes);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { ...await readContainer(bytes, signal), sourceHash, compressedBytes: bytes.length };
  if (bytes.length > archiveLimits.maxEntry) throw new ArchiveError('JSON 文件超过 32 MiB 上限');
  const raw = parseJson(bytes, 'JSON 文件') as Record<string, unknown>;
  let snapshot: LibrarySnapshot, sourceFormat: string, kind: ParsedImport['kind'], migrations: string[] = [];
  if (raw?.format === '2048-sandbox-m1-backup') {
    if (raw.schemaVersion !== 1) throw new ArchiveError(`不支持的 M1 备份版本：${String(raw.schemaVersion)}`);
    const { format: _format, schemaVersion: _version, exportedAt, ...payload } = raw;
    if (typeof exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(exportedAt)) throw new ArchiveError('M1 备份缺少有效导出时间');
    assertContract('LibrarySnapshot', payload); snapshot = payload as unknown as LibrarySnapshot;
    sourceFormat = 'm1-json-v1'; kind = 'library'; migrations = ['M1 JSON v1 → M2 完整快照库；原文件与原节点摘要保持不变'];
  } else if (raw && typeof raw === 'object' && 'definition' in raw) {
    assertContract('RuleSetVersion', raw);
    const rule = raw as unknown as RuleSetVersion;
    assertSupportedRule(rule);
    if (await hashJson(rule.definition) !== rule.definitionHash) throw new ArchiveError('规则摘要不匹配');
    const candidate = await prepareNewMatch(`${rule.name}新对局`, undefined, rule);
    snapshot = { projects: [{ id: candidate.project.id, project: candidate.project, updatedAt: candidate.node.createdAt }],
      nodes: [candidate.node], states: [{ hash: candidate.node.stateHash, state: candidate.state }], rules: [candidate.rule], checkpoints: [], settings: [{ key: 'lastProjectId', value: candidate.project.id }] };
    sourceFormat = 'rule-json-v1'; kind = 'rules';
  } else throw new ArchiveError('无法识别文件格式或缺少可用迁移器');
  await verifyLibrary(snapshot, { signal }); signal?.throwIfAborted();
  return { snapshot, sourceHash, sourceFormat, kind, migrations, compressedBytes: bytes.length, expandedBytes: bytes.length, deltaCount: 0 };
}

export async function prepareImportCopy(parsed: ParsedImport, signal?: AbortSignal): Promise<ImportPlan> {
  signal?.throwIfAborted();
  if (!parsed.snapshot.projects.length) throw new ArchiveError('文件中没有可导入的对局');
  const snapshot = structuredClone(parsed.snapshot), id = newId('import'), importedAt = timestamp();
  const mappings = new Map(snapshot.projects.map(record => [record.id, newId('match')]));
  for (const record of snapshot.projects) {
    const sourceProjectId = record.id, localId = mappings.get(sourceProjectId)!;
    record.id = localId; record.project.id = localId; record.project.name = record.project.name.slice(0, 4000) + '（导入副本）';
    record.updatedAt = importedAt;
    record.origin = { batchId: id, sourceProjectId, sourceHash: parsed.sourceHash, importedAt, sourceFormat: parsed.sourceFormat };
  }
  for (const node of snapshot.nodes) node.matchId = mappings.get(node.matchId)!;
  for (const checkpoint of snapshot.checkpoints) { checkpoint.projectId = mappings.get(checkpoint.projectId)!; checkpoint.id = newId('checkpoint'); }
  snapshot.settings = snapshot.settings.map(setting => ({ ...setting, value: mappings.get(setting.value)! }));
  assertContract('LibrarySnapshot', snapshot); await verifyLibrary(snapshot, { signal });
  return { record: { id, sourceHash: parsed.sourceHash, projectIds: snapshot.projects.map(record => record.id), importedAt, sourceFormat: parsed.sourceFormat }, snapshot };
}
