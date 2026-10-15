import { useState } from 'react';
import type { GameState, LoadedProject, SkillId, SkillPayload } from '../domain/types';
import { skillIds } from '../domain/types';
import { skillNames } from '../domain/actions';
import { skillResourceReason } from '../engine/core';

interface Props {
  loaded: LoadedProject; state: GameState; disabled: boolean; selected: SkillId | null; targets: number[];
  onSelect: (id: SkillId | null) => void; onUse: (payload: SkillPayload) => Promise<boolean>;
}
const instructions: Record<SkillId, string> = { undo: '恢复最近一次可撤销操作前的世界状态。', delete: '在棋盘上选择一个数字。', swap: '在棋盘上选择两个不同格子，可与空格交换。', upgrade: '选择一个数字，将它乘 2；不增加合并成绩。', downgrade: '选择一个不小于 2 的偶数，将它除以 2。', shuffle: '随机重排整张棋盘的数字与空位，结果相同也算成功。', spawn: '输入非负整数，再在棋盘上选择一个空格。', 'clear-line': '选择要清空的行或列，序号从 1 开始。', rotate: '旋转棋盘内容；非方形棋盘仅支持 180°。' };

export function SkillPanel({ loaded, state, disabled, selected, targets, onSelect, onUse }: Props) {
  const [value, setValue] = useState('2'), [axis, setAxis] = useState<'row' | 'column'>('row'), [line, setLine] = useState('1'), [degrees, setDegrees] = useState<90 | 180 | 270>(180);
  const lookup = (id: string) => { const node = loaded.nodes.find(item => item.id === id); return node ? loaded.states.get(node.stateHash) : undefined; };
  const enabled = skillIds.filter(id => loaded.rule.definition.skills[id].enabled);
  if (!enabled.length) return null;
  async function use(payload: SkillPayload) { if (await onUse(payload)) onSelect(null); }
  function payload(): SkillPayload | null {
    switch (selected) {
      case 'delete': case 'upgrade': case 'downgrade': return targets[0] === undefined ? null : { skillId: selected, index: targets[0] };
      case 'swap': return targets.length !== 2 ? null : { skillId: selected, firstIndex: targets[0]!, secondIndex: targets[1]! };
      case 'spawn': return targets[0] === undefined ? null : { skillId: selected, index: targets[0], value };
      case 'shuffle': return { skillId: selected, indices: state.world.board.cells.map((_, index) => index) };
      case 'clear-line': return { skillId: selected, axis, index: Number(line) - 1 };
      case 'rotate': return { skillId: selected, degrees };
      default: return null;
    }
  }
  const chosen = selected ? loaded.rule.definition.skills[selected] : null;
  const targetNode = loaded.nodes.find(node => node.id === state.undoStack.at(-1));
  const action = payload();
  const instruction = selected && loaded.rule.definition.numbers.sequence === 'custom' && (selected === 'upgrade' || selected === 'downgrade') ? `选择一个数列内数字，移到${selected === 'upgrade' ? '后一项' : '前一项'}。` : selected ? instructions[selected] : '';
  return <section className="skill-panel" aria-label="基础技能">
    <div className="panel-title"><h3>换一种走法</h3><span>技能也会留下节点</span></div>
    <div className="skill-buttons">{enabled.map(id => {
      const resource = state.ledger.skills[id], reason = skillResourceReason(state, loaded.rule, id, lookup);
      return <button key={id} disabled={disabled || !!reason} className={selected === id ? 'selected' : ''} aria-pressed={selected === id}
        aria-label={id === 'undo' ? '撤销一步' : `选择${skillNames[id]}技能`} title={reason ?? instructions[id]}
        onClick={() => { if (id === 'undo') { const targetNodeId = state.undoStack.at(-1); if (targetNodeId) void use({ skillId: 'undo', targetNodeId }); } else onSelect(selected === id ? null : id); }}>
        <strong>{id === 'undo' ? '↶ 撤销' : skillNames[id]}</strong><small>{resource.cooldownRemaining > 0 ? `${resource.cooldownRemaining} 回合冷却` : resource.charges === null ? '无限次数' : `${resource.charges} 次`}</small>
      </button>;
    })}</div>
    {enabled.includes('undo') && <p className="undo-hint">{targetNode ? `撤销将恢复第 ${targetNode.depth} 步的棋盘和成绩，当前资源照常扣除。` : '完成一次有效操作后即可撤销。'}</p>}
    {selected && chosen && <div className="skill-target" aria-label="技能目标">
      <strong>{skillNames[selected]}</strong><p>{instruction}</p>
      {selected === 'spawn' && <label className="field-label">放置数字<input inputMode="numeric" value={value} onChange={event => setValue(event.target.value)} /></label>}
      {selected === 'clear-line' && <div className="skill-options"><label className="field-label">轴<select value={axis} onChange={event => setAxis(event.target.value as 'row' | 'column')}><option value="row">行</option><option value="column">列</option></select></label>
        <label className="field-label">序号<input type="number" min="1" max={axis === 'row' ? state.world.board.rows : state.world.board.cols} value={line} onChange={event => setLine(event.target.value)} /></label></div>}
      {selected === 'rotate' && <label className="field-label">旋转角度<select value={degrees} onChange={event => setDegrees(Number(event.target.value) as 90 | 180 | 270)}><option value="180">180°</option>{state.world.board.rows === state.world.board.cols && <><option value="90">顺时针 90°</option><option value="270">顺时针 270°</option></>}</select></label>}
      {targets.length > 0 && <p className="target-coordinates">已选 {targets.map(index => `第 ${Math.floor(index / state.world.board.cols) + 1} 行 ${index % state.world.board.cols + 1} 列`).join('、')}</p>}
      <p className="skill-cost">成本 {chosen.scoreCost} 分 · {chosen.advanceRound ? '推进 1 回合' : '不推进回合'} · {chosen.spawnAfterUse || (chosen.advanceRound && loaded.rule.definition.spawn.triggerOn.includes('round')) ? '触发一次生成' : '不触发生成'}</p>
      <div className="button-row"><button className="primary" disabled={disabled || action === null} onClick={() => { if (action) void use(action); }}>施放{skillNames[selected]}</button><button disabled={disabled} onClick={() => onSelect(null)}>取消选取</button></div>
    </div>}
  </section>;
}
