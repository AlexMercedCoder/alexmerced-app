import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, APP_VERSION } from './sql';
import {
  applyImport, buildExport, clearAll, createQuery, deleteQuery, loadDraft, loadLimit,
  loadQueries, reviveQuery, saveDraft, saveLimit, saveQuery, type QuarryExport,
} from './store';

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('reviveQuery', () => {
  it('needs an id and some SQL', () => {
    expect(reviveQuery({ sql: 'SELECT 1' })).toBeNull();
    expect(reviveQuery({ id: 'a' })).toBeNull();
    expect(reviveQuery({ id: 'a', sql: '   ' })).toBeNull();
    expect(reviveQuery(null)).toBeNull();
  });

  it('names an unnamed query', () => {
    expect(reviveQuery({ id: 'a', sql: 'SELECT 1' })!.name).toBe('Untitled query');
  });

  it('round trips through JSON unchanged', () => {
    const query = createQuery('Mine', 'SELECT 1', new Date('2026-01-01T00:00:00Z'));
    expect(reviveQuery(JSON.parse(JSON.stringify(query)))).toEqual(query);
  });
});

describe('preferences', () => {
  it('remembers the draft', () => {
    expect(loadDraft()).toBe('');
    saveDraft('SELECT 42;');
    expect(loadDraft()).toBe('SELECT 42;');
  });

  it('clamps the row limit into something a table can hold', () => {
    saveLimit(5);
    expect(loadLimit()).toBe(10);
    saveLimit(9_999_999);
    expect(loadLimit()).toBe(200000);
    saveLimit(1000);
    expect(loadLimit()).toBe(1000);
  });
});

describe('storage', () => {
  it('starts empty', async () => {
    expect(await loadQueries()).toEqual([]);
  });

  it('lists the most recently edited first', async () => {
    await saveQuery({ ...createQuery('old', 'SELECT 1'), id: 'a', updatedAt: '2026-01-01T00:00:00Z' });
    await saveQuery({ ...createQuery('new', 'SELECT 2'), id: 'b', updatedAt: '2026-06-01T00:00:00Z' });
    expect((await loadQueries()).map((query) => query.id)).toEqual(['b', 'a']);
  });

  it('deletes only the one named', async () => {
    await saveQuery({ ...createQuery('a', 'SELECT 1'), id: 'a' });
    await saveQuery({ ...createQuery('b', 'SELECT 2'), id: 'b' });
    await deleteQuery('a');
    expect((await loadQueries()).map((query) => query.id)).toEqual(['b']);
  });
});

describe('export and import', () => {
  it('exports with a count', async () => {
    await saveQuery(createQuery('One', 'SELECT 1'));
    const envelope = await buildExport();
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts).toEqual({ queries: 1 });
  });

  it('replaces everything on replace', async () => {
    await saveQuery(createQuery('Old', 'SELECT 1'));
    const fresh = { ...createQuery('New', 'SELECT 2'), id: 'query_new' };
    const text = JSON.stringify(createEnvelope<QuarryExport>(APP_ID, APP_VERSION, { queries: [fresh] }, {}));
    expect(await applyImport(text, 'replace')).toBe(1);
    expect((await loadQueries()).map((query) => query.name)).toEqual(['New']);
  });

  it('keeps the newer side on merge', async () => {
    const mine = { ...createQuery('Mine', 'SELECT 1'), id: 'same', updatedAt: '2026-06-01T00:00:00Z' };
    await saveQuery(mine);
    const theirs = { ...mine, name: 'Theirs', updatedAt: '2026-01-01T00:00:00Z' };
    const text = JSON.stringify(createEnvelope<QuarryExport>(APP_ID, APP_VERSION, { queries: [theirs] }, {}));
    await applyImport(text, 'merge');
    expect((await loadQueries())[0].name).toBe('Mine');
  });

  it('refuses an export from another app', async () => {
    const text = JSON.stringify(createEnvelope('decanter', 1, { queries: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow();
  });

  it('refuses an export with nothing readable', async () => {
    const text = JSON.stringify(createEnvelope<QuarryExport>(APP_ID, APP_VERSION, { queries: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow(/no readable queries/);
  });

  it('survives a full round trip', async () => {
    await saveQuery({ ...createQuery('Round', "SELECT 'a;b' FROM t"), id: 'q1' });
    const text = JSON.stringify(await buildExport());
    await clearAll();
    await applyImport(text, 'replace');
    expect((await loadQueries())[0].sql).toBe("SELECT 'a;b' FROM t");
  });
});
