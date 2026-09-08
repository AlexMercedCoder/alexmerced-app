import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function exportData(page: Page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, 'utf8'));
}


// IndexedDB returns records in key order; first-run seeds can be in display
// order. Compare record identity and fields, preserving nested column/rank data.
function canonicalWorkspace(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
    Array.isArray(value) && value.every((record) => typeof record?.id === 'string')
      ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value,
  ]));
}

for (const app of ['laneway', 'rote', 'stint']) {
  test(`${app}: export, replace, reload, and merge preserve records`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/${app}`);
    const picker = { laneway: '#lw-board-picker', rote: '#rt-deck', stint: '#st-project' }[app]!;
    await expect(page.locator(`${picker} option`)).not.toHaveCount(0, { timeout: 30_000 });
    const original = await exportData(page);
    const parents = original.data.boards ?? original.data.decks ?? original.data.projects;
    const name = `${app} browser round trip`;
    parents[0].name = name;
    // Ensure merge also sees this as the newer record.
    parents[0].updatedAt = '2099-01-01T00:00:00.000Z';
    for (const mode of ['Replace everything', 'Merge']) {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await (await chooser).setFiles({ name: `${app}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) });
      await page.getByRole('button', { name: mode, exact: true }).click();
      await expect(page.locator('#toast-stack')).toContainText('Imported', { timeout: 30_000 });
      await page.reload();
      await expect(page.locator(`${picker} option`)).not.toHaveCount(0, { timeout: 30_000 });
      const exported = await exportData(page);
      expect(canonicalWorkspace(exported.data)).toEqual(canonicalWorkspace(original.data));
    }
    expect(errors).toEqual([]);
  });
}

test('catalogue count and navigation fit desktop and phone widths', async ({ page }) => {
  await page.goto('/');
  const count = await page.locator('.card').count();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${count} small tools that keep your data on your machine.`);
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('navigation', { name: 'Apps', exact: true }).getByRole('link', { name: 'Warren', exact: true }).focus();
    // Tab traverses every link and exercises native focus scrolling.
    for (let index = 0; index < count; index++) await page.keyboard.press('Tab');
    await expect(page.getByRole('navigation', { name: 'Apps', exact: true }).getByRole('link', { name: 'About', exact: true })).toBeInViewport();
  }
});
