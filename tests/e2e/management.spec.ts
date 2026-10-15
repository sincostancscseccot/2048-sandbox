import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { defaultExperience, experienceKey } from '../../src/presentation/preferences';
import { availableDirection, snapshot } from './helpers';

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000 });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: experienceKey, value: { ...defaultExperience, sound: false } });
  await page.goto('/');
});

async function custom(page: Page, rows: number, cols: number, layout: string) {
  await page.getByRole('button', { name: '自定义新局', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建自定义对局' });
  await dialog.getByLabel('棋盘行数', { exact: true }).fill(String(rows));
  await dialog.getByLabel('棋盘列数', { exact: true }).fill(String(cols));
  await dialog.getByLabel('开局数量', { exact: true }).fill('0');
  await dialog.getByLabel('每次生成数量', { exact: true }).fill('0');
  await dialog.getByLabel('初始布局（格索引:数字）', { exact: true }).fill(layout);
  await dialog.getByLabel('无路可走时判负', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
}

async function alignment(board: Locator) {
  return board.evaluate(element => {
    const cols = Number(element.getAttribute('aria-label')!.match(/(\d+) 列/)![1]);
    const cells = [...element.querySelectorAll('[data-testid="cell"]')];
    return [...element.querySelectorAll<HTMLElement>('.tile-layer .tile-visual')].map(tile => {
      const index = (Number(tile.style.gridRow) - 1) * cols + Number(tile.style.gridColumn) - 1;
      const a = tile.getBoundingClientRect(), b = cells[index]!.getBoundingClientRect();
      return { index, delta: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) };
    });
  });
}

test('sparse and rectangular boards keep every tile aligned with its background at desktop and mobile widths', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  for (const [rows, cols, layout] of [
    [3, 4, '0:3, 1:1, 2:1, 4:13, 5:5, 6:1, 8:3, 9:1, 10:5, 11:34'],
    [4, 4, '0:3, 1:1, 2:1, 4:13, 5:5, 6:1, 8:3, 9:1, 10:5, 11:34'],
    [4, 4, '0:2, 2:8, 8:4, 10:16'],
    [1, 4, '0:2, 3:4'],
    [4, 1, '0:2, 2:4'],
    [9, 9, '0:2, 8:4, 72:8, 80:16'],
  ] as const) {
    await custom(page, rows, cols, layout);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect.poll(async () => Math.max(...(await alignment(page.getByTestId('board'))).map(item => item.delta)),
        { message: `${rows}×${cols} at ${width}px` }).toBeLessThan(1);
      if (rows === 4 && layout.startsWith('0:3') && width === 390) await page.getByTestId('board').screenshot({ path: testInfo.outputPath('aligned-board-mobile.png') });
      if (rows === 4 && layout.startsWith('0:3') && width === 1440) await page.screenshot({ path: testInfo.outputPath('aligned-game-desktop.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '向右移动', exact: true }).click();
    await expect(page.getByTestId('action-count')).toHaveText(cols === 1 ? '0' : '1');
    await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
    await expect(page.getByTestId('board')).toHaveAttribute('data-animation-phase', 'idle');
    expect(Math.max(...(await alignment(page.getByTestId('board'))).map(item => item.delta))).toBeLessThan(1);
  }
});

test('returning home preserves the saved head and history; reopening resumes it, and the home classic entry uses classic rules', async ({ page }, testInfo) => {
  await custom(page, 2, 4, '0:2, 1:2, 6:8');
  await page.getByRole('button', { name: '向左移动', exact: true }).click();
  await expect(page.getByTestId('action-count')).toHaveText('1');
  await page.getByRole('button', { name: '保存检查点' }).click();
  await expect(page.getByRole('button', { name: '检查点已保存' })).toBeVisible();
  const before = await snapshot(page), project = before.projects[0]!, root = before.nodes.find(node => node.parentId === null)!;
  await page.locator(`.history-item[data-node-id="${root.id}"]`).click();
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await expect(page.getByTestId('board')).toHaveCount(0); await expect(page.getByRole('button', { name: '开始经典对局' })).toBeVisible();
  await page.keyboard.press('ArrowRight'); expect(await snapshot(page)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('home-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: /继续已保存的对局/ }).click();
  await page.locator(`.library-record[data-project-id="${project.id}"] .library-open`).click();
  await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', project.project.activeNodeId);
  await expect(page.getByTestId('action-count')).toHaveText('1'); expect(await snapshot(page)).toEqual(before);
  await page.getByRole('link', { name: '2048 Sandbox 首页', exact: true }).click();
  await expect(page.getByTestId('board')).toHaveCount(0); expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: '开始经典对局' }).click();
  await expect(page.getByTestId('board')).toHaveAttribute('aria-label', '2048 棋盘，4 行 4 列');
  await expect(page.locator('.mode-pill')).toContainText('CLASSIC');
  const after = await snapshot(page); expect(after.projects).toHaveLength(2);
  expect(after.projects.find(record => record.id === project.id)).toEqual(project);
  expect(after.nodes.filter(node => node.matchId === project.id)).toEqual(before.nodes);
});

test('deletion identifies the match, can cancel, removes old branches from backup and preserves the currently open match', async ({ page }, testInfo) => {
  await custom(page, 2, 4, '0:2, 1:2, 6:8');
  await page.getByRole('button', { name: '向左移动', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1');
  await page.getByRole('button', { name: '保存检查点' }).click(); await expect(page.getByRole('button', { name: '检查点已保存' })).toBeVisible();
  const old = (await snapshot(page)).projects[0]!;
  await page.getByRole('button', { name: '返回首页', exact: true }).click(); await page.getByRole('button', { name: '开始经典对局' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存'); const before = await snapshot(page), current = before.projects.find(record => record.id !== old.id)!;
  await page.getByRole('button', { name: /我的对局/ }).click();
  const remove = page.locator(`.library-record[data-project-id="${old.id}"] .library-delete`);
  await remove.click(); let dialog = page.getByRole('dialog', { name: '删除对局', exact: true });
  await expect(dialog).toContainText(old.project.name); await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(await snapshot(page)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('library-desktop.png'), fullPage: true });
  await remove.click(); dialog = page.getByRole('dialog', { name: '删除对局', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.library-record')).toHaveCount(1); await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', current.project.activeNodeId);
  const after = await snapshot(page); expect(after.projects).toEqual([current]); expect(after.checkpoints).toEqual([]);
  expect(after.nodes).toEqual(before.nodes.filter(node => node.matchId === current.id));
  expect(after.states).toEqual(before.states.filter(state => after.nodes.some(node => node.stateHash === state.hash)));
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click(); const download = await wait;
  expect(download.suggestedFilename()).toMatch(/\.2048backup$/); const path = testInfo.outputPath('after-deletion.2048backup'); await download.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path))), manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  expect(manifest.projects.map((project: { sourceProjectId: string }) => project.sourceProjectId)).toEqual([current.id]);
  await page.reload(); await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', current.project.activeNodeId);
  expect(await snapshot(page)).toEqual(after);
});

test('mobile can delete the current and final match offline, returns home and stays empty after reopening', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await custom(page, 4, 4, '0:2, 1:2, 10:8');
  const before = await snapshot(page), project = before.projects[0]!;
  await expect(page.getByText('离线资源已就绪', { exact: true })).toBeVisible(); await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
  await page.getByRole('button', { name: /我的对局/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('library-mobile.png'), fullPage: true });
  await page.locator(`.library-record[data-project-id="${project.id}"] .library-delete`).click(); const dialog = page.getByRole('dialog', { name: '删除对局', exact: true });
  expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('delete-dialog-mobile.png') });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('board')).toHaveCount(0); await expect(page.getByText('还没有已保存的对局。', { exact: true })).toBeVisible();
  const empty = { projects: [], nodes: [], states: [], rules: before.rules, checkpoints: [], settings: [] }; expect(await snapshot(page)).toEqual(empty);
  await page.reload(); await expect(page.getByRole('button', { name: '开始经典对局' })).toBeVisible(); expect(await snapshot(page)).toEqual(empty);
  await page.getByRole('button', { name: '开始经典对局' }).click(); await expect(page.getByTestId('save-status')).toHaveText('已自动保存'); expect((await snapshot(page)).projects).toHaveLength(1);
});

test('a changed match must be reconfirmed before deletion and a stale tab cannot save it back', async ({ page, context }) => {
  await custom(page, 1, 4, '0:2, 1:2'); const project = (await snapshot(page)).projects[0]!;
  await page.getByRole('button', { name: /我的对局/ }).click(); await page.locator(`.library-record[data-project-id="${project.id}"] .library-delete`).click();
  const dialog = page.getByRole('dialog', { name: '删除对局', exact: true }), second = await context.newPage(); await second.goto('/');
  await second.getByRole('button', { name: '向左移动', exact: true }).click(); await expect(second.getByTestId('action-count')).toHaveText('1'); const updated = await snapshot(second);
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('此对局已在另一页面更新');
  expect(await snapshot(page)).toEqual(updated); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator(`.library-record[data-project-id="${project.id}"] .library-delete`).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog).toHaveCount(0); expect((await snapshot(page)).projects).toHaveLength(0);
  await second.getByRole('button', { name: '向右移动', exact: true }).click(); await expect(second.getByTestId('save-status')).toHaveText('保存未确认');
  expect((await snapshot(second)).projects).toHaveLength(0); expect((await snapshot(second)).nodes).toHaveLength(0);
  await second.getByRole('button', { name: '重新读取已保存', exact: true }).click();
  await expect(second.getByRole('button', { name: '开始经典对局' })).toBeVisible(); await expect(second.getByTestId('board')).toHaveCount(0);
  await expect(second.getByRole('alert')).toHaveCount(0); expect((await snapshot(second)).projects).toHaveLength(0);
});

test('a storage failure rolls deletion back, keeps the named dialog open and allows the same confirmation to retry', async ({ page }) => {
  await custom(page, 2, 4, '0:2, 1:2, 6:8');
  await page.getByRole('button', { name: '保存检查点' }).click(); await expect(page.getByRole('button', { name: '检查点已保存' })).toBeVisible(); const before = await snapshot(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete; let fail = true;
    IDBObjectStore.prototype.delete = function (key) {
      if (this.name === 'settings' && key === 'lastProjectId' && fail) { fail = false; throw new DOMException('Injected deletion failure', 'UnknownError'); }
      return original.call(this, key);
    };
  });
  await page.getByRole('button', { name: /我的对局/ }).click(); await page.locator('.library-delete').click();
  const dialog = page.getByRole('dialog', { name: '删除对局', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Injected deletion failure');
  expect(await snapshot(page)).toEqual(before); await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', before.projects[0]!.project.activeNodeId);
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog).toHaveCount(0); expect((await snapshot(page)).projects).toHaveLength(0);
});

test('unconfirmed game saves disable returning home and deletion until the original save is resolved', async ({ page }) => {
  await page.getByRole('button', { name: '开始经典对局' }).click(); await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
  const before = await snapshot(page), direction = await availableDirection(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add; let fail = true;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'historyNodes' && fail) { fail = false; throw new DOMException('Injected quota', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
  });
  await page.getByRole('button', { name: direction.label, exact: true }).click(); await expect(page.getByTestId('save-status')).toHaveText('保存未确认');
  await expect(page.getByRole('button', { name: '返回首页', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: '2048 Sandbox 首页', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('link', { name: '2048 Sandbox 首页', exact: true }).dispatchEvent('click');
  await expect(page.getByTestId('board')).toHaveCount(1); expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: /我的对局/ }).click(); await expect(page.locator('.library-delete')).toBeDisabled();
  await page.getByRole('button', { name: '重试本次保存', exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1');
  await page.getByRole('button', { name: '返回首页', exact: true }).click(); await expect(page.getByTestId('board')).toHaveCount(0);
  expect((await snapshot(page)).nodes).toHaveLength(before.nodes.length + 1);
});
