import { expect, test, type Page } from '@playwright/test';

/** A real tiny WebM made by the browser, so the test carries no binary fixture. */
async function videoFile(page: Page, name: string, colour: string, milliseconds: number) {
  const base64 = await page.evaluate(async ({ colour, milliseconds }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.fillStyle = colour; context.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(12);
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const quiet = audio.createGain();
    const audioOut = audio.createMediaStreamDestination();
    quiet.gain.value = 0.08;
    tone.frequency.value = colour === '#185adb' ? 440 : 660;
    tone.connect(quiet).connect(audioOut);
    tone.start();
    stream.addTrack(audioOut.stream.getAudioTracks()[0]);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.start();
    const timer = window.setInterval(() => {
      context.fillStyle = colour; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff'; context.fillRect(Math.random() * 260, 70, 50, 40);
    }, 50);
    await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    window.clearInterval(timer);
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.stop(); await stopped;
    tone.stop(); await audio.close();
    stream.getTracks().forEach((track) => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { colour, milliseconds });
  return { name, mimeType: 'video/webm', buffer: Buffer.from(base64, 'base64') };
}

test('add, reorder, edit, split, remove, undo, save and reload a reel', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto('/limelight');
  const first = await videoFile(page, 'blue.webm', '#185adb', 700);
  const second = await videoFile(page, 'orange.webm', '#dc6b19', 900);

  await page.locator('#ll-file').setInputFiles(first);
  await expect(page.locator('#ll-stage')).toBeVisible();
  await page.locator('#ll-clip-file').setInputFiles(second);
  await expect(page.locator('.ll-clip')).toHaveCount(2);
  await expect(page.locator('.ll-clip__thumb')).toHaveCount(2);

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
  await expect(page.locator('.ll-clip')).toHaveCount(3);
  await expect(page.getByLabel('Name clip 1')).toHaveValue('Opening');

  await page.locator('.ll-clip').first().locator('summary').click();
  await page.locator('.ll-clip').first().getByRole('button', { name: 'Smooth next join' }).click();
  await expect(page.locator('.ll-clip').first().getByText('Fade out').locator('input')).toHaveValue('0.18');

  await page.getByLabel('Output size').selectOption({ label: '1280 by 720' });
  // Format lives in a collapsed advanced panel. Change it as a user setting
  // without coupling this workflow test to that panel's disclosure state.
  const usingMp4 = await page.locator('#ll-format').evaluate((select: HTMLSelectElement) => {
    const mp4 = select.querySelector<HTMLOptionElement>('option[value="mp4"]');
    if (mp4 && !mp4.disabled) {
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
  expect(browserErrors).toEqual([]);
});
