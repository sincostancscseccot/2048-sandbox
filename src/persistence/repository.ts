import { canonicalJson, hashJson, newId, timestamp } from '../domain/hash';
import type { Checkpoint, CommitCandidate, GameState, ImportPlan, LibrarySnapshot, LoadedProject, ProjectRecord } from '../domain/types';
import { assertContract, assertCoreState } from '../domain/validation';
import { assertRootState, stepGame } from '../engine/core';
import { assertSupportedRule } from '../presets/rules';
import { database, type SandboxDatabase } from './database';
import { verifyLibrary, verifyProject } from '../history/verify';

export class RevisionConflict extends Error {
  constructor() { super('另一页面已保存新进度。请重新读取已保存的对局，再选择继续位置。'); this.name = 'RevisionConflict'; }
}
export class IntegrityError extends Error {
  constructor(message: string) { super(`存档完整性检查失败：${message}`); this.name = 'IntegrityError'; }
}

export class Repository {
  constructor(readonly db: SandboxDatabase = database) {}

  listProjects(): Promise<ProjectRecord[]> { return this.db.projects.orderBy('updatedAt').reverse().toArray(); }
  async lastProjectId(): Promise<string | undefined> { return (await this.db.settings.get('lastProjectId'))?.value; }

  async deleteProject(id: string, expectedRevision: number): Promise<ProjectRecord[]> {
    return this.db.transaction('rw', this.db.tables, async () => {
      const record = await this.db.projects.get(id);
      // A retry after a lost acknowledgement must not recreate the deleted match.
      if (!record) return this.listProjects();
      if (record.project.revision !== expectedRevision) throw new RevisionConflict();
      const nodes = await this.db.historyNodes.where('matchId').equals(id).toArray();
      const hashes = [...new Set(nodes.map(node => node.stateHash))];
      await this.db.historyNodes.where('matchId').equals(id).delete();
      await this.db.checkpoints.where('projectId').equals(id).delete();
      await this.db.projects.delete(id);

      // Imported copies can share snapshots. Only collect this match's data
      // when no surviving node still references it.
      const usedHashes = new Set<string>();
      await this.db.historyNodes.each(node => { usedHashes.add(node.stateHash); });
      await this.db.states.bulkDelete(hashes.filter(hash => !usedHashes.has(hash)));
      // Reserve immutable rule versions even after their last match is deleted:
      // an older copy must not reuse a version and conflict with an old backup.

      const projects = await this.listProjects();
      if ((await this.lastProjectId()) === id) {
        if (projects[0]) await this.db.settings.put({ key: 'lastProjectId', value: projects[0].id });
        else await this.db.settings.delete('lastProjectId');
      }
      // Keep import receipts so an old in-flight retry cannot resurrect a deletion.
      return projects;
    });
  }

  async load(id: string): Promise<LoadedProject> {
    const raw = await this.db.transaction('r', [this.db.projects, this.db.historyNodes, this.db.states, this.db.rules, this.db.checkpoints], async () => {
      const record = await this.db.projects.get(id);
      if (!record) throw new IntegrityError('找不到对局');
      const nodes = await this.db.historyNodes.where('matchId').equals(id).toArray();
      const states = await this.db.states.bulkGet([...new Set(nodes.map(node => node.stateHash))]);
      const references = new Map(states.flatMap(snapshot => snapshot ? [[`${snapshot.state.ruleRef.id}/${snapshot.state.ruleRef.version}`, snapshot.state.ruleRef] as const] : []));
      const rules = await this.db.rules.bulkGet([...references.values()].map(ref => [ref.id, ref.version]));
      const checkpoints = await this.db.checkpoints.where('projectId').equals(id).toArray();
      return { record, nodes, states, rules, checkpoints };
    });
    try {
      return await verifyProject(raw.record, raw.nodes, raw.states, raw.rules, raw.checkpoints);
    } catch (error) { throw new IntegrityError(error instanceof Error ? error.message : String(error)); }
  }

  /** Hashing and schema checks finish BEFORE opening the IndexedDB transaction. */
  async commit(candidate: CommitCandidate): Promise<void> {
    const { project, node, state, rule, expectedRevision } = candidate;
    assertContract('Project', project); assertContract('HistoryNode', node); assertContract('RuleSetVersion', rule);
    assertCoreState(state, rule); assertSupportedRule(rule);
    if (await hashJson(rule.definition) !== rule.definitionHash) throw new IntegrityError('规则摘要不一致');
    if (await hashJson(state) !== node.stateHash || project.activeNodeId !== node.id || node.matchId !== project.id ||
      project.revision !== expectedRevision + 1 || !node.operationId) throw new IntegrityError('提交候选不一致');
    if (node.parentId === null) {
      if (node.action !== null || node.randomContext !== null || node.depth !== 0 || node.undoTargetId !== null) throw new IntegrityError('根节点状态无效');
      assertRootState(state, rule);
    } else {
      const raw = await this.db.transaction('r', [this.db.historyNodes, this.db.states, this.db.rules], async () => {
        const parent = await this.db.historyNodes.get([project.id, node.parentId!]);
        const parentSnapshot = parent ? await this.db.states.get(parent.stateHash) : undefined;
        // Settlement only reads the parent, undo target and the next rescue target.
        // The complete history is independently replayed by load() after saving.
        const ids = new Set([node.parentId!, ...parentSnapshot?.state.undoStack.slice(-2) ?? [],
          ...state.undoStack.slice(-1), ...(node.undoTargetId ? [node.undoTargetId] : [])]);
        const nodes = (await this.db.historyNodes.bulkGet([...ids].map(id => [project.id, id]))).filter(item => item !== undefined);
        const snapshots = await this.db.states.bulkGet([...new Set(nodes.map(item => item.stateHash))]);
        const refs = new Map(snapshots.flatMap(item => item ? [[`${item.state.ruleRef.id}/${item.state.ruleRef.version}`, item.state.ruleRef] as const] : []));
        const rules = await this.db.rules.bulkGet([...refs.values()].map(ref => [ref.id, ref.version]));
        return { nodes: new Map(nodes.map(item => [item.id, item])), snapshots, rules };
      });
      const rules = new Map(raw.rules.map(item => {
        if (!item) throw new IntegrityError('操作依赖的规则版本缺失');
        return [`${item.id}/${item.version}`, item] as const;
      }));
      for (const item of rules.values()) {
        assertSupportedRule(item);
        if (await hashJson(item.definition) !== item.definitionHash) throw new IntegrityError('操作依赖的规则摘要不一致');
      }
      const states = new Map<string, GameState>();
      for (const snapshot of raw.snapshots) {
        if (!snapshot) throw new IntegrityError('操作依赖的快照缺失');
        const storedRule = rules.get(`${snapshot.state.ruleRef.id}/${snapshot.state.ruleRef.version}`);
        if (!storedRule) throw new IntegrityError('操作依赖的规则版本缺失');
        assertCoreState(snapshot.state, storedRule);
        if (await hashJson(snapshot.state) !== snapshot.hash) throw new IntegrityError('操作依赖的状态摘要不一致');
        states.set(snapshot.hash, snapshot.state);
      }
      for (const item of raw.nodes.values()) assertContract('HistoryNode', item);
      const parent = raw.nodes.get(node.parentId);
      const parentState = parent ? states.get(parent.stateHash) : undefined;
      const parentRule = parentState ? rules.get(`${parentState.ruleRef.id}/${parentState.ruleRef.version}`) : undefined;
      const lookup = (id: string) => { const item = raw.nodes.get(id); return item ? states.get(item.stateHash) : undefined; };
      const undoTarget = node.action?.type === 'skill' && node.action.payload.skillId === 'undo' ? node.action.payload.targetNodeId : null;
      if (!parent || !parentState || !parentRule || parent.matchId !== project.id || !node.action || !node.randomContext ||
        node.undoTargetId !== undoTarget || (undoTarget && node.randomContext.mode !== 'advance') || await hashJson(parentState) !== parent.stateHash) {
        throw new IntegrityError('操作的父节点、状态或随机上下文无效');
      }
      const nextRef = node.action.type === 'rule-edit' || node.action.type === 'edit' ? node.action.payload.nextRuleRef : undefined;
      if (nextRef ? nextRef.id !== rule.id || nextRef.version !== rule.version || node.randomContext.mode !== 'advance' : parentRule.id !== rule.id || parentRule.version !== rule.version) throw new IntegrityError('规则变化缺少对应动作引用');
      if (node.action.type === 'edit' && node.randomContext.mode !== 'advance') throw new IntegrityError('棋盘编辑不能重抽随机流');
      if (node.randomContext.mode !== 'reroll' && canonicalJson(node.randomContext.before) !== canonicalJson(parentState.rng)) {
        throw new IntegrityError('延续或复现随机输入不一致');
      }
      if (undoTarget) { const target = raw.nodes.get(undoTarget), targetState = lookup(undoTarget); if (!target || !targetState || await hashJson(targetState) !== target.stateHash) throw new IntegrityError('撤销目标状态无效'); }
      const replay = stepGame(parentState, parentRule, node.action, parent.id, node.randomContext.before, lookup, nextRef ? rule : undefined);
      if (!replay.accepted || await hashJson(replay.state) !== node.stateHash || canonicalJson(node.randomContext.after) !== canonicalJson(state.rng)) {
        throw new IntegrityError('操作结果无法按记录复现');
      }
    }
    await this.db.transaction('rw', [this.db.projects, this.db.historyNodes, this.db.states, this.db.rules, this.db.settings], async () => {
      const existing = await this.db.historyNodes.where('[matchId+operationId]').equals([project.id, node.operationId!]).first();
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(node)) throw new IntegrityError('操作 ID 冲突');
        return; // A lost acknowledgement can be retried without another charge or random draw.
      }
      const current = await this.db.projects.get(project.id);
      if ((current?.project.revision ?? 0) !== expectedRevision) throw new RevisionConflict();
      if (node.parentId === null) {
        if (current || node.depth !== 0 || project.rootNodeIds.length !== 1 || project.rootNodeIds[0] !== node.id) throw new IntegrityError('根节点提交无效');
      } else {
        const parent = await this.db.historyNodes.get([project.id, node.parentId]);
        if (!current || !parent || parent.matchId !== project.id || parent.depth + 1 !== node.depth) throw new IntegrityError('提交的父节点或项目头缺失');
        if (canonicalJson(current!.project.rootNodeIds) !== canonicalJson(project.rootNodeIds)) throw new IntegrityError('既有根节点不能改写');
      }
      const existingRule = await this.db.rules.get([rule.id, rule.version]);
      if (existingRule && canonicalJson(existingRule) !== canonicalJson(rule)) throw new IntegrityError('不可变规则被覆盖');
      if (!existingRule) await this.db.rules.add(rule);
      const existingState = await this.db.states.get(node.stateHash);
      if (existingState && canonicalJson(existingState.state) !== canonicalJson(state)) throw new IntegrityError('快照摘要冲突');
      if (!existingState) await this.db.states.add({ hash: node.stateHash, state });
      await this.db.historyNodes.add(node);
      await this.db.projects.put({ ...current, id: project.id, project, updatedAt: node.createdAt });
      await this.db.settings.put({ key: 'lastProjectId', value: project.id });
    });
  }

  async checkpoint(loaded: LoadedProject, nodeId: string): Promise<void> {
    const node = loaded.nodes.find(item => item.id === nodeId);
    if (!node) throw new IntegrityError('检查点的节点不存在');
    const checkpoint: Checkpoint = { id: newId('checkpoint'), projectId: loaded.project.id, nodeId,
      name: `检查点 · 第 ${node.depth} 步`, createdAt: timestamp() };
    await this.db.transaction('rw', [this.db.projects, this.db.checkpoints], async () => {
      const record = await this.db.projects.get(loaded.project.id);
      if (record?.project.revision !== loaded.project.revision) throw new RevisionConflict();
      if (await this.db.checkpoints.where('[projectId+nodeId]').equals([loaded.project.id, nodeId]).count()) return;
      await this.db.checkpoints.add(checkpoint);
      await this.db.projects.put({ ...record, project: { ...record.project, revision: record.project.revision + 1 }, updatedAt: timestamp() });
    });
  }

  async readSnapshot(): Promise<LibrarySnapshot> {
    return this.db.transaction('r', this.db.tables, async () => ({
      projects: await this.db.projects.toArray(), nodes: await this.db.historyNodes.toArray(),
      states: await this.db.states.toArray(), rules: await this.db.rules.toArray(),
      checkpoints: await this.db.checkpoints.toArray(), settings: await this.db.settings.toArray(),
    }));
  }

  async exportBackup(): Promise<unknown> {
    return { format: '2048-sandbox-m1-backup', schemaVersion: 1, exportedAt: timestamp(), ...await this.readSnapshot() };
  }

  async importCopy(plan: ImportPlan): Promise<string[]> {
    await verifyLibrary(plan.snapshot);
    const { record, snapshot } = plan;
    if (canonicalJson(record.projectIds) !== canonicalJson(snapshot.projects.map(project => project.id))) throw new IntegrityError('导入批次的项目清单不一致');
    return this.db.transaction('rw', this.db.tables, async () => {
      const existing = await this.db.imports.get(record.id);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(record)) throw new IntegrityError('导入批次 ID 冲突');
        if ((await this.db.projects.bulkGet(existing.projectIds)).some(project => !project)) throw new IntegrityError('此批次的对局已被删除。请重新选择文件，创建新的导入副本');
        return existing.projectIds;
      }
      for (const project of snapshot.projects) if (await this.db.projects.get(project.id)) throw new IntegrityError('导入副本 ID 已存在，未覆盖原项目');
      for (const rule of snapshot.rules) {
        const current = await this.db.rules.get([rule.id, rule.version]);
        if (current && canonicalJson(current) !== canonicalJson(rule)) throw new IntegrityError('导入规则与本地同版本规则冲突');
        if (!current) await this.db.rules.add(rule);
      }
      for (const state of snapshot.states) {
        const current = await this.db.states.get(state.hash);
        if (current && canonicalJson(current.state) !== canonicalJson(state.state)) throw new IntegrityError('导入快照与本地摘要冲突');
        if (!current) await this.db.states.add(state);
      }
      await this.db.projects.bulkAdd(snapshot.projects);
      await this.db.historyNodes.bulkAdd(snapshot.nodes);
      await this.db.checkpoints.bulkAdd(snapshot.checkpoints);
      const preferred = snapshot.settings.find(item => item.key === 'lastProjectId')?.value ?? record.projectIds[0];
      if (preferred) await this.db.settings.put({ key: 'lastProjectId', value: preferred });
      await this.db.imports.add(record);
      return record.projectIds;
    });
  }

  async archiveBranch(loaded: LoadedProject, nodeId: string, archived: boolean): Promise<void> {
    if (!loaded.nodes.some(node => node.id === nodeId)) throw new IntegrityError('归档节点不存在');
    await this.db.transaction('rw', this.db.projects, async () => {
      const record = await this.db.projects.get(loaded.project.id);
      if (record?.project.revision !== loaded.project.revision) throw new RevisionConflict();
      const roots = new Set(record.archivedRootIds ?? []);
      if (archived) roots.add(nodeId); else roots.delete(nodeId);
      await this.db.projects.put({ ...record, archivedRootIds: [...roots],
        project: { ...record.project, revision: record.project.revision + 1 }, updatedAt: timestamp() });
    });
  }
}

export const repository = new Repository();

export function describeError(error: unknown): string {
  if (error instanceof RevisionConflict || error instanceof IntegrityError) return error.message;
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return '本地存储空间不足。本步未保存，可导出已保存的对局后重试。';
  if (name === 'InvalidStateError' || name === 'OpenFailedError' || name === 'SecurityError') return '浏览器未能打开本地存储。请允许此站点保存数据，再重新读取。';
  return `保存或读取失败：${error instanceof Error ? error.message : String(error)}`;
}
