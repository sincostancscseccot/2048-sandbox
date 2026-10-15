import 'fake-indexeddb/auto';
import { afterAll, expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import type { LibrarySnapshot } from '../../src/domain/types';
import { scaleFixture } from '../fixtures/scale';
import { verifyLibrary } from '../../src/history/verify';
import { createArchive, parseImport, prepareImportCopy } from '../../src/files/archive';
import { Repository } from '../../src/persistence/repository';
import { SandboxDatabase } from '../../src/persistence/database';
import { prepareMove } from '../../src/history/candidates';
import { layoutTree, visibleTree } from '../../src/history/tree';

const results: unknown[] = [];
async function measure<T>(action: () => Promise<T>) { const start = performance.now(); const value = await action(); return { value, ms: Math.round((performance.now() - start) * 100) / 100 }; }
for (const [shape, count] of [['chain',100],['chain',1000],['fan',1000],['balanced',1000],['library',50]] as const) {
  test(`${shape} ${count}: verify, indexed storage, complete archive and independent copies`, async () => {
    const created = await measure(async () => {
      if (shape !== 'library') return scaleFixture(count,shape);
      const source:LibrarySnapshot={projects:[],nodes:[],states:[],rules:[],checkpoints:[],settings:[]};
      for(let i=0;i<count;i++){const part=await scaleFixture(20,'chain');source.projects.push(...part.projects);source.nodes.push(...part.nodes);source.states.push(...part.states);source.rules.push(...part.rules);}
      source.settings=[{key:'lastProjectId',value:source.projects[0]!.id}];return source;
    });
    const source=created.value, checked=await measure(()=>verifyLibrary(source));
    const db=new SandboxDatabase(`scale-${crypto.randomUUID()}`),repo=new Repository(db);
    try {
      await db.projects.bulkAdd(source.projects);await db.historyNodes.bulkAdd(source.nodes);await db.states.bulkAdd(source.states);await db.rules.bulkAdd(source.rules);await db.settings.bulkAdd(source.settings);
      const opened=await measure(()=>repo.load(source.projects[0]!.id)),loaded=opened.value;
      const active=loaded.nodes.find(node=>node.id===loaded.project.activeNodeId)!,direction=active.depth%2?'left':'right';
      const next=await prepareMove(loaded,active.id,direction,'reroll');if('reason'in next)throw new Error(next.reason);
      const committed=await measure(()=>repo.commit(next)),confirmed=await measure(()=>repo.load(loaded.project.id));
      expect(confirmed.value.states.get(next.node.stateHash)).toEqual(next.state);
      const exported=await measure(()=>createArchive(source,{kind:'library'})),parsed=await measure(()=>parseImport(exported.value.bytes));
      expect(parsed.value.snapshot.nodes).toHaveLength(source.nodes.length);expect(parsed.value.snapshot.states).toHaveLength(source.states.length);
      const planned=await measure(()=>prepareImportCopy(parsed.value)),imported=await measure(()=>repo.importCopy(planned.value));
      const copy=await repo.load(imported.value[0]!);expect(copy.project.activeNodeId).toBe(loaded.project.activeNodeId);
      const start=performance.now(),layout=layoutTree(loaded.nodes,new Set(),new Set()),point=layout.byId.get(loaded.project.activeNodeId)!;
      const visible=visibleTree(layout,{x:point.x-380,y:point.y-205,width:760,height:410});
      results.push({shape,count,projects:source.projects.length,nodes:source.nodes.length,states:source.states.length,rules:source.rules.length,
        createMs:created.ms,verifyMs:checked.ms,loadMs:opened.ms,commitMs:committed.ms,confirmMs:confirmed.ms,
        exportMs:exported.ms,parseMs:parsed.ms,prepareImportMs:planned.ms,importCommitMs:imported.ms,
        zipBytes:exported.value.bytes.length,treeMs:Math.round((performance.now()-start)*100)/100,visibleNodes:visible.points.length,roundtrip:'passed'});
    } finally {db.close();await db.delete();}
  });
}
afterAll(async()=>{await mkdir('.work',{recursive:true});const file=`.work/m6-performance-${process.env.BENCH_LABEL??'final'}.json`;await writeFile(file,JSON.stringify({environment:{node:process.version,platform:process.platform,cpu:cpus()[0]?.model,memoryBytes:totalmem(),storage:'fake-indexeddb; browser measurements recorded separately'},results},null,2));console.log(`Performance report: ${file}`);});
