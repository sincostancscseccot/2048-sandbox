import type { RuleDefinition } from '../domain/types';
import { skillIds } from '../domain/types';
import { sandboxDefinition } from './rules';

export interface SandboxPreset { id: string; name: string; description: string; definition: () => RuleDefinition }
export const sandboxPresets: SandboxPreset[] = [
  { id: 'chain', name: '连锁合并', description: '1 × 4，向左一步将 2、2、4、8 连成 16；关闭自动生成。', definition: () => {
    const d = sandboxDefinition(); d.board.rows = 1; d.board.cols = 4;
    d.board.initialLayout = ['2', '2', '4', '8'].map((value, index) => ({ index, value }));
    d.spawn.initialCount = 4; d.spawn.perActionCount = 0;
    d.merge.chain = true; d.merge.maxMergesPerTile = 3; d.goals.tileValue = '16'; return d;
  } },
  { id: 'fibonacci', name: '斐波那契', description: '相邻数列项相遇合并，1 + 1 = 2，1 + 2 = 3；目标 1597。', definition: () => {
    const d = sandboxDefinition(); d.numbers.sequence = 'custom';
    d.numbers.customSequence = ['1','2','3','5','8','13','21','34','55','89','144','233','377','610','987','1597','2584','4181'];
    d.merge.kind = 'sequence-next'; d.goals.tileValue = '1597';
    d.spawn.initialWeights = [{ value: '1', weight: 9 }, { value: '2', weight: 1 }];
    d.spawn.weights = structuredClone(d.spawn.initialWeights);
    d.board.initialLayout = [{ index: 0, value: '1' }, { index: 1, value: '1' }]; return d;
  } },
  { id: 'skills', name: '技能练习场', description: '九种技能各 3 次；关闭自动生成和结束判定，自由尝试撤销与编辑。', definition: () => {
    const d = sandboxDefinition(); d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '4' }, { index: 5, value: '8' }];
    d.spawn.initialCount = 3; d.spawn.perActionCount = 0; d.goals.tileValue = null; d.goals.lossWhenNoMoves = false;
    for (const id of skillIds) { d.skills[id].enabled = true; d.skills[id].initialCharges = 3; d.skills[id].maxCharges = 3; }
    return d;
  } },
  { id: 'stages', name: '阶段与奖励', description: '3 × 5，第 3 回合起只生成 4；每次合并额外加 10 分，最多奖励 10 次。', definition: () => {
    const d = sandboxDefinition(); d.board.rows = 3; d.board.cols = 5;
    d.board.initialLayout = [{ index: 0, value: '2' }, { index: 1, value: '2' }];
    d.spawn.phaseRules = [{ id: 'late-stage', priority: 1, condition: { kind: 'compare', source: 'round', reference: null, operator: 'gte', value: '3' }, weights: [{ value: '4', weight: 1 }], count: 1 }];
    d.variables = { bonuses: '0' };
    d.events = [{ id: 'merge-bonus', name: '合并奖励', trigger: 'after-merge', condition: null,
      actions: [{ type: 'add-score', value: '10' }, { type: 'add-variable', name: 'bonuses', value: '1' }],
      priority: 0, maxExecutions: 10, cooldownTurns: 0, allowReentry: false }]; return d;
  } },
];
