import { expect, test } from '@playwright/test';

test.describe('Cadence recording and editing', () => {

  test('records a fake microphone, pauses, recovers original after edit, and exports WAV', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'This test uses Chromium fake media flags; it does not certify real microphones.');
    await context.grantPermissions(['microphone']);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/cadence/');
    await expect(page.locator('#cd-record')).toBeEnabled();
    await page.getByText('Recording setup', { exact: true }).click();
    await page.locator('#cd-preset').selectOption('voice');
    await expect(page.locator('#cd-noise')).toBeChecked();
    await page.locator('#cd-test').click();
    await page.waitForTimeout(1050);
    await page.locator('#cd-test').click();
    await expect(page.locator('#cd-test-play')).toBeEnabled();
    await page.locator('#cd-test-play').click();
    await page.locator('#cd-test-discard').click();
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(0);
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-record-status')).toContainText('Recording');
    await page.waitForTimeout(1300);
    await page.locator('#cd-pause').click();
    await expect(page.locator('#cd-record-status')).toContainText('paused');
    await page.locator('#cd-pause').click();
    await page.waitForTimeout(1300);
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(1, { timeout: 30_000 });
    await page.keyboard.press('Alt+m');
    await expect(page.locator('#cd-markers')).toContainText('Marker 1');
    await page.locator('#cd-reverse').click();
    await expect(page.locator('#cd-reset')).toBeEnabled();
    await page.locator('#cd-reset').click();
    await page.locator('#cd-effects-panel summary').click();
    await page.locator('#cd-effects-voice').click();
    await expect(page.locator('#cd-fx-enabled')).toBeChecked();
    const download = page.waitForEvent('download');
    await page.locator('#cd-download').click();
    expect((await download).suggestedFilename()).toMatch(/\.wav$/);
    if (await page.evaluate(() => typeof AudioEncoder !== 'undefined')) {
      await page.locator('#cd-export-kind').selectOption('opus');
      const opusDownload = page.waitForEvent('download');
      await page.locator('#cd-download').click();
      expect((await opusDownload).suggestedFilename()).toMatch(/\.webm$/);
    }
    await page.reload();
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('setup remains within phone width and unsupported capabilities are described', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto('/cadence/');
    await page.getByText('Recording setup', { exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 320, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#cd-applied')).toContainText('Applied settings appear after permission');
  });

  test('shows independently saved chunks after an interrupted recording', async ({ context, page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Uses Chromium fake media flags.');
    await context.grantPermissions(['microphone']);
    await page.goto('/cadence/');
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-record-status')).toContainText('Recording');
    await expect(page.locator('#cd-record-time')).toContainText('saved', { timeout: 10_000 });
    await page.waitForTimeout(1400);
    await page.close();
    const recovered = await context.newPage();
    await recovered.goto('/cadence/');
    await expect(recovered.locator('#cd-recovery')).toBeVisible();
    await expect(recovered.locator('#cd-recovery')).toContainText('Recording');
    const download = recovered.waitForEvent('download');
    await recovered.getByRole('button', { name: 'Save raw' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.(webm|ogg|m4a)$/);
  });

  test('reports denied microphone permission without creating a clip', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied for test', 'NotAllowedError'); };
    });
    await page.goto('/cadence/');
    if (!(await page.locator('#cd-record').isEnabled())) {
      await expect(page.locator('#cd-record')).toHaveAttribute('title', /does not offer microphone recording/);
      return;
    }
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-record-status')).toContainText('Permission denied for test');
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(0);
  });

  test('keeps two takes and renders a separate mix', async ({ context, page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Uses Chromium fake media flags.');
    await context.grantPermissions(['microphone']);
    await page.goto('/cadence/');
    for (let index = 0; index < 2; index += 1) {
      await page.locator('#cd-record').click();
      await page.waitForTimeout(1100);
      await page.locator('#cd-record').click();
      await expect(page.locator('#cd-list .cd-row')).toHaveCount(index + 1);
    }
    await page.locator('#cd-mix').click();
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(3);
    await expect(page.locator('#cd-name')).toHaveValue(/Mix/);
  });

  test('keeps countdown and named preset preferences after reload', async ({ context, page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Uses Chromium fake media flags.');
    await context.grantPermissions(['microphone']);
    await page.goto('/cadence/');
    await page.getByText('Recording setup', { exact: true }).click();
    await page.locator('#cd-countdown').selectOption('3');
    page.on('dialog', (dialog) => void dialog.accept('Interview'));
    await page.locator('#cd-save-preset').click();
    await expect(page.locator('#cd-preset')).toHaveValue('user:0');
    await page.reload();
    await page.getByText('Recording setup', { exact: true }).click();
    await expect(page.locator('#cd-countdown')).toHaveValue('3');
    await expect(page.locator('#cd-preset option')).toContainText(['Raw / Unprocessed', 'Voice', 'Podcast', 'Music', 'Custom', 'Interview']);
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-record-status')).toContainText('Recording starts in');
    await expect(page.locator('#cd-record-status')).toHaveText('Recording', { timeout: 8_000 });
    await page.locator('#cd-record').click();
  });

  test('punches a new take into a selection and retains its separate source', async ({ context, page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Uses Chromium fake media flags.');
    await context.grantPermissions(['microphone']);
    await page.goto('/cadence/');
    await page.locator('#cd-record').click();
    await page.waitForTimeout(1200);
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(1);
    const box = await page.locator('#cd-wave').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.5);
    await page.mouse.up();
    await page.locator('#cd-punch').click();
    await page.waitForTimeout(1200);
    await page.locator('#cd-record').click();
    await expect(page.locator('#cd-list .cd-row')).toHaveCount(2);
    await expect(page.locator('#cd-reset')).toBeEnabled();
  });
});
