import Dexie, { type Table } from 'dexie';
import type { Checkpoint, HistoryNode, ImportRecord, ProjectRecord, RuleSetVersion, StateRecord } from '../domain/types';

export const databaseName = '2048-sandbox-v1';
export class SandboxDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>;
  historyNodes!: Table<HistoryNode, [string, string]>;
  states!: Table<StateRecord, string>;
  rules!: Table<RuleSetVersion, [string, number]>;
  checkpoints!: Table<Checkpoint, string>;
  settings!: Table<{ key: string; value: string }, string>;
  imports!: Table<ImportRecord, string>;

  constructor(name = databaseName) {
    super(name);
    this.version(1).stores({
      projects: 'id,updatedAt', nodes: 'id,matchId,parentId,&operationId',
      states: 'hash', rules: '[id+version]', checkpoints: 'id,projectId,[projectId+nodeId]', settings: 'key',
    });
    // Two atomic upgrade steps avoid changing an existing IndexedDB primary key in place.
    this.version(2).stores({ historyNodes: '[matchId+id],matchId,[matchId+parentId],&[matchId+operationId]' })
      .upgrade(async transaction => {
        const oldNodes = await transaction.table<HistoryNode>('nodes').toArray();
        await transaction.table<HistoryNode>('historyNodes').bulkAdd(oldNodes);
      });
    this.version(3).stores({ nodes: null, imports: 'id' });
  }
}

export const database = new SandboxDatabase();
