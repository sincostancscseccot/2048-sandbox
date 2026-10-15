import { test, expect, type Page } from '@playwright/test';
import { defaultExperience, experienceKey } from '../../src/presentation/preferences';
import { snapshot } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: experienceKey, value: { ...defaultExperience, sound: false } });
  await page.goto('/');
});
async function create(page: Page) {
  await page.getByRole('button', { name: '自定义新局', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建自定义对局' });
  await dialog.getByLabel('开局数量', { exact: true }).fill('0');
  await dialog.getByLabel('每次生成数量', { exact: true }).fill('0');
  await dialog.getByLabel('初始布局（格索引:数字）', { exact: true }).fill('0:2, 1:2, 6:8');
  await dialog.getByLabel('无路可走时判负', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: '创建自定义对局', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
}

test('WASD and arrows move the game without scrolling while the library stays open after deleting another match', async ({ page }) => {
  await create(page); const old = (await snapshot(page)).projects[0]!;
  await page.getByRole('button', { name: '新开一局' }).click(); await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
  await page.getByRole('button', { name: /我的对局/ }).click();
  await page.locator(`.library-record[data-project-id="${old.id}"] .library-delete`).click();
  const dialog = page.getByRole('dialog', { name: '删除对局', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: '我的对局', exact: true })).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 180); });
  const top = await page.evaluate(() => scrollY); expect(top).toBeGreaterThan(0);
  let step = 0;
  for (const key of ['d', 's', 'a', 'w', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
    await page.keyboard.press(key); await expect(page.getByTestId('action-count')).toHaveText(String(++step));
    expect(await page.evaluate(() => scrollY)).toBe(top);
  }
  await expect(page.getByRole('region', { name: '我的对局', exact: true })).toBeVisible();
  const saved = await snapshot(page); expect(saved.projects).toHaveLength(1); expect(saved.nodes).toHaveLength(9);
});

test('held direction keys and movement pressed during a pending save do not scroll or queue duplicate moves', async ({ page }) => {
  await create(page);
  await page.evaluate(() => {
    const probe = { events: [] as { key: string; repeat: boolean; prevented: boolean }[], release: () => {} };
    (window as unknown as { keyboardProbe: typeof probe }).keyboardProbe = probe;
    // Observe after the full native dispatch, including listeners rebound on save.
    window.addEventListener('keydown', event => setTimeout(() => probe.events.push({ key: event.key, repeat: event.repeat, prevented: event.defaultPrevented }), 0));
    const digest = SubtleCrypto.prototype.digest; let hold = true;
    SubtleCrypto.prototype.digest = async function (algorithm, data) {
      if (hold) { hold = false; await new Promise<void>(resolve => { probe.release = resolve; }); }
      return digest.call(this, algorithm, data);
    };
    (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 150);
  });
  const top = await page.evaluate(() => scrollY);
  await page.keyboard.down('ArrowRight'); await expect(page.getByTestId('save-status')).toHaveText('保存中…');
  await page.keyboard.down('ArrowRight'); await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => (window as unknown as { keyboardProbe: { events: unknown[] } }).keyboardProbe.events.length)).toBe(3);
  let events = await page.evaluate(() => (window as unknown as { keyboardProbe: { events: { repeat: boolean; prevented: boolean }[] } }).keyboardProbe.events);
  expect(events.some(event => event.repeat)).toBe(true); expect(events.every(event => event.prevented)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(top);
  await page.evaluate(() => (window as unknown as { keyboardProbe: { release: () => void } }).keyboardProbe.release());
  await expect(page.getByTestId('action-count')).toHaveText('1');
  await page.keyboard.down('ArrowRight'); await page.keyboard.up('ArrowRight');
  await expect.poll(() => page.evaluate(() => (window as unknown as { keyboardProbe: { events: unknown[] } }).keyboardProbe.events.length)).toBe(4);
  events = await page.evaluate(() => (window as unknown as { keyboardProbe: { events: { repeat: boolean; prevented: boolean }[] } }).keyboardProbe.events);
  expect(events.at(-1)).toMatchObject({ repeat: true, prevented: true });
  expect((await snapshot(page)).nodes).toHaveLength(2); expect(await page.evaluate(() => scrollY)).toBe(top);
});

test('text fields, number fields, modal windows and the home page retain their own keyboard behavior', async ({ page }) => {
  await create(page); const before = await snapshot(page);
  await page.getByRole('button', { name: '自定义新局', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建自定义对局' });
  const rows = dialog.getByLabel('棋盘行数', { exact: true }); await rows.fill('4'); await rows.focus(); await page.keyboard.press('ArrowUp'); await expect(rows).toHaveValue('5');
  const name = dialog.getByLabel('对局名称', { exact: true }); await name.fill(''); await name.focus();
  for (const key of ['w', 'a', 's', 'd']) await page.keyboard.press(key); await expect(name).toHaveValue('wasd'); expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('button', { name: '帮助', exact: true }).click(); const help = page.getByRole('dialog', { name: '玩法与保存帮助' });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('d'); expect(await snapshot(page)).toEqual(before);
  await help.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('button', { name: '返回首页', exact: true }).click(); await expect(page.getByTestId('board')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 600 }); await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.keyboard.press('ArrowDown'); await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0); expect(await snapshot(page)).toEqual(before);
});
