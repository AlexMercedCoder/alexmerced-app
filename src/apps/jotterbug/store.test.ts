import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, createNote, type Note } from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deleteNote,
  loadNotes,
  loadView,
  saveNote,
  saveView,
} from './store';

const note = (overrides: Partial<Note> = {}) => createNote(overrides, new Date('2026-01-01T00:00:00Z'));

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('note persistence', () => {
  it('round trips a note through IndexedDB', async () => {
    const saved = note({ title: 'Remember' });
    await saveNote(saved);
    const loaded = await loadNotes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe('Remember');
  });

  it('updates an existing note rather than duplicating it', async () => {
    const original = note({ title: 'One' });
    await saveNote(original);
    await saveNote({ ...original, title: 'Two' });
    const loaded = await loadNotes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe('Two');
  });

  it('deletes a note', async () => {
    const saved = note();
    await saveNote(saved);
    await deleteNote(saved.id);
    expect(await loadNotes()).toHaveLength(0);
  });

  it('sweeps trash older than the retention window on load', async () => {
    await saveNote(note({ id: 'old', trashedAt: '2026-01-01T00:00:00Z' }));
    await saveNote(note({ id: 'fresh', trashedAt: '2026-03-01T00:00:00Z' }));
    const loaded = await loadNotes(new Date('2026-03-05T00:00:00Z'));
    expect(loaded.map((n) => n.id)).toEqual(['fresh']);
    expect(await loadNotes(new Date('2026-03-05T00:00:00Z'))).toHaveLength(1);
  });
});

describe('view preferences', () => {
  it('defaults sensibly', () => {
    expect(loadView()).toEqual({ layout: 'grid', shelf: 'active', label: null, color: null });
  });

  it('round trips and rejects nonsense', () => {
    saveView({ layout: 'list', shelf: 'trash', label: 'work', color: 'mint' });
    expect(loadView().layout).toBe('list');
    saveView({ layout: 'spiral' as 'grid', shelf: 'nowhere' as 'active', label: null, color: null });
    expect(loadView().layout).toBe('grid');
    expect(loadView().shelf).toBe('active');
  });
});

describe('export and import', () => {
  it('exports every note with a count', async () => {
    await saveNote(note({ title: 'a' }));
    await saveNote(note({ title: 'b' }));
    const envelope = await buildExport(new Date('2026-04-01T00:00:00Z'));
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts.notes).toBe(2);
    expect(envelope.data.notes).toHaveLength(2);
  });

  it('replaces the whole store on replace', async () => {
    await saveNote(note({ id: 'local', title: 'local' }));
    const file = JSON.stringify(createEnvelope(APP_ID, 1, { notes: [note({ id: 'file', title: 'file' })] }, { notes: 1 }));
    const count = await applyImport(file, 'replace');
    expect(count).toBe(1);
    expect((await loadNotes())[0].id).toBe('file');
  });

  it('merges and keeps the newer copy of a conflicting note', async () => {
    await saveNote(note({ id: 'shared', title: 'local wins', updatedAt: '2026-06-01T00:00:00Z' }));
    const file = JSON.stringify(
      createEnvelope(APP_ID, 1, { notes: [note({ id: 'shared', title: 'file loses', updatedAt: '2026-01-01T00:00:00Z' })] }, { notes: 1 }),
    );
    await applyImport(file, 'merge');
    const loaded = await loadNotes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe('local wins');
  });

  it('adds notes the local store has never seen', async () => {
    await saveNote(note({ id: 'local' }));
    const file = JSON.stringify(createEnvelope(APP_ID, 1, { notes: [note({ id: 'incoming' })] }, { notes: 1 }));
    expect(await applyImport(file, 'merge')).toBe(2);
  });

  it('refuses a file with no readable notes', async () => {
    const file = JSON.stringify(createEnvelope(APP_ID, 1, { notes: [{ junk: true }] }, { notes: 1 }));
    await expect(applyImport(file, 'merge')).rejects.toThrow(/no readable notes/);
  });

  it('refuses a file from a different app', async () => {
    const file = JSON.stringify(createEnvelope('laneway', 1, { boards: [] }, {}));
    await expect(applyImport(file, 'merge')).rejects.toThrow(/came from "laneway"/);
  });
});
