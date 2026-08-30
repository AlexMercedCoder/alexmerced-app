import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import {
  APP_ID, APP_VERSION, createPage, defaultSettings, reviveCorners, revivePage, reviveSettings,
} from './model';
import {
  applyImport, buildExport, clearAll, deletePage, fromPortable, loadPages, loadSettings,
  savePage, saveSettings, storedBytes, toPortable, type FoolscapExport,
} from './store';

/** A tiny but structurally valid JPEG, so the size reader has something to read. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x30, 0x03, 0x01, 0x11,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('reviveSettings', () => {
  it('falls back for junk', () => {
    expect(reviveSettings(null)).toEqual(defaultSettings);
  });

  it('rejects a finish it does not know', () => {
    expect(reviveSettings({ finish: 'sepia' }).finish).toBe('contrast');
    expect(reviveSettings({ finish: 'blackAndWhite' }).finish).toBe('blackAndWhite');
  });

  it('clamps the resolution cap so a scan cannot be asked for at 40000 pixels', () => {
    expect(reviveSettings({ maxEdge: 100000 }).maxEdge).toBe(6000);
    expect(reviveSettings({ maxEdge: 10 }).maxEdge).toBe(600);
  });

  it('clamps quality into the range a JPEG encoder accepts', () => {
    expect(reviveSettings({ quality: 5 }).quality).toBe(1);
    expect(reviveSettings({ quality: 0 }).quality).toBe(0.3);
  });
});

describe('revivePage', () => {
  it('rejects a page with no image', () => {
    expect(revivePage({ id: 'a' })).toBeNull();
    expect(revivePage({ id: 'a', bytes: new Uint8Array(0) })).toBeNull();
  });

  it('rejects anything with no id', () => {
    expect(revivePage({ bytes: JPEG })).toBeNull();
  });

  it('replaces impossible dimensions', () => {
    const page = revivePage({ id: 'a', bytes: JPEG, width: -4, height: 0 })!;
    expect(page.width).toBe(1);
    expect(page.height).toBe(1);
  });
});

describe('reviveCorners', () => {
  it('accepts four finite points', () => {
    const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(reviveCorners(corners)).toEqual(corners);
  });

  it('rejects the wrong count', () => {
    expect(reviveCorners([{ x: 0, y: 0 }])).toBeNull();
  });

  it('rejects a point that is not a number', () => {
    expect(reviveCorners([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 'a', y: 1 }, { x: 0, y: 1 }])).toBeNull();
    expect(reviveCorners([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: NaN, y: 1 }, { x: 0, y: 1 }])).toBeNull();
  });
});

describe('storage', () => {
  it('starts empty', async () => {
    expect(await loadPages()).toEqual([]);
  });

  it('keeps pages in the order they were scanned', async () => {
    await savePage({ ...createPage(JPEG, 64, 48, 'contrast'), id: 'b', createdAt: '2026-02-01T00:00:00Z' });
    await savePage({ ...createPage(JPEG, 64, 48, 'contrast'), id: 'a', createdAt: '2026-01-01T00:00:00Z' });
    expect((await loadPages()).map((page) => page.id)).toEqual(['a', 'b']);
  });

  it('breaks a same-timestamp tie deterministically', async () => {
    const stamp = '2026-01-01T00:00:00Z';
    await savePage({ ...createPage(JPEG, 1, 1, 'contrast'), id: 'page_2', createdAt: stamp });
    await savePage({ ...createPage(JPEG, 1, 1, 'contrast'), id: 'page_1', createdAt: stamp });
    expect((await loadPages()).map((page) => page.id)).toEqual(['page_1', 'page_2']);
  });

  it('keeps the image bytes intact through IndexedDB', async () => {
    const page = createPage(JPEG, 64, 48, 'contrast');
    await savePage(page);
    expect((await loadPages())[0].bytes).toEqual(JPEG);
  });

  it('reports how much is stored', async () => {
    await savePage(createPage(JPEG, 64, 48, 'contrast'));
    expect(await storedBytes()).toBe(JPEG.length);
  });

  it('deletes only the page named', async () => {
    const a = { ...createPage(JPEG, 1, 1, 'contrast'), id: 'a' };
    const b = { ...createPage(JPEG, 1, 1, 'contrast'), id: 'b' };
    await savePage(a);
    await savePage(b);
    await deletePage('a');
    expect((await loadPages()).map((page) => page.id)).toEqual(['b']);
  });
});

describe('export and import', () => {
  it('exports every page with the settings', async () => {
    await savePage(createPage(JPEG, 64, 48, 'contrast'));
    saveSettings({ ...defaultSettings, pageSize: 'a4' });
    const envelope = await buildExport();
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts).toEqual({ pages: 1 });
    expect(envelope.data.settings.pageSize).toBe('a4');
  });

  it('restores the image bytes exactly', async () => {
    await savePage(createPage(JPEG, 64, 48, 'contrast'));
    const text = JSON.stringify(await buildExport());
    await clearAll();
    await applyImport(text, 'replace');
    expect((await loadPages())[0].bytes).toEqual(JPEG);
  });

  it('restores the settings', async () => {
    await savePage(createPage(JPEG, 1, 1, 'contrast'));
    saveSettings({ ...defaultSettings, finish: 'grayscale' });
    const text = JSON.stringify(await buildExport());
    localStorage.clear();
    await applyImport(text, 'replace');
    expect(loadSettings().finish).toBe('grayscale');
  });

  it('adds pages on merge without duplicating what is here', async () => {
    const mine = { ...createPage(JPEG, 1, 1, 'contrast'), id: 'mine' };
    await savePage(mine);
    const theirs = { ...createPage(JPEG, 1, 1, 'contrast'), id: 'theirs' };
    const text = JSON.stringify(createEnvelope<FoolscapExport>(
      APP_ID, APP_VERSION, { pages: [toPortable(mine), toPortable(theirs)], settings: defaultSettings }, {},
    ));
    expect(await applyImport(text, 'merge')).toBe(2);
  });

  it('skips a broken page rather than failing the import', async () => {
    const good = toPortable(createPage(JPEG, 1, 1, 'contrast'));
    const text = JSON.stringify(createEnvelope<FoolscapExport>(
      APP_ID, APP_VERSION, { pages: [{ ...good, id: 'bad', bytes: '@@@' }, good], settings: defaultSettings }, {},
    ));
    expect(await applyImport(text, 'replace')).toBe(1);
  });

  it('refuses an export from another app', async () => {
    const text = JSON.stringify(createEnvelope('loupe', 1, { pages: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow();
  });

  it('refuses an export with no pages', async () => {
    const text = JSON.stringify(createEnvelope<FoolscapExport>(
      APP_ID, APP_VERSION, { pages: [], settings: defaultSettings }, {},
    ));
    await expect(applyImport(text, 'merge')).rejects.toThrow(/no readable pages/);
  });

  it('round trips a page through base64 unchanged', () => {
    const page = createPage(JPEG, 64, 48, 'blackAndWhite');
    const restored = fromPortable(toPortable(page))!;
    expect(restored.bytes).toEqual(JPEG);
    expect(restored.finish).toBe('blackAndWhite');
  });
});
