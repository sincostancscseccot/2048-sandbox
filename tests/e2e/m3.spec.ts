import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { snapshot, start } from './helpers';
import type { LibrarySnapshot } from '../../src/domain/types';

test.use({ viewport: { width: 1440, height: 1000 } });
async function setup(page: Page, rows = 2, cols = 4, allSkills = false) {
  await page.getByRole('button', { name: '自定义新局', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建自定义对局' });
  await dialog.getByLabel('对局名称', { exact: true }).fill('技能实验');
  await dialog.getByLabel('棋盘行数', { exact: true }).fill(String(rows)); await dialog.getByLabel('棋盘列数', { exact: true }).fill(String(cols));
  await dialog.getByLabel('开局数量', { exact: true }).fill('0'); await dialog.getByLabel('每次生成数量', { exact: true }).fill('0');
  await dialog.getByRole('textbox', { name: '初始布局（格索引:数字）', exact: true }).fill('0:2, 1:2, 2:4');
  await dialog.getByLabel('无路可走时判负', { exact: true }).uncheck();
  if (allSkills) for (const name of ['删除', '交换', '升级', '降级', '洗牌', '放置', '清空行列', '旋转']) await dialog.getByRole('checkbox', { name: `启用${name}`, exact: true }).check();
  return dialog;
}
async function create(page: Page, rows = 2, cols = 4, allSkills = false) {
  const dialog = await setup(page, rows, cols, allSkills); await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByTestId('action-count')).toHaveText('0');
}
async function left(page: Page, count: number) {
  await page.getByRole('button', { name: '向左移动', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText(String(count));
}
async function gridSkill(page: Page, name: string, indices: number[], count: number) {
  await page.getByRole('button', { name: `选择${name}技能`, exact: true }).click();
  for (const index of indices) await page.getByTestId('board').getByTestId('cell').nth(index).click();
  await page.getByRole('button', { name: `施放${name}`, exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText(String(count));
}
async function openImport(page: Page) {
  await page.getByRole('button', { name: '文件与恢复', exact: true }).click(); return page.getByRole('dialog', { name: '文件与备份' });
}
async function importFile(page: Page, file: string) {
  const dialog = await openImport(page); await dialog.getByLabel('选择存档文件').setInputFiles(file);
  await expect(dialog.getByTestId('import-preview')).toBeVisible(); await dialog.getByRole('button', { name: '导入副本', exact: true }).click();
  await expect(dialog.getByText('已完成导入', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: '开始查看', exact: true }).click();
}
function head(saved: LibrarySnapshot) {
  const id = saved.settings.find(item => item.key === 'lastProjectId')!.value, project = saved.projects.find(item => item.id === id)!;
  const node = saved.nodes.find(item => item.matchId === id && item.id === project.project.activeNodeId)!;
  return { project, node, state: saved.states.find(item => item.hash === node.stateHash)!.state };
}

test('invalid/cancelled configuration never changes saved games and error links focus fields', async ({ page }, testInfo) => {
  await start(page); const before = await snapshot(page), dialog = await setup(page);
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('m3-setup-desktop.png') });
  await dialog.getByLabel('棋盘行数', { exact: true }).fill('0');
  await expect(dialog.getByRole('alert')).toContainText('请修正'); await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('link', { name: '棋盘行数', exact: true }).click(); await expect(dialog.getByLabel('棋盘行数', { exact: true })).toBeFocused();
  await dialog.getByLabel('棋盘行数', { exact: true }).fill('2'); await dialog.getByLabel('开局数量', { exact: true }).fill('2');
  await dialog.getByRole('textbox', { name: '初始布局（格索引:数字）', exact: true }).fill(''); await dialog.getByLabel('开局数字权重', { exact: true }).fill('2:0, 4:0');
  await expect(dialog.getByRole('alert')).toContainText('权重总和'); expect(await snapshot(page)).toEqual(before);
  await dialog.getByLabel('开局数字权重', { exact: true }).fill('2:9, 4:1');
  await dialog.getByLabel('回合上限（留空不限）', { exact: true }).fill('0');
  await dialog.getByRole('link', { name: '回合上限', exact: true }).first().click(); await expect(dialog.getByLabel('回合上限（留空不限）', { exact: true })).toBeFocused();
  await dialog.getByLabel('回合上限（留空不限）', { exact: true }).fill('');
  const undoConfig = dialog.locator('.skill-config').filter({ has: page.getByRole('checkbox', { name: '启用撤销', exact: true }) }); await undoConfig.locator('summary').click();
  await dialog.getByLabel('撤销恢复间隔（留空关闭）', { exact: true }).fill('0'); await dialog.getByRole('link', { name: '撤销 · 恢复间隔', exact: true }).first().click();
  await expect(dialog.getByLabel('撤销恢复间隔（留空关闭）', { exact: true })).toBeFocused(); expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click(); expect(await snapshot(page)).toEqual(before);
});

test('all nine skills use real grid targets; consecutive undo preserves path and current resources', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await create(page, 2, 4, true); await expect(page.getByTestId('cell')).toHaveCount(8);
  await page.screenshot({ path: testInfo.outputPath('m3-game-desktop.png'), fullPage: true });
  await left(page, 1); await expect(page.getByTestId('score')).toHaveText('4'); await left(page, 2); await expect(page.getByTestId('score')).toHaveText('12');
  const beforeUndo = await snapshot(page), original = head(beforeUndo);
  await page.getByRole('button', { name: '撤销一步', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('3'); await expect(page.getByTestId('score')).toHaveText('4');
  await page.getByRole('button', { name: '撤销一步', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('4'); await expect(page.getByTestId('score')).toHaveText('0');
  const undone = head(await snapshot(page)); expect(undone.state.world.roundCount).toBe(0); expect(undone.state.ledger.chargedTurnCount).toBe(2); expect(undone.state.ledger.skills.undo.charges).toBe(1);
  expect((await snapshot(page)).nodes.find(node => node.id === original.node.id)).toEqual(original.node);
  const beforeIllegal = await snapshot(page); await page.getByRole('button', { name: '选择删除技能', exact: true }).click();
  await page.getByTestId('board').getByTestId('cell').nth(3).click(); await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: '施放删除', exact: true }).click(); await expect(page.locator('.action-message')).toHaveText('请选择一个非空格'); expect(await snapshot(page)).toEqual(beforeIllegal);
  await page.getByRole('button', { name: '取消选取', exact: true }).click();
  await gridSkill(page, '升级', [2], 5); await expect(page.getByTestId('cell').nth(2)).toHaveAttribute('data-value', '8');
  await gridSkill(page, '降级', [2], 6); await gridSkill(page, '交换', [0, 3], 7); await gridSkill(page, '删除', [3], 8);
  await page.getByRole('button', { name: '选择放置技能', exact: true }).click(); await page.getByLabel('放置数字', { exact: true }).fill('0');
  await page.getByTestId('board').getByTestId('cell').nth(0).click(); await page.getByRole('button', { name: '施放放置', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('9'); await expect(page.getByTestId('cell').nth(0)).toHaveAttribute('data-value', '0');
  await page.getByRole('button', { name: '选择清空行列技能', exact: true }).click(); await page.getByRole('combobox', { name: '轴', exact: true }).selectOption('column'); await page.getByLabel('序号', { exact: true }).fill('2');
  await page.getByRole('button', { name: '施放清空行列', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('10');
  await gridSkill(page, '旋转', [], 11); await gridSkill(page, '洗牌', [], 12);
  const saved = await snapshot(page), active = head(saved); expect(saved.nodes).toHaveLength(13); expect(active.state.ledger.chargedTurnCount).toBe(10);
  for (const id of ['delete', 'swap', 'upgrade', 'downgrade', 'shuffle', 'spawn', 'clear-line', 'rotate'] as const) expect(active.state.ledger.skills[id]).toMatchObject({ charges: 2, usedCount: 1 });
  await page.reload(); await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', active.node.id); expect(await snapshot(page)).toEqual(saved);
  await page.getByRole('button', { name: '打开完整历史树' }).click(); const tree = page.getByRole('dialog', { name: '历史树与回放' });
  await expect(tree.getByTestId('history-tree').locator('[data-tree-node]')).not.toHaveCount(0);
  await expect(tree.getByText('0 / 8 格', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('m3-skills-tree-desktop.png') }); expect(errors).toEqual([]);
});

test('mixed classic/custom backup recovers in an empty browser and custom creation works offline', async ({ page, browser }, testInfo) => {
  await start(page); await create(page, 3, 5, true); await left(page, 1);
  await gridSkill(page, '洗牌', [], 2); await page.getByRole('button', { name: '撤销一步', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('3');
  await expect(page.getByText('离线资源已就绪', { exact: true })).toBeVisible(); const source = await snapshot(page), original = head(source);
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const file = testInfo.outputPath('m3-mixed-demo.2048backup'); await (await wait).saveAs(file);
  const files = unzipSync(await readFile(file)), manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); expect(manifest.requiredCapabilities).toEqual(expect.arrayContaining(['sandbox-v1', 'skills-v1']));
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1000 } });
  try {
    const restored = await context.newPage(); await restored.goto('/'); await importFile(restored, file);
    const copied = await snapshot(restored), active = head(copied); expect(copied.projects).toHaveLength(2); expect(copied.nodes).toHaveLength(source.nodes.length);
    expect(active.node.stateHash).toBe(original.node.stateHash); expect(active.state).toEqual(original.state); expect(copied.rules).toEqual(source.rules);
    await expect(restored.getByText('离线资源已就绪', { exact: true })).toBeVisible(); await restored.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true); await restored.reload(); await expect(restored.getByTestId('board')).toHaveAttribute('data-node-id', active.node.id);
    await restored.getByRole('button', { name: '自定义新局', exact: true }).click(); const dialog = restored.getByRole('dialog', { name: '新建自定义对局' });
    await dialog.getByRole('button', { name: '复制当前规则', exact: true }).click(); await expect(dialog.getByLabel('棋盘行数', { exact: true })).toHaveValue('3'); await expect(dialog.getByLabel('棋盘列数', { exact: true })).toHaveValue('5');
    await dialog.getByLabel('对局名称', { exact: true }).fill('离线沙盒'); await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await left(restored, 1); expect((await snapshot(restored)).projects).toHaveLength(3); expect(await snapshot(page)).toEqual(source);
  } finally { await context.close(); }
});

test('real browser quota rollback retries the same undo with one resource charge', async ({ page }) => {
  await page.goto('/'); await create(page); await left(page, 1); await left(page, 2); const before = await snapshot(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put, add = IDBObjectStore.prototype.add;
    const scope = window as unknown as { failUndo: boolean; undoIds: string[]; restore: () => void };
    scope.failUndo = true; scope.undoIds = [];
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) { if (this.name === 'projects' && scope.failUndo) throw new DOMException('quota', 'QuotaExceededError'); return put.apply(this, args); };
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) { if (this.name === 'historyNodes') scope.undoIds.push(args[0].id); return add.apply(this, args); };
    scope.restore = () => { IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.add = add; };
  });
  await page.getByRole('button', { name: '撤销一步', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('空间不足'); expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: '重试本次保存', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('空间不足'); expect(await snapshot(page)).toEqual(before);
  await page.evaluate(() => { (window as unknown as { failUndo: boolean }).failUndo = false; });
  await page.getByRole('button', { name: '重试本次保存', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('3'); await expect(page.getByTestId('score')).toHaveText('4');
  const ids = await page.evaluate(() => (window as unknown as { undoIds: string[] }).undoIds); expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(1);
  expect(head(await snapshot(page)).state.ledger.skills.undo).toMatchObject({ charges: 2, usedCount: 1 });
  await page.evaluate(() => { (window as unknown as { restore: () => void }).restore(); });
});

test('mobile configuration and wide-board skill targeting stay within the viewport', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await page.goto('/'); const dialog = await setup(page, 3, 10, true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).scrollIntoViewIfNeeded();
    const submitBox = (await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).boundingBox())!, modalBox = (await dialog.boundingBox())!;
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(modalBox.y + modalBox.height);
    await dialog.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('m3-setup-mobile.png') });
    await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.getByTestId('cell')).toHaveCount(30);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByTestId('board').scrollIntoViewIfNeeded();
    const boardBox = (await page.locator('.board-scroll').boundingBox())!, cdp = await context.newCDPSession(page);
    const x = boardBox.x + boardBox.width - 35, y = boardBox.y + boardBox.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 100, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('.board-scroll').evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expect(page.getByTestId('action-count')).toHaveText('0');
    await page.getByRole('button', { name: '选择删除技能', exact: true }).click(); await page.getByTestId('board').getByTestId('cell').nth(2).click();
    await page.screenshot({ path: testInfo.outputPath('m3-target-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '施放删除', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1');
    expect(head(await snapshot(page)).state.world.board.cells[2]!.tile).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('custom rule JSON exchange previews a new match and rejects unsupported or corrupt rules without writing', async ({ page }, testInfo) => {
  await page.goto('/'); await create(page); const source = await snapshot(page);
  const dialog = await openImport(page); await dialog.getByRole('tab', { name: '导出文件', exact: true }).click();
  await dialog.getByRole('combobox', { name: '导出范围', exact: true }).selectOption('rules'); const wait = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载导出文件', exact: true }).click(); const file = testInfo.outputPath('m3-rules.json'); await (await wait).saveAs(file);
  const rule = JSON.parse(await readFile(file, 'utf8')); expect(rule).toEqual(source.rules[0]);
  await dialog.getByRole('tab', { name: '导入与恢复', exact: true }).click(); const input = dialog.getByLabel('选择存档文件');
  await input.setInputFiles(file); await expect(dialog.getByTestId('import-preview')).toBeVisible(); expect(await snapshot(page)).toEqual(source);
  const bad = structuredClone(rule); bad.definitionHash = `sha256:${'0'.repeat(64)}`;
  await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) }); await expect(dialog.getByRole('alert')).toContainText('摘要'); expect(await snapshot(page)).toEqual(source);
  const advanced = structuredClone(rule); advanced.requiredCapabilities.push('scripts-v99');
  await input.setInputFiles({ name: 'advanced.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(advanced)) }); await expect(dialog.getByRole('alert')).toContainText('scripts-v99'); expect(await snapshot(page)).toEqual(source);
  await input.setInputFiles(file); await expect(dialog.getByTestId('import-preview')).toBeVisible(); await dialog.getByRole('button', { name: '使用规则新建', exact: true }).click();
  await expect(dialog.getByText('已完成导入', { exact: true })).toBeVisible(); expect((await snapshot(page)).projects).toHaveLength(2);
});

test('new match reuses current custom rules and classic shortcut preserves every earlier game', async ({ page }) => {
  await page.goto('/'); await create(page, 3, 5); const before = await snapshot(page), original = head(before);
  await page.getByRole('button', { name: '＋ 新开一局', exact: true }).click();
  await expect(page.getByTestId('board')).not.toHaveAttribute('data-node-id', original.node.id);
  const restarted = await snapshot(page); expect(restarted.projects).toHaveLength(2); expect(head(restarted).state.world.board).toMatchObject({ rows: 3, cols: 5 });
  expect(head(restarted).state.ruleRef).toEqual(original.state.ruleRef); expect(restarted.projects.find(item => item.id === original.project.id)).toEqual(original.project);
  await page.getByRole('button', { name: '自定义新局', exact: true }).click(); await page.getByRole('button', { name: '直接开始经典对局', exact: false }).click();
  await expect(page.getByTestId('cell')).toHaveCount(16); const classic = await snapshot(page);
  expect(classic.projects).toHaveLength(3); expect(head(classic).state.ruleRef).toEqual({ id: 'rules-classic', version: 1 });
  expect(classic.projects.find(item => item.id === original.project.id)).toEqual(original.project);
});

test('configured undo cost, cooldown, recharge and round limit settle through the UI and persist', async ({ page }) => {
  await page.goto('/'); const dialog = await setup(page);
  const undoConfig = dialog.locator('.skill-config').filter({ has: page.getByRole('checkbox', { name: '启用撤销', exact: true }) });
  await undoConfig.locator('summary').click();
  await dialog.getByLabel('撤销初始次数', { exact: true }).fill('2'); await dialog.getByLabel('撤销冷却回合', { exact: true }).fill('1');
  await dialog.getByLabel('撤销恢复间隔（留空关闭）', { exact: true }).fill('2'); await dialog.getByLabel('撤销成绩成本', { exact: true }).fill('4');
  await dialog.getByLabel('回合上限（留空不限）', { exact: true }).fill('2'); await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await left(page, 1); await left(page, 2); let saved = await snapshot(page);
  expect(head(saved).state.world.outcome).toMatchObject({ status: 'lost', reason: 'round-limit', canContinue: true });
  expect(head(saved).state.ledger.skills.undo.charges).toBe(3); await page.getByRole('button', { name: '撤销一步', exact: true }).click();
  await expect(page.getByTestId('action-count')).toHaveText('3'); await expect(page.getByTestId('score')).toHaveText('0');
  saved = await snapshot(page); const current = head(saved);
  expect(current.state.world.roundCount).toBe(1); expect(current.state.ledger.chargedTurnCount).toBe(2);
  expect(current.state.ledger.skills.undo).toMatchObject({ charges: 2, cooldownRemaining: 1, usedCount: 1, rechargeProgress: 0 });
  await expect(page.getByRole('button', { name: '撤销一步', exact: true })).toBeDisabled(); await page.reload();
  await expect(page.getByTestId('action-count')).toHaveText('3'); expect(await snapshot(page)).toEqual(saved);
  await left(page, 4); expect(head(await snapshot(page)).state.ledger.skills.undo).toMatchObject({ cooldownRemaining: 0, rechargeProgress: 1 });
  await expect(page.getByRole('button', { name: '撤销一步', exact: true })).toBeDisabled(); // restored score 0 cannot pay 4.
});
