import { lazy, Suspense, useEffect, useState } from 'react';
import { useGame } from '../app/useGame';
import type { Direction, ProjectRecord, SkillId } from '../domain/types';
import { repository } from '../persistence/repository';
import { Board } from './Board';
import { History } from './History';
import { OfflineStatus } from './OfflineStatus';
import { SkillPanel } from './SkillPanel';
import type { ExportKind } from '../files/types';
import { ruleForState } from '../history/candidates';
import { useExperience } from '../app/useExperience';
import { useSound } from '../app/useSound';
import { scoreChange } from '../presentation/feedback';
import brandSvg from '../../public/icon.svg?raw';
import { APP_VERSION } from '../app/version';

const brandIcon = import.meta.env.MODE === 'standalone' ? `data:image/svg+xml,${encodeURIComponent(brandSvg)}` : `${import.meta.env.BASE_URL}icon.svg`;

const HistoryTree = lazy(() => import('./HistoryTree').then(module => ({ default: module.HistoryTree })));
const FileCenter = lazy(() => import('./FileCenter').then(module => ({ default: module.FileCenter })));
const CustomSetup = lazy(() => import('./CustomSetup').then(module => ({ default: module.CustomSetup })));
const BoardEditor = lazy(() => import('./BoardEditor').then(module => ({ default: module.BoardEditor })));
const Statistics = lazy(() => import('./Statistics').then(module => ({ default: module.Statistics })));
const Help = lazy(() => import('./Help').then(module => ({ default: module.Help })));
const ExperienceSettings = lazy(() => import('./ExperienceSettings').then(module => ({ default: module.ExperienceSettings })));
const DeleteMatch = lazy(() => import('./DeleteMatch').then(module => ({ default: module.DeleteMatch })));

const keyDirections: Record<string, Direction> = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left', w: 'up', d: 'right', s: 'down', a: 'left' };

export function App() {
  const game = useGame();
  const experience = useExperience(), { preferences } = experience;
  const sound = useSound(preferences.sound, preferences.volume, game.feedback);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false), [fileBusy, setFileBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false), [selectedSkill, setSelectedSkill] = useState<SkillId | null>(null), [targets, setTargets] = useState<number[]>([]);
  const [ruleEditOpen, setRuleEditOpen] = useState(false), [boardEditOpen, setBoardEditOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [experienceOpen, setExperienceOpen] = useState(false);
  const [files, setFiles] = useState<{ tab: 'import' | 'export'; kind: ExportKind; nodeId: string | null } | null>(null);
  const { loaded, busy, error, previewId, armedId } = game;
  const selectedId = loaded ? previewId ?? loaded.project.activeNodeId : null;
  const node = loaded?.nodes.find(item => item.id === selectedId);
  const state = node ? loaded?.states.get(node.stateHash) : null;
  const viewedLoaded = loaded && state ? { ...loaded, rule: ruleForState(loaded, state) } : loaded;
  const inspecting = previewId !== null && armedId === null;
  const modalOpen = deleteTarget !== null || treeOpen || files !== null || setupOpen || ruleEditOpen || boardEditOpen || statisticsOpen || helpOpen || experienceOpen;
  const actionBlocked = busy || !!error || inspecting || modalOpen;
  const blocked = actionBlocked || selectedSkill !== null || !state?.world.outcome.canContinue || state.world.outcome.status === 'lost';
  const selectingCell = selectedSkill !== null && ['delete', 'swap', 'upgrade', 'downgrade', 'spawn'].includes(selectedSkill);
  useEffect(() => { setSelectedSkill(null); setTargets([]); }, [node?.id, previewId, armedId]);
  function chooseSkill(id: SkillId | null) { setSelectedSkill(id); setTargets([]); }
  function returnHome() { game.returnHome(); setLibraryOpen(false); }
  function selectCell(index: number) {
    setTargets(current => selectedSkill === 'swap' ? current.includes(index) ? current.filter(item => item !== index) : current.length < 2 ? [...current, index] : [index] : [index]);
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && (event.target.closest('input,select,textarea') || event.target.isContentEditable)) return;
      const direction = keyDirections[event.key] ?? keyDirections[event.key.toLowerCase()];
      if (!direction || !state || modalOpen) return;
      // Movement belongs to the game even while saving or ignoring a held key.
      event.preventDefault();
      if (!event.repeat && !blocked) void game.move(direction);
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [game.move, state, blocked, modalOpen]);

  useEffect(() => {
    function nativeBack(event: Event) {
      if (busy || fileBusy || exporting || game.hasPending || game.initializing) { event.preventDefault(); return; }
      if (modalOpen || selectedSkill || libraryOpen || loaded) event.preventDefault();
      if (deleteTarget) setDeleteTarget(null);
      else if (files) setFiles(null);
      else if (treeOpen) setTreeOpen(false);
      else if (setupOpen) setSetupOpen(false);
      else if (ruleEditOpen) setRuleEditOpen(false);
      else if (boardEditOpen) setBoardEditOpen(false);
      else if (statisticsOpen) setStatisticsOpen(false);
      else if (helpOpen) setHelpOpen(false);
      else if (experienceOpen) setExperienceOpen(false);
      else if (selectedSkill) chooseSkill(null);
      else if (libraryOpen) setLibraryOpen(false);
      else if (loaded) { game.returnHome(); setLibraryOpen(false); }
    }
    window.addEventListener('sandbox-native-back', nativeBack);
    return () => window.removeEventListener('sandbox-native-back', nativeBack);
  }, [busy, fileBusy, exporting, game.hasPending, game.initializing, game.returnHome, modalOpen, selectedSkill, libraryOpen, loaded,
    deleteTarget, files, treeOpen, setupOpen, ruleEditOpen, boardEditOpen, statisticsOpen, helpOpen, experienceOpen]);

  async function exportBackup() {
    if (exporting) return;
    setExporting(true); setExportError(null);
    try {
      const [{ createArchive }, { downloadFile }] = await Promise.all([import('../files/archive'), import('../files/download')]);
      let backup;
      try { backup = await createArchive(await repository.readSnapshot(), { kind: 'library' }); }
      catch (cause) {
        const data = await repository.exportBackup();
        await downloadFile({ bytes: new TextEncoder().encode(JSON.stringify(data, null, 2)), filename: `2048-recovery-raw-${new Date().toISOString().slice(0, 10)}.json` });
        setExportError(`完整备份校验未通过，已导出原始恢复 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (backup) await downloadFile(backup);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); } finally { setExporting(false); }
  }

  const turn = game.feedback?.turn && game.feedback.turn.toNodeId === node?.id && game.feedback.turn.projectId === loaded?.project.id ? game.feedback.turn : null;
  const delta = turn ? scoreChange(turn) : '0';
  return <div className={`app-shell ${preferences.decorations ? 'ambient-on' : ''} ${experience.motion ? '' : 'motion-off'}`} data-testid="app-shell">
    {preferences.decorations && <div className="ambient-background" aria-hidden="true" />}
    <header className="site-header">
      <a className="brand" href={import.meta.env.BASE_URL} aria-label="2048 Sandbox 首页" aria-disabled={busy || game.initializing || game.hasPending}
        onClick={event => { event.preventDefault(); if (!busy && !game.initializing && !game.hasPending) returnHome(); }}><img src={brandIcon} alt="" /><span>2048 <strong>Sandbox</strong></span></a>
      <span className="header-mode">{viewedLoaded?.rule.definition.mode === 'custom' ? '自定义模式' : '经典模式'} <span>v{APP_VERSION}</span></span>
      <nav aria-label="对局管理">{loaded && <button className="text-button home-entry" disabled={busy || game.hasPending} onClick={returnHome}>返回首页</button>}
        <button className="text-button" onClick={() => setLibraryOpen(value => !value)} aria-expanded={libraryOpen}>我的对局 <span className="nav-count">{game.library.length}</span></button>
        <button className="text-button" disabled={busy || game.initializing || game.hasPending} onClick={() => setSetupOpen(true)}>自定义新局</button>
        <button className="text-button" disabled={busy || game.initializing} onClick={() => setFiles({ tab: 'import', kind: 'library', nodeId: selectedId })}>文件与恢复</button>
        <button className="text-button" disabled={exporting} onClick={() => { void exportBackup(); }}>{exporting ? '导出中…' : '导出备份'}</button>
        <button className="text-button experience-entry" onClick={() => setExperienceOpen(true)}>动效与声音</button>
        <button className="text-button" onClick={() => setHelpOpen(true)}>帮助</button></nav>
    </header>

    {libraryOpen && <section className="library" aria-label="我的对局">
      <div className="panel-title"><h2>我的对局</h2><button className="text-button" onClick={() => setLibraryOpen(false)}>收起</button></div>
      <p className="muted">新开一局或返回首页都会保留记录。可逐局删除不再需要的对局。</p>
      <div className="library-list">{game.library.length ? game.library.map(record => <div className="library-record" key={record.id} data-project-id={record.id}>
        <button className="library-open" disabled={busy || game.hasPending}
          onClick={() => { void game.openProject(record.id); setLibraryOpen(false); }}>
          <strong>{record.project.name}</strong><span>{record.project.id === loaded?.project.id ? '正在查看' : '打开对局'} →</span>
        </button>
        <button className="text-button library-delete" disabled={busy || game.hasPending} aria-label={`删除对局：${record.project.name}`}
          onClick={() => setDeleteTarget(record)}>删除</button>
      </div>) : <p>还没有已保存的对局。</p>}</div>
    </section>}

    <main>
      <div className="page-heading"><div><div className="eyebrow">PLAY · EXPLORE · RETURN</div><h1>向 2048，再走一步。</h1><p>每次尝试都有来处，每一步都可以回看。</p></div>
        <div className={`save-status ${error ? 'failed' : ''}`} role="status" data-testid="save-status"><span className="status-dot" />{game.initializing ? '读取中…' : busy ? '保存中…' : error ? '保存未确认' : loaded ? '已自动保存' : '本地保存已准备'}</div></div>

      {(error || exportError) && <section className="error-panel" role="alert">
        <strong>{error ?? exportError}</strong>
        {error && <p>{game.hasPending ? '本次操作的输入已保留。重试会确认同一笔保存，不会再次抽取随机结果。' : '请重新读取保存的数据后继续。'}棋盘显示最后确认的状态。</p>}
        <div className="button-row">{game.hasPending && <button className="primary" disabled={busy} onClick={() => { void game.retry(); }}>重试本次保存</button>}
          {error && <button disabled={busy} onClick={() => { void game.reloadSaved(); }}>重新读取已保存</button>}
          <button disabled={exporting} onClick={() => { void exportBackup(); }}>导出已保存的备份</button>
          {exportError && <button onClick={() => setExportError(null)}>关闭提示</button>}</div>
      </section>}

      {game.initializing ? <div className="loading" role="status">正在读取本地对局…</div> : loaded && state && node ?
        <div className="game-layout">
          <aside className="game-details">
            <div className="mode-pill"><span className="status-dot" /> {viewedLoaded!.rule.definition.mode === 'normal' ? 'CLASSIC' : 'SANDBOX'} / {state.world.board.rows} × {state.world.board.cols}</div>
            <h2>{loaded.project.name}</h2><p className="muted">{viewedLoaded!.rule.definition.merge.kind === 'equal-sum' ? '相同数字相遇，合为新的可能。' : '按当前规则合并，探索新的可能。'}</p>
            <dl className="metrics"><div className="score-card"><dt>节点成绩</dt><dd data-testid="score" title={state.world.score}>{state.world.score}</dd><span>POINTS</span>
              {experience.motion && preferences.decorations && delta !== '0' && <i key={game.feedback!.sequence} className={`score-float ${delta.startsWith('-') ? 'negative' : ''}`} title={delta} aria-hidden="true" data-testid="score-change">{delta.length > 12 ? `${delta.slice(0,8)}…` : delta}</i>}</div>
              <div><dt>有效操作</dt><dd data-testid="action-count">{state.ledger.effectiveActionCount}</dd></div>
              <div><dt>合并次数</dt><dd>{state.world.mergeCount}</dd></div></dl>
            <div className="node-meta"><span>{inspecting ? '历史预览' : armedId ? '从历史继续' : '当前保存节点'}</span><code data-testid="selected-node">{node.id.slice(-8)}</code>
              <small>规则 v{state.ruleRef.version} · 第 {state.world.roundCount} 回合</small></div>
            <div className="detail-actions"><button disabled={busy || game.hasPending} onClick={() => { void game.newMatch(viewedLoaded!.rule); }}>＋ 新开一局</button>
              <button disabled={busy || !!error || loaded.checkpoints.some(item => item.nodeId === node.id)} onClick={() => { void game.checkpoint(); }}>{loaded.checkpoints.some(item => item.nodeId === node.id) ? '★ 检查点已保存' : '☆ 保存检查点'}</button></div>
            <button className="text-button export-match" disabled={busy} onClick={() => setFiles({ tab: 'export', kind: 'project', nodeId: node.id })}>导出这局 →</button>
            <div className="edit-actions"><button disabled={busy || game.hasPending} onClick={() => setBoardEditOpen(true)}>编辑本节点棋盘</button><button disabled={busy || game.hasPending} onClick={() => setRuleEditOpen(true)}>修改本节点规则</button></div>
            <button className="statistics-entry" disabled={busy} onClick={() => setStatisticsOpen(true)}>规则与路径统计 ↗</button>
          </aside>

          <section className="play-area" aria-label={viewedLoaded!.rule.definition.mode === 'normal' ? '经典对局' : '自定义对局'}>
            {previewId && <div className="preview-banner"><div><strong>{armedId ? '下一步，从这里出发' : `正在回看 · 第 ${node.depth} 步`}</strong>
              <small>{armedId ? '成功操作后，自动保存新的分支。' : '浏览历史不改变当前保存位置。'}</small></div>
              <button className="text-button" disabled={busy} onClick={game.returnToActive}>回到当前</button>
              {!armedId && <button className="primary" disabled={busy || !!error || !state.world.outcome.canContinue} onClick={game.continueHere}>从此继续</button>}</div>}
            {armedId && <label className="branch-policy">继续时的随机结果<select value={game.branchPolicy} disabled={busy} onChange={event => game.setBranchPolicy(event.target.value as 'reroll' | 'reproduce')}>
              <option value="reroll">重新抽取（默认）</option><option value="reproduce">复现随机结果</option></select></label>}
            <Board state={state} nodeId={node.id} disabled={blocked} onMove={direction => { void game.move(direction); }} onSelect={selectingCell && !actionBlocked ? selectCell : undefined} selectedIndices={targets}
              motion={experience.motion} decorations={preferences.decorations} turn={turn} />
            <div className="board-caption"><span>{state.world.board.rows} × {state.world.board.cols}</span><span>{viewedLoaded!.rule.definition.goals.tileValue !== null ? <>数字目标 <strong>{viewedLoaded!.rule.definition.goals.tileValue}</strong></> : viewedLoaded!.rule.definition.goals.scoreTarget !== null ? <>成绩目标 <strong>{viewedLoaded!.rule.definition.goals.scoreTarget}</strong></> : '无尽玩法'}</span></div>
            <div className="experience-quick" aria-label="对局体验开关"><button aria-label="切换滑动动画" aria-pressed={preferences.motion} onClick={() => experience.update({ motion:!preferences.motion })}><span aria-hidden="true">↝</span> 动画 {preferences.motion ? '开' : '关'}</button>
              <button aria-label="切换游戏音效" aria-pressed={preferences.sound} onClick={() => experience.update({ sound:!preferences.sound })}><span aria-hidden="true">{preferences.sound ? '♫' : '♪'}</span> 音效 {preferences.sound ? '开' : '关'}</button><button className="text-button" onClick={() => setExperienceOpen(true)}>更多设置</button></div>
            {state.world.outcome.status !== 'playing' && <div className={`outcome ${state.world.outcome.status}`} role="status">
              <strong>{state.world.outcome.status === 'won' ? '目标，达成！' : state.world.outcome.reason === 'round-limit' ? '已到回合上限。' : '当前没有可移动的方向。'}</strong>
              <p>{state.world.outcome.status === 'won' ? state.world.outcome.canContinue ? '你可以继续向更大的数字前进。' : '本局已按规则结束，记录完整保留。' : state.world.outcome.canContinue ? '仍有可用的挽救技能，成功施放后会保存新节点。' : '记录已保存，可以回看历史或新开一局。'}</p></div>}
            <div className="input-help"><p id="board-help">{state.world.board.rows > 8 || state.world.board.cols > 8 ? '方向键 / WASD，或使用方向按钮' : '方向键 / WASD，或在棋盘上滑动'}</p><div className="direction-pad" aria-label="方向操作">
              {([['left', '←', '向左移动'], ['up', '↑', '向上移动'], ['down', '↓', '向下移动'], ['right', '→', '向右移动']] as const).map(([direction, arrow, label]) =>
                <button key={direction} aria-label={label} disabled={blocked || !viewedLoaded!.rule.definition.movement.directions.includes(direction)} onClick={() => { void game.move(direction); }}>{arrow}</button>)}
            </div></div>
            <p className="action-message" aria-live="polite">{game.message}</p>
            <SkillPanel key={node.id} loaded={viewedLoaded!} state={state} disabled={actionBlocked} selected={selectedSkill} targets={targets} onSelect={chooseSkill} onUse={game.skill} />
          </section>

          <History key={loaded.project.id} loaded={loaded} selectedId={node.id} busy={busy} onPreview={game.preview} onOpenTree={() => setTreeOpen(true)} />
        </div> :
        <section className="welcome"><div className="welcome-mark" aria-hidden="true"><span>2</span><span>4</span><span>8</span><span>?</span></div>
          <div className="eyebrow">A SMALL BOARD. MANY POSSIBILITIES.</div><h2>{game.library.length ? <>新的可能，<br />从这里开始。</> : <>你的第一条路径，<br />从这里开始。</>}</h2><p>经典规则，纯粹合并。棋盘、成绩和每次操作<br className="desktop-break" />都会留在这台设备上，下次打开接着玩。</p>
          {game.library.length > 0 && <button className="resume-library" onClick={() => setLibraryOpen(true)}>继续已保存的对局 <span className="nav-count">{game.library.length}</span> →</button>}
          <button className="primary start-button" disabled={busy || game.hasPending} onClick={() => { void game.newMatch(); }}>开始经典对局 <span>↗</span></button>
          <button className="custom-start" disabled={busy || game.hasPending} onClick={() => setSetupOpen(true)}>创建自己的规则 →</button></section>}
    </main>
    <footer><span>2048 Sandbox <span className="footer-separator">/</span> 让每次尝试留下记录</span><OfflineStatus blocked={busy || game.hasPending || !!error || fileBusy || exporting || deleteTarget !== null || treeOpen || files !== null || setupOpen || ruleEditOpen || boardEditOpen || statisticsOpen || helpOpen || experienceOpen} />
      <small>数据保存在{import.meta.env.MODE === 'android' ? '本应用中' : '当前浏览器'}。完整备份包含全部分支与检查点，导入时创建独立副本。</small></footer>
    <Suspense fallback={<p className="feature-loading" role="status">正在打开…</p>}>
      {deleteTarget && <DeleteMatch key={deleteTarget.id} record={deleteTarget} busy={busy} onDelete={game.deleteProject} onClose={() => setDeleteTarget(null)} />}
      {experienceOpen && <ExperienceSettings preferences={preferences} onChange={experience.update} reducedMotion={experience.reducedMotion} persisted={experience.persisted} unavailable={sound.unavailable} onPreview={sound.preview} onClose={() => setExperienceOpen(false)} />}
      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}
      {setupOpen && <CustomSetup currentRule={viewedLoaded?.rule} onClose={() => setSetupOpen(false)} onStart={game.newCustomMatch} />}
      {ruleEditOpen && viewedLoaded && state && node && <CustomSetup key={`rules-${node.id}`} currentRule={viewedLoaded.rule} onClose={() => setRuleEditOpen(false)} onStart={game.newCustomMatch}
        editing={{ state, rule: viewedLoaded.rule, onPublish: (definition, name, policy) => game.publishRules(node.id, definition, name, policy) }} />}
      {boardEditOpen && viewedLoaded && state && node && <BoardEditor key={`board-${node.id}`} state={state} rule={viewedLoaded.rule} onClose={() => setBoardEditOpen(false)} onCommit={patches => game.editBoard(node.id, patches)} />}
      {statisticsOpen && loaded && node && <Statistics loaded={loaded} selectedId={node.id} busy={busy} onPreview={game.preview} onClose={() => setStatisticsOpen(false)} />}
      {treeOpen && loaded && node && <HistoryTree loaded={loaded} selectedId={node.id} busy={busy} canContinue={!error && !game.hasPending}
        onPreview={game.preview} onContinue={game.continueFrom} onClose={() => setTreeOpen(false)} onArchive={game.archiveBranch} onStatistics={() => { setTreeOpen(false); setStatisticsOpen(true); }}
        onExport={(kind, nodeId) => { setTreeOpen(false); setFiles({ tab: 'export', kind, nodeId }); }} />}
      {files && <FileCenter loaded={loaded} library={game.library} initialTab={files.tab} initialKind={files.kind} selectedNodeId={files.nodeId}
        canImport={!busy && !game.hasPending} onClose={() => setFiles(null)} onImported={game.imported} onBusy={setFileBusy} />}
    </Suspense>
  </div>;
}
