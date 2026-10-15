import { expect, type Page } from '@playwright/test';
import type { Checkpoint, HistoryNode, ProjectRecord, RuleSetVersion, StateRecord } from '../../src/domain/types';

export async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('2048-sandbox-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['projects', 'historyNodes', 'states', 'checkpoints', 'rules', 'settings'], 'readonly');
    function getAll<T>(name: string): Promise<T[]> {
      return new Promise((resolve, reject) => { const request = transaction.objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    }
    const [projects, nodes, states, checkpoints, rules, settings] = await Promise.all([
      getAll<ProjectRecord>('projects'), getAll<HistoryNode>('historyNodes'), getAll<StateRecord>('states'), getAll<Checkpoint>('checkpoints'), getAll<RuleSetVersion>('rules'), getAll<{ key: string; value: string }>('settings'),
    ]);
    db.close(); return { projects, nodes, states, checkpoints, rules, settings };
  });
}

export async function start(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: '开始经典对局' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
  await expect(page.getByTestId('action-count')).toHaveText('0');
}

export async function availableDirection(page: Page) {
  const values = await page.getByTestId('cell').evaluateAll(cells => cells.map(cell => cell.getAttribute('data-value')));
  for (const [direction, label, key] of [['left','向左移动','ArrowLeft'], ['up','向上移动','ArrowUp'], ['right','向右移动','ArrowRight'], ['down','向下移动','ArrowDown']] as const) {
    let canMove = false;
    for (let line = 0; line < 4; line++) {
      let empty = false, last: string | null = null;
      for (let offset = 0; offset < 4; offset++) {
        const index = direction === 'left' ? line * 4 + offset : direction === 'right' ? line * 4 + 3 - offset : direction === 'up' ? offset * 4 + line : (3 - offset) * 4 + line;
        const value = values[index];
        if (!value) empty = true;
        else { if (empty || value === last) canMove = true; last = value; }
      }
    }
    if (!canMove) continue;
    return { direction, label, key };
  }
  throw new Error('没有可用移动');
}

export async function validMove(page: Page, keyMode = false) {
  const { direction, label, key } = await availableDirection(page);
  const old = await page.getByTestId('board').getAttribute('data-node-id');
  if (keyMode) await page.keyboard.press(key);
  else await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByTestId('board')).not.toHaveAttribute('data-node-id', old!);
  await expect(page.getByTestId('save-status')).toHaveText('已自动保存');
  return direction;
}

