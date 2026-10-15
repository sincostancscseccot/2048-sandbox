import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../../src/app/version';
import { start, validMove } from './helpers';

test('production validates and exports under a CSP that prohibits dynamic code evaluation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:4173/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(),
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    } });
  });
  await start(page); await validMove(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.2048backup$/);
  expect(errors).toEqual([]);
});

test('single-file web artifact runs from a nested upload URL without external assets and keeps saved moves', async ({ page }) => {
  const url = 'http://127.0.0.1:4173/upload/2048.html';
  const html = await readFile(`release/2048-sandbox-v${APP_VERSION}-web.html`);
  await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('button', { name: '开始经典对局' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
  await validMove(page);
  await expect(page.locator('.brand img')).toHaveAttribute('src', /^data:image\/svg\+xml,/);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').length)).toBe(0);
  await page.reload();
  await expect(page.getByTestId('action-count')).toHaveText('1');
  expect(errors).toEqual([]);
});
