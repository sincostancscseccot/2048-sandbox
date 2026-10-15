import { expect, test } from 'vitest';
import type { Condition, EventRule, GameState, RuleDefinition, RuleSetVersion } from '../../src/domain/types';
import { canonicalJson } from '../../src/domain/hash';
import { conditionMatches } from '../../src/domain/advanced';
import { createCustomRule, createRuleRevision, sandboxDefinition, validateDefinition } from '../../src/presets/rules';
import { assertRootState, createInitialState, stepGame } from '../../src/engine/core';
import { migrateState } from '../../src/engine/migration';
import { seedPcg32 } from '../../src/random/pcg32';

const seed = seedPcg32(42n,54n);
async function rule(change: (definition: RuleDefinition) => void = () => {}) {
  const d = sandboxDefinition(); d.board.rows = 1; d.board.cols = 5; d.spawn.initialCount = 0; d.spawn.perActionCount = 0;
  d.board.initialLayout = [{index:0,value:'2'},{index:1,value:'2'},{index:2,value:'4'}]; d.goals.lossWhenNoMoves = false;
  d.skills.upgrade.enabled = true; d.skills.downgrade.enabled = true;
  change(d); return createCustomRule('高级规则测试',d);
}
function moved(state: GameState, rule: RuleSetVersion, direction: 'left'|'right' = 'left') {
  const result = stepGame(state,rule,{type:'move',payload:{direction},elapsedMs:0},`S${state.ledger.effectiveActionCount}`);
  if (!result.accepted) throw new Error(result.reason); return result.state;
}
const values = (state: GameState) => state.world.board.cells.map(cell=>cell.tile?.value??null);
const compare = (source: Extract<Condition,{kind:'compare'}>['source'],value:string,reference:string|null=null):Condition => ({kind:'compare',source,reference,operator:'gte',value});
const event = (change: Partial<EventRule> = {}): EventRule => ({id:'event-a',name:'测试事件',trigger:'after-round',condition:null,actions:[{type:'add-score',value:'1'}],priority:0,maxExecutions:null,cooldownTurns:0,allowReentry:false,...change});

test('root validation rejects a generated tile outside its weighted positions', async () => {
  const r = await rule(d => { d.spawn.initialCount = 4; d.spawn.positionStrategy = 'weighted'; d.spawn.positionWeights = [{ index: 4, weight: 1 }]; });
  const state = createInitialState(r, seed); assertRootState(state, r);
  state.world.board.cells[3] = state.world.board.cells[4]!; state.world.board.cells[4] = { tile: null };
  expect(() => assertRootState(state, r)).toThrow(/生成位置/);
});

test.each([
  [false,1,['4','4','8',null,null],'4',1], [true,1,['4','4','8',null,null],'4',1],
  [true,2,['8','8',null,null,null],'12',2], [true,3,['16',null,null,null,null],'28',3],
] as const)('chain=%s limit=%s controls new-tile merges without changing old input', async(chain,limit,expected,score,merges)=>{
  const r=await rule(d=>{ d.board.initialLayout=['2','2','4','8'].map((value,index)=>({index,value})); d.merge.chain=chain; d.merge.maxMergesPerTile=limit; });
  const initial=createInitialState(r,seed),before=canonicalJson(initial),next=moved(initial,r);
  expect(values(next)).toEqual(expected); expect(next.world.score).toBe(score); expect(next.world.mergeCount).toBe(merges); expect(canonicalJson(initial)).toBe(before);
});

test('mapping priority, explicit rule order, stable ID and directional matching are deterministic',async()=>{
  const r=await rule(d=>{ d.board.initialLayout=[{index:0,value:'2'},{index:1,value:'4'}]; d.merge.kind='mapping'; d.merge.mappings=[{id:'map-b',left:'2',right:'4',result:'8',priority:1,directional:false},{id:'map-a',left:'2',right:'4',result:'16',priority:1,directional:false}]; });
  expect(values(moved(createInitialState(r,seed),r))[0]).toBe('16');
  const ordered=await rule(d=>{ Object.assign(d,r.definition); d.merge=structuredClone(r.definition.merge); d.merge.ruleOrder=['map-b']; });
  expect(values(moved(createInitialState(ordered,seed),ordered))[0]).toBe('8');
  const directional=await rule(d=>{ d.board.initialLayout=[{index:0,value:'4'},{index:1,value:'2'}]; d.merge.kind='mapping'; d.merge.mappings=[{id:'only',left:'2',right:'4',result:'32',priority:0,directional:true}]; });
  expect(stepGame(createInitialState(directional,seed),directional,{type:'move',payload:{direction:'left'},elapsedMs:0},'S0').accepted).toBe(false);
  expect(values(moved(createInitialState(directional,seed),directional,'right')).at(-1)).toBe('32');
});

test('adjacent sequence has explicit base/terminal behavior and sequence skills use neighbors',async()=>{
  const r=await rule(d=>{ d.numbers.sequence='custom'; d.numbers.customSequence=['1','2','3','5','8']; d.merge.kind='sequence-next'; d.board.initialLayout=['1','1','2','3'].map((value,index)=>({index,value})); });
  const next=moved(createInitialState(r,seed),r); expect(values(next)).toEqual(['2','5',null,null,null]); expect(next.world.score).toBe('7');
  const upgrade=stepGame(next,r,{type:'skill',payload:{skillId:'upgrade',index:1},elapsedMs:0},'S1'); if(!upgrade.accepted) throw new Error(upgrade.reason);
  expect(values(upgrade.state)[1]).toBe('8');
  const down=stepGame(upgrade.state,r,{type:'skill',payload:{skillId:'downgrade',index:1},elapsedMs:0},'S2'); if(!down.accepted) throw new Error(down.reason); expect(values(down.state)[1]).toBe('5');
});

test('position weights and phase conditions generate only eligible values and positions without extra draws',async()=>{
  const r=await rule(d=>{ d.spawn.perActionCount=1; d.spawn.positionStrategy='weighted'; d.spawn.positionWeights=[{index:4,weight:1}]; d.spawn.phaseRules=[{id:'phase',priority:0,condition:compare('round','1'),weights:[{value:'7',weight:1}],count:1}]; });
  const initial=createInitialState(r,seed),next=moved(initial,r); expect(values(next)).toEqual(['4','4',null,null,'7']); expect(next.rng).toEqual(initial.rng);
});

test('unavailable weighted cells skip generation and a zero-count phase consumes no entropy',async()=>{
  const r=await rule(d=>{ d.spawn.perActionCount=1; d.spawn.positionStrategy='weighted'; d.spawn.positionWeights=[{index:0,weight:1}]; });
  const next=moved(createInitialState(r,seed),r); expect(values(next)).toEqual(['4','4',null,null,null]); expect(next.rng).toEqual(seed);
  const zero=await rule(d=>{ d.spawn.perActionCount=1; d.spawn.phaseRules=[{id:'zero',priority:1,condition:compare('round','1'),weights:[],count:0}]; });
  expect(moved(createInitialState(zero,seed),zero).rng).toEqual(seed);
});

test('phase priority chooses first match and before-spawn events feed its variable condition',async()=>{
  const r=await rule(d=>{ d.variables={switch:'0'}; d.spawn.perActionCount=1; d.spawn.positionStrategy='weighted'; d.spawn.positionWeights=[{index:4,weight:1}];
    d.events=[event({trigger:'before-spawn',actions:[{type:'set-variable',name:'switch',value:'1'}]})];
    d.spawn.phaseRules=[{id:'low',priority:0,condition:compare('round','1'),weights:[{value:'3',weight:1}],count:1},{id:'high',priority:5,condition:compare('variable','1','switch'),weights:[{value:'0',weight:1}],count:1}]; });
  const next=moved(createInitialState(r,seed),r); expect(values(next)[4]).toBe('0'); expect(next.world.events.variables.switch).toBe('1');
});

test('nested conditions compare exact integers and reference only declared variables/events',async()=>{
  const r=await rule(d=>{ d.variables={counter:'9007199254740993'}; d.events=[event()]; });
  const state=createInitialState(r,seed);
  const condition:Condition={kind:'all',children:[compare('variable','9007199254740993','counter'),{kind:'not',child:compare('round','1')},{kind:'any',children:[compare('event-count','1','event-a'),compare('empty-count','2')]}]};
  expect(conditionMatches(condition,state)).toBe(true);
});

test('event priority, total execution limits and cooldown are stored in world state',async()=>{
  const r=await rule(d=>{ d.variables={x:'0'}; d.events=[event({id:'low',priority:0,maxExecutions:1,condition:compare('variable','1','x'),actions:[{type:'add-score',value:'10'}]}),event({id:'high',priority:10,maxExecutions:1,actions:[{type:'set-variable',name:'x',value:'1'}]})]; });
  const first=moved(createInitialState(r,seed),r); expect(first.world.score).toBe('14'); expect(first.world.events.counters).toEqual({low:1,high:1});
  const second = moved(first,r,'right');
  expect(second.world.score).toBe('22'); expect(second.world.events.counters).toEqual({low:1,high:1});
  const cooldown=await rule(d=>{d.events=[event({cooldownTurns:2})];});
  const a=moved(createInitialState(cooldown,seed),cooldown),b=moved(a,cooldown,'right'),c=moved(b,cooldown);
  expect(b.world.events.counters['event-a']).toBe(1); expect(c.world.events.counters['event-a']).toBe(2); expect(c.world.events.cooldowns?.['event-a']).toBe(2);
});

test('event actions set cells/variables and cap finite skill charges in one atomic operation',async()=>{
  const r=await rule(d=>{d.variables={x:'0'};d.events=[event({actions:[{type:'set-cell',index:4,value:'0'},{type:'add-variable',name:'x',value:'9007199254740993'},{type:'add-charge',skillId:'undo',amount:20}]})];});
  const initial=createInitialState(r,seed); initial.ledger.skills.undo.charges=1;
  const next=moved(initial,r); expect(values(next)[4]).toBe('0'); expect(next.world.events.variables.x).toBe('9007199254740993'); expect(next.ledger.skills.undo.charges).toBe(3);
});

test.each([false,true])('reentry=%s is bounded by explicit total execution count',async reentry=>{
  const r=await rule(d=>{d.events=[event({maxExecutions:3,allowReentry:reentry,actions:[{type:'add-score',value:'1'},{type:'emit',trigger:'after-round'}]})];});
  const next=moved(createInitialState(r,seed),r); expect(next.world.events.counters['event-a']).toBe(reentry?3:1); expect(next.world.score).toBe(reentry?'7':'5');
});

test.each(['recursive','queue','variable'] as const)('%s budget failure discards the whole candidate',async kind=>{
  const r=await rule(d=>{
    if(kind==='variable'){d.variables={x:'9'.repeat(4096)};d.events=[event({actions:[{type:'add-variable',name:'x',value:'1'}]})];}
    else d.events=[event({allowReentry:true,actions:Array.from({length:kind==='queue'?64:1},()=>({type:'emit' as const,trigger:'after-round' as const}))})];
  });
  const initial=createInitialState(r,seed),before=canonicalJson(initial); expect(()=>moved(initial,r)).toThrow(/预算|队列/); expect(canonicalJson(initial)).toBe(before);
});

test.each(['mapping-id','position-index','missing-variable','missing-event','deep-condition'] as const)('invalid %s configuration is rejected with a field path',kind=>{
  const d=sandboxDefinition();
  if(kind==='mapping-id') d.merge.mappings=[{id:'same',left:'2',right:'2',result:'4',priority:0,directional:false},{id:'same',left:'4',right:'4',result:'8',priority:0,directional:false}];
  if(kind==='position-index') {d.spawn.positionStrategy='weighted';d.spawn.positionWeights=[{index:99,weight:1}];}
  if(kind==='missing-variable') d.events=[event({actions:[{type:'set-variable',name:'missing',value:'1'}]})];
  if(kind==='missing-event') d.spawn.phaseRules=[{id:'phase',priority:0,condition:compare('event-count','1','missing'),weights:[{value:'2',weight:1}],count:1}];
  if(kind==='deep-condition') {let condition=compare('round','1');for(let i=0;i<18;i++) condition={kind:'not',child:condition}; d.events=[event({condition})];}
  expect(validateDefinition(d).some(issue=>issue.severity==='error'&&issue.path.startsWith('/'))).toBe(true);
});

test.each(['cancel','pack','drop'] as const)('resize %s is explicit, deterministic and leaves input untouched',async policy=>{
  const old=await rule(d=>{d.board.rows=2;d.board.cols=3;d.board.initialLayout=[{index:0,value:'2'},{index:5,value:'8'}];});
  const input=createInitialState(old,seed),d=structuredClone(old.definition);d.board.rows=1;d.board.cols=3;d.board.initialLayout=[];
  const next=await createRuleRevision(old,d,[old]),before=canonicalJson(input);
  if(policy==='cancel') expect(()=>migrateState(input,old,next,policy)).toThrow(/影响 1/);
  else {const migrated=migrateState(input,old,next,policy);expect(values(migrated.state)).toEqual(policy==='pack'?['2','8',null]:['2',null,null]);expect(migrated.overflow).toEqual([{index:5,value:'8'}]);}
  expect(canonicalJson(input)).toBe(before);
});

test('migration rejects insufficient packing space and clips resources without reapplying initial layout',async()=>{
  const old=await rule(d=>{d.board.rows=2;d.board.cols=2;d.board.initialLayout=['2','4','8','16'].map((value,index)=>({index,value}));d.skills.undo.unlimited=true;});
  const input=createInitialState(old,seed),d=structuredClone(old.definition);d.board.rows=1;d.board.cols=1;d.board.initialLayout=[{index:0,value:'32'}];d.skills.undo.unlimited=false;d.skills.undo.initialCharges=1;d.skills.undo.maxCharges=1;
  const next=await createRuleRevision(old,d,[old]);expect(()=>migrateState(input,old,next,'pack')).toThrow(/空间不足/);
  const migrated=migrateState(input,old,next,'drop');expect(values(migrated.state)).toEqual(['2']);expect(migrated.state.ledger.skills.undo.charges).toBe(1);expect(migrated.state.undoStack).toEqual([]);
});

test('board edit counts once without charging rounds, remains undoable, and no-op is free',async()=>{
  const r=await rule(),initial=createInitialState(r,seed);
  const result=stepGame(initial,r,{type:'edit',payload:{patches:[{index:0,value:'0'},{index:4,value:'16'}]},elapsedMs:0},'S0');if(!result.accepted)throw new Error(result.reason);
  expect(result.state.ledger.effectiveActionCount).toBe(1);expect(result.state.ledger.chargedTurnCount).toBe(0);expect(result.state.undoStack).toEqual(['S0']);
  const undo=stepGame(result.state,r,{type:'skill',payload:{skillId:'undo',targetNodeId:'S0'},elapsedMs:0},'S1',result.state.rng,id=>id==='S0'?initial:undefined);if(!undo.accepted)throw new Error(undo.reason);expect(undo.state.world).toEqual(initial.world);
  expect(stepGame(initial,r,{type:'edit',payload:{patches:[{index:0,value:'2'}]},elapsedMs:0},'S0').accepted).toBe(false);
});

test('version publication changes reference, clears undo boundary, preserves score/RNG, and runs new edit events',async()=>{
  const old=await rule(),initial=createInitialState(old,seed),current=moved(initial,old),d=structuredClone(old.definition);d.events=[event({trigger:'after-edit',actions:[{type:'add-score',value:'10'}]})];
  const next=await createRuleRevision(old,d,[old]);const result=stepGame(current,old,{type:'rule-edit',payload:{nextRuleRef:{id:next.id,version:next.version},overflowPolicy:'cancel'},elapsedMs:0},'S1',current.rng,()=>undefined,next);if(!result.accepted)throw new Error(result.reason);
  expect(result.state.ruleRef).toEqual({id:old.id,version:2});expect(result.state.world.score).toBe('14');expect(result.state.ledger.effectiveActionCount).toBe(2);expect(result.state.ledger.chargedTurnCount).toBe(1);expect(result.state.undoStack).toEqual([]);expect(result.state.rng).toEqual(current.rng);
});
