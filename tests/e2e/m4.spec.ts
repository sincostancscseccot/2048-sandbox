import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { LibrarySnapshot } from '../../src/domain/types';
import { snapshot, start } from './helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
function head(saved: LibrarySnapshot) {
  const id = saved.settings.find(item => item.key === 'lastProjectId')!.value, project = saved.projects.find(item => item.id === id)!;
  const node = saved.nodes.find(item => item.matchId === id && item.id === project.project.activeNodeId)!;
  return { project, node, state: saved.states.find(item => item.hash === node.stateHash)!.state };
}
async function setup(page: Page, rows = 2, cols = 4, layout = '0:2, 1:2, 2:4') {
  await page.getByRole('button', { name: '自定义新局', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建自定义对局' });
  await dialog.getByLabel('对局名称', { exact: true }).fill('M4 规则实验');
  await dialog.getByLabel('棋盘行数', { exact: true }).fill(String(rows)); await dialog.getByLabel('棋盘列数', { exact: true }).fill(String(cols));
  await dialog.getByLabel('开局数量', { exact: true }).fill('0'); await dialog.getByLabel('每次生成数量', { exact: true }).fill('0');
  await dialog.getByRole('textbox', { name: '初始布局（格索引:数字）', exact: true }).fill(layout);
  await dialog.getByLabel('无路可走时判负', { exact: true }).uncheck(); return dialog;
}
async function create(page: Page) {
  const dialog = await setup(page); await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0);
}
async function editor(page: Page) {
  await page.getByRole('button', { name: '编辑本节点棋盘', exact: true }).click(); return page.getByRole('dialog', { name: '编辑本节点棋盘' });
}
async function rules(page: Page) {
  await page.getByRole('button', { name: '修改本节点规则', exact: true }).click(); return page.getByRole('dialog', { name: '修改本节点规则' });
}
async function advanced(dialog: Locator) { await dialog.locator('details.advanced-rules > summary').click(); }
async function publish(dialog: Locator) { await dialog.getByRole('button', { name: '发布规则新版本', exact: true }).click(); await expect(dialog).toHaveCount(0); }
async function left(page: Page, count: number) {
  await page.getByRole('button', { name: '向左移动', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText(String(count));
}

test('classic board drafts undo/redo, cancel safely and publish one custom child without changing the original', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await start(page); const before = await snapshot(page), original = head(before);
  let dialog = await editor(page); await dialog.getByRole('button', { name: '清空棋盘草稿', exact: true }).click();
  await dialog.getByLabel('画笔数字', { exact: true }).fill('0'); await dialog.getByTestId('cell').nth(0).click();
  await dialog.getByRole('button', { name: '撤销草稿', exact: true }).click(); await expect(dialog.getByTestId('cell').nth(0)).toHaveAttribute('data-value', '');
  await dialog.getByRole('button', { name: '重做草稿', exact: true }).click(); await expect(dialog.getByTestId('cell').nth(0)).toHaveAttribute('data-value', '0');
  await page.keyboard.press('ArrowLeft'); expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click(); expect(await snapshot(page)).toEqual(before);
  dialog = await editor(page); await dialog.getByRole('button', { name: '清空棋盘草稿', exact: true }).click(); await dialog.getByLabel('画笔数字', { exact: true }).fill('9007199254740993');
  await dialog.getByTestId('cell').nth(0).click();
  const submitBox = (await dialog.getByRole('button', { name: '提交棋盘编辑', exact: true }).boundingBox())!, modalBox = (await dialog.boundingBox())!;
  expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(modalBox.y + modalBox.height);
  await page.screenshot({ path: testInfo.outputPath('m4-board-editor-desktop.png') });
  await dialog.getByRole('button', { name: '提交棋盘编辑', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('action-count')).toHaveText('1'); const saved = await snapshot(page), edited = head(saved);
  expect(saved.nodes).toHaveLength(2); expect(edited.state.world.board.cells[0]!.tile!.value).toBe('9007199254740993'); expect(edited.node.action).toMatchObject({ type: 'edit', payload: { nextRuleRef: edited.state.ruleRef } });
  expect(edited.state.undoStack).toEqual([]); expect(saved.states.find(state => state.hash === original.node.stateHash)!.state).toEqual(original.state);
  await page.reload(); await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', edited.node.id); expect(await snapshot(page)).toEqual(saved); expect(errors).toEqual([]);
});

test('resize previews overflow, packs explicitly, compares different sizes and branches using old rules', async ({ page }, testInfo) => {
  await page.goto('/'); await create(page); const original = head(await snapshot(page));
  let draft = await editor(page); await draft.getByLabel('画笔数字', { exact: true }).fill('8'); await draft.getByTestId('cell').nth(7).click(); await draft.getByRole('button', { name: '提交棋盘编辑', exact: true }).click(); await expect(draft).toHaveCount(0);
  const before = await snapshot(page), dialog = await rules(page); await dialog.getByLabel('棋盘行数', { exact: true }).fill('1');
  await expect(dialog.getByRole('alert')).toContainText('会影响 1 个数字'); expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('combobox', { name: '缩小棋盘策略', exact: true }).selectOption('drop'); await expect(dialog.getByTestId('migration-preview')).toContainText('丢弃 1 个');
  await dialog.getByRole('combobox', { name: '缩小棋盘策略', exact: true }).selectOption('pack'); await expect(dialog.getByTestId('migration-preview')).toContainText('搬移 1 个');
  await dialog.getByTestId('migration-preview').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('m4-resize-preview-desktop.png') });
  await publish(dialog); await expect(page.getByTestId('cell')).toHaveCount(4); await expect(page.getByTestId('cell').nth(3)).toHaveAttribute('data-value', '8');
  const published = head(await snapshot(page)); expect(published.state.ruleRef.version).toBe(2); expect(published.state.ledger.chargedTurnCount).toBe(0); expect(published.state.undoStack).toEqual([]);
  await left(page, 3); const newest = head(await snapshot(page)); await page.getByRole('button', { name: '打开完整历史树' }).click();
  const tree = page.getByRole('dialog', { name: '历史树与回放' }); await tree.locator(`[data-tree-node="${original.node.id}"]`).click();
  await expect(tree.locator('.inspector-data')).toContainText('/ 8 格'); await expect(tree.locator('.inspector-data')).toContainText('v1');
  await tree.getByRole('button', { name: '从所选节点继续', exact: true }).click(); await left(page, 1);
  const branch = head(await snapshot(page)); expect(branch.node.parentId).toBe(original.node.id); expect(branch.state.ruleRef).toEqual(original.state.ruleRef); expect(branch.state.world.board.rows).toBe(2);
  expect((await snapshot(page)).nodes).toContainEqual(newest.node);
});

test('graphical mapping, weighted phases and event variables settle, export and restore offline', async ({ page, browser }, testInfo) => {
  await page.goto('/'); const dialog = await setup(page, 1, 5, '0:2, 1:4'); await dialog.getByLabel('每次生成数量', { exact: true }).fill('1'); await advanced(dialog);
  await dialog.getByRole('combobox', { name: '合并方式', exact: true }).selectOption('mapping'); await dialog.getByRole('button', { name: '添加合并映射', exact: true }).click(); await dialog.getByLabel('映射1结果', { exact: true }).fill('16');
  await dialog.getByRole('combobox', { name: '生成位置', exact: true }).selectOption('weighted'); await dialog.getByRole('button', { name: '添加位置权重', exact: true }).click(); await dialog.getByLabel('位置1格索引', { exact: true }).fill('4');
  await dialog.getByRole('button', { name: '添加生成阶段', exact: true }).click(); await dialog.getByLabel('阶段1数字1', { exact: true }).fill('7');
  await dialog.getByRole('button', { name: '添加变量', exact: true }).click(); await dialog.getByLabel('变量1名称', { exact: true }).fill('moves');
  await dialog.getByRole('button', { name: '添加事件规则', exact: true }).click(); await dialog.getByLabel('事件1动作1数值', { exact: true }).fill('10');
  await dialog.getByLabel('事件1最多执行次数', { exact: true }).fill(''); await dialog.getByRole('button', { name: '添加事件动作', exact: true }).click();
  await dialog.getByRole('combobox', { name: '事件1动作2类型', exact: true }).selectOption('add-variable'); await dialog.getByRole('combobox', { name: '事件1动作2变量', exact: true }).selectOption('moves');
  await page.screenshot({ path: testInfo.outputPath('m4-events-form-desktop.png') });
  await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0); await left(page, 1);
  await expect(page.getByTestId('score')).toHaveText('26'); await expect(page.getByTestId('cell').nth(4)).toHaveAttribute('data-value', '7');
  const source = await snapshot(page), original = head(source); expect(original.state.world.events.variables.moves).toBe('1'); expect(original.state.world.events.counters).toEqual({ [Object.keys(original.state.world.events.counters)[0]!]: 1 });
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click(); const file = testInfo.outputPath('m4-advanced-demo.2048backup'); await (await wait).saveAs(file);
  const files = unzipSync(await readFile(file)), manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); expect(manifest.requiredCapabilities).toEqual(expect.arrayContaining(['advanced-v1', 'events-v1', 'editing-v1']));
  await page.getByRole('button', { name: '文件与恢复', exact: true }).click(); const center = page.getByRole('dialog', { name: '文件与备份' }); await center.getByRole('tab', { name: '导出文件', exact: true }).click(); await center.getByRole('combobox', { name: '导出范围', exact: true }).selectOption('rules');
  const ruleWait = page.waitForEvent('download'); await center.getByRole('button', { name: '下载导出文件', exact: true }).click(); await (await ruleWait).saveAs(testInfo.outputPath('m4-advanced-rules.json'));
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1000 } });
  try {
    const restored = await context.newPage(); await restored.goto('/'); await restored.getByRole('button', { name: '文件与恢复', exact: true }).click(); const modal = restored.getByRole('dialog', { name: '文件与备份' });
    await modal.getByLabel('选择存档文件').setInputFiles(file); await expect(modal.getByTestId('import-preview')).toBeVisible(); await modal.getByRole('button', { name: '导入副本', exact: true }).click(); await expect(modal.getByText('已完成导入', { exact: true })).toBeVisible(); await modal.getByRole('button', { name: '开始查看', exact: true }).click();
    expect(head(await snapshot(restored)).state).toEqual(original.state); await expect(restored.getByText('离线资源已就绪', { exact: true })).toBeVisible(); await restored.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true); await restored.reload();
    await expect(restored.getByTestId('board')).toHaveAttribute('data-node-id', original.node.id); const change = await rules(restored); await change.getByLabel('规则版本名称', { exact: true }).fill('离线新版本'); await publish(change); await expect(restored.getByTestId('action-count')).toHaveText('2');
    expect(head(await snapshot(restored)).state.ruleRef.version).toBe(2); expect(await snapshot(page)).toEqual(source);
  } finally { await context.close(); }
});

test('chain limits and adjacent custom sequences work through their graphical controls', async ({ page }) => {
  await page.goto('/'); let dialog = await setup(page, 1, 5, '0:2, 1:2, 2:4, 3:8'); await advanced(dialog);
  await dialog.getByRole('checkbox', { name: '允许新合并块继续连锁', exact: true }).check(); await dialog.getByLabel('单块最多合并次数', { exact: true }).fill('3');
  await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0); await left(page, 1); await expect(page.getByTestId('score')).toHaveText('28'); await expect(page.getByTestId('cell').nth(0)).toHaveAttribute('data-value', '16');
  dialog = await setup(page, 1, 5, '0:1, 1:1, 2:2, 3:3'); await dialog.getByRole('checkbox', { name: '启用升级', exact: true }).check(); await advanced(dialog); await dialog.getByRole('combobox', { name: '合并方式', exact: true }).selectOption('sequence-next');
  await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0); await left(page, 1); await expect(page.getByTestId('score')).toHaveText('7');
  await page.getByRole('button', { name: '选择升级技能', exact: true }).click(); await page.getByTestId('board').getByTestId('cell').nth(1).click(); await page.getByRole('button', { name: '施放升级', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('2'); await expect(page.getByTestId('cell').nth(1)).toHaveAttribute('data-value', '8');
});

test('recursive events exhaust their budget without saving partial board, RNG or counters', async ({ page }) => {
  await page.goto('/'); const dialog = await setup(page); await advanced(dialog); await dialog.getByRole('button', { name: '添加事件规则', exact: true }).click();
  await dialog.getByLabel('事件1最多执行次数', { exact: true }).fill(''); await dialog.getByRole('checkbox', { name: '允许同一步重复触发', exact: true }).check(); await dialog.getByRole('combobox', { name: '事件1动作1类型', exact: true }).selectOption('emit');
  await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0); const before = await snapshot(page);
  await page.getByRole('button', { name: '向左移动', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('预算'); expect(await snapshot(page)).toEqual(before); await expect(page.getByTestId('action-count')).toHaveText('0');
  const fix = await rules(page); await advanced(fix); await fix.getByLabel('事件1最多执行次数', { exact: true }).fill('1'); await publish(fix); await left(page, 2); expect(head(await snapshot(page)).state.world.events.counters).toEqual({ [Object.keys(head(before).state.world.events.counters)[0]!]: 1 });
});

test('browser quota failure atomically retries the same rule version, preserving old rule and node', async ({ page }) => {
  await page.goto('/'); await create(page); const before = await snapshot(page);
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; const scope = window as unknown as { failM4: boolean; restoreM4: () => void }; scope.failM4 = true; IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) { if (this.name === 'projects' && scope.failM4) throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); }; scope.restoreM4 = () => { IDBObjectStore.prototype.put = put; }; });
  const dialog = await rules(page); await dialog.getByLabel('棋盘列数', { exact: true }).fill('5'); await dialog.getByRole('button', { name: '发布规则新版本', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('保存未确认'); expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('空间不足'); await page.evaluate(() => { (window as unknown as { failM4: boolean }).failM4 = false; });
  await page.getByRole('button', { name: '重试本次保存', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1'); const saved = await snapshot(page); expect(saved.rules).toHaveLength(2); expect(saved.nodes).toHaveLength(2); expect(head(saved).state.ruleRef.version).toBe(2); await page.evaluate(() => { (window as unknown as { restoreM4: () => void }).restoreM4(); });
});

test('mobile board editor and advanced version preview remain within the viewport', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await page.goto('/'); await create(page); const dialog = await editor(page); await dialog.getByLabel('画笔数字', { exact: true }).fill('0'); await dialog.getByTestId('cell').nth(7).click();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath('m4-board-editor-mobile.png') });
    await dialog.getByRole('button', { name: '提交棋盘编辑', exact: true }).click(); await expect(dialog).toHaveCount(0); const change = await rules(page); await change.getByLabel('棋盘列数', { exact: true }).fill('5'); await advanced(change); await change.getByRole('button', { name: '添加事件规则', exact: true }).click();
    expect(await change.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await change.getByTestId('migration-preview').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('m4-version-preview-mobile.png') }); await publish(change);
    await expect(page.getByTestId('cell')).toHaveCount(10); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('mixed-version library backup restores the entire historical rule graph in a clean browser', async ({ page, browser }, testInfo) => {
  await start(page); const classic = head(await snapshot(page)); const draft = await editor(page); await draft.getByRole('button', { name: '清空棋盘草稿', exact: true }).click(); await draft.getByTestId('cell').nth(0).click(); await draft.getByTestId('cell').nth(1).click(); await draft.getByRole('button', { name: '提交棋盘编辑', exact: true }).click(); await expect(draft).toHaveCount(0);
  const dialog = await rules(page); await dialog.getByLabel('棋盘列数', { exact: true }).fill('5'); await publish(dialog); await left(page, 3); const source = await snapshot(page), original = head(source);
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click(); const file = testInfo.outputPath('m4-mixed-versions-demo.2048backup'); await (await wait).saveAs(file);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  try {
    const restored = await context.newPage(); await restored.goto('/'); await restored.getByRole('button', { name: '文件与恢复', exact: true }).click(); const modal = restored.getByRole('dialog', { name: '文件与备份' }); await modal.getByLabel('选择存档文件').setInputFiles(file); await expect(modal.getByTestId('import-preview')).toBeVisible(); await modal.getByRole('button', { name: '导入副本', exact: true }).click(); await expect(modal.getByText('已完成导入', { exact: true })).toBeVisible(); await modal.getByRole('button', { name: '开始查看', exact: true }).click();
    const copied = await snapshot(restored); expect(copied.rules).toEqual(source.rules); expect(copied.states).toEqual(source.states); expect(head(copied).state).toEqual(original.state); expect(copied.nodes).toHaveLength(4);
    await restored.locator(`.history-item[data-node-id="${classic.node.id}"]`).click(); await expect(restored.getByTestId('cell')).toHaveCount(16); await expect(restored.locator('.mode-pill')).toContainText('CLASSIC');
  } finally { await context.close(); }
});
