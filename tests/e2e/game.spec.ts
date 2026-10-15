import { test, expect } from '@playwright/test';
import type { HistoryNode } from '../../src/domain/types';

import { availableDirection, snapshot, start, validMove } from './helpers';
import { unzipSync } from 'fflate';

test('keyboard moves, exact node state, checkpoint, close/reopen and lossless portable backup', async ({ page, context }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await validMove(page); // Focus stays on a direction button; keys must still work.
  for (let i = 0; i < 5; i++) await validMove(page, true);
  const saved = await snapshot(page);
  const project = saved.projects[0]!.project;
  const head = saved.nodes.find(node => node.id === project.activeNodeId)!;
  const state = saved.states.find(record => record.hash === head.stateHash)!.state;
  expect(saved.nodes).toHaveLength(7); expect(state.ledger.effectiveActionCount).toBe(6);
  await expect(page.getByTestId('score')).toHaveText(state.world.score);
  await page.getByRole('button', { name: '保存检查点' }).click(); await expect(page.getByRole('button', { name: '检查点已保存' })).toBeVisible();
  const marked = await snapshot(page); expect(marked.nodes).toHaveLength(7); expect(marked.checkpoints).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('desktop-game.png'), fullPage: true });
  await page.close();
  const reopened = await context.newPage(); await reopened.goto('/');
  await expect(reopened.getByTestId('board')).toHaveAttribute('data-node-id', head.id);
  await expect(reopened.getByTestId('action-count')).toHaveText('6'); await expect(reopened.getByTestId('score')).toHaveText(state.world.score);
  expect((await snapshot(reopened)).states.find(record => record.hash === head.stateHash)?.state).toEqual(state);
  const downloadPromise = reopened.waitForEvent('download');
  await reopened.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await downloadPromise; const file = testInfo.outputPath('backup.json'); await download.saveAs(file);
  const { readFile } = await import('node:fs/promises');
  const files = unzipSync(new Uint8Array(await readFile(file)));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  expect(manifest.format).toBe('2048-sandbox'); expect(manifest.nodeCount).toBe(7);
  expect(JSON.parse(new TextDecoder().decode(files[manifest.projects[0].documentPath])).checkpoints).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('preview is free; reproduced and rerolled branches preserve the original path', async ({ page }) => {
  await start(page); await validMove(page);
  let saved = await snapshot(page); const root = saved.nodes.find(node => node.parentId === null)!;
  const original = saved.nodes.find(node => node.parentId === root.id)!; const before = saved.projects[0]!.project;
  await page.locator(`.history-item[data-node-id="${root.id}"]`).click(); await expect(page.getByTestId('score')).toHaveText('0');
  await page.getByTestId('board').focus(); await page.keyboard.press('ArrowLeft');
  saved = await snapshot(page); expect(saved.projects[0]!.project).toEqual(before); expect(saved.nodes).toHaveLength(2);
  await page.getByRole('button', { name: '从此继续', exact: true }).click();
  expect((await snapshot(page)).nodes).toHaveLength(2);
  await page.getByRole('combobox', { name: '继续时的随机结果' }).selectOption('reproduce');
  const labels = { left:'向左移动', right:'向右移动', up:'向上移动', down:'向下移动' };
  if (original.action?.type !== 'move') throw new Error('Expected a move node');
  await page.getByRole('button', { name: labels[original.action!.payload.direction], exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存'); await expect(page.getByTestId('board')).not.toHaveAttribute('data-node-id', root.id);
  saved = await snapshot(page); expect(saved.nodes).toHaveLength(3);
  const reproduced = saved.nodes.find(node => node.id === saved.projects[0]!.project.activeNodeId)!;
  expect(reproduced.stateHash).toBe(original.stateHash); expect(reproduced.id).not.toBe(original.id);
  expect(reproduced.randomContext?.mode).toBe('reproduce');
  await page.locator(`.history-item[data-node-id="${root.id}"]`).click(); await page.getByRole('button', { name: '从此继续', exact: true }).click();
  await page.getByRole('combobox', { name: '继续时的随机结果' }).selectOption('reroll');
  await validMove(page);
  saved = await snapshot(page); const rerolled = saved.nodes.find(node => node.id === saved.projects[0]!.project.activeNodeId)!;
  expect(saved.nodes).toHaveLength(4); expect(rerolled.randomContext?.mode).toBe('reroll');
  expect(rerolled.randomContext?.before).not.toEqual(original.randomContext?.before);
  expect(saved.nodes.find(node => node.id === original.id)).toEqual(original);
});

test('a stale tab gets an explicit conflict and can reload saved progress', async ({ page, context }) => {
  await start(page);
  const stale = await context.newPage(); await stale.goto('/'); await expect(stale.getByTestId('action-count')).toHaveText('0');
  await validMove(page);
  const updated = await snapshot(page);
  const action = updated.nodes.find(node => node.parentId !== null)!.action;
  if (action?.type !== 'move') throw new Error('Expected a move node');
  const direction = action.payload.direction;
  await stale.getByRole('button', { name: { left:'向左移动', right:'向右移动', up:'向上移动', down:'向下移动' }[direction], exact: true }).click();
  await expect(stale.getByRole('alert')).toContainText('另一页面已保存新进度');
  expect((await snapshot(page)).nodes).toHaveLength(2);
  await stale.getByRole('button', { name: '重新读取已保存', exact: true }).click();
  await expect(stale.getByTestId('action-count')).toHaveText('1'); await expect(stale.getByRole('alert')).toHaveCount(0);
});

test('production cache supports reopening and continuing entirely offline', async ({ page, context }) => {
  await start(page); await validMove(page);
  await expect(page.getByText('离线资源已就绪', { exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const saved = await snapshot(page); const head = saved.projects[0]!.project.activeNodeId;
  await page.close(); await context.setOffline(true);
  const offline = await context.newPage(); await offline.goto('/');
  await expect(offline.getByTestId('board')).toHaveAttribute('data-node-id', head);
  await validMove(offline); await expect(offline.getByTestId('action-count')).toHaveText('2');
  await offline.reload(); await expect(offline.getByTestId('action-count')).toHaveText('2');
  expect((await snapshot(offline)).nodes).toHaveLength(3);
  await context.setOffline(false);
});

test('mobile swipe, accessible direction buttons and layout work without horizontal overflow', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(); await start(page);
  const root = await page.getByTestId('board').getAttribute('data-node-id');
  // Touch coordinates must be inside the viewport after responsive header wrapping.
  await page.getByTestId('board').scrollIntoViewIfNeeded();
  const bounds = (await page.getByTestId('board').boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  const cdp = await context.newCDPSession(page);
  for (const [dx, dy] of [[-90,0],[0,-90],[90,0],[0,90]]) {
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx!, y: y + dy! }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('save-status')).not.toHaveText('保存中…');
    if (await page.getByTestId('board').getAttribute('data-node-id') !== root) break;
  }
  await expect(page.getByTestId('action-count')).toHaveText('1');
  await validMove(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-game.png'), fullPage: true });
  await context.close();
});

test('corrupt saved state is diagnosed on reopen and can still be exported', async ({ page }) => {
  await start(page); await validMove(page);
  const saved = await snapshot(page); const head = saved.nodes.find(node => node.id === saved.projects[0]!.project.activeNodeId)!;
  await page.evaluate(async hash => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('2048-sandbox-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('states', 'readwrite'), store = transaction.objectStore('states');
      const request = store.get(hash); request.onsuccess = () => { const record = request.result; record.state.world.score = '999'; store.put(record); };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    }); db.close();
  }, head.stateHash);
  await page.reload(); await expect(page.getByRole('alert')).toContainText('状态摘要不匹配');
  expect((await snapshot(page)).projects).toHaveLength(1);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出已保存的备份' }).click(); await download;
});

test('quota rollback retries the identical operation; a waiting app update stays blocked until saved', async ({ page }) => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const swPath = new URL('../../dist/sw.js', import.meta.url);
  const originalSw = await readFile(swPath, 'utf8');
  try {
    await start(page);
    await expect(page.getByText('离线资源已就绪', { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByTestId('action-count')).toHaveText('0');
    const before = await snapshot(page);
    await page.evaluate(() => {
      const originalPut = IDBObjectStore.prototype.put, originalAdd = IDBObjectStore.prototype.add;
      const scope = window as unknown as { failWrites: boolean; attempts: HistoryNode[]; restoreWrites: () => void };
      scope.failWrites = true; scope.attempts = [];
      IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
        if (this.name === 'projects' && scope.failWrites) throw new DOMException('Injected quota failure', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
        if (this.name === 'historyNodes') scope.attempts.push(structuredClone(args[0]));
        return originalAdd.apply(this, args);
      };
      scope.restoreWrites = () => { IDBObjectStore.prototype.put = originalPut; IDBObjectStore.prototype.add = originalAdd; };
    });
    await page.getByRole('button', { name: (await availableDirection(page)).label, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('本地存储空间不足');
    expect(await snapshot(page)).toEqual(before);
    await page.getByRole('button', { name: '重试本次保存' }).click();
    await expect(page.getByRole('alert')).toContainText('本地存储空间不足');
    const attempts = await page.evaluate(() => (window as unknown as { attempts: HistoryNode[] }).attempts);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await writeFile(swPath, `${originalSw}\n// integration-update-${Date.now()}\n`);
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration!.update(); });
    const updateButton = page.getByRole('button', { name: '新版本就绪 · 保存后更新' });
    await expect(updateButton).toBeVisible(); await expect(updateButton).toBeDisabled();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await page.evaluate(() => { (window as unknown as { failWrites: boolean }).failWrites = false; });
    await page.getByRole('button', { name: '重试本次保存' }).click();
    await expect(page.getByTestId('action-count')).toHaveText('1'); await expect(updateButton).toBeEnabled();
    const saved = await snapshot(page); expect(saved.nodes).toHaveLength(2);
    expect(saved.nodes.find(node => node.parentId !== null)).toEqual(attempts[0]);
    await page.evaluate(() => { (window as unknown as { restoreWrites: () => void }).restoreWrites(); });
    await Promise.all([page.waitForEvent('load'), updateButton.click()]);
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
    await expect(page.getByTestId('action-count')).toHaveText('1');
    expect((await snapshot(page)).nodes).toHaveLength(2);
  } finally { await writeFile(swPath, originalSw); }
});
