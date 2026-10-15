import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { LibrarySnapshot, LoadedProject } from '../../src/domain/types';
import { createCustomRule, sandboxDefinition } from '../../src/presets/rules';
import { prepareMove, prepareNewMatch } from '../../src/history/candidates';
import { createArchive } from '../../src/files/archive';
import { seedPcg32 } from '../../src/random/pcg32';
import { snapshot } from './helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
function head(saved: LibrarySnapshot) {
  const id = saved.settings.find(item => item.key === 'lastProjectId')!.value, project = saved.projects.find(item => item.id === id)!;
  const node = saved.nodes.find(item => item.matchId === id && item.id === project.project.activeNodeId)!;
  return { project, node, state: saved.states.find(item => item.hash === node.stateHash)!.state };
}
async function setup(page: Page) {
  await page.getByRole('button', { name: '自定义新局', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '新建自定义对局' });
  await dialog.getByLabel('对局名称', { exact: true }).fill('M5 交互实验'); await dialog.getByLabel('棋盘行数', { exact: true }).fill('2'); await dialog.getByLabel('棋盘列数', { exact: true }).fill('4');
  await dialog.getByLabel('开局数量', { exact: true }).fill('0'); await dialog.getByLabel('每次生成数量', { exact: true }).fill('0');
  await dialog.getByRole('textbox', { name: '初始布局（格索引:数字）', exact: true }).fill('0:2, 1:2, 2:4'); await dialog.getByLabel('无路可走时判负', { exact: true }).uncheck(); return dialog;
}
async function create(page: Page) { const dialog = await setup(page); await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0); }
async function left(page: Page, count: number) { await page.getByRole('button', { name: '向左移动', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText(String(count)); }
async function stats(page: Page) { await page.getByRole('button', { name: '规则与路径统计' }).click(); return page.getByRole('dialog', { name: '规则与路径统计' }); }
async function tree(page: Page) { await page.getByRole('button', { name: '打开完整历史树' }).click(); return page.getByRole('dialog', { name: '历史树与回放' }); }

test('rectangle drafts fill and erase exact coordinates, cancel freely and commit one undoable operation', async ({ page }, testInfo) => {
  await page.goto('/'); await create(page); const before = await snapshot(page);
  await page.getByRole('button', { name: '编辑本节点棋盘', exact: true }).click(); let draft = page.getByRole('dialog', { name: '编辑本节点棋盘' });
  await draft.getByRole('combobox', { name: '绘制范围', exact: true }).selectOption('rectangle'); await draft.getByLabel('画笔数字', { exact: true }).fill('0'); await draft.getByTestId('cell').nth(4).click();
  await expect(draft.getByRole('button', { name: '提交棋盘编辑', exact: true })).toBeDisabled(); expect(await snapshot(page)).toEqual(before); await draft.getByTestId('cell').nth(7).click(); await expect(draft.getByTestId('draft-change-count')).toHaveText('草稿修改 4 格');
  await draft.getByRole('button', { name: '撤销草稿', exact: true }).click(); await expect(draft.getByTestId('draft-change-count')).toHaveText('草稿修改 0 格'); await draft.getByRole('button', { name: '重做草稿', exact: true }).click();
  await draft.getByLabel('清空画笔', { exact: true }).check(); await draft.getByTestId('cell').nth(5).click(); await draft.getByTestId('cell').nth(6).click(); await expect(draft.getByTestId('cell').nth(5)).toHaveAttribute('data-value','');
  await draft.getByRole('button', { name: '撤销草稿', exact: true }).click(); await page.screenshot({ path: testInfo.outputPath('m5-batch-editor-desktop.png') }); await draft.getByRole('button', { name: '关闭窗口', exact: true }).click(); expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: '编辑本节点棋盘', exact: true }).click(); draft = page.getByRole('dialog', { name: '编辑本节点棋盘' }); await draft.getByRole('combobox', { name: '绘制范围', exact: true }).selectOption('rectangle'); await draft.getByLabel('画笔数字', { exact: true }).fill('0'); await draft.getByTestId('cell').nth(4).click(); await draft.getByTestId('cell').nth(7).click();
  await draft.getByRole('button', { name: '提交棋盘编辑', exact: true }).click(); await expect(draft).toHaveCount(0); await expect(page.getByTestId('action-count')).toHaveText('1'); const saved = await snapshot(page); expect(saved.nodes).toHaveLength(2); expect(head(saved).state.world.board.cells.slice(4).map(cell=>cell.tile?.value)).toEqual(['0','0','0','0']); expect(head(saved).state.world.roundCount).toBe(0);
  await page.getByRole('button', { name: '撤销一步', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('2'); expect(head(await snapshot(page)).state.world.board).toEqual(head(before).state.world.board);
});

test('read-only statistics preserve undo score drops, exact JSON and saved progress while previewing', async ({ page }, testInfo) => {
  const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message)); await page.goto('/'); await create(page); await left(page,1); await left(page,2); await page.getByRole('button',{name:'撤销一步',exact:true}).click(); await expect(page.getByTestId('action-count')).toHaveText('3');
  const before = await snapshot(page), dialog = await stats(page); await expect(dialog.getByTestId('path-high-score')).toHaveText('12'); await page.screenshot({path:testInfo.outputPath('m5-path-statistics-desktop.png')});
  const wait = page.waitForEvent('download'); await dialog.getByRole('button',{name:'下载统计 JSON',exact:true}).click(); const file=testInfo.outputPath('m5-path-statistics.json'); await (await wait).saveAs(file); const report=JSON.parse(await readFile(file,'utf8'));
  expect(report.format).toBe('2048-sandbox-path-statistics'); expect(report.rows.map((row:{score:string})=>row.score)).toEqual(['0','4','12','4']); expect(report.actions).toMatchObject({move:2,skill:1});
  await dialog.getByRole('button',{name:'回看第 0 步，成绩 0',exact:true}).click(); await expect(page.getByTestId('action-count')).toHaveText('0'); await page.keyboard.press('ArrowLeft'); expect(await snapshot(page)).toEqual(before); await expect(dialog.getByTestId('path-high-score')).toHaveText('12');
  await dialog.getByRole('slider',{name:'统计预览步数',exact:true}).focus(); await page.keyboard.press('End'); await expect(page.getByTestId('action-count')).toHaveText('3'); await dialog.getByRole('tab',{name:'路径统计',exact:true}).focus(); await page.keyboard.press('ArrowRight'); await expect(dialog.getByRole('tab',{name:'规则状态',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(dialog.getByTestId('rule-runtime')).toContainText('计费回合'); await dialog.getByRole('tab',{name:'节点对比',exact:true}).click(); await dialog.getByRole('combobox',{name:'比较基准',exact:true}).selectOption('parent'); await expect(dialog.locator('.node-comparison')).toContainText('成绩变化 -8'); await expect(dialog.locator('.node-comparison')).toContainText('余量 3 → 2');
  await page.screenshot({path:testInfo.outputPath('m5-node-comparison-desktop.png')}); await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click(); expect(await snapshot(page)).toEqual(before); expect(errors).toEqual([]);
});

test('rule navigation, nested conditions, safe variable rename and action ordering produce the intended event state', async ({ page }, testInfo) => {
  await page.goto('/'); const dialog=await setup(page); await dialog.getByRole('navigation',{name:'规则设置导航'}).getByRole('button',{name:'事件',exact:true}).click();
  await dialog.getByRole('button',{name:'添加变量',exact:true}).click(); await dialog.getByRole('button',{name:'添加变量',exact:true}).click(); await dialog.getByLabel('变量2名称',{exact:true}).fill('value1'); await expect(dialog.getByRole('alert')).toContainText('名称已存在'); await expect(dialog.getByLabel('变量2名称',{exact:true})).toHaveValue('value2');
  await dialog.getByRole('button',{name:'添加事件规则',exact:true}).click(); await dialog.getByRole('combobox',{name:'事件1条件',exact:true}).selectOption('all'); await dialog.getByRole('button',{name:'添加子条件',exact:true}).click();
  await dialog.getByRole('combobox',{name:'事件1子项2比较字段',exact:true}).selectOption('variable'); await dialog.getByRole('combobox',{name:'事件1子项2比较方式',exact:true}).selectOption('eq'); await dialog.getByLabel('事件1子项2比较值',{exact:true}).fill('0');
  await dialog.getByLabel('变量1名称',{exact:true}).fill('moves'); await expect(dialog.getByRole('combobox',{name:'事件1子项2引用',exact:true})).toHaveValue('moves');
  await dialog.getByRole('button',{name:'添加事件动作',exact:true}).click(); await dialog.getByRole('combobox',{name:'事件1动作2类型',exact:true}).selectOption('set-variable'); await dialog.getByRole('combobox',{name:'事件1动作2变量',exact:true}).selectOption('moves'); await dialog.getByLabel('事件1动作2数值',{exact:true}).fill('5');
  await dialog.getByRole('button',{name:'添加事件动作',exact:true}).click(); await dialog.getByRole('combobox',{name:'事件1动作3类型',exact:true}).selectOption('add-variable'); await dialog.getByRole('combobox',{name:'事件1动作3变量',exact:true}).selectOption('moves'); await dialog.getByLabel('事件1动作3数值',{exact:true}).fill('2'); await dialog.getByRole('button',{name:'事件1动作3上移',exact:true}).click(); await expect(dialog.getByRole('combobox',{name:'事件1动作3类型',exact:true})).toHaveValue('set-variable');
  await dialog.getByRole('button',{name:'复制事件',exact:true}).click(); await dialog.getByRole('button',{name:'创建自定义对局',exact:true}).click(); await expect(dialog).toHaveCount(0); await left(page,1); await expect(page.getByTestId('score')).toHaveText('5'); const current=head(await snapshot(page)); expect(current.state.world.events.variables).toEqual({moves:'5',value2:'0'}); expect(Object.values(current.state.world.events.counters).reduce((a,b)=>a+b,0)).toBe(1);
  const analysis=await stats(page); await analysis.getByRole('tab',{name:'规则状态',exact:true}).click(); await expect(analysis.getByTestId('rule-runtime')).toContainText('次数已达上限'); await expect(analysis.getByTestId('rule-runtime')).toContainText('条件未满足'); await page.screenshot({path:testInfo.outputPath('m5-rule-runtime-desktop.png')});
});

test('tree keyboard navigation, overview, camera controls and statistics stay read-only', async ({ page }, testInfo) => {
  await page.goto('/'); await create(page); await left(page,1); await left(page,2); const before=await snapshot(page), active=head(before), dialog=await tree(page);
  const selected=dialog.locator(`[data-tree-node="${active.node.id}"]`); await selected.focus(); await page.keyboard.press('ArrowLeft'); await expect(dialog.getByTestId('tree-score')).toHaveText('4'); await expect(dialog.locator('[data-tree-node].selected')).toBeFocused(); await page.keyboard.press('ArrowLeft'); await expect(dialog.getByTestId('tree-score')).toHaveText('0'); await page.keyboard.press('ArrowRight'); await expect(dialog.getByTestId('tree-score')).toHaveText('4');
  const canvas=dialog.getByTestId('history-tree'), old=await canvas.getAttribute('viewBox'); await canvas.focus(); await page.keyboard.press('ArrowRight'); await expect(canvas).not.toHaveAttribute('viewBox',old!); const overview=dialog.getByTestId('tree-overview'); await overview.click({position:{x:130,y:30}});
  await dialog.getByRole('button',{name:'定位保存节点',exact:true}).click(); await expect(dialog.getByTestId('tree-score')).toHaveText('12'); await dialog.getByLabel('跟随所选',{exact:true}).check(); await page.screenshot({path:testInfo.outputPath('m5-tree-desktop.png')}); expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button',{name:'查看路径统计',exact:true}).click(); await expect(page.getByRole('dialog',{name:'规则与路径统计'})).toBeVisible(); expect(await snapshot(page)).toEqual(before);
});

test('mobile batch editing, statistics and real two-finger tree zoom fit the viewport', async ({ browser }, testInfo) => {
  const context=await browser.newContext({baseURL:'http://127.0.0.1:4173',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try {
    const page=await context.newPage(); await page.goto('/'); await create(page); await page.getByRole('button',{name:'编辑本节点棋盘',exact:true}).click(); const draft=page.getByRole('dialog',{name:'编辑本节点棋盘'}); await draft.getByRole('combobox',{name:'绘制范围',exact:true}).selectOption('rectangle'); await draft.getByLabel('画笔数字',{exact:true}).fill('0'); await draft.getByTestId('cell').nth(4).click(); await draft.getByTestId('cell').nth(7).click(); expect(await draft.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true); await page.screenshot({path:testInfo.outputPath('m5-batch-editor-mobile.png')}); await draft.getByRole('button',{name:'提交棋盘编辑',exact:true}).click(); await expect(draft).toHaveCount(0);
    await left(page,2); const before=await snapshot(page), analysis=await stats(page); expect(await analysis.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true); await page.screenshot({path:testInfo.outputPath('m5-statistics-mobile.png')}); await analysis.getByRole('button',{name:'关闭窗口',exact:true}).click(); const dialog=await tree(page), canvas=dialog.getByTestId('history-tree'); await canvas.scrollIntoViewIfNeeded();
    const old=(await canvas.getAttribute('viewBox'))!.split(' ').map(Number), box=(await canvas.boundingBox())!, cdp=await context.newCDPSession(page), x=box.x+box.width/2,y=box.y+25;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-25,y},{x:x+25,y}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-55,y},{x:x+55,y}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(async()=>Number((await canvas.getAttribute('viewBox'))!.split(' ')[2])).toBeLessThan(old[2]!); await dialog.getByRole('button',{name:'定位所选',exact:true}).click(); await page.screenshot({path:testInfo.outputPath('m5-tree-mobile.png')}); expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true); expect(await snapshot(page)).toEqual(before);
  } finally {await context.close();}
});

async function largeFixture(count:number) {
  const d=sandboxDefinition(); d.board.rows=1; d.board.cols=3; d.board.initialLayout=[{index:0,value:'2'}]; d.spawn.initialCount=0; d.spawn.perActionCount=0; d.goals.lossWhenNoMoves=false;
  const rule=await createCustomRule('长路径',d), root=await prepareNewMatch('300 步历史导航',seedPcg32(42n,54n),rule);
  const loaded:LoadedProject={project:root.project,nodes:[root.node],states:new Map([[root.node.stateHash,root.state]]),rule,rules:new Map([[`${rule.id}/1`,rule]]),checkpoints:[],archivedRootIds:[]};
  for(let i=0;i<count;i++){const next=await prepareMove(loaded,loaded.project.activeNodeId,i%2?'left':'right','reroll');if('reason'in next)throw new Error(next.reason);loaded.project=next.project;loaded.nodes.push(next.node);loaded.states.set(next.node.stateHash,next.state);}
  const source:LibrarySnapshot={projects:[{id:loaded.project.id,project:loaded.project,updatedAt:loaded.nodes.at(-1)!.createdAt}],nodes:loaded.nodes,states:[...loaded.states].map(([hash,state])=>({hash,state})),rules:[rule],checkpoints:[],settings:[{key:'lastProjectId',value:loaded.project.id}]};
  return {file:await createArchive(source,{kind:'library'}),source};
}
test('a real 301-node archive uses bounded tree/list/table rendering and complete statistics',async({page},testInfo)=>{
  test.setTimeout(90_000); const {file}=await largeFixture(300); await page.goto('/'); await page.getByRole('button',{name:'文件与恢复',exact:true}).click(); const center=page.getByRole('dialog',{name:'文件与备份'}); await center.getByLabel('选择存档文件').setInputFiles({name:'m5-large.2048backup',mimeType:'application/zip',buffer:Buffer.from(file.bytes)}); await expect(center.getByTestId('import-preview')).toBeVisible(); await center.getByRole('button',{name:'导入副本',exact:true}).click(); await expect(center.getByText('已完成导入',{exact:true})).toBeVisible(); await center.getByRole('button',{name:'开始查看',exact:true}).click();
  const before=await snapshot(page); expect(before.nodes).toHaveLength(301); const dialog=await tree(page); await expect(dialog.locator('[data-tree-node]')).not.toHaveCount(0); expect(await dialog.locator('[data-tree-node]').count()).toBeLessThan(20); await dialog.getByLabel('查找步数或节点 ID',{exact:true}).fill('0'); await dialog.getByRole('button',{name:/^第 0 步 ·/}).click(); await expect(dialog.getByTestId('tree-score')).toHaveText('0'); expect(await dialog.locator('[data-tree-node]').count()).toBeLessThan(20); await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click(); expect(await page.locator('.history-item').count()).toBeLessThanOrEqual(60);
  const analysis=await stats(page); await analysis.getByRole('button',{name:'以保存位置为终点',exact:true}).click(); expect(await analysis.locator('.score-trend g').count()).toBeLessThanOrEqual(200); expect(await analysis.locator('tbody tr').count()).toBeLessThanOrEqual(50); const wait=page.waitForEvent('download'); await analysis.getByRole('button',{name:'下载统计 JSON',exact:true}).click(); const path=testInfo.outputPath('m5-large-statistics.json'); await(await wait).saveAs(path); expect(JSON.parse(await readFile(path,'utf8')).rows).toHaveLength(301); await page.screenshot({path:testInfo.outputPath('m5-large-statistics-desktop.png')}); expect(await snapshot(page)).toEqual(before);
});

test('cached analysis and overview work entirely offline with an advanced imported game',async({page,context},testInfo)=>{
  await page.goto('/'); await page.getByRole('button',{name:'文件与恢复',exact:true}).click(); const center=page.getByRole('dialog',{name:'文件与备份'}); await center.getByLabel('选择存档文件').setInputFiles(fileURLToPath(new URL('../../examples/projects/m4-advanced-demo.2048backup',import.meta.url))); await expect(center.getByTestId('import-preview')).toBeVisible(); await center.getByRole('button',{name:'导入副本',exact:true}).click(); await expect(center.getByText('已完成导入',{exact:true})).toBeVisible(); await center.getByRole('button',{name:'开始查看',exact:true}).click();
  await expect(page.getByText('离线资源已就绪',{exact:true})).toBeVisible(); await page.evaluate(()=>navigator.serviceWorker.ready); const before=await snapshot(page); await context.setOffline(true); await page.reload(); await expect(page.getByTestId('score')).toHaveText('26'); const analysis=await stats(page); await analysis.getByRole('tab',{name:'规则状态',exact:true}).click(); await expect(analysis.getByTestId('rule-runtime')).toContainText('moves'); await page.screenshot({path:testInfo.outputPath('m5-offline-runtime-desktop.png')}); await analysis.getByRole('button',{name:'关闭窗口',exact:true}).click(); await tree(page); await expect(page.getByTestId('tree-overview')).toBeVisible(); expect(await snapshot(page)).toEqual(before);
});

test('new game from a historical preview uses that displayed rule version and preserves both old paths',async({page})=>{
  await page.goto('/'); await create(page); const initial=head(await snapshot(page)); await page.getByRole('button',{name:'修改本节点规则',exact:true}).click(); const dialog=page.getByRole('dialog',{name:'修改本节点规则'}); await dialog.getByLabel('棋盘列数',{exact:true}).fill('5'); await dialog.getByRole('button',{name:'发布规则新版本',exact:true}).click(); await expect(dialog).toHaveCount(0); const before=await snapshot(page); await page.locator(`.history-item[data-node-id="${initial.node.id}"]`).click(); await expect(page.getByTestId('cell')).toHaveCount(8); await page.getByRole('button',{name:'＋ 新开一局',exact:true}).click(); const saved=await snapshot(page); expect(saved.projects).toHaveLength(2); expect(head(saved).state.ruleRef).toEqual(initial.state.ruleRef); expect(head(saved).state.world.board.cols).toBe(4); expect(saved.nodes.filter(node=>node.matchId===initial.project.id)).toEqual(before.nodes); expect(saved.projects.find(project=>project.id===initial.project.id)).toEqual(initial.project.id===before.projects[0]!.id?before.projects[0]:before.projects[1]);
});
