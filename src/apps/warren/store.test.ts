import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, childrenOf, createPage, livePages, type Page } from './model';
import { applyImport, buildExport, clearAll, deletePages, loadPages, loadView, savePage, saveView } from './store';

const NOW = new Date('2026-06-15T12:00:00Z');
const page = (id: string, title: string, parentId: string | null = null, updatedAt = NOW.toISOString()): Page => ({
  ...createPage(parentId, title, NOW),
  id,
  updatedAt,
});

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('first run', () => {
  it('seeds starter pages so the app is never blank', async () => {
    const pages = await loadPages(NOW);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(childrenOf(pages, null)).toHaveLength(1);
  });

  it('does not re-seed on the second load', async () => {
    const first = await loadPages(NOW);
    const second = await loadPages(NOW);
    expect(second).toHaveLength(first.length);
  });
});

describe('persistence', () => {
  it('round trips pages through IndexedDB', async () => {
    await clearAll();
    await savePage(page('a', 'Alpha'));
    await savePage(page('b', 'Beta', 'a'));
    const pages = await loadPages(NOW);
    expect(pages.map((p) => p.title).sort()).toEqual(['Alpha', 'Beta']);
    expect(childrenOf(pages, 'a').map((p) => p.title)).toEqual(['Beta']);
  });

  it('repairs a parent that no longer exists', async () => {
    await clearAll();
    await savePage(page('orphan', 'Orphan', 'gone'));
    const pages = await loadPages(NOW);
    expect(pages[0].parentId).toBeNull();
  });

  it('deletes a set of pages', async () => {
    await clearAll();
    await savePage(page('a', 'A'));
    await savePage(page('b', 'B'));
    await deletePages(['a']);
    expect((await loadPages(NOW)).map((p) => p.id)).toEqual(['b']);
  });
});

describe('view preferences', () => {
  it('defaults to an open sidebar and no page', () => {
    expect(loadView()).toEqual({ openPageId: null, sidebarOpen: true, showTrash: false });
  });

  it('round trips', () => {
    saveView({ openPageId: 'p1', sidebarOpen: false, showTrash: true });
    expect(loadView()).toEqual({ openPageId: 'p1', sidebarOpen: false, showTrash: true });
  });
});

describe('export and import', () => {
  const fileWith = (pages: Page[]) =>
    JSON.stringify(createEnvelope(APP_ID, 1, { pages }, { pages: pages.length }));

  it('exports every page with a count', async () => {
    const pages = await loadPages(NOW);
    const envelope = await buildExport(NOW);
    expect(envelope.counts.pages).toBe(pages.length);
    expect(envelope.app).toBe(APP_ID);
  });

  it('replaces the whole workspace on replace', async () => {
    await loadPages(NOW);
    const count = await applyImport(fileWith([page('only', 'Only page')]), 'replace');
    expect(count).toBe(1);
    expect((await loadPages(NOW)).map((p) => p.title)).toEqual(['Only page']);
  });

  it('merges and keeps the newer copy', async () => {
    await clearAll();
    await savePage(page('shared', 'Local wins', null, '2026-06-01T00:00:00Z'));
    await applyImport(fileWith([page('shared', 'File loses', null, '2026-01-01T00:00:00Z')]), 'merge');
    expect((await loadPages(NOW))[0].title).toBe('Local wins');
  });

  it('repairs an imported tree with a cycle', async () => {
    await clearAll();
    const a = { ...page('a', 'A'), parentId: 'b' };
    const b = { ...page('b', 'B'), parentId: 'a' };
    await applyImport(fileWith([a, b]), 'replace');
    const pages = await loadPages(NOW);
    expect(childrenOf(pages, null).length).toBeGreaterThan(0);
    expect(livePages(pages)).toHaveLength(2);
  });

  it('refuses an export with nothing readable', async () => {
    await expect(applyImport(fileWith([]), 'replace')).rejects.toThrow(/no readable pages/);
  });

  it('refuses a file from another app', async () => {
    const file = JSON.stringify(createEnvelope('tessera', 1, { codes: [] }, {}));
    await expect(applyImport(file, 'merge')).rejects.toThrow(/came from "tessera"/);
  });
});
