import { expect, test } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { scaleFixture } from '../fixtures/scale';
import { createArchive, parseImport } from '../../src/files/archive';
import type { LibrarySnapshot } from '../../src/domain/types';
import { snapshot } from './helpers';
import { APP_VERSION } from '../../src/app/version';

const execute = promisify(execFile);
test.use({ actionTimeout:15_000 });
function head(saved: LibrarySnapshot) {
  const id = saved.settings.find(item => item.key === 'lastProjectId')!.value;
  const project = saved.projects.find(item => item.id === id)!, node = saved.nodes.find(item => item.matchId === id && item.id === project.project.activeNodeId)!;
  return { project, node, state: saved.states.find(item => item.hash === node.stateHash)!.state };
}

for (const [name, viewport] of [['desktop', { width:1440, height:1000 }], ['mobile', { width:390, height:844 }]] as const) {
  test(`${name}: help and preset selection are read-only, all four presets create playable saved games offline`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.getByText('离线资源已就绪', { exact:true })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
    await page.getByRole('button', { name:'帮助', exact:true }).click();
    const help = page.getByRole('dialog', { name:'玩法与保存帮助' }); await expect(help).toContainText(`v${APP_VERSION}`);
    await expect(help).toContainText('127.0.0.1:4173'); await page.screenshot({ path:testInfo.outputPath(`m6-help-${name}.png`) });
    await help.getByRole('button', { name:'关闭窗口', exact:true }).click();
    for (const [title, score] of [['连锁合并','28'],['斐波那契','2'],['技能练习场','0'],['阶段与奖励','14']]) {
      const before = await snapshot(page);
      await page.getByRole('button', { name:'自定义新局', exact:true }).click(); const setup = page.getByRole('dialog', { name:'新建自定义对局' });
      await setup.getByText('探索预设玩法 · 4 套', { exact:true }).click(); await setup.locator('.preset-grid').getByRole('button', { name:new RegExp(`^${title}`) }).click();
      expect(await snapshot(page)).toEqual(before); await expect(setup.getByLabel('对局名称', { exact:true })).toHaveValue(title!);
      if (title === '连锁合并') await page.screenshot({ path:testInfo.outputPath(`m6-presets-${name}.png`) });
      await setup.getByRole('button', { name:'创建自定义对局', exact:true }).click(); await expect(setup).toHaveCount(0);
      await page.getByRole('button', { name:'向左移动', exact:true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1');
      await expect(page.getByTestId('score')).toHaveText(score!); await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
      const saved = await snapshot(page);
      await page.getByRole('button', { name:'帮助', exact:true }).click(); await page.keyboard.press('ArrowRight'); expect(await snapshot(page)).toEqual(saved);
      await page.getByRole('dialog', { name:'玩法与保存帮助' }).getByRole('button', { name:'关闭窗口', exact:true }).click();
    }
    expect((await snapshot(page)).projects).toHaveLength(4); await page.reload(); await expect(page.getByTestId('score')).toHaveText('14');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); expect(overflow).toBe(false);
  });
}

test('cancel a large check and immediately choose a different file without stale preview or database changes', async ({ page }) => {
  test.setTimeout(90_000); const source = await scaleFixture(1000, 'balanced');
  const bytes = new TextEncoder().encode(JSON.stringify({ format:'2048-sandbox-m1-backup', schemaVersion:1, exportedAt:'2026-10-14T00:00:00Z', ...source }));
  await page.goto('/'); const before = await snapshot(page);
  await page.getByRole('button', { name:'文件与恢复', exact:true }).click(); const center = page.getByRole('dialog', { name:'文件与备份' });
  await center.getByLabel('选择存档文件').setInputFiles({ name:'large-check.json', mimeType:'application/json', buffer:Buffer.from(bytes) });
  await center.getByRole('button', { name:'取消检查', exact:true }).click();
  await center.getByLabel('选择存档文件').setInputFiles('examples/presets/m6/chain.json');
  await expect(center.getByTestId('import-preview')).toBeVisible(); await expect(center.getByTestId('import-preview')).toContainText('连锁合并');
  await expect(center.locator('.import-counts')).toContainText('节点1'); expect(await snapshot(page)).toEqual(before);
  await center.getByRole('button', { name:'使用规则新建', exact:true }).click(); await expect(center.getByText('已完成导入', { exact:true })).toBeVisible();
  await center.getByRole('button', { name:'开始查看', exact:true }).click(); await page.getByRole('button', { name:'向左移动', exact:true }).click();
  await expect(page.getByTestId('score')).toHaveText('28'); expect((await snapshot(page)).nodes).toHaveLength(2);
});

test('1001-node chain survives real browser import, indexed save, bounded tree, reload and a complete backup copy', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000); await page.setViewportSize({ width:1440, height:1000 });
  const source = await scaleFixture(1000, 'chain'), file = await createArchive(source, { kind:'library' });
  const times: Record<string, number> = {}, errors:string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByRole('button', { name:'文件与恢复', exact:true }).click(); let center = page.getByRole('dialog', { name:'文件与备份' });
  let clock = performance.now(); await center.getByLabel('选择存档文件').setInputFiles({ name:'m6-chain.2048backup', mimeType:'application/zip', buffer:Buffer.from(file.bytes) });
  await expect(center.getByTestId('import-preview')).toBeVisible({ timeout:60_000 }); times.checkAndPrepareMs = performance.now() - clock;
  clock = performance.now(); await center.getByRole('button', { name:'导入副本', exact:true }).click(); await expect(center.getByText('已完成导入', { exact:true })).toBeVisible({ timeout:60_000 });
  await center.getByRole('button', { name:'开始查看', exact:true }).click(); times.importAndOpenMs = performance.now() - clock;
  await expect(page.getByTestId('action-count')).toHaveText('1000'); expect((await snapshot(page)).nodes).toHaveLength(1001);
  clock = performance.now(); await page.getByRole('button', { name:'打开完整历史树 ↗', exact:true }).click(); const tree = page.getByRole('dialog', { name:'历史树与回放' });
  await expect(page.getByTestId('tree-overview')).toBeVisible(); times.openTreeMs = performance.now() - clock;
  const renderedTreeNodes = await tree.locator('.tree-node').count(); expect(renderedTreeNodes).toBeLessThan(80);
  await page.screenshot({ path:testInfo.outputPath('m6-large-tree-desktop.png') }); await tree.getByRole('button', { name:'关闭窗口', exact:true }).click();
  clock = performance.now(); await page.getByRole('button', { name:'向右移动', exact:true }).click(); await expect(page.getByTestId('action-count')).toHaveText('1001', { timeout:60_000 });
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存'); times.saveAndConfirmMs = performance.now() - clock;
  const saved = await snapshot(page), active = head(saved);
  clock = performance.now(); await page.reload(); await expect(page.getByTestId('board')).toHaveAttribute('data-node-id', active.node.id, { timeout:60_000 }); times.reloadMs = performance.now() - clock;
  expect(head(await snapshot(page)).state).toEqual(active.state);
  clock = performance.now(); const download = page.waitForEvent('download'); await page.getByRole('button', { name:'导出备份', exact:true }).click();
  const backup = testInfo.outputPath('m6-chain.2048backup'); await (await download).saveAs(backup); times.exportMs = performance.now() - clock;
  const parsed = await parseImport(new Uint8Array(await readFile(backup))); expect(parsed.snapshot.nodes).toHaveLength(1002);
  expect(head(parsed.snapshot).state).toEqual(active.state);
  await page.getByRole('button', { name:'文件与恢复', exact:true }).click(); center = page.getByRole('dialog', { name:'文件与备份' });
  await center.getByLabel('选择存档文件').setInputFiles(backup); await expect(center.getByTestId('import-preview')).toBeVisible({ timeout:60_000 });
  await center.getByRole('button', { name:'导入副本', exact:true }).click(); await expect(center.getByText('已完成导入', { exact:true })).toBeVisible({ timeout:60_000 });
  const recovered = await snapshot(page); expect(recovered.projects).toHaveLength(2); expect(recovered.nodes).toHaveLength(2004);
  expect(recovered.projects.find(item => item.id === active.project.id)).toEqual(active.project); expect(head(recovered).state).toEqual(active.state); expect(errors).toEqual([]);
  await mkdir('.work', { recursive:true }); await writeFile('.work/m6-browser-performance.json', JSON.stringify({ browser:browser.version(), viewport:{ width:1440,height:1000 }, fixture:'1001-node chain; actual Chrome IndexedDB', measurements:Object.fromEntries(Object.entries(times).map(([key,value])=>[key,Math.round(value*100)/100])), renderedTreeNodes, archiveBytes:file.bytes.length, completeBackupNodes:2004, errors }, null, 2));
});

test('clean extracted release verifies hashes, detects changes and plays offline without node_modules', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const releasePath = `release/2048-sandbox-v${APP_VERSION}.zip`;
  const bytes = await readFile(releasePath), checksum = (await readFile(`${releasePath}.sha256`,'utf8')).split(/\s/)[0];
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(checksum);
  const parent = resolve('.work/release-tests'); await mkdir(parent, { recursive:true }); const directory = await mkdtemp(resolve(parent, 'package-'));
  const base = `2048-sandbox-v${APP_VERSION}/`, root = resolve(directory, base), files = unzipSync(bytes);
  for (const [path, content] of Object.entries(files)) {
    expect(path.startsWith(base)).toBe(true); expect(path.split('/').some(part => part === '..')).toBe(false);
    expect(path).not.toMatch(/node_modules|\.work|(^|\/)src\//);
    const output = resolve(directory, path); expect(output.startsWith(directory + sep)).toBe(true);
    await mkdir(dirname(output), { recursive:true }); await writeFile(output, content);
  }
  let output = ''; const child = spawn(process.execPath, ['scripts/serve-release.mjs','--port','4318'], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  child.stdout.on('data', chunk => output += String(chunk)); child.stderr.on('data', chunk => output += String(chunk));
  const context = await browser.newContext({ viewport:{ width:390,height:844 } });
  try {
    expect((await execute(process.execPath,['scripts/verify-release.mjs'], { cwd:root, windowsHide:true })).stdout).toContain(`Verified 2048 Sandbox v${APP_VERSION}`);
    const marker = resolve(root,'dist/build-info.json'), original = await readFile(marker); await writeFile(marker,'{}');
    await expect(execute(process.execPath,['scripts/verify-release.mjs'], { cwd:root, windowsHide:true })).rejects.toMatchObject({ code:1 }); await writeFile(marker,original);
    await expect.poll(() => output, { timeout:15_000 }).toContain('http://127.0.0.1:4318/');
    const page = await context.newPage(); await page.goto('http://127.0.0.1:4318/'); await page.getByRole('button',{ name:'自定义新局',exact:true }).click();
    const setup = page.getByRole('dialog',{ name:'新建自定义对局' }); await setup.getByText('探索预设玩法 · 4 套',{ exact:true }).click();
    await setup.locator('.preset-grid').getByRole('button',{ name:/^阶段与奖励/ }).click(); await setup.getByRole('button',{ name:'创建自定义对局',exact:true }).click(); await expect(setup).toHaveCount(0);
    await page.getByRole('button',{ name:'向左移动',exact:true }).click(); await expect(page.getByTestId('score')).toHaveText('14');
    await expect(page.getByText('离线资源已就绪',{ exact:true })).toBeVisible(); await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true); await page.reload(); await expect(page.getByTestId('action-count')).toHaveText('1');
    await page.getByRole('button',{ name:'帮助',exact:true }).click(); await expect(page.getByRole('dialog',{ name:'玩法与保存帮助' })).toContainText(`v${APP_VERSION}`);
    await page.screenshot({ path:testInfo.outputPath('m6-release-offline-mobile.png') });
  } finally {
    await context.close(); const ended = new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit',()=>resolve()); }); child.kill(); await ended;
    if (resolve(directory).startsWith(parent + sep)) await rm(directory,{ recursive:true,force:true });
  }
});
