import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

/** Independent, deterministic clips avoid short MediaRecorder captures with no frames. */
async function videoFile(colour: 'blue' | 'orange') {
  return {
    name: `${colour}.webm`, mimeType: 'video/webm',
    buffer: await readFile(new URL(`../fixtures/ffmpeg-${colour}.webm`, import.meta.url)),
  };
}

test('add, reorder, edit, split, remove, undo, save and reload a reel', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The full export workflow requires Chromium WebCodecs support.');
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto('/limelight');
  const first = await videoFile('blue');
  const second = await videoFile('orange');

  await page.locator('#ll-file').setInputFiles(first);
  await expect(page.locator('#ll-stage'), await page.locator('#ll-status').textContent() ?? '').toBeVisible();
  await page.locator('#ll-clip-file').setInputFiles(second);
  await expect(page.locator('.ll-clip')).toHaveCount(2);
  await expect(page.locator('.ll-clip__thumb')).toHaveCount(2);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Move clip 2 earlier', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ll-status')).toContainText('Moved a clip earlier');
  await page.getByRole('button', { name: 'Move clip 1 later', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ll-status')).toContainText('Moved a clip later');

  await page.locator('.ll-clip').nth(1).dragTo(page.locator('.ll-clip').first());
  await expect(page.locator('#ll-status')).toContainText('Reordered the clips');

  const firstName = page.getByLabel('Name clip 1');
  await firstName.fill('Opening');
  await firstName.press('Tab');
  await expect(firstName).toHaveValue('Opening');

  await page.locator('.ll-clip').first().locator('summary').click();
  await page.locator('.ll-clip').first().getByText('Out', { exact: true }).locator('input').fill('0.8');
  await page.locator('.ll-clip').first().getByText('Out', { exact: true }).locator('input').press('Tab');
  await page.locator('.ll-clip').first().locator('summary').click();
  await page.locator('.ll-clip').first().getByText('Volume').locator('input').fill('0.65');
  await page.locator('.ll-clip').first().getByText('Volume').locator('input').press('Tab');

  await page.locator('#ll-scrub').fill('0.36');
  await page.locator('#ll-split-clip').click();
  await expect(page.locator('.ll-clip')).toHaveCount(3);

  await page.getByRole('button', { name: 'Remove clip 3' }).click();
  await expect(page.locator('.ll-clip')).toHaveCount(2);
  await page.locator('#ll-undo').click();
  await expect(page.locator('.ll-clip')).toHaveCount(3);

  await page.waitForTimeout(900);
  await page.reload();
  // Reopening must restore even a project with an empty automatic zoom track.
  await expect(page.locator('.ll-clip')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByLabel('Name clip 1')).toHaveValue('Opening');

  await page.locator('.ll-clip').first().locator('summary').click();
  await page.locator('.ll-clip').first().getByRole('button', { name: 'Smooth next join' }).click();
  await expect(page.locator('.ll-clip').first().getByText('Fade out').locator('input')).toHaveValue('0.18');

  await page.getByLabel('Output size').selectOption({ label: '1280 by 720' });
  // Format lives in a collapsed advanced panel. Change it as a user setting
  // without coupling this workflow test to that panel's disclosure state.
  const usingMp4 = await page.locator('#ll-format').evaluate(async (select: HTMLSelectElement) => {
    const mp4 = select.querySelector<HTMLOptionElement>('option[value="mp4"]');
    // H.264 support does not imply AAC support in every Chromium build.
    const aac = typeof AudioEncoder !== 'undefined' && await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000,
    }).then(config => config.supported === true).catch(() => false);
    if (mp4 && !mp4.disabled && aac) {
      select.value = 'mp4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  });
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.locator('#ll-export').click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(usingMp4 ? /\.mp4$/ : /\.webm$/);
  if (usingMp4) await expect(page.locator('#ll-status')).not.toContainText('Opus');
  const encoded = (await readFile((await exported.path())!)).toString('base64');
  const metadata = await page.evaluate(async ({ encoded, mime }) => {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const video = document.createElement('video');
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('The browser cannot decode the exported file.'));
      });
      video.src = url;
      await loaded;
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  }, { encoded, mime: usingMp4 ? 'video/mp4' : 'video/webm' });
  expect(metadata.width).toBe(1280);
  expect(metadata.height).toBe(720);
  expect(metadata.duration).toBeGreaterThan(0);
  expect(Number.isFinite(metadata.duration)).toBe(true);
  expect(browserErrors).toEqual([]);
});
