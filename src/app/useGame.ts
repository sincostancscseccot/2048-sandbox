import { useEffect, useRef, useState } from 'react';
import type { BoardEditAction, BranchPolicy, CommitCandidate, Direction, LoadedProject, ProjectRecord, RuleDefinition, RuleSetVersion, SkillPayload } from '../domain/types';
import { prepareBoardEdit, prepareMove, prepareNewMatch, prepareRuleEdit, prepareSkill, ruleForState } from '../history/candidates';
import { createRuleRevision } from '../presets/rules';
import { describeError, repository } from '../persistence/repository';
import { soundForTurn, type CommittedTurn, type GameFeedback } from '../presentation/feedback';

export function useGame() {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [library, setLibrary] = useState<ProjectRecord[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('每一步，自动保存。');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [branchPolicy, setBranchPolicy] = useState<BranchPolicy>('reroll');
  const pending = useRef<CommitCandidate | null>(null);
  const flight = useRef(false);
  const [feedback, setFeedback] = useState<GameFeedback | null>(null);
  const feedbackSequence = useRef(0), lastPresented = useRef('');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const projects = await repository.listProjects();
        const lastId = await repository.lastProjectId();
        const id = lastId ?? projects[0]?.id;
        const restored = id ? await repository.load(id) : null;
        if (live) {
          setLibrary(projects); setLoaded(restored);
          if (restored) { setBranchPolicy(restored.project.preferences.randomBranchPolicy); setMessage('已恢复最后保存的节点。'); }
        }
      } catch (cause) {
        if (live) { setError(describeError(cause)); void repository.listProjects().then(projects => { if (live) setLibrary(projects); }).catch(() => {}); }
      } finally { if (live) setInitializing(false); }
    })();
    return () => { live = false; };
  }, []);

  function begin(): boolean {
    if (flight.current || initializing) return false;
    flight.current = true; setBusy(true); return true;
  }
  function end() { flight.current = false; setBusy(false); }
  function accept(restored: LoadedProject) {
    setFeedback(null);
    setLoaded(restored); setPreviewId(null); setArmedId(null);
    setBranchPolicy(restored.project.preferences.randomBranchPolicy);
  }
  async function save(candidate: CommitCandidate) {
    pending.current = candidate;
    await repository.commit(candidate);
    const restored = await repository.load(candidate.project.id);
    const projects = await repository.listProjects();
    accept(restored); setLibrary(projects); pending.current = null; setError(null);
    const key = `${candidate.project.id}/${candidate.node.id}`;
    if (lastPresented.current !== key && restored.project.activeNodeId === candidate.node.id) {
      const parent = loaded?.project.id === candidate.project.id ? loaded.nodes.find(item => item.id === candidate.node.parentId) : undefined;
      const before = parent ? loaded!.states.get(parent.stateHash)! : null;
      const turn: CommittedTurn = { projectId: candidate.project.id, fromNodeId: candidate.node.parentId, toNodeId: candidate.node.id,
        before, after: candidate.state, action: candidate.node.action, rule: before ? ruleForState(loaded!, before) : candidate.rule };
      lastPresented.current = key; setFeedback({ sequence: ++feedbackSequence.current, kind: soundForTurn(turn), turn });
    }
    setMessage(candidate.node.parentId === null ? '新对局已保存，开始吧。' : `第 ${candidate.node.depth} 步已保存。`);
  }
  async function newMatch(selectedRule?: RuleSetVersion) {
    if (pending.current || !begin()) return;
    try {
      setError(null); const rule = selectedRule ?? loaded?.rule;
      const name = rule?.definition.mode === 'custom' ? `${rule.name} ${library.length + 1}` : `经典对局 ${library.length + 1}`;
      await save(await prepareNewMatch(name, undefined, rule));
    }
    catch (cause) { setError(describeError(cause)); }
    finally { end(); }
  }
  async function newCustomMatch(rule: RuleSetVersion, name: string): Promise<boolean> {
    if (pending.current || !begin()) return false;
    try { setError(null); await save(await prepareNewMatch(name, undefined, rule)); return true; }
    catch (cause) { setError(describeError(cause)); return false; } finally { end(); }
  }
  async function editBoard(parentId: string, patches: BoardEditAction['payload']['patches']): Promise<boolean> {
    if (!loaded || pending.current || !begin()) return false;
    try {
      const node = loaded.nodes.find(node => node.id === parentId); if (!node) throw new Error('编辑父节点不存在');
      const rule = ruleForState(loaded, loaded.states.get(node.stateHash)!);
      const revision = rule.requiredCapabilities.includes('editing-v1') ? undefined : await createRuleRevision(rule, rule.definition, (await repository.readSnapshot()).rules, `${rule.name} · 编辑`);
      const candidate = await prepareBoardEdit(loaded, parentId, patches, revision);
      if ('reason' in candidate) { setMessage(candidate.reason); return false; }
      await save(candidate); return true;
    } catch (cause) { setError(describeError(cause)); return false; } finally { end(); }
  }
  async function publishRules(parentId: string, definition: RuleDefinition, name: string, policy: 'cancel' | 'drop' | 'pack'): Promise<boolean> {
    if (!loaded || pending.current || !begin()) return false;
    try {
      const node = loaded.nodes.find(node => node.id === parentId); if (!node) throw new Error('规则修改父节点不存在');
      const previous = ruleForState(loaded, loaded.states.get(node.stateHash)!);
      const revision = await createRuleRevision(previous, definition, (await repository.readSnapshot()).rules, name);
      const candidate = await prepareRuleEdit(loaded, parentId, revision, policy);
      if ('reason' in candidate) { setMessage(candidate.reason); return false; }
      await save(candidate); return true;
    } catch (cause) { setError(describeError(cause)); return false; } finally { end(); }
  }
  async function skill(payload: SkillPayload): Promise<boolean> {
    if (!loaded || error || pending.current || (previewId !== null && armedId === null) || !begin()) return false;
    try {
      const candidate = await prepareSkill(loaded, armedId ?? loaded.project.activeNodeId, payload, branchPolicy);
      if ('reason' in candidate) { setMessage(candidate.reason); return false; }
      await save(candidate); return true;
    } catch (cause) { setError(describeError(cause)); return false; } finally { end(); }
  }
  async function move(direction: Direction) {
    if (!loaded || error || pending.current || (previewId !== null && armedId === null) || !begin()) return;
    try {
      const candidate = await prepareMove(loaded, armedId ?? loaded.project.activeNodeId, direction, branchPolicy);
      if ('reason' in candidate) { setMessage(candidate.reason); setFeedback({ sequence: ++feedbackSequence.current, kind: 'blocked', turn: null }); }
      else await save(candidate);
    } catch (cause) { setError(describeError(cause)); }
    finally { end(); }
  }
  async function retry() {
    const candidate = pending.current;
    if (!candidate || !begin()) return;
    try { await save(candidate); } catch (cause) { setError(describeError(cause)); } finally { end(); }
  }
  async function openProject(id: string) {
    if (pending.current || !begin()) return;
    try { accept(await repository.load(id)); setError(null); setMessage('已读取保存的对局。'); }
    catch (cause) { setError(describeError(cause)); } finally { end(); }
  }
  function showHome() {
    setLoaded(null); setPreviewId(null); setArmedId(null); setFeedback(null); setError(null);
    setMessage('已返回首页，保存的对局可在“我的对局”中继续。');
  }
  function returnHome() {
    if (flight.current || initializing || pending.current) return;
    showHome();
  }
  async function deleteProject(record: ProjectRecord): Promise<void> {
    if (pending.current || !begin()) throw new Error('请先处理尚未确认的保存，再删除对局');
    try {
      const projects = await repository.deleteProject(record.id, record.project.revision);
      setLibrary(projects);
      if (loaded?.project.id === record.id) showHome();
      setMessage(`已删除“${record.project.name}”。`);
    } catch (cause) {
      try { setLibrary(await repository.listProjects()); } catch { /* Keep the last confirmed library if reading also fails. */ }
      throw cause;
    } finally { end(); }
  }
  async function reloadSaved() {
    if (!begin()) return;
    try {
      const projects = await repository.listProjects();
      const maybePending = pending.current?.project.id;
      const id = maybePending && projects.some(item => item.id === maybePending) ? maybePending : loaded?.project.id ?? await repository.lastProjectId();
      if (id && projects.some(item => item.id === id)) accept(await repository.load(id));
      else showHome();
      setLibrary(projects); pending.current = null; setError(null); setMessage('已重新读取已保存的进度。');
    } catch (cause) { setError(describeError(cause)); } finally { end(); }
  }
  async function checkpoint() {
    if (!loaded || pending.current || error || !begin()) return;
    const selected = previewId ?? loaded.project.activeNodeId;
    try {
      await repository.checkpoint(loaded, selected);
      setLoaded(await repository.load(loaded.project.id));
      setLibrary(await repository.listProjects()); setMessage('检查点已保存，不计入有效操作。');
    } catch (cause) { setError(describeError(cause)); } finally { end(); }
  }
  function preview(id: string) {
    if (busy) return;
    setFeedback(null);
    setPreviewId(id); setArmedId(null); setMessage('正在查看历史，当前保存位置保持不变。');
  }
  function returnToActive() { setFeedback(null); setPreviewId(null); setArmedId(null); setMessage('已回到当前保存位置。'); }
  function continueHere() {
    if (!previewId || error || pending.current || busy) return;
    continueFrom(previewId);
  }
  function continueFrom(id: string) {
    if (!loaded?.nodes.some(node => node.id === id) || error || pending.current || busy) return;
    setFeedback(null); setPreviewId(id); setArmedId(id); setMessage('已选定继续位置，下一次成功操作将保存新节点。');
  }
  async function archiveBranch(id: string, archived: boolean) {
    if (!loaded || pending.current || !begin()) return;
    try {
      await repository.archiveBranch(loaded, id, archived);
      setLoaded(await repository.load(loaded.project.id)); setLibrary(await repository.listProjects());
      setMessage(archived ? '分支已归档，记录仍完整保留。' : '归档分支已恢复。');
    } catch (cause) { setError(describeError(cause)); throw cause; } finally { end(); }
  }
  async function imported(id: string) {
    if (pending.current || !begin()) throw new Error('请先处理尚未确认的游戏保存');
    try {
      const restored = await repository.load(id), projects = await repository.listProjects();
      accept(restored); setLibrary(projects); setError(null); setMessage('已打开导入副本，原对局完整保留。');
    } finally { end(); }
  }
  return { loaded, library, initializing, busy, error, message, previewId, armedId, branchPolicy, setBranchPolicy, feedback,
    hasPending: pending.current !== null, newMatch, newCustomMatch, move, skill, retry, reloadSaved, openProject, checkpoint, preview, returnToActive, continueHere,
    continueFrom, archiveBranch, imported, editBoard, publishRules, returnHome, deleteProject };
}
