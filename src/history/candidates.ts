import { hashJson, newId, timestamp } from '../domain/hash';
import type { BoardEditAction, BranchPolicy, CommitCandidate, Direction, GameAction, GameState, HistoryNode, LoadedProject, Project, RngState, RuleSetVersion, SkillPayload } from '../domain/types';
import { createInitialState, stepGame } from '../engine/core';
import { classicRule, defaultPreferences } from '../presets/classic';
import { freshRng } from '../random/pcg32';

export async function prepareNewMatch(name: string, randomInput = freshRng(), rule = classicRule): Promise<CommitCandidate> {
  const state = createInitialState(rule, randomInput);
  const id = newId('match');
  const node: HistoryNode = {
    id: newId('node'), matchId: id, parentId: null, depth: 0, action: null, randomContext: null,
    stateHash: await hashJson(state), createdAt: timestamp(), operationId: newId('op'), undoTargetId: null, tags: [],
  };
  const project: Project = { id, name, rootNodeIds: [node.id], activeNodeId: node.id, revision: 1, preferences: { ...defaultPreferences } };
  return { expectedRevision: 0, project, node, state, rule: structuredClone(rule) };
}

export async function prepareMove(loaded: LoadedProject, parentId: string, direction: Direction, policy: BranchPolicy,
  entropy: () => RngState = freshRng): Promise<CommitCandidate | { reason: string }> {
  return prepareAction(loaded, parentId, { type: 'move', payload: { direction }, elapsedMs: 0 }, policy, entropy);
}

export async function prepareSkill(loaded: LoadedProject, parentId: string, payload: SkillPayload, policy: BranchPolicy): Promise<CommitCandidate | { reason: string }> {
  return prepareAction(loaded, parentId, { type: 'skill', payload, elapsedMs: 0 }, policy);
}
export function ruleForState(loaded: LoadedProject, state: GameState): RuleSetVersion {
  const rule = loaded.rules.get(`${state.ruleRef.id}/${state.ruleRef.version}`);
  if (!rule) throw new Error('节点的规则版本缺失'); return rule;
}
export async function prepareRuleEdit(loaded: LoadedProject, parentId: string, nextRule: RuleSetVersion, overflowPolicy: 'cancel' | 'drop' | 'pack') {
  return prepareAction(loaded, parentId, { type: 'rule-edit', payload: { nextRuleRef: { id: nextRule.id, version: nextRule.version }, overflowPolicy }, elapsedMs: 0 }, 'reproduce', freshRng, nextRule);
}
export async function prepareBoardEdit(loaded: LoadedProject, parentId: string, patches: BoardEditAction['payload']['patches'], nextRule?: RuleSetVersion) {
  return prepareAction(loaded, parentId, { type: 'edit', payload: { patches, ...(nextRule ? { nextRuleRef: { id: nextRule.id, version: nextRule.version } } : {}) }, elapsedMs: 0 }, 'reproduce', freshRng, nextRule);
}

async function prepareAction(loaded: LoadedProject, parentId: string, action: GameAction, policy: BranchPolicy,
  entropy: () => RngState = freshRng, nextRule?: RuleSetVersion): Promise<CommitCandidate | { reason: string }> {
  const parent = loaded.nodes.find(node => node.id === parentId);
  if (!parent) throw new Error('操作的父节点不存在');
  const input = loaded.states.get(parent.stateHash);
  if (!input) throw new Error('父节点状态缺失');
  const rule = ruleForState(loaded, input);
  const byId = new Map(loaded.nodes.map(node => [node.id, node]));
  const lookup = (id: string) => { const node = byId.get(id); return node ? loaded.states.get(node.stateHash) : undefined; };
  let result = stepGame(input, rule, action, parentId, input.rng, lookup, nextRule);
  if (!result.accepted) return { reason: result.reason };
  const branching = parentId !== loaded.project.activeNodeId || loaded.nodes.some(node => node.parentId === parentId);
  const undoTargetId = action.type === 'skill' && action.payload.skillId === 'undo' ? action.payload.targetNodeId : null;
  const mode = undoTargetId || action.type === 'edit' || action.type === 'rule-edit' ? 'advance' : branching ? policy : 'advance';
  const before = mode === 'reroll' ? entropy() : input.rng;
  if (mode === 'reroll') result = stepGame(input, rule, action, parentId, before, lookup);
  if (!result.accepted) return { reason: result.reason };
  const node: HistoryNode = {
    id: newId('node'), matchId: loaded.project.id, parentId, depth: parent.depth + 1,
    action, randomContext: { mode, before: structuredClone(before), after: result.state.rng },
    stateHash: await hashJson(result.state), createdAt: timestamp(), operationId: newId('op'), undoTargetId, tags: action.type === 'edit' ? ['edited-board'] : action.type === 'rule-edit' ? ['edited-rules'] : [],
  };
  const project = { ...loaded.project, activeNodeId: node.id, revision: loaded.project.revision + 1,
    preferences: { ...loaded.project.preferences, randomBranchPolicy: policy } };
  return { expectedRevision: loaded.project.revision, project, node, state: result.state, rule: nextRule ?? rule };
}
