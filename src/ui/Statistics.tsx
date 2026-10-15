import { useMemo, useState } from 'react';
import type { GameState, LoadedProject, RuleSetVersion } from '../domain/types';
import { skillIds } from '../domain/types';
import { skillNames } from '../domain/actions';
import { conditionMatches, ordered } from '../domain/advanced';
import { describeCondition } from '../domain/editor';
import { buildPathStatistics, compareBoards, scoreTrend } from '../history/statistics';
import { ruleForState } from '../history/candidates';
import { downloadFile } from '../files/download';
import { Modal } from './Modal';
import { triggerNames } from './AdvancedRules';

function RuleState({ state, rule }: { state: GameState; rule: RuleSetVersion }) {
  const definition = rule.definition, phase = ordered(definition.spawn.phaseRules).find(item => conditionMatches(item.condition, state));
  const skills = skillIds.filter(id => definition.skills[id].enabled || state.ledger.skills[id].usedCount > 0);
  return <div className="rule-state" data-testid="rule-runtime">
    <div className="runtime-heading"><div><span className="eyebrow">SELECTED NODE</span><h3>{rule.name} · v{rule.version}</h3></div><span className="mode-pill">{state.world.board.rows} × {state.world.board.cols}</span></div>
    <dl className="stats-metrics"><div><dt>世界回合</dt><dd>{state.world.roundCount}</dd></div><div><dt>计费回合</dt><dd>{state.ledger.chargedTurnCount}</dd></div><div><dt>有效操作</dt><dd>{state.ledger.effectiveActionCount}</dd></div></dl>
    <section><h3>合并与生成</h3><p>{({ 'equal-sum': '同值相加', mapping: '映射合并', 'sequence-next': '相邻数列' })[definition.merge.kind]} · {definition.merge.chain ? `允许连锁，单块最多 ${definition.merge.maxMergesPerTile} 次` : '新合并块本步不再次合并'} · 计分倍率 {definition.score.multiplier}</p>
      <p>当前位置策略：{definition.spawn.positionStrategy === 'uniform' ? '所有空格均匀' : '指定空格权重'}；按当前状态命中{phase ? `阶段 ${definition.spawn.phaseRules.findIndex(item => item.id === phase.id) + 1}` : '基础分布'}，生成 {phase?.count ?? definition.spawn.perActionCount} 个。</p>
      <p className="field-hint">这里读取所选节点；生成前事件可能改变实际命中的阶段。随机流已抽取 {state.rng.drawCount} 次。</p>
    </section>
    <section><h3>目标与结束</h3><p>数字目标：{definition.goals.tileValue ?? '关闭'}；成绩目标：{definition.goals.scoreTarget ?? '关闭'}；{definition.goals.winPolicy === 'all' ? '全部目标达成' : '任一目标达成'}。</p><p>当前状态：{({ playing: '进行中', won: '已达成目标', lost: '已触发结束条件' })[state.world.outcome.status]}；已达成：{state.world.goals.achieved.map(goal => goal === 'tile' ? '数字目标' : '成绩目标').join('、') || '暂无'}；{state.world.outcome.canContinue ? '仍可继续操作或使用允许的技能' : '本节点已经结束'}。</p></section>
    <section><h3>规则变量</h3>{Object.keys(state.world.events.variables).length ? <dl className="runtime-variables">{Object.entries(state.world.events.variables).map(([name, value]) => <div key={name}><dt>{name}</dt><dd title={value}>{value}</dd></div>)}</dl> : <p className="muted">本规则没有运行变量。</p>}</section>
    <section><h3>事件状态</h3>{definition.events.length ? <div className="runtime-events">{ordered(definition.events).map(event => {
      const count = state.world.events.counters[event.id] ?? 0, cooldown = state.world.events.cooldowns?.[event.id] ?? 0;
      const status = event.maxExecutions !== null && count >= event.maxExecutions ? '次数已达上限' : cooldown > 0 ? `冷却 ${cooldown} 回合` : conditionMatches(event.condition, state) ? `等待${triggerNames[event.trigger]}触发` : '条件未满足';
      return <article key={event.id}><div><strong>{event.name}</strong><span>{status}</span></div><p>已执行 {count} / {event.maxExecutions ?? '不限'} · {triggerNames[event.trigger]}</p><p className="field-hint">{describeCondition(event.condition, definition)}</p></article>;
    })}</div> : <p className="muted">本规则没有事件。</p>}</section>
    <section><h3>技能资源</h3>{skills.length ? <div className="stats-table-scroll"><table><thead><tr><th>技能</th><th>余量</th><th>已用</th><th>冷却</th><th>恢复进度</th></tr></thead><tbody>{skills.map(id => <tr key={id}><th>{skillNames[id]}{!definition.skills[id].enabled && '（已关闭）'}</th><td>{state.ledger.skills[id].charges ?? '无限'}</td><td>{state.ledger.skills[id].usedCount}</td><td>{state.ledger.skills[id].cooldownRemaining}</td><td>{state.ledger.skills[id].rechargeProgress} / {definition.skills[id].rechargeEveryTurns ?? '关闭'}</td></tr>)}</tbody></table></div> : <p className="muted">本规则没有启用技能。</p>}</section>
  </div>;
}

export function Statistics({ loaded, selectedId, busy, onPreview, onClose }: { loaded: LoadedProject; selectedId: string; busy: boolean; onPreview: (id: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState('path'), [endId, setEndId] = useState(selectedId), [page, setPage] = useState(-1), [filter, setFilter] = useState('all');
  const [baseline, setBaseline] = useState('saved'), [diffLimit, setDiffLimit] = useState(100);
  const byId = useMemo(() => new Map(loaded.nodes.map(node => [node.id, node])), [loaded.nodes]);
  const stats = useMemo(() => buildPathStatistics(loaded, endId), [loaded, endId]);
  const trend = useMemo(() => scoreTrend(stats.rows, selectedId), [stats, selectedId]);
  const selected = byId.get(selectedId)!, state = loaded.states.get(selected.stateHash)!, rule = ruleForState(loaded, state);
  const basisId = baseline === 'parent' ? selected.parentId ?? selectedId : baseline === 'start' ? stats.rows[0]!.nodeId : baseline === 'end' ? endId : loaded.project.activeNodeId;
  const basis = byId.get(basisId)!, basisState = loaded.states.get(basis.stateHash)!;
  const basisRule = ruleForState(loaded, basisState);
  const eventChanges = [...new Set([...Object.keys(basisState.world.events.counters), ...Object.keys(state.world.events.counters)])].filter(id => basisState.world.events.counters[id] !== state.world.events.counters[id] || basisState.world.events.cooldowns?.[id] !== state.world.events.cooldowns?.[id]);
  const comparison = useMemo(() => compareBoards(basisState, state), [basisState, state]);
  const filtered = stats.rows.filter(row => filter === 'all' || row.actionType === filter), pages = Math.max(1, Math.ceil(filtered.length / 50)), currentPage = page < 0 ? pages - 1 : Math.min(page, pages - 1);
  const selectedIndex = stats.rows.findIndex(row => row.nodeId === selectedId);
  function endpoint(id: string) { setEndId(id); setPage(-1); }
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('');
  async function download() {
    if (exporting) return;
    setExporting(true); setExportError('');
    try { await downloadFile({ filename: `${loaded.project.id}-statistics.json`, bytes: new TextEncoder().encode(JSON.stringify({ format: '2048-sandbox-path-statistics', formatVersion: 1, projectId: loaded.project.id, exportedAt: new Date().toISOString(), ...stats }, null, 2)) }); }
    catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExporting(false); }
  }
  return <Modal title="规则与路径统计" className="statistics-modal" busy={busy} onClose={onClose}>
    <p className="muted">只读分析已保存的节点；点选图表或表格可免费回看，保存位置保持不变。</p>
    <div className="stats-tabs" role="tablist" aria-label="统计页面">{[['path', '路径统计'], ['runtime', '规则状态'], ['compare', '节点对比']].map(([id, label], index) => <button key={id} role="tab" id={`stats-tab-${id}`} tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls="stats-content" onClick={() => setTab(id!)} onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
      if (next !== null) { event.preventDefault(); const target = ['path', 'runtime', 'compare'][next]!; setTab(target); document.getElementById(`stats-tab-${target}`)?.focus(); }
    }}>{label}</button>)}</div>
    <div role="tabpanel" id="stats-content" aria-labelledby={`stats-tab-${tab}`}>
      {tab === 'path' && <>
        <div className="stats-path-heading"><h3>起点 → 第 {stats.rows.at(-1)!.depth} 步</h3><div className="button-row"><button disabled={busy} onClick={() => endpoint(selectedId)}>以当前预览为终点</button><button disabled={busy} onClick={() => endpoint(loaded.project.activeNodeId)}>以保存位置为终点</button><button disabled={exporting} onClick={() => { void download(); }}>{exporting ? '正在保存…' : '下载统计 JSON'}</button></div></div>
        {exportError && <p role="alert" className="file-error">{exportError}</p>}
        <dl className="stats-metrics"><div><dt>路径最高成绩</dt><dd data-testid="path-high-score" title={stats.highestScore}>{stats.highestScore}</dd></div><div><dt>路径最大数字</dt><dd title={stats.largestTile}>{stats.largestTile}</dd></div><div><dt>路径有效操作</dt><dd>{stats.rows.length - 1}</dd></div><div><dt>实际合并累计</dt><dd>{stats.mergeOperations}</dd></div><div><dt>经历规则版本</dt><dd>{stats.ruleVersions}</dd></div><div><dt>路径检查点</dt><dd>{stats.pathCheckpoints}</dd></div></dl>
        <div className="score-trend"><div className="panel-title"><h3>节点成绩变化</h3><span>包含撤销与规则编辑</span></div>
          <svg viewBox="-5 -10 110 120" role="group" aria-label="路径成绩趋势，点选回看" preserveAspectRatio="none"><path className="trend-baseline" d="M0,100H100" /><polyline points={trend.map(point => `${point.x},${point.y}`).join(' ')} />
            {trend.map(point => <g key={point.nodeId} role="button" tabIndex={0} aria-label={`回看第 ${point.depth} 步，成绩 ${point.score}`} className={point.nodeId === selectedId ? 'selected' : ''} onClick={() => onPreview(point.nodeId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPreview(point.nodeId); } }}><title>第 {point.depth} 步 · {point.score} 分</title><circle className="trend-hit" cx={point.x} cy={point.y} r="3" /><circle cx={point.x} cy={point.y} r="1" /></g>)}
          </svg><label className="field-label">统计预览步数<input type="range" min={0} max={stats.rows.length - 1} value={selectedIndex < 0 ? stats.rows.length - 1 : selectedIndex} onChange={event => onPreview(stats.rows[Number(event.target.value)]!.nodeId)} /></label>
          <p className="field-hint">图表最多抽样 200 点并保留峰值；统计、滑块与下载包含完整路径。成绩和数字始终使用精确整数。</p>
        </div>
        <div className="stats-breakdown">{Object.entries({ move: '方向移动', skill: '技能', edit: '棋盘编辑', 'rule-edit': '规则发布' }).map(([key, label]) => <span key={key}>{label}<strong>{stats.actions[key as keyof typeof stats.actions]}</strong></span>)}</div>
        <p className="field-hint">路径重抽 {stats.rerolls} 次，复现 {stats.reproductions} 次。全局 {stats.totalNodes} 个节点、{stats.forkPoints} 处分叉；全局计数包含归档，不将其他分支的成绩相加。</p>
        <div className="stats-list-heading"><h3>逐步记录</h3><label>筛选路径操作<select value={filter} onChange={event => { setFilter(event.target.value); setPage(-1); }}><option value="all">全部</option><option value="move">方向移动</option><option value="skill">技能</option><option value="edit">棋盘编辑</option><option value="rule-edit">规则发布</option></select></label></div>
        <div className="stats-table-scroll"><table><thead><tr><th>节点</th><th>操作</th><th>成绩</th><th>变化</th><th>世界回合</th><th>规则</th></tr></thead><tbody>{filtered.slice(currentPage * 50, (currentPage + 1) * 50).map(row => <tr key={row.nodeId} aria-current={row.nodeId === selectedId ? 'step' : undefined}><td><button onClick={() => onPreview(row.nodeId)}>第 {row.depth} 步 · {row.nodeId.slice(-6)}</button></td><td>{row.action}</td><td title={row.score}>{row.score}</td><td>{row.scoreDelta}</td><td>{row.round}</td><td>v{row.ruleRef.version}</td></tr>)}</tbody></table></div>
        {!filtered.length && <p className="muted">这条路径没有此类操作。</p>}<div className="stats-pagination"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>前 50 条</button><span>{currentPage + 1} / {pages} 页 · {filtered.length} 条</span><button disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>后 50 条</button></div>
      </>}
      {tab === 'runtime' && <RuleState state={state} rule={rule} />}
      {tab === 'compare' && <div className="node-comparison"><label className="field-label">比较基准<select value={baseline} onChange={event => { setBaseline(event.target.value); setDiffLimit(100); }}><option value="saved">当前保存节点</option><option value="parent">所选节点的父节点</option><option value="start">统计路径起点</option><option value="end">统计路径终点</option></select></label>
        <p>第 {basis.depth} 步 → 所选第 {selected.depth} 步 · 成绩变化 <strong>{comparison.scoreDelta}</strong> · 棋盘差异 {comparison.differences.length} / {comparison.total} 格</p>
        <p>规则 v{basisState.ruleRef.version} → v{state.ruleRef.version} · 有效操作 {basisState.ledger.effectiveActionCount} → {state.ledger.effectiveActionCount} · 世界回合 {basisState.world.roundCount} → {state.world.roundCount}</p>
        <p>基准规则：{basisRule.name}；所选规则：{rule.name}</p><details className="rule-identities"><summary>规则标识与摘要</summary><p>{basisRule.id} / v{basisRule.version}<br />{basisRule.definitionHash}</p><p>{rule.id} / v{rule.version}<br />{rule.definitionHash}</p></details>
        <p>随机流{basisState.rng.state === state.rng.state && basisState.rng.increment === state.rng.increment && basisState.rng.drawCount === state.rng.drawCount ? '相同' : '不同'} · 抽取计数 {basisState.rng.drawCount} → {state.rng.drawCount}</p>
        {comparison.differences.length ? <div className="stats-table-scroll"><table><thead><tr><th>位置</th><th>基准数字</th><th>所选数字</th></tr></thead><tbody>{comparison.differences.slice(0, diffLimit).map(item => <tr key={`${item.row}/${item.col}`}><th>{item.row} 行 {item.col} 列</th><td>{item.before}</td><td>{item.after}</td></tr>)}</tbody></table></div> : <p className="muted">棋盘数字与尺寸一致；资源和随机流仍可能不同。</p>}
        {comparison.differences.length > diffLimit && <button onClick={() => setDiffLimit(value => value + 100)}>显示更多差异</button>}
        <h3>资源与变量变化</h3><ul>{skillIds.filter(id => JSON.stringify(basisState.ledger.skills[id]) !== JSON.stringify(state.ledger.skills[id])).map(id => <li key={id}>{skillNames[id]}：余量 {basisState.ledger.skills[id].charges ?? '无限'} → {state.ledger.skills[id].charges ?? '无限'}，已用 {basisState.ledger.skills[id].usedCount} → {state.ledger.skills[id].usedCount}，冷却 {basisState.ledger.skills[id].cooldownRemaining} → {state.ledger.skills[id].cooldownRemaining}，恢复进度 {basisState.ledger.skills[id].rechargeProgress} → {state.ledger.skills[id].rechargeProgress}</li>)}</ul>
        <dl className="runtime-variables">{[...new Set([...Object.keys(basisState.world.events.variables), ...Object.keys(state.world.events.variables)])].filter(key => basisState.world.events.variables[key] !== state.world.events.variables[key]).map(key => <div key={key}><dt>{key}</dt><dd>{basisState.world.events.variables[key] ?? '未声明'} → {state.world.events.variables[key] ?? '未声明'}</dd></div>)}</dl>
        <h3>事件变化</h3>{eventChanges.length ? <ul>{eventChanges.map(id => <li key={id}>{rule.definition.events.find(event => event.id === id)?.name ?? basisRule.definition.events.find(event => event.id === id)?.name ?? id}：执行 {basisState.world.events.counters[id] ?? '未声明'} → {state.world.events.counters[id] ?? '未声明'}，冷却 {basisState.world.events.cooldowns?.[id] ?? '未声明'} → {state.world.events.cooldowns?.[id] ?? '未声明'}</li>)}</ul> : <p className="muted">事件执行次数与冷却一致。</p>}
      </div>}
    </div>
  </Modal>;
}
