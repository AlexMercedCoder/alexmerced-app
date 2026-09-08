import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Download } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function load(page: Page) {
  await page.goto('/limelight');
  await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'limelight');
  await page.locator('#ll-file').setInputFiles({
    name: 'Review sample.webm',
    mimeType: 'video/webm',
    buffer: await readFile(new URL('../fixtures/limelight-gaps.webm', import.meta.url)),
  });
  await expect(page.locator('#ll-stage')).toBeVisible();
  await expect(page.locator('.ll-project')).toHaveCount(1);
}
async function captions(page: Page) {
  await page.locator('#ll-captions-file').setInputFiles({
    name: 'words.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '1\n00:00:00,200 --> 00:00:01,000\nAlpha demo\n\n2\n00:00:01,200 --> 00:00:02,000\nBeta demo\n',
    ),
  });
  await expect(page.locator('.ll-cue')).toHaveCount(2);
}
async function disclose(page: Page, selector: string) {
  await page.locator(selector).evaluate((el) => {
    const details = el.closest('details');
    if (details) details.open = true;
  });
}
async function seek(page: Page, time: number) {
  await page.locator('#ll-scrub').evaluate((el: HTMLInputElement, t) => {
    el.value = String(t);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, time);
}
async function metadata(page: Page, download: Download) {
  const file = await readFile((await download.path())!);
  expect(file.includes(Buffer.from('A_OPUS'))).toBe(true);
  const bytes = file.toString('base64');
  return page.evaluate(async (bytes) => {
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], { type: 'video/webm' }),
    );
    const video = document.createElement('video');
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(Error('Cannot decode export'));
        video.src = url;
      });
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }, bytes);
}
test('transcript corrections, timing, styles and checkpoints survive reload', async ({ page }) => {
  await load(page);
  await captions(page);
  await page.locator('#ll-transcript-tools summary').click();
  await page.getByLabel('Find in transcript').fill('demo');
  await expect(page.locator('#ll-transcript-count')).toHaveText('2 matching lines');
  await page.getByLabel('Replace with').fill('example');
  await page.getByRole('button', { name: 'Replace all matches' }).click();
  await expect(page.locator('.ll-cue textarea').first()).toHaveValue('Alpha example');
  await page.getByLabel('Find in transcript').fill('Beta');
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(page.locator('.ll-cue textarea').last()).toBeFocused();
  await page.getByLabel('Start of subtitle Beta example', { exact: true }).fill('0.9');
  await page.getByLabel('Start of subtitle Beta example', { exact: true }).press('Tab');
  await expect(page.locator('#ll-cue-overlaps')).toContainText('2 subtitle lines overlap');
  await page.locator('.ll-cue input[type=checkbox]').first().check();
  await page.locator('.ll-cue input[type=checkbox]').last().check();
  await page.getByRole('button', { name: 'Merge selected lines' }).click();
  await expect(page.locator('.ll-cue')).toHaveCount(1);
  await page.getByLabel('Shift all subtitles (seconds)').fill('0.1');
  await page.getByRole('button', { name: 'Shift timing', exact: true }).click();
  await page.getByRole('combobox', { name: 'Caption font', exact: true }).selectOption('mono');
  await page.getByRole('combobox', { name: 'Caption position', exact: true }).selectOption('top');
  await page.getByLabel('Caption style name', { exact: true }).fill('Tutorial');
  await page.getByRole('button', { name: 'Save caption style', exact: true }).click();
  await page.getByLabel('Version name', { exact: true }).fill('Before split');
  await page.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(page.locator('#ll-tools-status')).toContainText('Checkpoint saved');
  await seek(page, 1);
  await page.getByRole('button', { name: 'Split at playhead', exact: true }).click();
  await expect(page.locator('.ll-cue')).toHaveCount(2);
  await page
    .getByRole('combobox', { name: 'Saved checkpoint', exact: true })
    .selectOption({ label: 'Checkpoint: Before split' });
  await page.getByRole('button', { name: 'Restore a copy', exact: true }).click();
  await expect(page.locator('#ll-tools-status')).toContainText('Opened a restored copy');
  await expect(page.locator('.ll-cue')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'limelight');
  await expect(page.locator('.ll-cue')).toHaveCount(1);
  await expect(page.locator('#ll-style-font')).toHaveValue('mono');
  await expect(page.locator('#ll-style-position')).toHaveValue('top');
  await page.locator('#ll-transcript-tools summary').click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download transcript', exact: true }).click();
  expect(await readFile((await (await pending).path())!, 'utf8')).toContain(
    'Alpha example Beta example',
  );
});
test('timeline zoom, framing guides and clean thumbnail exports', async ({ page }) => {
  await load(page);
  await page.getByRole('combobox', { name: 'Timeline zoom', exact: true }).selectOption('4');
  const ratio = await page
    .locator('#ll-trim')
    .evaluate((el) => el.clientWidth / el.parentElement!.clientWidth);
  expect(ratio).toBeGreaterThan(3.8);
  await page.getByLabel('Show 10% framing guides', { exact: true }).check();
  await expect(page.locator('#ll-safe-guide')).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save frame as PNG' }).click();
  const image = await pending;
  const bytes = await readFile((await image.path())!);
  expect(bytes.readUInt32BE(16)).toBe(1920);
  expect(bytes.readUInt32BE(20)).toBe(1080);
  await page
    .locator('#ll-tools details')
    .evaluateAll((elements) => elements.forEach((el) => ((el as HTMLDetailsElement).open = true)));
  const results = await new AxeBuilder({ page }).include('#ll-tools').analyze();
  expect(results.violations).toEqual([]);
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});
test('silence proposals can be reviewed, applied and undone', async ({ page }) => {
  await load(page);
  await page.locator('#ll-silence-tools summary').click();
  await expect(page.locator('#ll-wavewrap')).toBeAttached();
  await page.getByRole('button', { name: 'Find proposed cuts', exact: true }).click();
  await expect(page.locator('#ll-silence-list li')).not.toHaveCount(0);
  await page.locator('#ll-silence-list button').first().click();
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
  await page.getByRole('button', { name: 'Apply selected cuts', exact: true }).click();
  await expect(page.locator('#ll-tools-status')).toContainText('Applied');
  await expect(page.locator('.ll-cutband')).not.toHaveCount(0);
  await page.locator('#ll-undo').click();
  await expect(page.locator('.ll-cutband')).toHaveCount(0);
});
test('test exports and queued framing versions produce decodable files', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Video encoding requires the supported Chromium WebCodecs path.',
  );
  await load(page);
  await page.getByRole('combobox', { name: 'Output size', exact: true }).selectOption('480p');
  await page.locator('#ll-export-tools summary').click();
  await page.getByRole('button', { name: 'Review current export', exact: true }).click();
  await expect(page.locator('#ll-export-summary')).toContainText('854 × 480');
  await page.getByLabel('Test start in finished video (seconds)').fill('1');
  await page.getByLabel('Test length (seconds)').fill('0.5');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export test range', exact: true }).click();
  const meta = await metadata(page, await pending);
  expect(meta.width).toBe(854);
  expect(meta.height).toBe(480);
  expect(meta.duration).toBeGreaterThan(0.4);
  expect(meta.duration).toBeLessThan(0.7);
  await page.getByLabel('Export version name', { exact: true }).fill('Landscape');
  await page.getByRole('button', { name: 'Add current version', exact: true }).click();
  await expect(page.locator('#ll-export-queue li')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Output size', exact: true }).selectOption('square');
  await page.getByLabel('Export version name', { exact: true }).fill('Square');
  await page.getByRole('button', { name: 'Add current version', exact: true }).click();
  await expect(page.locator('#ll-export-queue li')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Output size', exact: true }).selectOption('720p');
  await page.getByRole('button', { name: 'Run export queue', exact: true }).click();
  await expect(page.locator('#ll-export-queue a')).toHaveCount(2, { timeout: 90000 });
  for (const [i, size] of [
    [0, 854],
    [1, 1080],
  ]) {
    const pending = page.waitForEvent('download');
    await page.locator('#ll-export-queue a').nth(i).click();
    const meta = await metadata(page, await pending);
    expect(meta.width).toBe(size);
    expect(meta.height).toBe(i === 0 ? 480 : 1080);
  }
});
test('queued exports cancel and retain a retryable entry', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Video encoding requires Chromium WebCodecs.');
  await load(page);
  await page.locator('#ll-export-tools summary').click();
  await page.getByRole('button', { name: 'Add current version', exact: true }).click();
  await expect(page.locator('#ll-export-queue li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Run export queue', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel export queued versions', exact: true }).click();
  await expect(page.locator('#ll-export-queue li')).toContainText('Cancelled');
  await expect(page.locator('#ll-export-queue a')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run export queue', exact: true })).toBeEnabled();
});

test('recording setup releases camera and microphone tracks on close', async ({
  playwright,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Uses Chromium synthetic camera and microphone devices.');
  const browser = await playwright.chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4329/limelight');
    await expect(page.locator('main')).toHaveAttribute('data-workspace-ready', 'limelight');
    await page.locator('#ll-mic').check();
    await page.locator('#ll-camera').check();
    await page.locator('#ll-device-check').click();
    await expect(page.locator('#ll-device-status')).toContainText('Microphone:');
    await expect(page.locator('#ll-device-status')).toContainText('Camera:');
    const tracks = await page
      .locator('#ll-device-video')
      .evaluateHandle((el: HTMLVideoElement) => (el.srcObject as MediaStream).getTracks());
    expect(await tracks.evaluate((tracks) => tracks.every((t) => t.readyState === 'live'))).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Close setup', exact: true }).click();
    await expect(page.locator('#ll-device-dialog')).not.toBeVisible();
    expect(await tracks.evaluate((tracks) => tracks.every((t) => t.readyState === 'ended'))).toBe(
      true,
    );
    await page.locator('#ll-device-check').click();
    await expect(page.locator('#ll-device-status')).toContainText('Microphone:');
    await page.keyboard.press('Escape');
    await expect(page.locator('#ll-device-dialog')).not.toBeVisible();
  } finally {
    await browser.close();
  }
});
test('burned captions keep the edited clock in thumbnails and short exports', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Verifies pixels from a Chromium encoded export.');
  await load(page);
  await captions(page);
  await page.getByRole('combobox', { name: 'Output size', exact: true }).selectOption('480p');
  await disclose(page, '#ll-captions-burn');
  await page.locator('#ll-captions-burn').check();
  await page.locator('#ll-transcript-tools summary').click();
  await page.locator('#ll-style-color').fill('#00ff00');
  await page.locator('#ll-style-color').dispatchEvent('change');
  await seek(page, 1);
  await page.locator('#ll-trim-start').click();
  await seek(page, 1.5);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save frame as PNG' }).click();
  const image = await pending;
  async function green(download: Download, isVideo: boolean) {
    const bytes = (await readFile((await download.path())!)).toString('base64');
    return page.evaluate(
      async ({ bytes, isVideo }) => {
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], {
            type: isVideo ? 'video/webm' : 'image/png',
          }),
        );
        const source = isVideo ? document.createElement('video') : new Image();
        await new Promise<void>((resolve, reject) => {
          source.addEventListener(isVideo ? 'loadeddata' : 'load', () => resolve(), { once: true });
          source.addEventListener('error', () => reject(Error('Decode failed')), { once: true });
          source.src = url;
        });
        if (isVideo) {
          const video = source as HTMLVideoElement;
          await new Promise<void>((resolve) => {
            video.addEventListener('seeked', () => resolve(), { once: true });
            video.currentTime = Math.min(0.04, video.duration / 2);
          });
        }
        const canvas = document.createElement('canvas');
        canvas.width = 854;
        canvas.height = 480;
        const c = canvas.getContext('2d')!;
        c.drawImage(source, 0, 0);
        const pixels = c.getImageData(0, 0, 854, 480).data;
        let found = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i + 1] > 140 && pixels[i] < 90 && pixels[i + 2] < 90) found++;
        URL.revokeObjectURL(url);
        return found;
      },
      { bytes, isVideo },
    );
  }
  expect(await green(image, false)).toBeGreaterThan(50);
  await page.locator('#ll-export-tools summary').click();
  await page.getByLabel('Test start in finished video (seconds)').fill('0.5');
  await page.getByLabel('Test length (seconds)').fill('0.2');
  const testExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export test range', exact: true }).click();
  expect(await green(await testExport, true)).toBeGreaterThan(50);
});
