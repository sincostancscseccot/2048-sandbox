import type { GameAction, SkillId } from './types';

export const skillNames: Record<SkillId, string> = { undo: '撤销', delete: '删除', swap: '交换', upgrade: '升级', downgrade: '降级', shuffle: '洗牌', spawn: '放置', 'clear-line': '清空行列', rotate: '旋转' };
const arrows = { up: '↑', right: '→', down: '↓', left: '←' };
export function actionLabel(action: GameAction | null): string {
  return action === null ? '○' : action.type === 'move' ? arrows[action.payload.direction] : action.type === 'skill' ? skillNames[action.payload.skillId] : action.type === 'edit' ? '编辑' : '规则';
}
