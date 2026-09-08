import { expect, test, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';
// WebKit's protocol offline mode rejects navigations before consulting the
// worker on this Linux build. Closing server connections exercises a real
// network outage while leaving the browser's cache/worker path intact.
async function offline(context: BrowserContext, request: APIRequestContext, browserName: string, value: boolean) {
  if (browserName === 'webkit') await request.post(`/__test__/network?offline=${value ? 1 : 0}`);
  else await context.setOffline(value);
}
test.afterEach(async ({ request }) => { await request.post('/__test__/network?offline=0'); });

async function ready(page: Page) {
  await page.goto('/laneway');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
}

test('cached tools remain interactive offline', async ({ page, context, request, browserName }) => {
  await ready(page);
  await offline(context, request, browserName, true);
  await page.goto('/reckoner');
  // Network emulation may leave navigator.onLine true on a fresh document;
  // exercising an export proves the cached script actually runs.
  // Native buttons exercise the cached application script, not just its HTML.
  await expect(page.locator('[data-action="export"]')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.locator('[data-action="export"]').click();
  expect((await download).suggestedFilename()).toMatch(/reckoner.*\.json$/);
});

test('failed update preserves offline cache, successful update waits for Reload', async ({ page, request, context, browserName }) => {
  await ready(page);
  const before = await page.evaluate(() => caches.keys());
  await request.post('/__test__/release?fail=/about/');
  await page.evaluate(async () => {
    const reg = (await navigator.serviceWorker.getRegistration())!;
    const finished = new Promise<void>((resolve) => reg.addEventListener('updatefound', () => {
      const worker = reg.installing!;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
    }, { once: true }));
    await reg.update();
    await finished;
  });
  expect(await page.evaluate(() => caches.keys())).toEqual(before);
  await offline(context, request, browserName, true);
  await page.reload();
  await expect(page.locator('#lw-board-picker')).toBeVisible();
  await offline(context, request, browserName, false);
  await request.post('/__test__/release');
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  const reload = page.getByRole('button', { name: 'Reload', exact: true });
  await expect(reload).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
  await Promise.all([page.waitForEvent('load'), reload.click()]);
  await expect.poll(() => page.evaluate(() => caches.keys())).not.toEqual(before);
  await offline(context, request, browserName, true);
  await page.reload();
  await expect(page.locator('#lw-board-picker option')).not.toHaveCount(0);
});
