import data from '../../examples/presets/classic.json' with { type: 'json' };
import { canonicalJson } from '../domain/hash';
import type { Project, RuleSetVersion } from '../domain/types';

export const classicRule = { ...data, schemaVersion: 1 } as RuleSetVersion;
export const defaultPreferences: Project['preferences'] = {
  randomBranchPolicy: 'reroll', snapshotEveryActions: 32, compression: 'deflate',
  deduplicateSnapshots: true, exportIncludeArchived: true, theme: 'system', motion: 'system', tileDisplayDigits: 10,
};

export function assertClassicRule(rule: RuleSetVersion): void {
  if (rule.id !== classicRule.id || rule.version !== classicRule.version ||
    canonicalJson(rule.definition) !== canonicalJson(classicRule.definition) ||
    rule.definitionHash !== classicRule.definitionHash ||
    canonicalJson(rule.requiredCapabilities) !== canonicalJson(classicRule.requiredCapabilities)) {
    throw new Error('此版本只支持经典规则；自定义规则将在后续阶段开放');
  }
}
