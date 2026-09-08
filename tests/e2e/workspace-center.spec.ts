import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

test('launcher supports task search, favorites, keyboard close and focus return', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Search by name or task').fill('combine pdfs');
  await expect(page.locator('#launcher-results a')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pin Quire', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Find a tool', exact: true })).toBeFocused();
  await page.reload(); await page.getByRole('button', { name: 'Find a tool', exact: true }).click();
  await expect(page.locator('#launcher-results a').first()).toContainText('Quire');
  expect((await new AxeBuilder({ page }).include('#workspace-launcher').analyze()).violations).toEqual([]);
});

test('file inbox creates a separate editable chart and preserves an existing one', async ({ page }) => {
  await page.goto('/ordinate');
  await expect(page.locator('#or-source')).not.toHaveValue('');
  await page.goto('/');
  await page.locator('#home-file').setInputFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from('Month,Sales\nJan,10\nFeb,20') });
  await page.getByRole('button', { name: 'Open in Ordinate', exact: true }).click();
  await expect(page.locator('#or-name')).toHaveValue('sample');
  await expect(page.locator('#or-source')).toHaveValue('Month,Sales\nJan,10\nFeb,20');
  await page.reload(); await expect(page.locator('#or-name')).toHaveValue('sample');
});

test('backup restores selected workspaces and blocks unknown archive input', async ({ page }) => {
  await page.goto('/workspace');
  await page.getByRole('button', { name: 'Freelance project board' }).click();
  await expect(page.locator('#lw-board-picker')).toContainText('Freelance website project');
  await page.goto('/workspace');
  for (const box of await page.locator('#backup-apps input').all()) await box.uncheck();
  await page.locator('#backup-apps input[value="laneway"]').check();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup', exact: true }).click();
  const bytes = await readFile((await (await downloading).path())!);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('laneway'); request.onsuccess = () => {
        const db = request.result; const tx = db.transaction(['boards', 'cards'], 'readwrite'); tx.objectStore('boards').clear(); tx.objectStore('cards').clear(); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.locator('#backup-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.locator('#restore-preview')).toContainText('laneway:');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Replace selected workspaces' }).click();
  await expect(page.locator('#backup-status')).toContainText('Restore complete');
  await page.goto('/laneway'); await expect(page.locator('#lw-board-picker')).toContainText('Freelance website project');
  await page.goto('/workspace');
  await page.locator('#backup-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('#backup-status')).toContainText('Invalid backup');
  await expect(page.locator('#backup-restore')).toBeHidden();
});

test('second editing tab cannot overwrite the first and can reopen when it closes', async ({ page, context }) => {
  await page.goto('/laneway'); await expect(page.locator('#lw-board-picker option')).not.toHaveCount(0, { timeout: 30_000 });
  const second = await context.newPage(); await second.goto('/laneway');
  await expect(second.getByRole('alert')).toContainText('Close the other laneway tab');
  await page.close(); await second.getByRole('button', { name: 'Try again' }).click();
  await expect(second.locator('#lw-board-picker option')).not.toHaveCount(0, { timeout: 30_000 });
});

test('workspace has named controls, readable contrast and no horizontal overflow', async ({ page }) => {
  await page.goto('/workspace');
  await expect(page.locator('#offline-core')).not.toContainText('Checking');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const width of [1280, 375, 320]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
});

test('Decanter output runs in Quarry and its results become an Ordinate chart', async ({ page }) => {
  await page.goto('/decanter');
  await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'decanter');
  await page.locator('#dc-input').fill('[{"Month":"Jan","Sales":10},{"Month":"Feb","Sales":20}]');
  await page.locator('#dc-out-format').selectOption('csv');
  await page.getByRole('button', { name: 'Query output in Quarry' }).click();
  await expect(page.locator('#qy-schema')).toContainText('decanter', { timeout: 60_000 });
  await page.locator('#qy-sql').fill('SELECT * FROM decanter');
  await page.locator('#qy-run').click();
  await expect(page.locator('#qy-csv')).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Chart results' }).click();
  await expect(page.locator('#or-source')).toHaveValue(/Sales/);
  await expect(page.locator('#or-name')).toHaveValue('query-results');
});

test('processed image transfers from Loupe to Quire and exports a PDF', async ({ page }) => {
  await page.goto('/loupe');
  await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'loupe');
  await page.locator('#lp-file').setInputFiles(new URL('../../public/icon-180.png', import.meta.url).pathname);
  await expect(page.locator('#lp-list')).toContainText('icon-180');
  await expect(page.locator('#lp-save-all')).toBeEnabled();
  await page.getByRole('button', { name: 'Make a PDF in Quire' }).click();
  await expect(page.locator('#qr-summary')).toContainText('1');
  const downloading = page.waitForEvent('download'); await page.locator('#qr-save').click();
  expect((await downloading).suggestedFilename()).toMatch(/\.pdf$/);
});

test('audio export runs in a worker and produces a playable WAV', async ({ page }) => {
  await page.goto('/cadence');
  await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'cadence');
  await page.locator('#cd-file').setInputFiles(new URL('../fixtures/ffmpeg-pcm.wav', import.meta.url).pathname);
  await expect(page.locator('#cd-name')).toHaveValue('ffmpeg pcm');
  await expect(page.locator('#cd-download')).toBeEnabled();
  const downloading = page.waitForEvent('download'); await page.locator('#cd-download').click();
  const bytes = await readFile((await (await downloading).path())!);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF'); expect(bytes.byteLength).toBeGreaterThan(44);
});

test('optional SQL cache can be prepared and removed without removing core pages', async ({ page }) => {
  await page.goto('/workspace');
  await page.getByRole('button', { name: 'Prepare core tools', exact: true }).click();
  await expect(page.locator('#offline-core')).toContainText('Core tools cached', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Download SQL engine (about 34 MB)', exact: true }).click();
  await expect(page.locator('#offline-sql')).toHaveText('SQL engine: downloaded.', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Remove SQL download', exact: true }).click();
  await expect(page.locator('#offline-sql')).toHaveText('SQL engine: not downloaded.');
  await expect(page.locator('#offline-core')).toContainText('Core tools cached');
});

test('Stint creates a separate invoice draft for the selected project and date range', async ({ page }) => {
  await page.goto('/stint'); await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'stint');
  await page.evaluate(async () => {
    const now = new Date(); now.setHours(10, 0, 0, 0); const start = now.toISOString(); now.setHours(11, 30, 0, 0); const end = now.toISOString();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.open('stint'); request.onsuccess = () => {
      const db = request.result; const tx = db.transaction(['projects', 'entries'], 'readwrite');
      tx.objectStore('projects').put({ id: 'billing-project', name: 'Website review', client: 'Example client', rate: 75, color: 'blue', archived: false, createdAt: start, updatedAt: end });
      tx.objectStore('entries').put({ id: 'billing-entry', projectId: 'billing-project', description: 'Review', tags: [], start, end, billable: true, createdAt: start, updatedAt: end });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    }; });
  });
  await page.reload(); await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'stint');
  await page.getByRole('button', { name: 'Draft invoice in Tally' }).click();
  await page.getByLabel('Project to invoice', { exact: true }).selectOption('billing-project');
  await page.getByRole('button', { name: 'Create draft', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'tally');
  await expect(page.locator('#ty-notes')).toHaveValue(/Draft from Stint/);
});

test('cancelling an optional download leaves no partial engine cache', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/duckdb/duckdb-eh.wasm', async route => { await waiting; await route.abort().catch(() => {}); });
  try {
    await page.goto('http://127.0.0.1:4329/workspace');
    await page.getByRole('button', { name: 'Download SQL engine (about 34 MB)', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel download sql engine', exact: true }).click();
    await expect(page.locator('.workspace-job')).toHaveCount(0);
    expect(await page.evaluate(async () => !!await caches.match('/duckdb/duckdb-eh.wasm'))).toBe(false);
  } finally { release(); await context.close(); }
});

test('board cards move by keyboard and retain focus after the move', async ({ page }) => {
  await page.goto('/laneway'); await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'laneway');
  const card = page.locator('[data-drop-column]').first().locator('[data-card-id]').first();
  const id = await card.getAttribute('data-card-id');
  await card.focus(); await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('[data-drop-column]').nth(1).locator(`[data-card-id="${id}"]`)).toBeFocused();
});

test('Warren page search and the site launcher have separate keyboard shortcuts', async ({ page }) => {
  await page.goto('/warren'); await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'warren');
  await page.keyboard.press('Control+k');
  await expect(page.locator('#launcher-query')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+f');
  await expect(page.locator('#wr-search')).toBeFocused();
});
