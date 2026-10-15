import { canonicalJson, hashJson, newId } from '../domain/hash';
import type { Condition, RuleDefinition, RuleSetVersion, Weight } from '../domain/types';
import { skillIds } from '../domain/types';
import { assertContract, contractErrors } from '../domain/validation';
import { assertClassicRule, classicRule } from './classic';

export const ruleCapabilities = new Set(['core-v1', 'sandbox-v1', 'skills-v1', 'editing-v1', 'advanced-v1', 'events-v1']);
export function capabilitiesForDefinition(d: RuleDefinition): string[] {
  return ['core-v1', 'sandbox-v1', 'editing-v1', ...(skillIds.some(id => d.skills[id].enabled) ? ['skills-v1'] : []),
    ...(d.merge.kind !== 'equal-sum' || d.merge.chain || d.merge.maxMergesPerTile !== 1 || d.merge.mappings.length || d.numbers.sequence === 'custom' || d.spawn.positionStrategy !== 'uniform' || d.spawn.positionWeights.length || d.spawn.phaseRules.length ? ['advanced-v1'] : []),
    ...(d.events.length || Object.keys(d.variables).length ? ['events-v1'] : [])];
}
export interface RuleIssue { path: string; message: string; severity: 'error' | 'warning' }

export function sandboxDefinition(): RuleDefinition {
  const definition = structuredClone(classicRule.definition);
  definition.mode = 'custom'; definition.skills.undo.enabled = true;
  return definition;
}

export function validateDefinition(definition: RuleDefinition): RuleIssue[] {
  const issues: RuleIssue[] = contractErrors('RuleDefinition', definition).map(issue => ({ ...issue, severity: 'error' }));
  if (issues.length) return issues;
  const add = (path: string, message: string, severity: RuleIssue['severity'] = 'error') => issues.push({ path, message, severity });
  const d = definition, size = d.board.rows * d.board.cols;
  if (d.board.rows > 64 || d.board.cols > 64 || size > 4096) add('/board/rows', '行列分别不超过 64，棋盘最多 4096 格');
  if (d.timer.mode !== 'none' || d.timer.limitMs !== null) add('/timer/mode', '计时对局在后续阶段开放');
  if (d.numbers.sequence === 'custom' && d.numbers.customSequence.length < 2) add('/numbers/customSequence', '自定义数列至少包含两个不同数字');
  if (d.numbers.sequence !== 'custom' && d.numbers.customSequence.length) add('/numbers/customSequence', '请启用自定义数列或清空列表');
  if (d.numbers.customSequence.some(value => value.length > d.numbers.maxDigits)) add('/numbers/customSequence', '数列数字超过位数预算');
  if (d.merge.kind === 'sequence-next' && d.numbers.sequence !== 'custom') add('/merge/kind', '相邻数列合并需要启用自定义数列');
  const valueOkay = (value: string) => value.length <= d.numbers.maxDigits && (d.numbers.allowedValues === null || d.numbers.allowedValues.includes(value));
  if (d.numbers.allowedValues?.some(value => value.length > d.numbers.maxDigits)) add('/numbers/allowedValues', '允许数字中有值超过位数预算');
  const placed = new Set<number>();
  for (const [i, item] of d.board.initialLayout.entries()) {
    if (item.index >= size || placed.has(item.index)) add(`/board/initialLayout/${i}/index`, '初始格索引越界或重复');
    if (!valueOkay(item.value)) add(`/board/initialLayout/${i}/value`, '初始数字超出预算或不在允许列表中');
    placed.add(item.index);
  }
  const weights = (items: Weight[], path: string, needed: boolean) => {
    let total = 0; const values = new Set<string>();
    for (const [i, item] of items.entries()) {
      if (values.has(item.value)) add(`${path}/${i}/value`, '数字重复，请合并权重');
      if (!valueOkay(item.value)) add(`${path}/${i}/value`, '生成数字超出预算或不在允许列表中');
      values.add(item.value); total += item.weight;
    }
    if (total > 0xffffffff) add(path, '权重总和最多 4294967295，请约分或降低权重');
    if (needed && total === 0) add(path, '需要生成数字时，权重总和必须大于 0');
    else if (!needed && total === 0) add(path, '当前不使用这个分布，允许全零权重', 'warning');
  };
  const initialNeeded = d.spawn.initialCount > d.board.initialLayout.length && d.board.initialLayout.length < size &&
    (d.spawn.emptyStrategy !== 'skip-batch' || d.spawn.initialCount <= size);
  const turnNeeded = d.spawn.perActionCount > 0 && (d.spawn.triggerOn.length > 0 || skillIds.some(id => d.skills[id].enabled && d.skills[id].spawnAfterUse));
  weights(d.spawn.initialWeights, '/spawn/initialWeights', initialNeeded);
  weights(d.spawn.weights, '/spawn/weights', turnNeeded);
  const safeKey = (key: string) => !['constructor', 'prototype', '__proto__'].includes(key);
  const ids = (items: { id: string }[], path: string) => {
    if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => !safeKey(item.id))) add(path, '标识重复或使用了保留名称');
  };
  ids(d.merge.mappings, '/merge/mappings'); ids(d.spawn.phaseRules, '/spawn/phaseRules'); ids(d.events, '/events');
  for (const item of d.merge.mappings) if ([item.left, item.right, item.result].some(value => value.length > d.numbers.maxDigits)) add('/merge/mappings', '映射数字超过位数预算');
  if (d.merge.ruleOrder.some(id => !d.merge.mappings.some(item => item.id === id))) add('/merge/ruleOrder', '排序引用不存在的映射');
  if (d.merge.kind === 'mapping' && !d.merge.mappings.length) add('/merge/mappings', '映射列表为空，数字不会合并', 'warning');
  let conditionCount = 0;
  const checkCondition = (condition: Condition | null, path: string, depth = 0) => {
    if (!condition) return;
    if (++conditionCount > 4096 || depth > 16) { add(path, '条件总量超过 4096 或嵌套超过 16 层'); return; }
    if (condition.kind === 'all' || condition.kind === 'any') for (const child of condition.children) checkCondition(child, path, depth + 1);
    else if (condition.kind === 'not') checkCondition(condition.child, path, depth + 1);
    else if (condition.source === 'variable' ? !Object.hasOwn(d.variables, condition.reference ?? '') : condition.source === 'event-count' ? !d.events.some(event => event.id === condition.reference) : condition.reference !== null) add(path, '条件引用的变量/事件不存在，或普通条件包含多余引用');
  };
  for (const [i, phase] of d.spawn.phaseRules.entries()) {
    checkCondition(phase.condition, `/spawn/phaseRules/${i}/condition`);
    weights(phase.weights, `/spawn/phaseRules/${i}/weights`, (phase.count ?? d.spawn.perActionCount) > 0);
  }
  const positions = d.spawn.positionWeights;
  if (new Set(positions.map(item => item.index)).size !== positions.length || positions.some(item => item.index >= size) || positions.reduce((sum, item) => sum + item.weight, 0) > 0xffffffff) add('/spawn/positionWeights', '位置索引重复/越界或权重总和超过上限');
  if (d.spawn.positionStrategy === 'weighted' && !positions.some(item => item.weight > 0)) add('/spawn/positionWeights', '位置分布至少需要一个正权重格');
  for (const [key, value] of Object.entries(d.variables)) if (!safeKey(key) || value.length > 4096) add('/variables', '变量名称保留或初值超过预算');
  for (const [i, event] of d.events.entries()) {
    checkCondition(event.condition, `/events/${i}/condition`);
    for (const action of event.actions) {
      if (action.type === 'set-cell' && (action.index >= size || (action.value !== null && !valueOkay(action.value)))) add(`/events/${i}/actions`, '事件格子越界或放置数字不合法');
      if ((action.type === 'set-variable' || action.type === 'add-variable') && !Object.hasOwn(d.variables, action.name)) add(`/events/${i}/actions`, '事件引用的变量不存在');
    }
  }
  for (const id of skillIds) {
    const config = d.skills[id];
    if (config.initialCharges > config.maxCharges) add(`/skills/${id}/initialCharges`, '初始次数不能超过最大储量');
  }
  if (d.mode === 'normal' && canonicalJson(d) !== canonicalJson(classicRule.definition)) add('/mode', '经典模式使用固定参数；修改参数请创建自定义对局');
  if (size === 1) add('/board/rows', '1×1 棋盘没有通常的滑动空间', 'warning');
  if (!d.movement.directions.length) add('/movement/directions', '没有移动方向，只能使用已启用的技能', 'warning');
  if (d.spawn.initialCount === 0 && !d.board.initialLayout.length) add('/spawn/initialCount', '开局为空；请配置无效移动生成，或关闭无路可走判负并启用放置技能', 'warning');
  if (d.spawn.initialCount > size || d.spawn.perActionCount > size) add('/spawn/initialCount', '生成数量超过格数，将按空间策略处理', 'warning');
  if (d.board.initialLayout.length > d.spawn.initialCount) add('/board/initialLayout', '初始布局超过开局数量，将全部保留', 'warning');
  if (d.numbers.allowedValues !== null) add('/numbers/allowedValues', '允许列表限制初始布局、生成和放置；合并与升级结果可超出列表', 'warning');
  if (d.goals.tileValue === '0' || d.goals.scoreTarget === '0') add('/goals/scoreTarget', '目标为 0，可能开局就完成', 'warning');
  if (d.goals.tileValue === null && d.goals.scoreTarget === null) add('/goals/tileValue', '目标全部关闭，为无尽玩法', 'warning');
  return issues;
}

export function assertSupportedRule(rule: RuleSetVersion): void {
  assertContract('RuleSetVersion', rule);
  const unknown = rule.requiredCapabilities.filter(capability => !ruleCapabilities.has(capability));
  if (unknown.length) throw new Error(`规则需要未支持的能力：${unknown.join('、')}`);
  if (!rule.requiredCapabilities.includes('core-v1')) throw new Error('规则缺少 core-v1 能力声明');
  if (rule.definition.mode === 'normal') { assertClassicRule(rule); return; }
  if (!rule.requiredCapabilities.includes('sandbox-v1') || (skillIds.some(id => rule.definition.skills[id].enabled) && !rule.requiredCapabilities.includes('skills-v1'))) throw new Error('自定义或技能规则缺少必要能力声明');
  if (capabilitiesForDefinition(rule.definition).some(capability => capability !== 'editing-v1' && !rule.requiredCapabilities.includes(capability))) throw new Error('高级规则或事件缺少必要能力声明');
  const error = validateDefinition(rule.definition).find(issue => issue.severity === 'error');
  if (error) throw new Error(`${error.path}：${error.message}`);
}

export async function createCustomRule(name: string, definition: RuleDefinition): Promise<RuleSetVersion> {
  const candidate = structuredClone(definition); candidate.mode = 'custom';
  const rule: RuleSetVersion = { schemaVersion: 1, id: newId('rules'), version: 1, name: name.trim() || '自定义规则',
    requiredCapabilities: capabilitiesForDefinition(candidate),
    definition: candidate, definitionHash: await hashJson(candidate) };
  assertSupportedRule(rule); return rule;
}

export async function createRuleRevision(previous: RuleSetVersion, definition: RuleDefinition, allRules: RuleSetVersion[], name = previous.name): Promise<RuleSetVersion> {
  const next = await createCustomRule(name, definition);
  if (previous.definition.mode === 'custom') {
    const version = allRules.reduce((maximum, rule) => rule.id === previous.id ? Math.max(maximum, rule.version) : maximum, previous.version) + 1;
    if (!Number.isSafeInteger(version)) throw new Error('规则版本号达到上限');
    next.id = previous.id; next.version = version;
  }
  return next;
}
