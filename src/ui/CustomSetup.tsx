import { useState, type FormEvent } from 'react';
import type { Direction, GameState, RuleDefinition, RuleSetVersion, SkillConfig, Weight } from '../domain/types';
import { skillIds } from '../domain/types';
import { skillNames } from '../domain/actions';
import { capabilitiesForDefinition, createCustomRule, sandboxDefinition, validateDefinition, type RuleIssue } from '../presets/rules';
import { classicRule } from '../presets/classic';
import { Modal } from './Modal';
import { AdvancedRules } from './AdvancedRules';
import { migrateState, type ResizePreview } from '../engine/migration';
import { canonicalJson } from '../domain/hash';
import { Board } from './Board';
import { sandboxPresets } from '../presets/catalog';

interface Props {
  currentRule?: RuleSetVersion | undefined; onClose: () => void; onStart: (rule: RuleSetVersion, name: string) => Promise<boolean>;
  editing?: { state: GameState; rule: RuleSetVersion; onPublish: (definition: RuleDefinition, name: string, policy: 'cancel' | 'drop' | 'pack') => Promise<boolean> } | undefined;
}
const weightText = (weights: Weight[]) => weights.map(item => `${item.value}:${item.weight}`).join(', ');
const inputNumber = (value: string) => value === '' ? NaN : Number(value);
const fieldId = (path: string) => `rule${path.replaceAll('/', '-')}`;
const extraNames: Record<string, string> = { '/goals/roundLimit': '回合上限', '/score/multiplier': '合并计分倍率' };
const skillFieldNames: Record<string, string> = { initialCharges: '初始次数', maxCharges: '最大储量', cooldownTurns: '冷却回合', scoreCost: '成绩成本', rechargeEveryTurns: '恢复间隔', rechargeAmount: '恢复数量' };
const fieldNames: Record<string, string> = { '/board/rows': '棋盘行数', '/board/cols': '棋盘列数', '/board/initialLayout': '初始布局', '/numbers/maxDigits': '数字位数预算', '/numbers/allowedValues': '允许数字', '/spawn/initialCount': '开局数量', '/spawn/initialWeights': '开局数字权重', '/spawn/perActionCount': '每次生成数量', '/spawn/weights': '回合数字权重', '/movement/directions': '移动方向', '/goals/tileValue': '数字目标', '/goals/scoreTarget': '成绩目标' };

function NumberField({ path, label, value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, disabled = false }: {
  path: string; label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; disabled?: boolean;
}) {
  return <label className="field-label" htmlFor={fieldId(path)}>{label}<input id={fieldId(path)} type="number" min={min} max={max} step="1" disabled={disabled}
    value={Number.isFinite(value) ? value : ''} onChange={event => onChange(inputNumber(event.target.value))} /></label>;
}

export function CustomSetup({ currentRule, onClose, onStart, editing }: Props) {
  const initial = editing?.rule.definition ?? sandboxDefinition();
  const [definition, setDefinition] = useState<RuleDefinition>(() => ({ ...structuredClone(initial), mode: 'custom' })), [name, setName] = useState(editing?.rule.name ?? '我的沙盒');
  const [initialWeights, setInitialWeights] = useState(() => weightText(initial.spawn.initialWeights)), [weights, setWeights] = useState(() => weightText(initial.spawn.weights));
  const [layout, setLayout] = useState(() => initial.board.initialLayout.map(item => `${item.index}:${item.value}`).join(', ')), [allowed, setAllowed] = useState(() => initial.numbers.allowedValues?.join(', ') ?? '');
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  function patch<K extends 'board' | 'numbers' | 'spawn' | 'movement' | 'score' | 'goals'>(group: K, change: Partial<RuleDefinition[K]>) {
    setDefinition(current => ({ ...current, [group]: { ...current[group], ...change } }));
  }
  function skill(id: keyof RuleDefinition['skills'], change: Partial<SkillConfig>) {
    setDefinition(current => ({ ...current, skills: { ...current.skills, [id]: { ...current.skills[id], ...change } } }));
  }
  function preset(source: RuleDefinition, title: string) {
    const next = structuredClone(source); next.mode = 'custom'; setDefinition(next); setName(title);
    setInitialWeights(weightText(next.spawn.initialWeights)); setWeights(weightText(next.spawn.weights));
    setLayout(next.board.initialLayout.map(item => `${item.index}:${item.value}`).join(', '));
    setAllowed(next.numbers.allowedValues?.join(', ') ?? ''); setFailure(null);
  }
  const candidate = structuredClone(definition), textIssues: RuleIssue[] = [];
  function parsePairs(text: string, path: string, kind: 'weights' | 'layout') {
    if (!text.trim()) return [];
    return text.trim().split(/[,，\s]+/).map((pair, index) => {
      const parts = pair.split(':');
      if (parts.length !== 2 || parts.some(part => !/^(0|[1-9][0-9]*)$/.test(part))) textIssues.push({ path, severity: 'error', message: `第 ${index + 1} 项格式应为${kind === 'weights' ? '数字:权重' : '格索引:数字'}，使用非负整数` });
      return { first: parts[0] ?? '', second: parts[1] ?? '' };
    });
  }
  candidate.spawn.initialWeights = parsePairs(initialWeights, '/spawn/initialWeights', 'weights').map(item => ({ value: item.first, weight: Number(item.second) }));
  candidate.spawn.weights = parsePairs(weights, '/spawn/weights', 'weights').map(item => ({ value: item.first, weight: Number(item.second) }));
  candidate.board.initialLayout = parsePairs(layout, '/board/initialLayout', 'layout').map(item => ({ index: Number(item.first), value: item.second }));
  candidate.numbers.allowedValues = allowed.trim() ? allowed.trim().split(/[,，\s]+/) : null;
  const issues = [...textIssues, ...validateDefinition(candidate)];
  let migration: ResizePreview | null = null;
  if (editing && !issues.some(issue => issue.severity === 'error')) {
    try {
      const preview: RuleSetVersion = { ...editing.rule, id: editing.rule.definition.mode === 'normal' ? 'rules-preview' : editing.rule.id, version: editing.rule.version + 1,
        definition: candidate, requiredCapabilities: capabilitiesForDefinition(candidate) };
      migration = migrateState(editing.state, editing.rule, preview, candidate.board.overflowPolicy);
    } catch (cause) { issues.push({ path: '/board/overflowPolicy', severity: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
  }
  const errors = issues.filter(issue => issue.severity === 'error'), warnings = issues.filter(issue => issue.severity === 'warning');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (errors.length) { document.getElementById('rule-errors')?.focus(); return; }
    setBusy(true); setFailure(null);
    try {
      const saved = editing ? await editing.onPublish(candidate, name.trim() || editing.rule.name, candidate.board.overflowPolicy) : await onStart(await createCustomRule(name, candidate), name.trim() || '我的沙盒');
      if (saved) onClose(); else setFailure('保存未确认；请关闭设置查看提示，必要时重试同一笔保存。');
    }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function startClassic() {
    if (busy) return; setBusy(true); setFailure(null);
    try { if (await onStart(classicRule, '经典对局')) onClose(); else setFailure('新局保存未确认，请关闭设置并重试同一笔保存。'); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  function issueField(path: string) {
    if (path.startsWith('/skills/')) { const parts = path.split('/'); return { path: parts.slice(0, 4).join('/'), name: `${skillNames[parts[2] as keyof typeof skillNames]} · ${skillFieldNames[parts[3]!] ?? parts[3]}` }; }
    const advanced: Record<string, string> = { '/numbers/customSequence': '自定义数列', '/merge': '合并规则', '/spawn/positionWeights': '位置权重', '/spawn/phaseRules': '阶段生成', '/events': '事件规则', '/variables': '规则变量', '/board/overflowPolicy': '缩小棋盘策略' };
    const group = Object.keys(advanced).find(item => path.startsWith(item));
    if (group) return { path: group, name: advanced[group]! };
    const key = Object.keys(fieldNames).find(item => path.startsWith(item)) ?? path;
    return { path: key, name: fieldNames[key] ?? extraNames[key] ?? key };
  }
  const d = definition;
  return <Modal title={editing ? '修改本节点规则' : '新建自定义对局'} className="setup-modal" busy={busy} onClose={onClose}>
    <p className="muted">{editing ? '发布为本节点的新子节点和不可变规则版本。原有路径保留，技能撤销栈清空形成版本边界。' : '设置用于新开一局。已保存的对局和路径都会保留。'}</p>
    <div className="preset-row"><button disabled={busy} onClick={() => preset(sandboxDefinition(), '我的沙盒')}>基础沙盒 · 撤销 3 次</button>
      <button disabled={busy} onClick={() => preset(classicRule.definition, '自定义对局')}>从经典参数开始</button>
      {currentRule && <button disabled={busy} onClick={() => preset(currentRule.definition, `${currentRule.name}副本`)}>复制当前规则</button>}</div>
    {!editing && <button className="text-button classic-shortcut" disabled={busy} onClick={() => { void startClassic(); }}>直接开始经典对局 →</button>}
    {!editing && <details className="preset-gallery"><summary>探索预设玩法 · 4 套</summary><div className="preset-grid">{sandboxPresets.map(item => <button key={item.id} disabled={busy} onClick={() => preset(item.definition(), item.name)}><strong>{item.name}</strong><span>{item.description}</span></button>)}</div><p className="field-hint">选择预设只填写下方配置；创建后才保存新对局。</p></details>}
    <nav className="setup-nav" aria-label="规则设置导航">{[['setup-board','棋盘'],['setup-spawn','生成移动'],['setup-goals','目标'],['setup-skills','技能'],['rule-merge','高级合并'],['rule-events','事件']].map(([id, title]) => <button type="button" key={id} onClick={() => {
      const element = document.getElementById(id!); let ancestor = element?.parentElement;
      while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
      element?.scrollIntoView({ block: 'start' }); element?.focus({ preventScroll: true });
    }}>{title}</button>)}</nav>
    <form onSubmit={event => { void submit(event); }} noValidate>
      <fieldset disabled={busy} className="setup-fields">
        <label className="field-label">{editing ? '规则版本名称' : '对局名称'}<input value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
        <section className="setup-section" id="setup-board" tabIndex={-1}><h3>棋盘与数字</h3><div className="setup-grid">
          <NumberField path="/board/rows" label="棋盘行数" min={1} max={64} value={d.board.rows} onChange={value => patch('board', { rows: value })} />
          <NumberField path="/board/cols" label="棋盘列数" min={1} max={64} value={d.board.cols} onChange={value => patch('board', { cols: value })} />
          <NumberField path="/numbers/maxDigits" label="数字位数预算" min={1} max={4096} value={d.numbers.maxDigits} onChange={value => patch('numbers', { maxDigits: value })} />
          <NumberField path="/score/multiplier" label="合并计分倍率" value={d.score.multiplier} onChange={value => patch('score', { multiplier: value })} />
        </div><label className="field-label">初始布局（格索引:数字）<textarea id={fieldId('/board/initialLayout')} rows={2} value={layout} placeholder="例如 0:2, 1:2, 4:8" onChange={event => setLayout(event.target.value)} /></label>
          <p className="field-hint">{editing ? '初始布局与开局数量只影响下次新局；当前数字按下方策略迁移。索引仍需符合新尺寸。' : '索引从 0 开始，按行排列；数字 0 也占格。先放布局，再补足开局数量。'}</p>
          {editing && <label className="field-label">缩小棋盘策略<select id={fieldId('/board/overflowPolicy')} value={d.board.overflowPolicy} onChange={event => patch('board', { overflowPolicy: event.target.value as 'cancel' | 'drop' | 'pack' })}><option value="cancel">出现溢出数字时取消</option><option value="pack">按原索引搬到空格，空间不足取消</option><option value="drop">明确丢弃溢出数字，旧节点仍保留</option></select></label>}
          <label className="field-label">允许数字（留空为不限）<input id={fieldId('/numbers/allowedValues')} value={allowed} placeholder="例如 0, 2, 4, 8" onChange={event => setAllowed(event.target.value)} /></label>
        </section>
        <section className="setup-section" id="setup-spawn" tabIndex={-1}><h3>生成与移动</h3><div className="setup-grid">
          <NumberField path="/spawn/initialCount" label="开局数量" value={d.spawn.initialCount} onChange={value => patch('spawn', { initialCount: value })} />
          <NumberField path="/spawn/perActionCount" label="每次生成数量" value={d.spawn.perActionCount} onChange={value => patch('spawn', { perActionCount: value })} />
          <label className="field-label">开局数字权重<input id={fieldId('/spawn/initialWeights')} value={initialWeights} onChange={event => setInitialWeights(event.target.value)} /></label>
          <label className="field-label">回合数字权重<input id={fieldId('/spawn/weights')} value={weights} onChange={event => setWeights(event.target.value)} /></label>
          <label className="field-label">空间不足时<select value={d.spawn.emptyStrategy} onChange={event => patch('spawn', { emptyStrategy: event.target.value as 'fill-available' | 'skip-batch' })}><option value="fill-available">生成至填满</option><option value="skip-batch">整批跳过</option></select></label>
          <label className="field-label">无效方向输入<select value={d.movement.invalidMovePolicy} onChange={event => patch('movement', { invalidMovePolicy: event.target.value as 'ignore' | 'advance-round' })}><option value="ignore">忽略，不计步</option><option value="advance-round">计入操作并推进回合</option></select></label>
        </div><p className="field-hint">权重写作“数字:权重”，以逗号分隔。0 数量允许关闭生成。</p>
          <div className="setup-checks"><span>生成触发</span>{(['move', 'round'] as const).map(trigger => <label key={trigger}><input type="checkbox" checked={d.spawn.triggerOn.includes(trigger)} onChange={event => patch('spawn', { triggerOn: event.target.checked ? [...d.spawn.triggerOn, trigger] : d.spawn.triggerOn.filter(item => item !== trigger) })} />{trigger === 'move' ? '移动后' : '规则回合后'}</label>)}</div>
          <div className="setup-checks" id={fieldId('/movement/directions')}><span>移动方向</span>{(['up', 'right', 'down', 'left'] as Direction[]).map((direction, index) => <label key={direction}><input type="checkbox" checked={d.movement.directions.includes(direction)} onChange={event => patch('movement', { directions: event.target.checked ? [...d.movement.directions, direction] : d.movement.directions.filter(item => item !== direction) })} />{['上', '右', '下', '左'][index]}</label>)}</div>
        </section>
        <section className="setup-section" id="setup-goals" tabIndex={-1}><h3>目标与结束</h3><div className="setup-grid">
          <label className="field-label">数字目标（留空关闭）<input id={fieldId('/goals/tileValue')} inputMode="numeric" value={d.goals.tileValue ?? ''} onChange={event => patch('goals', { tileValue: event.target.value === '' ? null : event.target.value })} /></label>
          <label className="field-label">成绩目标（留空关闭）<input id={fieldId('/goals/scoreTarget')} inputMode="numeric" value={d.goals.scoreTarget ?? ''} onChange={event => patch('goals', { scoreTarget: event.target.value === '' ? null : event.target.value })} /></label>
          <label className="field-label">完成方式<select value={d.goals.winPolicy} onChange={event => patch('goals', { winPolicy: event.target.value as 'any' | 'all' })}><option value="any">任一目标</option><option value="all">全部目标</option></select></label>
          <label className="field-label">回合上限（留空不限）<input id={fieldId('/goals/roundLimit')} type="number" min="1" value={d.goals.roundLimit ?? ''} onChange={event => patch('goals', { roundLimit: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        </div><div className="setup-checks">
          <label><input type="checkbox" checked={d.goals.continueAfterWin} onChange={event => patch('goals', { continueAfterWin: event.target.checked })} />胜利后继续</label>
          <label><input type="checkbox" checked={d.goals.lossWhenNoMoves} onChange={event => patch('goals', { lossWhenNoMoves: event.target.checked })} />无路可走时判负</label>
          <label><input type="checkbox" checked={d.goals.allowRescueSkills} onChange={event => patch('goals', { allowRescueSkills: event.target.checked })} />考虑失败后可用技能</label>
        </div></section>
        <section className="setup-section" id="setup-skills" tabIndex={-1}><h3>基础技能</h3><p className="field-hint">每次成功施放都会计入有效操作并自动保存。撤销恢复世界进度，资源从当前节点扣除。</p>
          <div className="skill-configs">{skillIds.map(id => {
            const config = d.skills[id], prefix = `/skills/${id}`;
            return <div key={id} className={`skill-config ${config.enabled ? 'enabled' : ''}`}>
              <label className="skill-enable"><input type="checkbox" checked={config.enabled} onChange={event => skill(id, { enabled: event.target.checked })} aria-label={`启用${skillNames[id]}`} />{skillNames[id]}</label>
              <details><summary>{config.unlimited ? '无限次数' : `${config.initialCharges} 次`} · 资源与结算</summary><fieldset disabled={!config.enabled} className="skill-config-fields">
                <div className="setup-grid"><NumberField path={`${prefix}/initialCharges`} label={`${skillNames[id]}初始次数`} value={config.initialCharges} onChange={value => skill(id, { initialCharges: value })} />
                  <NumberField path={`${prefix}/maxCharges`} label={`${skillNames[id]}最大储量`} value={config.maxCharges} onChange={value => skill(id, { maxCharges: value })} />
                  <NumberField path={`${prefix}/cooldownTurns`} label={`${skillNames[id]}冷却回合`} value={config.cooldownTurns} onChange={value => skill(id, { cooldownTurns: value })} />
                  <label className="field-label">{skillNames[id]}成绩成本<input id={fieldId(`${prefix}/scoreCost`)} inputMode="numeric" value={config.scoreCost} onChange={event => skill(id, { scoreCost: event.target.value })} /></label>
                  <label className="field-label">{skillNames[id]}恢复间隔（留空关闭）<input id={fieldId(`${prefix}/rechargeEveryTurns`)} type="number" min="1" value={config.rechargeEveryTurns ?? ''} onChange={event => skill(id, { rechargeEveryTurns: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                  <NumberField path={`${prefix}/rechargeAmount`} label={`${skillNames[id]}每次恢复数量`} value={config.rechargeAmount} onChange={value => skill(id, { rechargeAmount: value })} /></div>
                <div className="setup-checks">{([['unlimited', '无限次数'], ['advanceRound', '推进规则回合'], ['spawnAfterUse', '施放后生成'], ['allowAfterLoss', '失败后可用']] as const).map(([field, label]) => <label key={field}><input type="checkbox" checked={config[field]} onChange={event => skill(id, { [field]: event.target.checked })} />{skillNames[id]}{label}</label>)}</div>
              </fieldset></details>
            </div>;
          })}</div>
        </section>
        <AdvancedRules definition={definition} onChange={setDefinition} />
      </fieldset>
      {errors.length > 0 && <div id="rule-errors" className="file-error" role="alert" tabIndex={-1}><strong>请修正 {errors.length} 处配置</strong><ul>{errors.map((issue, index) => { const field = issueField(issue.path); return <li key={index}><a href={`#${fieldId(field.path)}`} onClick={event => { event.preventDefault(); const input = document.getElementById(fieldId(field.path)); let container = input?.parentElement; while (container) { if (container.tagName === 'DETAILS') container.setAttribute('open', ''); container = container.parentElement; } input?.focus(); }}>{field.name}</a>：{issue.message}</li>; })}</ul></div>}
      {warnings.length > 0 && <div className="setup-warnings" role="status"><strong>玩法提示</strong><ul>{warnings.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>}
      {failure && <p className="file-error" role="alert">{failure}</p>}
      {editing && migration && <section className="migration-preview" data-testid="migration-preview"><h3>规则修改预览</h3><p>{editing.state.world.board.rows} × {editing.state.world.board.cols} → {migration.state.world.board.rows} × {migration.state.world.board.cols} · 搬移 {migration.moved} 个 · 丢弃 {migration.dropped} 个</p>
        <p>成绩保持 {editing.state.world.score}；不推进规则回合，成功后有效操作 +1。事件如配置“编辑后”触发，将在提交结算时执行。</p>
        <div className="migration-board"><Board state={migration.state} nodeId="preview" disabled onMove={() => {}} /></div>
        <p>变化模块：{Object.entries(candidate).filter(([key, value]) => canonicalJson(value) !== canonicalJson(editing.rule.definition[key as keyof RuleDefinition])).map(([key]) => ({ mode: '模式', board: '棋盘', numbers: '数字', spawn: '生成', movement: '移动', merge: '合并', score: '计分', skills: '技能', goals: '目标', timer: '计时', events: '事件', variables: '变量' })[key]).join('、') || '仅版本名称或版本边界'}</p>
        {migration.overflow.length > 0 && <p>受影响数字：{migration.overflow.map(item => `格 ${item.index} 的 ${item.value}`).join('、')}</p>}
        <ul>{skillIds.filter(id => editing.state.ledger.skills[id].charges !== migration.state.ledger.skills[id].charges).map(id => <li key={id}>{skillNames[id]}余量 {editing.state.ledger.skills[id].charges ?? '无限'} → {migration!.state.ledger.skills[id].charges ?? '无限'}</li>)}</ul>
      </section>}
      <div className="setup-submit"><span>{d.board.rows} × {d.board.cols} · {skillIds.filter(id => d.skills[id].enabled).length} 种技能</span><button className="primary" type="submit" disabled={busy}>{busy ? '正在保存…' : editing ? '发布规则新版本' : '创建自定义对局'}</button></div>
    </form>
  </Modal>;
}
