import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import type { LibrarySnapshot } from '../../src/domain/types';
import { snapshot, start, validMove } from './helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

async function openImport(page: Page) { await page.getByRole('button', { name: '文件与恢复', exact: true }).click(); return page.getByRole('dialog', { name: '文件与备份' }); }
async function finishImport(page: Page) {
  const dialog = page.getByRole('dialog', { name: '文件与备份' });
  await dialog.getByRole('button', { name: '导入副本', exact: true }).click();
  await expect(dialog.getByText('已完成导入', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '开始查看', exact: true }).click();
}
async function downloadBackup(page: Page, file: string) {
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await wait; expect(download.suggestedFilename()).toMatch(/\.2048backup$/); await download.saveAs(file);
}

test('tree shows both branches; pan/zoom/collapse, read-only replay, archive restore and path export work', async ({ page }, testInfo) => {
  await start(page); for (let i = 0; i < 6; i++) await validMove(page);
  let saved = await snapshot(page);
  const root = saved.nodes.find(node => !node.parentId)!, originalHead = saved.projects[0]!.project.activeNodeId;
  const originalFirst = saved.nodes.find(node => node.parentId === root.id)!;
  await page.locator(`.history-item[data-node-id="${root.id}"]`).click(); await page.getByRole('button', { name: '从此继续', exact: true }).click();
  await page.getByRole('combobox', { name: '继续时的随机结果' }).selectOption('reproduce');
  if (originalFirst.action?.type !== 'move') throw new Error('Expected a move node');
  const label = { up:'向上移动', right:'向右移动', down:'向下移动', left:'向左移动' }[originalFirst.action!.payload.direction];
  await page.getByRole('button', { name: label, exact: true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1');
  saved = await snapshot(page); const activeId = saved.projects[0]!.project.activeNodeId;
  await page.getByRole('button', { name: '打开完整历史树' }).click();
  const dialog = page.getByRole('dialog', { name: '历史树与回放' }), canvas = dialog.getByTestId('history-tree');
  await expect(canvas.locator('[data-tree-node]')).toHaveCount(8);
  await canvas.locator(`[data-tree-node="${root.id}"]`).click(); await expect(dialog.getByTestId('tree-score')).toHaveText('0');
  await dialog.getByRole('button', { name: '折叠后续分支', exact: true }).click(); await expect(canvas.locator('[data-tree-node]')).toHaveCount(1);
  await dialog.getByRole('button', { name: '展开后续分支', exact: true }).click(); await expect(canvas.locator('[data-tree-node]')).toHaveCount(8);
  const initialView = await canvas.getAttribute('viewBox'); await dialog.getByRole('button', { name: '放大历史树' }).click();
  await expect(canvas).not.toHaveAttribute('viewBox', initialView!);
  const zoomed = await canvas.getAttribute('viewBox'), bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + bounds.height - 35); await page.mouse.down(); await page.mouse.move(bounds.x + 90, bounds.y + bounds.height - 55); await page.mouse.up();
  await expect(canvas).not.toHaveAttribute('viewBox', zoomed!); await dialog.getByRole('button', { name: '适应全树', exact: true }).click();
  await canvas.locator(`[data-tree-node="${originalHead}"]`).click();
  await dialog.getByRole('combobox', { name: '速度', exact: true }).selectOption('250');
  await dialog.getByRole('button', { name: '播放路径', exact: true }).click();
  await expect(dialog.getByTestId('replay-position')).toContainText('1 / 7'); await expect(dialog.getByTestId('replay-position')).toContainText('7 / 7');
  expect((await snapshot(page)).projects[0]!.project.activeNodeId).toBe(activeId);
  expect((await snapshot(page)).nodes).toEqual(saved.nodes);
  await dialog.getByRole('button', { name: '归档此分支', exact: true }).click(); await expect(dialog.getByRole('button', { name: '恢复此归档分支' })).toBeVisible();
  await dialog.getByRole('checkbox', { name: '显示归档' }).uncheck(); await expect(canvas.locator(`[data-tree-node="${originalHead}"]`)).toHaveCount(0);
  await dialog.getByRole('button', { name: '恢复此归档分支' }).click(); await expect(canvas.locator(`[data-tree-node="${originalHead}"]`)).toBeVisible();
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('m2-tree-desktop.png') });
  await dialog.getByRole('button', { name: '导出此路径', exact: true }).click();
  const files = page.getByRole('dialog', { name: '文件与备份' }); const wait = page.waitForEvent('download');
  await files.getByRole('button', { name: '下载导出文件' }).click(); const download = await wait;
  const path = testInfo.outputPath('path.2048lab'); await download.saveAs(path);
  const archive = unzipSync(new Uint8Array(await readFile(path))), manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json']));
  expect(manifest.exportKind).toBe('branch'); expect(manifest.nodeCount).toBe(7); expect((await snapshot(page)).nodes).toHaveLength(8);
});

test('complete library restores into an empty browser, duplicates safely, and works offline', async ({ page, browser }, testInfo) => {
  await start(page); for (let i = 0; i < 4; i++) await validMove(page);
  await page.getByRole('button', { name: '保存检查点' }).click(); await expect(page.getByRole('button', { name: '检查点已保存' })).toBeVisible();
  await page.getByRole('button', { name: '新开一局' }).click(); await expect(page.getByTestId('action-count')).toHaveText('0'); await validMove(page);
  const original = await snapshot(page), file = testInfo.outputPath('library.2048backup'); await downloadBackup(page, file);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1000 } }), restoredPage = await context.newPage();
  await restoredPage.goto('/'); let dialog = await openImport(restoredPage);
  await dialog.getByLabel('选择存档文件').setInputFiles(file); await expect(dialog.getByTestId('import-preview')).toBeVisible();
  expect((await snapshot(restoredPage)).projects).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('m2-game-desktop.png'), fullPage: true });
  await finishImport(restoredPage);
  let restored = await snapshot(restoredPage); expect(restored.projects).toHaveLength(2);
  expect(restored.states).toEqual(original.states); expect(restored.checkpoints).toHaveLength(1);
  for (const project of restored.projects) {
    const sourceId = project.origin!.sourceProjectId;
    expect(restored.nodes.filter(node => node.matchId === project.id).map(node => ({ ...node, matchId: sourceId }))).toEqual(original.nodes.filter(node => node.matchId === sourceId));
  }
  dialog = await openImport(restoredPage); await dialog.getByLabel('选择存档文件').setInputFiles(file); await expect(dialog.getByTestId('import-preview')).toBeVisible();
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await restoredPage.screenshot({ path: testInfo.outputPath('m2-import-desktop.png') });
  await finishImport(restoredPage); restored = await snapshot(restoredPage); expect(restored.projects).toHaveLength(4); expect(restored.states).toEqual(original.states);
  expect(await snapshot(page)).toEqual(original);
  await validMove(restoredPage); const count = await restoredPage.getByTestId('action-count').textContent();
  await expect(restoredPage.getByText('离线资源已就绪', { exact: true })).toBeVisible();
  await context.setOffline(true); await restoredPage.reload(); await expect(restoredPage.getByTestId('action-count')).toHaveText(count!);
  await validMove(restoredPage); dialog = await openImport(restoredPage); await dialog.getByLabel('选择存档文件').setInputFiles(file);
  await expect(dialog.getByTestId('import-preview')).toBeVisible(); await finishImport(restoredPage);
  expect((await snapshot(restoredPage)).projects).toHaveLength(6);
  await context.close();
});

test('legacy preview, malformed-file rejection and same-batch quota retry preserve existing projects', async ({ page }, testInfo) => {
  await start(page); await validMove(page); await page.getByRole('button', { name: '新开一局' }).click(); await expect(page.getByTestId('action-count')).toHaveText('0');
  const original = await snapshot(page), legacy = { format: '2048-sandbox-m1-backup', schemaVersion: 1, exportedAt: '2026-10-14T00:00:00Z', ...original };
  await writeFile(testInfo.outputPath('m1-legacy.json'), JSON.stringify(legacy, null, 2));
  const dialog = await openImport(page), input = dialog.getByLabel('选择存档文件');
  await input.setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await expect(dialog.getByText(/兼容迁移/)).toBeVisible(); expect(await snapshot(page)).toEqual(original);
  const corrupt = structuredClone(legacy); corrupt.states[0]!.state.world.score = '999';
  await input.setInputFiles({ name: 'corrupt.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(corrupt)) });
  await expect(dialog.getByRole('alert')).toContainText('状态摘要不匹配'); expect(await snapshot(page)).toEqual(original);
  await input.setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) }); await expect(dialog.getByTestId('import-preview')).toBeVisible();
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add, scope = window as unknown as { failed: boolean; projectAttempts: string[]; restore: () => void };
    scope.failed = true; scope.projectAttempts = [];
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.name === 'projects') { scope.projectAttempts.push(args[0].id); if (scope.failed) throw new DOMException('quota', 'QuotaExceededError'); }
      return add.apply(this, args);
    };
    scope.restore = () => { IDBObjectStore.prototype.add = add; };
  });
  await dialog.getByRole('button', { name: '导入副本', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('空间不足'); expect(await snapshot(page)).toEqual(original);
  const firstAttempts = await page.evaluate(() => (window as unknown as { projectAttempts: string[] }).projectAttempts.slice());
  await dialog.getByRole('button', { name: '重试同一批导入', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('空间不足');
  const attempts = await page.evaluate(() => (window as unknown as { projectAttempts: string[] }).projectAttempts);
  expect(firstAttempts.length).toBeGreaterThan(0); expect(attempts.slice(firstAttempts.length)).toEqual(firstAttempts);
  await page.evaluate(() => { (window as unknown as { failed: boolean }).failed = false; });
  await dialog.getByRole('button', { name: '重试同一批导入', exact: true }).click(); await expect(dialog.getByText('已完成导入', { exact: true })).toBeVisible();
  expect((await snapshot(page)).projects).toHaveLength(4);
  await page.evaluate(() => { (window as unknown as { restore: () => void }).restore(); });
});

test('mobile tree and import preview fit the viewport; unknown capabilities never write', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await start(page); await validMove(page);
  await page.getByRole('button', { name: '打开完整历史树' }).click(); const tree = page.getByRole('dialog', { name: '历史树与回放' });
  await expect(tree.getByTestId('history-tree')).toBeVisible();
  expect(await tree.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await tree.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('m2-tree-mobile.png') }); await tree.getByRole('button', { name: '关闭窗口' }).click();
  const file = testInfo.outputPath('mobile.2048backup'); await downloadBackup(page, file);
  const dialog = await openImport(page); await dialog.getByLabel('选择存档文件').setInputFiles(file); await expect(dialog.getByTestId('import-preview')).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('m2-import-mobile.png') });
  const before = await snapshot(page), files = unzipSync(new Uint8Array(await readFile(file)));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); manifest.requiredCapabilities.push('scripts-v99'); files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  await dialog.getByLabel('选择存档文件').setInputFiles({ name: 'unknown.2048backup', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) });
  await expect(dialog.getByRole('alert')).toContainText('scripts-v99'); expect(await snapshot(page)).toEqual(before);
  await context.close();
});

test('an actual M1 browser database upgrades and restores its saved head unchanged', async ({ page, browser }) => {
  await start(page); await validMove(page); const original = await snapshot(page);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await context.addInitScript((data: LibrarySnapshot) => {
    const request = indexedDB.open('2048-sandbox-v1', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const projects = database.createObjectStore('projects', { keyPath: 'id' }); projects.createIndex('updatedAt', 'updatedAt');
      const nodes = database.createObjectStore('nodes', { keyPath: 'id' }); nodes.createIndex('matchId','matchId'); nodes.createIndex('parentId','parentId'); nodes.createIndex('operationId','operationId',{ unique: true });
      database.createObjectStore('states', { keyPath: 'hash' }); database.createObjectStore('rules', { keyPath: ['id','version'] });
      const checkpoints = database.createObjectStore('checkpoints', { keyPath: 'id' }); checkpoints.createIndex('projectId','projectId'); checkpoints.createIndex('[projectId+nodeId]',['projectId','nodeId']);
      database.createObjectStore('settings', { keyPath: 'key' });
      for (const [name, rows] of Object.entries(data)) for (const row of rows) request.transaction!.objectStore(name).add(row);
    };
    request.onsuccess = () => request.result.close();
  }, original);
  const migrated = await context.newPage(); await migrated.goto('/');
  await expect(migrated.getByTestId('action-count')).toHaveText('1');
  expect(await snapshot(migrated)).toEqual(original);
  await context.close();
});
