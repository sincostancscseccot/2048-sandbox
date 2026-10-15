import { expect, test } from 'vitest';
import type { Direction, RuleDefinition } from '../../src/domain/types';
import { sandboxDefinition, createCustomRule } from '../../src/presets/rules';
import { createInitialState, stepGame } from '../../src/engine/core';
import { seedPcg32 } from '../../src/random/pcg32';
import { tileAppearance, traceSlide } from '../../src/presentation/motion';
import { defaultExperience, parseExperience } from '../../src/presentation/preferences';
import { GameSound, soundNotes } from '../../src/presentation/sound';
import { scoreChange, soundForTurn, type CommittedTurn, type SoundKind } from '../../src/presentation/feedback';

function definition(kind: string): RuleDefinition {
  const d = sandboxDefinition(); d.board.rows = 3; d.board.cols = 5; d.spawn.initialCount = 0; d.spawn.perActionCount = 0;
  d.goals.lossWhenNoMoves = false; d.movement.invalidMovePolicy = 'advance-round';
  if (kind === 'chain') { d.merge.chain = true; d.merge.maxMergesPerTile = 3; }
  if (kind === 'mapping') { d.merge.kind = 'mapping'; d.merge.chain = true; d.merge.maxMergesPerTile = 2;
    d.merge.mappings = [{ id:'a',left:'2',right:'4',result:'8',directional:true,priority:0 }, { id:'b',left:'8',right:'8',result:'16',directional:false,priority:0 }]; }
  if (kind === 'sequence') { d.merge.kind = 'sequence-next'; d.numbers.sequence = 'custom'; d.numbers.customSequence = ['1','2','3','5','8','13','21','34']; }
  return d;
}
for (const kind of ['equal','chain','mapping','sequence']) test(`visual lineage agrees with actual ${kind} settlement in all four directions, without changing input`, async () => {
  const d = definition(kind), rule = await createCustomRule(kind,d), initial = createInitialState(rule,seedPcg32(42n,54n));
  const values = kind === 'sequence' ? [null,'1','2','3','5','8'] : [null,'0','2','4','8','16'];
  for (let sample = 0; sample < 30; sample++) {
    const before = structuredClone(initial);
    before.world.board.cells = before.world.board.cells.map((_,index) => {
      const value = values[(sample * 13 + index * (sample % 5 + 1) + Math.floor(sample / 3)) % values.length];
      return { tile: value === null ? null : { id:`tile-${index}`,value:value!,attributes:{} } };
    });
    const original = structuredClone(before);
    for (const direction of ['left','right','up','down'] as Direction[]) {
      const groups = traceSlide(before,d,direction), result = stepGame(before,rule,{type:'move',payload:{direction},elapsedMs:0},'parent');
      if (!result.accepted) throw new Error(result.reason);
      expect(result.state.world.board.cells.map(cell=>cell.tile?.value??null)).toEqual(before.world.board.cells.map((_,index)=>groups.find(group=>group.index===index)?.value??null));
      expect(groups.flatMap(group=>group.sources.map(source=>source.tile.id)).sort()).toEqual(before.world.board.cells.flatMap(cell=>cell.tile?[cell.tile.id]:[]).sort());
      expect(groups.reduce((sum,group)=>sum+group.sources.length-1,0)).toBe(result.merges);
    }
    expect(before).toEqual(original);
  }
});

test('multi-stage chain sends every source to the final destination and formats exact large values without Number conversion', async () => {
  const d = definition('chain'); d.board.rows = 1; d.board.cols = 4;
  d.board.initialLayout = ['2','2','4','8'].map((value,index)=>({index,value}));
  const rule = await createCustomRule('chain',d), state = createInitialState(rule,seedPcg32(42n,54n));
  const groups = traceSlide(state,d,'left'); expect(groups).toHaveLength(1); expect(groups[0]!.value).toBe('16'); expect(groups[0]!.sources.map(source=>source.index)).toEqual([0,1,2,3]);
  expect(tileAppearance('900719925474099312345')).toMatchObject({text:'90071…345',level:12,small:true}); expect(tileAppearance('0')).toMatchObject({text:'0',level:0});
});

test('experience preferences are versioned, bounded and recover from malformed or unavailable values', () => {
  for (const raw of [null,'bad','null','{}','{"version":2}','{"version":1,"motion":false,"sound":false,"decorations":false,"volume":-1}']) expect(parseExperience(raw)).toEqual(defaultExperience);
  const off = {version:1,motion:false,sound:false,decorations:false,volume:0}; expect(parseExperience(JSON.stringify(off))).toEqual(off);
  const parsed = parseExperience(JSON.stringify({...off,volume:100,extra:'ignore'})); expect(parsed).toEqual({...off,volume:100}); parsed.motion = true; expect(defaultExperience.motion).toBe(true);
});

class FakeParam { value = 0; calls:number[]=[]; setTargetAtTime(value:number) {this.calls.push(value);} setValueAtTime(value:number) {this.calls.push(value);} linearRampToValueAtTime(value:number){this.calls.push(value);} exponentialRampToValueAtTime(value:number){this.calls.push(value);} }
class FakeGain {gain=new FakeParam(); disconnected=false;connect(){} disconnect(){this.disconnected=true;} }
class FakeOscillator {frequency=new FakeParam();type='sine';starts:number[]=[];stops:(number|undefined)[]=[];disconnected=false;onended:(()=>void)|null=null;connect(){} disconnect(){this.disconnected=true;}start(time:number){this.starts.push(time);}stop(time?:number){this.stops.push(time);} }

function audioFixture() {
  const oscillators:FakeOscillator[]=[],gains:FakeGain[]=[];
  const context = { state:'suspended',currentTime:1,destination:{},resumes:0,closed:false,
    createGain(){const gain=new FakeGain();gains.push(gain);return gain;},createOscillator(){const oscillator=new FakeOscillator();oscillators.push(oscillator);return oscillator;},
    async resume(){this.resumes++;this.state='running';},async close(){this.closed=true;this.state='closed';} };
  let creations=0; const sound=new GameSound(()=>{creations++;return context as unknown as AudioContext;});
  return {sound,context,oscillators,gains,creations:()=>creations};
}
test('audio remains dormant before a gesture, plays real scheduled notes after unlock, and muting cancels scheduled voices', async () => {
  const f=audioFixture(); f.sound.configure(true,30); expect(f.creations()).toBe(0); expect(f.sound.play('merge')).toBe(false);
  expect(await f.sound.unlock()).toBe(true); expect(f.creations()).toBe(1); expect(f.context.resumes).toBe(1);
  expect(f.sound.play('merge')).toBe(true); expect(f.oscillators).toHaveLength(2); expect(f.oscillators[0]!.starts[0]).toBeCloseTo(1.16);
  expect(f.gains[0]!.gain.value).toBe(.3); expect(f.gains[1]!.gain.calls).toEqual([0,.13,.001]);
  f.sound.configure(false,30); expect(f.oscillators.every(node=>node.disconnected&&node.stops.at(-1)===undefined)).toBe(true); expect(f.sound.play('win')).toBe(false);
  f.sound.configure(true,0); expect(f.sound.play('start')).toBe(false); f.sound.dispose(); expect(f.context.closed).toBe(true);
});
test('missing or blocked audio never throws into game input, and zero volume does not create a context', async () => {
  const sound = new GameSound(()=>{throw new Error('unavailable');}); sound.configure(true,30); expect(await sound.unlock()).toBe(false); expect(sound.play('move')).toBe(false); sound.dispose();
  const f=audioFixture(); f.sound.configure(true,0); expect(await f.sound.unlock()).toBe(false); expect(f.creations()).toBe(0);
});
test('all related sound cues are finite, short and bounded', () => {
  for(const kind of ['move','merge','undo','skill','edit','start','win','loss','blocked'] as SoundKind[]) {
    const tones=soundNotes(kind); expect(tones.length).toBeGreaterThan(0); expect(tones.length).toBeLessThanOrEqual(4);
    for(const tone of tones){ expect(tone.frequency).toBeGreaterThan(0); expect(tone.gain).toBeLessThanOrEqual(.13); expect(tone.delay+tone.duration).toBeLessThan(1); }
  }
});
test('feedback uses committed results, distinguishes undo, and preserves huge exact score deltas', async () => {
  const rule=await createCustomRule('feedback',definition('equal')),before=createInitialState(rule,seedPcg32(42n,54n)),after=structuredClone(before);
  const turn:CommittedTurn={projectId:'p',fromNodeId:'a',toNodeId:'b',before,after,rule,action:{type:'move',payload:{direction:'left'},elapsedMs:0}};
  expect(soundForTurn(turn)).toBe('move'); after.world.mergeCount=1; expect(soundForTurn(turn)).toBe('merge');
  turn.action={type:'skill',payload:{skillId:'undo',targetNodeId:'a'},elapsedMs:0}; expect(soundForTurn(turn)).toBe('undo');
  after.world.outcome.status='won'; expect(soundForTurn(turn)).toBe('win'); before.world.outcome.status='won'; expect(soundForTurn(turn)).toBe('undo');
  before.world.score='900719925474099312345'; after.world.score='900719925474099312352'; expect(scoreChange(turn)).toBe('+7');
  after.world.score='0'; expect(scoreChange(turn)).toBe('-900719925474099312345');
});
