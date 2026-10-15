import { canonicalJson, hashJson } from '../domain/hash';
import type { Checkpoint, GameState, HistoryNode, LibrarySnapshot, LoadedProject, ProjectRecord, RuleSetVersion, StateRecord } from '../domain/types';
import { assertContract, assertCoreState } from '../domain/validation';
import { assertRootState, createGameStepper } from '../engine/core';
import { assertSupportedRule } from '../presets/rules';

export interface VerificationOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: { completed: number; total: number }) => void) | undefined;
}
function control(total: number, options: VerificationOptions) {
  let completed = 0;
  options.signal?.throwIfAborted();
  options.onProgress?.({ completed, total });
  return async () => {
    options.signal?.throwIfAborted(); completed++;
    if (completed % 64 === 0 || completed === total) {
      options.onProgress?.({ completed, total });
      // A macrotask lets the browser deliver a cancel click during CPU-heavy replay.
      if (completed < total) await new Promise<void>(resolve => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
    }
  };
}
type Tick = () => Promise<void>;
const ruleKey = (rule: { id: string; version: number }) => `${rule.id}/${rule.version}`;

async function verifyPool(snapshots: (StateRecord | undefined)[], availableRules: (RuleSetVersion | undefined)[], tick: Tick) {
  const rules = new Map<string, RuleSetVersion>();
  for (const rule of availableRules) {
    if (!rule) throw new Error('规则版本缺失');
    if (rules.has(ruleKey(rule))) throw new Error('规则版本条目重复');
    assertSupportedRule(rule);
    if (await hashJson(rule.definition) !== rule.definitionHash) throw new Error('规则摘要不匹配');
    rules.set(ruleKey(rule), rule); await tick();
  }
  const states = new Map<string, GameState>();
  for (const snapshot of snapshots) {
    if (!snapshot) throw new Error('节点引用的快照缺失');
    const rule = rules.get(ruleKey(snapshot.state.ruleRef));
    if (!rule) throw new Error('规则版本缺失');
    assertCoreState(snapshot.state, rule);
    if (await hashJson(snapshot.state) !== snapshot.hash) throw new Error('状态摘要不匹配');
    if (states.has(snapshot.hash)) throw new Error('快照条目重复');
    states.set(snapshot.hash, snapshot.state); await tick();
  }
  return { rules, states, steppers: new Map([...rules].map(([key, rule]) => [key, createGameStepper(rule)])) };
}
type Pool = Awaited<ReturnType<typeof verifyPool>>;

async function verifyNodes(record: ProjectRecord, unsorted: HistoryNode[], checkpoints: Checkpoint[], pool: Pool, tick: Tick): Promise<LoadedProject> {
  const { rules, states, steppers } = pool, id = record.project.id;
  assertContract('Project', record.project);
  if (record.id !== id) throw new Error('项目引用不匹配');
  const nodes = unsorted.slice().sort((a, b) => a.depth - b.depth || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const lookup = (nodeId: string) => { const node = byId.get(nodeId); return node ? states.get(node.stateHash) : undefined; };
  if (byId.size !== nodes.length) throw new Error('同一项目的节点 ID 重复');
  const roots: string[] = [];
  const operations = new Set<string>();
  for (const node of nodes) {
    assertContract('HistoryNode', node);
    if (node.operationId) {
      if (operations.has(node.operationId)) throw new Error('同一项目的操作 ID 重复');
      operations.add(node.operationId);
    }
    const state = states.get(node.stateHash);
    if (!state || node.matchId !== id) throw new Error('节点引用不一致');
    const rule = rules.get(`${state.ruleRef.id}/${state.ruleRef.version}`)!;
    if (node.parentId === null) {
      roots.push(node.id);
      if (node.depth !== 0 || node.action !== null || node.randomContext !== null || state.ledger.effectiveActionCount !== 0 ||
        state.world.score !== '0' || state.undoStack.length !== 0 || node.undoTargetId !== null) throw new Error('根节点无效');
      assertRootState(state, rule);
    } else {
      const parent = byId.get(node.parentId);
      if (!parent || parent.depth + 1 !== node.depth || !node.action || !node.randomContext) throw new Error(`父节点、动作或深度不一致：${node.id}`);
      const parentState = states.get(parent.stateHash)!;
      const parentRule = rules.get(`${parentState.ruleRef.id}/${parentState.ruleRef.version}`)!;
      const nextRef = node.action.type === 'rule-edit' || node.action.type === 'edit' ? node.action.payload.nextRuleRef : undefined;
      if (nextRef ? nextRef.id !== rule.id || nextRef.version !== rule.version || node.randomContext.mode !== 'advance' : rule.id !== parentRule.id || rule.version !== parentRule.version) throw new Error('节点规则版本变化缺少对应发布记录');
      if (node.action.type === 'edit' && node.randomContext.mode !== 'advance') throw new Error('棋盘编辑不能重抽随机流');
      const undoTarget = node.action.type === 'skill' && node.action.payload.skillId === 'undo' ? node.action.payload.targetNodeId : null;
      if (node.undoTargetId !== undoTarget || (undoTarget && node.randomContext.mode !== 'advance')) throw new Error('撤销目标或随机模式不一致');
      if (node.randomContext.mode !== 'reroll' && canonicalJson(node.randomContext.before) !== canonicalJson(parentState.rng)) throw new Error('延续或复现随机输入不一致');
      const replay = steppers.get(ruleKey(parentRule))!(parentState, node.action, parent.id, node.randomContext.before, lookup, nextRef ? rule : undefined);
      if (!replay.accepted || await hashJson(replay.state) !== node.stateHash || canonicalJson(node.randomContext.after) !== canonicalJson(state.rng)) throw new Error(`节点回放不一致：${node.id}`);
    }
    await tick();
  }
  if (canonicalJson(roots.slice().sort()) !== canonicalJson(record.project.rootNodeIds.slice().sort()) || !byId.has(record.project.activeNodeId)) throw new Error('根节点或活跃位置缺失');
  const archivedRootIds = record.archivedRootIds ?? [];
  if (new Set(archivedRootIds).size !== archivedRootIds.length || archivedRootIds.some(nodeId => !byId.has(nodeId))) throw new Error('归档分支引用无效');
  for (const checkpoint of checkpoints) if (checkpoint.projectId !== id || !byId.has(checkpoint.nodeId)) throw new Error('检查点引用缺失');
  const active = byId.get(record.project.activeNodeId)!, ref = states.get(active.stateHash)!.ruleRef;
  return { project: record.project, nodes, states, rule: rules.get(`${ref.id}/${ref.version}`)!, rules, checkpoints, archivedRootIds };
}

export async function verifyProject(record: ProjectRecord, unsorted: HistoryNode[], snapshots: (StateRecord | undefined)[],
  availableRules: (RuleSetVersion | undefined)[], checkpoints: Checkpoint[], options: VerificationOptions = {}): Promise<LoadedProject> {
  const tick = control(snapshots.length + availableRules.length + unsorted.length, options);
  return verifyNodes(record, unsorted, checkpoints, await verifyPool(snapshots, availableRules, tick), tick);
}

export async function verifyLibrary(snapshot: LibrarySnapshot, options: VerificationOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  assertContract('LibrarySnapshot', snapshot);
  const projects = new Set(snapshot.projects.map(record => record.id));
  const stateMap = new Map(snapshot.states.map(record => [record.hash, record]));
  const ruleMap = new Map(snapshot.rules.map(rule => [`${rule.id}/${rule.version}`, rule]));
  if (projects.size !== snapshot.projects.length || stateMap.size !== snapshot.states.length || ruleMap.size !== snapshot.rules.length ||
    new Set(snapshot.checkpoints.map(checkpoint => checkpoint.id)).size !== snapshot.checkpoints.length) throw new Error('库中包含重复项目、快照、规则或检查点');
  if (snapshot.nodes.some(node => !projects.has(node.matchId)) || snapshot.checkpoints.some(checkpoint => !projects.has(checkpoint.projectId))) throw new Error('库中包含无所属项目的节点或检查点');
  if (snapshot.settings.length > 1 || snapshot.settings.some(setting => !projects.has(setting.value))) throw new Error('库设置引用不存在的项目');
  const tick = control(snapshot.rules.length + snapshot.states.length + snapshot.nodes.length, options);
  // Shared and unused legacy payloads are all checked exactly once in this pass.
  const pool = await verifyPool(snapshot.states, snapshot.rules, tick);
  const nodesByProject = new Map<string, HistoryNode[]>(), checksByProject = new Map<string, Checkpoint[]>();
  for (const node of snapshot.nodes) {
    const list = nodesByProject.get(node.matchId) ?? []; list.push(node); nodesByProject.set(node.matchId, list);
  }
  for (const checkpoint of snapshot.checkpoints) {
    const list = checksByProject.get(checkpoint.projectId) ?? []; list.push(checkpoint); checksByProject.set(checkpoint.projectId, list);
  }
  for (const record of snapshot.projects) {
    await verifyNodes(record, nodesByProject.get(record.id) ?? [], checksByProject.get(record.id) ?? [], pool, tick);
  }
  options.signal?.throwIfAborted();
}
