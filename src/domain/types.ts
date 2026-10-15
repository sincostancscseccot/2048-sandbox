export type Direction = 'up' | 'right' | 'down' | 'left';
export type BranchPolicy = 'reroll' | 'reproduce';
export const skillIds = ['undo', 'delete', 'swap', 'upgrade', 'downgrade', 'shuffle', 'spawn', 'clear-line', 'rotate'] as const;
export type SkillId = typeof skillIds[number];
export interface Weight { value: string; weight: number }
export type EventTrigger = 'after-move' | 'after-merge' | 'after-skill' | 'before-spawn' | 'after-spawn' | 'after-round' | 'after-edit';
export type Condition = { kind: 'compare'; source: 'score' | 'round' | 'effective-actions' | 'merge-count' | 'empty-count' | 'variable' | 'event-count'; reference: string | null; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: string } |
  { kind: 'all'; children: Condition[] } | { kind: 'any'; children: Condition[] } | { kind: 'not'; child: Condition };
export interface MergeMapping { id: string; left: string; right: string; result: string; directional: boolean; priority: number }
export interface SpawnPhase { id: string; priority: number; condition: Condition; weights: Weight[]; count: number | null }
export type EventAction = { type: 'set-cell'; index: number; value: string | null } | { type: 'add-score'; value: string } |
  { type: 'set-variable' | 'add-variable'; name: string; value: string } | { type: 'add-charge'; skillId: SkillId; amount: number } | { type: 'emit'; trigger: EventTrigger };
export interface EventRule { id: string; name: string; trigger: EventTrigger; condition: Condition | null; actions: EventAction[]; priority: number; maxExecutions: number | null; cooldownTurns: number; allowReentry: boolean }
export interface SkillConfig {
  enabled: boolean; unlimited: boolean; initialCharges: number; maxCharges: number; cooldownTurns: number;
  rechargeEveryTurns: number | null; rechargeAmount: number; scoreCost: string; advanceRound: boolean;
  spawnAfterUse: boolean; allowAfterLoss: boolean; params: Record<string, never>;
}
export interface RuleDefinition {
  mode: 'normal' | 'custom';
  board: { rows: number; cols: number; initialLayout: { index: number; value: string }[]; cells: never[]; regions: never[]; resizeAnchor: 'top-left'; overflowPolicy: 'cancel' | 'drop' | 'pack' };
  numbers: { maxDigits: number; allowedValues: string[] | null; sequence: 'powers-of-two' | 'custom'; customSequence: string[]; specialTypes: never[] };
  spawn: { initialCount: number; initialWeights: Weight[]; perActionCount: number; weights: Weight[]; triggerOn: ('move' | 'round')[]; emptyStrategy: 'fill-available' | 'skip-batch'; positionStrategy: 'uniform' | 'weighted'; positionWeights: { index: number; weight: number }[]; phaseRules: SpawnPhase[] };
  movement: { directions: Direction[]; distance: 'slide'; invalidMovePolicy: 'ignore' | 'advance-round'; wrap: 'none' };
  merge: { kind: 'equal-sum' | 'mapping' | 'sequence-next'; maxMergesPerTile: number; chain: boolean; mappings: MergeMapping[]; ruleOrder: string[] };
  score: { method: 'merged-value'; multiplier: number };
  skills: Record<SkillId, SkillConfig>;
  goals: { tileValue: string | null; scoreTarget: string | null; winPolicy: 'any' | 'all'; continueAfterWin: boolean; roundLimit: number | null; lossWhenNoMoves: boolean; allowRescueSkills: boolean };
  timer: { mode: 'none' | 'elapsed' | 'countdown'; limitMs: number | null; pauseWhenHidden: boolean };
  events: EventRule[]; variables: Record<string, string>;
}
export interface RuleSetVersion { schemaVersion: 1; id: string; version: number; name: string; requiredCapabilities: string[]; definition: RuleDefinition; definitionHash: string }
export interface RuleRef { id: string; version: number }
export interface Tile { id: string; value: string; attributes: Record<string, never> }
export interface Cell { tile: Tile | null }
export interface RngState {
  algorithm: 'pcg32-xsh-rr-v1'; state: string; increment: string; drawCount: number;
}
export interface SkillState { charges: number | null; cooldownRemaining: number; usedCount: number; rechargeProgress: number }
export interface GameState {
  schemaVersion: 1;
  ruleRef: RuleRef;
  world: {
    board: { rows: number; cols: number; cells: Cell[] };
    score: string; roundCount: number; mergeCount: number;
    goals: { achieved: ('tile' | 'score')[]; firstWinLogicalMs: number | null };
    outcome: { status: 'playing' | 'won' | 'lost'; canContinue: boolean; reason: string | null };
    events: { queue: never[]; counters: Record<string, number>; variables: Record<string, string>; cooldowns?: Record<string, number> };
    clock: { mode: 'none' | 'elapsed' | 'countdown'; logicalElapsedMs: number; remainingMs: number | null; statusAtCommit: 'paused' | 'running' };
  };
  ledger: { effectiveActionCount: number; chargedTurnCount: number; skills: Record<SkillId, SkillState> };
  rng: RngState;
  undoStack: string[];
}
export interface MoveAction { type: 'move'; payload: { direction: Direction }; elapsedMs: number }
export type SkillPayload = { skillId: 'undo'; targetNodeId: string } |
  { skillId: 'delete' | 'upgrade' | 'downgrade'; index: number } |
  { skillId: 'swap'; firstIndex: number; secondIndex: number } |
  { skillId: 'shuffle'; indices: number[] } |
  { skillId: 'spawn'; index: number; value: string } |
  { skillId: 'clear-line'; axis: 'row' | 'column'; index: number } |
  { skillId: 'rotate'; degrees: 90 | 180 | 270 };
export interface SkillAction { type: 'skill'; payload: SkillPayload; elapsedMs: number }
export interface BoardEditAction { type: 'edit'; payload: { patches: { index: number; value: string | null }[]; nextRuleRef?: RuleRef }; elapsedMs: number }
export interface RuleEditAction { type: 'rule-edit'; payload: { nextRuleRef: RuleRef; overflowPolicy: 'cancel' | 'drop' | 'pack' }; elapsedMs: number }
export type GameAction = MoveAction | SkillAction | BoardEditAction | RuleEditAction;
export type StateLookup = (nodeId: string) => GameState | undefined;
export interface RandomContext { mode: 'advance' | BranchPolicy; before: RngState; after: RngState }
export interface HistoryNode {
  id: string; matchId: string; parentId: string | null; depth: number;
  action: GameAction | null; randomContext: RandomContext | null; stateHash: string;
  createdAt: string; operationId: string | null; undoTargetId: string | null; tags: string[];
}
export interface Project {
  id: string; name: string; rootNodeIds: string[]; activeNodeId: string; revision: number;
  preferences: {
    randomBranchPolicy: BranchPolicy; snapshotEveryActions: number; compression: 'deflate';
    deduplicateSnapshots: boolean; exportIncludeArchived: boolean; theme: 'system';
    motion: 'system'; tileDisplayDigits: number;
  };
}
export interface Checkpoint { id: string; projectId: string; nodeId: string; name: string; createdAt: string }
export interface StateRecord { hash: string; state: GameState }
export interface ImportOrigin { batchId: string; sourceProjectId: string; sourceHash: string; importedAt: string; sourceFormat: string }
export interface ProjectRecord { id: string; project: Project; updatedAt: string; archivedRootIds?: string[]; origin?: ImportOrigin }
export interface LoadedProject {
  project: Project; nodes: HistoryNode[]; states: Map<string, GameState>; rule: RuleSetVersion; checkpoints: Checkpoint[];
  rules: Map<string, RuleSetVersion>;
  archivedRootIds: string[];
}
export interface LibrarySnapshot {
  projects: ProjectRecord[]; nodes: HistoryNode[]; states: StateRecord[]; rules: RuleSetVersion[];
  checkpoints: Checkpoint[]; settings: { key: string; value: string }[];
}
export interface ImportRecord { id: string; sourceHash: string; projectIds: string[]; importedAt: string; sourceFormat: string }
export interface ImportPlan { record: ImportRecord; snapshot: LibrarySnapshot }
export interface CommitCandidate {
  expectedRevision: number; project: Project; node: HistoryNode; state: GameState; rule: RuleSetVersion;
}
