import { test, expect, type Page } from '@playwright/test';
import { experienceKey, defaultExperience } from '../../src/presentation/preferences';
import { snapshot, availableDirection } from './helpers';

test.use({ viewport:{width:1440,height:1000}, actionTimeout:15_000 });
async function quiet(page:Page) {
  await page.addInitScript(({key,value})=>{ if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(value)); },{key:experienceKey,value:{...defaultExperience,sound:false}});
}
async function create(page:Page) {
  await page.getByRole('button',{name:'自定义新局',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新建自定义对局'});
  await dialog.getByLabel('棋盘行数',{exact:true}).fill('2');await dialog.getByLabel('棋盘列数',{exact:true}).fill('4');
  await dialog.getByLabel('开局数量',{exact:true}).fill('0');await dialog.getByLabel('每次生成数量',{exact:true}).fill('0');
  await dialog.getByLabel('初始布局（格索引:数字）',{exact:true}).fill('0:2, 1:2, 6:8');await dialog.getByLabel('无路可走时判负',{exact:true}).uncheck();
  await dialog.getByRole('button',{name:'创建自定义对局',exact:true}).click();await expect(dialog).toHaveCount(0);
}
async function settings(page:Page){await page.getByRole('button',{name:'动效与声音',exact:true}).click();return page.getByRole('dialog',{name:'动效、声音与外观'});}
async function holdAnimations(page:Page){await page.evaluate(()=>{
  const original=Element.prototype.animate;Element.prototype.animate=function(keyframes,options){const animation=original.call(this,keyframes,options);if(this.closest('.visual-board')){animation.pause();animation.currentTime=0;}return animation;};
});}
async function finishAnimations(page:Page){await page.getByTestId('board').evaluate(element=>{for(const animation of element.getAnimations({subtree:true}))animation.finish();});await expect(page.locator('.tile-ghost')).toHaveCount(0);}

test('tiles visibly travel through intermediate positions; both merge operands arrive before the result appears, including chain merges',async({page},testInfo)=>{
  await quiet(page);await page.goto('/');await create(page);await holdAnimations(page);
  const before=await snapshot(page),positions=await page.getByTestId('cell').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));
  await page.getByRole('button',{name:'向左移动',exact:true}).click();await expect(page.getByTestId('action-count')).toHaveText('1');
  await expect(page.locator('.tile-ghost')).toHaveCount(2);
  await page.getByTestId('board').evaluate(element=>{for(const animation of element.getAnimations({subtree:true}))animation.currentTime=80;});
  const middle=await page.locator('.tile-layer .tile-visual[data-value="8"]').boundingBox();expect(middle!.x).toBeGreaterThan(positions[4]!.x);expect(middle!.x).toBeLessThan(positions[6]!.x);
  const operand=await page.locator('.tile-ghost[data-from-index="1"]').boundingBox();expect(operand!.x).toBeGreaterThan(positions[0]!.x);expect(operand!.x).toBeLessThan(positions[1]!.x);
  expect(await page.locator('.tile-layer .tile-visual[data-value="4"]').evaluate(element=>Number(getComputedStyle(element).opacity))).toBe(0);
  await page.screenshot({path:testInfo.outputPath('experience-slide-desktop.png')});await finishAnimations(page);
  await expect(page.locator('.tile-layer .tile-visual')).toHaveCount(2);await expect(page.getByTestId('score')).toHaveText('4');expect((await snapshot(page)).nodes).toHaveLength(before.nodes.length+1);
  const alignment=await page.getByTestId('board').evaluate(element=>{
    const cells=[...element.querySelectorAll('[data-testid="cell"]')];return [...element.querySelectorAll<HTMLElement>('.tile-layer .tile-visual')].every(tile=>{const col=Number(tile.style.gridColumn)-1,row=Number(tile.style.gridRow)-1,a=tile.getBoundingClientRect(),b=cells[row*4+col]!.getBoundingClientRect();return Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1&&Math.abs(a.width-b.width)<1&&Math.abs(a.height-b.height)<1;});
  });expect(alignment).toBe(true);
  await page.getByRole('button',{name:'自定义新局',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新建自定义对局'});await dialog.getByText('探索预设玩法 · 4 套',{exact:true}).click();await dialog.locator('.preset-grid').getByRole('button',{name:/^连锁合并/}).click();await dialog.getByRole('button',{name:'创建自定义对局',exact:true}).click();await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'向左移动',exact:true}).click();await expect(page.getByTestId('score')).toHaveText('28');await expect(page.locator('.tile-ghost')).toHaveCount(4);
  expect(await page.locator('.tile-ghost').evaluateAll(tiles=>tiles.every(tile=>(tile as HTMLElement).dataset.toIndex==='0'))).toBe(true);await finishAnimations(page);await expect(page.locator('.tile-layer .tile-visual')).toHaveText('16');
});

test('sound uses a real unlocked AudioContext with nonzero audio, mutes immediately, and failed/retried saves or history do not duplicate cues',async({page})=>{
  await page.addInitScript(()=>{
    const Native=window.AudioContext,probe={contexts:0,starts:[] as number[],stops:0,peak:0};(window as unknown as {audioProbe:typeof probe}).audioProbe=probe;
    window.AudioContext=class extends Native{
      constructor(options?:AudioContextOptions){super(options);probe.contexts++;}
      override createOscillator(){const oscillator=super.createOscillator(),start=oscillator.start.bind(oscillator),stop=oscillator.stop.bind(oscillator);oscillator.start=(when?:number)=>{probe.starts.push(when??0);start(when);};oscillator.stop=(when?:number)=>{probe.stops++;stop(when);};return oscillator;}
      override createGain(){const gain=super.createGain(),connect=gain.connect.bind(gain),context=this;
        Object.defineProperty(gain,'connect',{value:(target:AudioNode)=>{if(target===context.destination){const analyser=context.createAnalyser(),buffer=new Float32Array(analyser.fftSize);connect(analyser);analyser.connect(target);const sample=()=>{if(context.state==='closed')return;analyser.getFloatTimeDomainData(buffer);for(const value of buffer)probe.peak=Math.max(probe.peak,Math.abs(value));requestAnimationFrame(sample);};requestAnimationFrame(sample);return target;}return connect(target);}});return gain;}
    };
  });
  const played=()=>page.evaluate(()=>(window as unknown as {audioProbe:{starts:number[]}}).audioProbe.starts.length);
  await page.goto('/');expect(await page.evaluate(()=>(window as unknown as {audioProbe:{contexts:number}}).audioProbe.contexts)).toBe(0);
  let dialog=await settings(page);expect(await played()).toBe(0);await dialog.getByRole('button',{name:'♫ 试听合并音效',exact:true}).click();await expect.poll(played).toBe(2);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {audioProbe:{peak:number}}).audioProbe.peak)).toBeGreaterThan(.0001);
  await dialog.getByRole('switch',{name:'游戏音效',exact:true}).click();const muted=await played();await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click();await page.getByRole('button',{name:'开始经典对局'}).click();await expect(page.getByTestId('save-status')).toHaveText('已自动保存');expect(await played()).toBe(muted);
  dialog=await settings(page);await dialog.getByRole('switch',{name:'游戏音效',exact:true}).click();expect(await played()).toBe(muted);await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click();
  const before=await snapshot(page),direction=await availableDirection(page);
  await page.evaluate(()=>{const add=IDBObjectStore.prototype.add;let fail=true;IDBObjectStore.prototype.add=function(...args){if(this.name==='historyNodes'&&fail){fail=false;throw new DOMException('injected quota','QuotaExceededError');}return add.apply(this,args);};});
  await page.getByRole('button',{name:direction.label,exact:true}).click();await expect(page.getByTestId('save-status')).toHaveText('保存未确认');expect(await played()).toBe(muted);expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button',{name:'重试本次保存',exact:true}).click();await expect(page.getByTestId('action-count')).toHaveText('1');await expect.poll(played).toBeGreaterThan(muted);const confirmed=await played();
  await page.getByRole('button',{name:'保存检查点'}).click();expect(await played()).toBe(confirmed);
  const saved=await snapshot(page),root=saved.nodes.find(node=>node.parentId===null)!;await page.locator(`.history-item[data-node-id="${root.id}"]`).click();await page.getByRole('button',{name:'回到当前',exact:true}).click();expect(await played()).toBe(confirmed);
  dialog=await settings(page);const volume=dialog.getByRole('slider',{name:'音效音量',exact:true});await volume.focus();await page.keyboard.press('Home');await expect(volume).toHaveValue('0');await expect(dialog.getByRole('button',{name:'♫ 试听合并音效',exact:true})).toBeDisabled();
});

test('mobile controls persist, synchronize between tabs, and disable motion and decorations without changing game data',async({page,context},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await quiet(page);await page.goto('/');await create(page);const before=await snapshot(page),dialog=await settings(page);
  await dialog.getByRole('switch',{name:'滑动动画',exact:true}).click();await dialog.getByRole('switch',{name:'氛围与光影',exact:true}).click();await page.screenshot({path:testInfo.outputPath('experience-settings-mobile.png')});expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click();await expect(page.locator('.ambient-background')).toHaveCount(0);
  await page.getByRole('button',{name:'向左移动',exact:true}).click();await expect(page.getByTestId('action-count')).toHaveText('1');expect(await page.getByTestId('board').evaluate(element=>element.getAnimations({subtree:true}).length)).toBe(0);
  await page.reload();const reopened=await settings(page);await expect(reopened.getByRole('switch',{name:'滑动动画',exact:true})).toHaveAttribute('aria-checked','false');await expect(reopened.getByRole('switch',{name:'游戏音效',exact:true})).toHaveAttribute('aria-checked','false');await expect(reopened.getByRole('switch',{name:'氛围与光影',exact:true})).toHaveAttribute('aria-checked','false');
  const second=await context.newPage();await second.goto('/');const remote=await settings(second);await remote.getByRole('switch',{name:'氛围与光影',exact:true}).click();await expect(reopened.getByRole('switch',{name:'氛围与光影',exact:true})).toHaveAttribute('aria-checked','true');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('reduced-motion and unavailable preference storage remain usable, including all gameplay controls',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.addInitScript(({key,value})=>{
    const original=Storage.prototype.setItem;original.call(localStorage,key,JSON.stringify(value));Storage.prototype.setItem=function(name,value){if(name===key)throw new DOMException('unavailable','SecurityError');return original.call(this,name,value);};
  },{key:experienceKey,value:{...defaultExperience,sound:false}});
  await page.goto('/');await create(page);await page.getByRole('button',{name:'向左移动',exact:true}).click();await expect(page.getByTestId('score')).toHaveText('4');expect(await page.getByTestId('board').evaluate(element=>element.getAnimations({subtree:true}).length)).toBe(0);
  const dialog=await settings(page);await expect(dialog).toContainText('减少动态效果');await expect(dialog).toContainText('本次使用仍然生效');await dialog.getByRole('switch',{name:'滑动动画',exact:true}).click();await expect(dialog.getByRole('switch',{name:'滑动动画',exact:true})).toHaveAttribute('aria-checked','false');
});

test('rapid moves and resizing interrupt old animations cleanly and leave exactly the saved tiles',async({page},testInfo)=>{
  await quiet(page);await page.goto('/');await create(page);
  for(let step=1;step<=8;step++){await page.keyboard.press(step%2?'ArrowRight':'ArrowLeft');await expect(page.getByTestId('action-count')).toHaveText(String(step));}
  await page.setViewportSize({width:390,height:844});await expect(page.getByTestId('board')).toHaveAttribute('data-animation-phase','idle');await expect(page.locator('.tile-ghost')).toHaveCount(0);
  const saved=await snapshot(page),project=saved.projects[0]!.project,node=saved.nodes.find(node=>node.id===project.activeNodeId)!,state=saved.states.find(state=>state.hash===node.stateHash)!.state;
  expect(await page.locator('.tile-layer .tile-visual').evaluateAll(tiles=>tiles.map(tile=>(tile as HTMLElement).dataset.tileId).sort())).toEqual(state.world.board.cells.flatMap(cell=>cell.tile?[cell.tile.id]:[]).sort());
  await page.screenshot({path:testInfo.outputPath('experience-game-mobile.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('cached presentation settings, animated gameplay and sounds remain available offline',async({page,context},testInfo)=>{
  await quiet(page);await page.goto('/');await create(page);await expect(page.getByText('离线资源已就绪',{exact:true})).toBeVisible();await page.evaluate(()=>navigator.serviceWorker.ready);await context.setOffline(true);await page.reload();
  const dialog=await settings(page);await expect(dialog.getByRole('switch',{name:'滑动动画',exact:true})).toHaveAttribute('aria-checked','true');await dialog.getByRole('switch',{name:'游戏音效',exact:true}).click();await dialog.getByRole('button',{name:'♫ 试听合并音效',exact:true}).click();await expect(dialog).not.toContainText('未能播放音效');await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await page.getByRole('button',{name:'向左移动',exact:true}).click();await expect(page.getByTestId('score')).toHaveText('4');await expect(page.getByTestId('board')).toHaveAttribute('data-animation-phase','idle');await page.screenshot({path:testInfo.outputPath('experience-game-desktop.png')});await page.reload();await expect(page.getByTestId('action-count')).toHaveText('1');
});

test('effective moves without board changes finish idle and dense boards use a static result',async({page})=>{
  await quiet(page);await page.goto('/');await page.getByRole('button',{name:'自定义新局',exact:true}).click();let dialog=page.getByRole('dialog',{name:'新建自定义对局'});
  await dialog.getByLabel('棋盘行数',{exact:true}).fill('1');await dialog.getByLabel('棋盘列数',{exact:true}).fill('3');await dialog.getByLabel('开局数量',{exact:true}).fill('0');await dialog.getByLabel('每次生成数量',{exact:true}).fill('0');await dialog.getByLabel('初始布局（格索引:数字）',{exact:true}).fill('0:2');await dialog.getByRole('combobox',{name:'无效方向输入',exact:true}).selectOption('advance-round');await dialog.getByLabel('无路可走时判负',{exact:true}).uncheck();
  await dialog.getByRole('button',{name:'创建自定义对局',exact:true}).click();await expect(dialog).toHaveCount(0);const before=await snapshot(page);await page.getByRole('button',{name:'向左移动',exact:true}).click();await expect(page.getByTestId('action-count')).toHaveText('1');
  // Cross the 160 ms slide timer boundary: a valid no-op must never stay settling.
  await page.waitForTimeout(220);await expect(page.getByTestId('board')).toHaveAttribute('data-animation-phase','idle');expect(await page.getByTestId('board').evaluate(element=>element.getAnimations({subtree:true}).length)).toBe(0);expect((await snapshot(page)).nodes.length).toBe(before.nodes.length+1);
  await page.getByRole('button',{name:'自定义新局',exact:true}).click();dialog=page.getByRole('dialog',{name:'新建自定义对局'});await dialog.getByLabel('棋盘行数',{exact:true}).fill('9');await dialog.getByLabel('棋盘列数',{exact:true}).fill('9');await dialog.getByLabel('开局数量',{exact:true}).fill('0');await dialog.getByLabel('每次生成数量',{exact:true}).fill('0');await dialog.getByLabel('初始布局（格索引:数字）',{exact:true}).fill(Array.from({length:70},(_,i)=>`${i}:${i%2?'4':'2'}`).join(', '));await dialog.getByLabel('无路可走时判负',{exact:true}).uncheck();await dialog.getByRole('button',{name:'创建自定义对局',exact:true}).click();await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'向右移动',exact:true}).click();await expect(page.getByTestId('action-count')).toHaveText('1');await expect(page.getByTestId('board')).toHaveAttribute('data-animation-phase','idle');expect(await page.getByTestId('board').evaluate(element=>element.getAnimations({subtree:true}).length)).toBe(0);await expect(page.locator('.tile-ghost')).toHaveCount(0);await expect(page.locator('.tile-layer .tile-visual')).toHaveCount(70);
});
