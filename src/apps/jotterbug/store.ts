import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, expiredTrash, reviveNote, type Note, type NoteColor, type Shelf } from './model';

const DB_NAME = 'jotterbug';
const DB_VERSION = 1;
const STORE = 'notes';
const VIEW_KEY = 'jotterbug:view';

export type ViewPrefs = {
  layout: 'grid' | 'list';
  shelf: Shelf;
  label: string | null;
  color: NoteColor | null;
};

export const defaultView: ViewPrefs = { layout: 'grid', shelf: 'active', label: null, color: null };

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return {
    layout: raw.layout === 'list' ? 'list' : 'grid',
    shelf: raw.shelf === 'archived' || raw.shelf === 'trash' ? raw.shelf : 'active',
    label: typeof raw.label === 'string' ? raw.label : null,
    color: typeof raw.color === 'string' ? (raw.color as NoteColor) : null,
  };
}

export function saveView(view: ViewPrefs): void {
  writePref(VIEW_KEY, view);
}

let notes: Collection<Note> | null = null;

export async function notesStore(): Promise<Collection<Note>> {
  if (notes) return notes;
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    {
      name: STORE,
      keyPath: 'id',
      indexes: [
        { name: 'updatedAt', keyPath: 'updatedAt' },
        { name: 'archived', keyPath: 'archived' },
      ],
    },
  ]);
  notes = new Collection<Note>(db, STORE);
  return notes;
}

/** Loads every note, repairing anything malformed and clearing stale trash. */
export async function loadNotes(now: Date = new Date()): Promise<Note[]> {
  const store = await notesStore();
  const raw = await store.all();
  const revived = raw.map(reviveNote).filter((note): note is Note => note !== null);

  const stale = expiredTrash(revived, now);
  if (stale.length) {
    await store.deleteMany(stale.map((note) => note.id));
    const staleIds = new Set(stale.map((note) => note.id));
    return revived.filter((note) => !staleIds.has(note.id));
  }

  return revived;
}

export async function saveNote(note: Note): Promise<void> {
  const store = await notesStore();
  await store.put(note);
}

export async function saveNotes(list: Note[]): Promise<void> {
  const store = await notesStore();
  await store.putMany(list);
}

export async function deleteNote(id: string): Promise<void> {
  const store = await notesStore();
  await store.delete(id);
}

export async function deleteNotes(ids: string[]): Promise<void> {
  const store = await notesStore();
  await store.deleteMany(ids);
}

export async function clearAll(): Promise<void> {
  const store = await notesStore();
  await store.clear();
}

export type JotterbugExport = { notes: Note[] };

export async function buildExport(now: Date = new Date()) {
  const list = await loadNotes(now);
  return createEnvelope<JotterbugExport>(APP_ID, APP_VERSION, { notes: list }, { notes: list.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<JotterbugExport>(text, APP_ID);
  const incoming = Array.isArray(envelope.data.notes)
    ? envelope.data.notes.map(reviveNote).filter((note): note is Note => note !== null)
    : [];

  if (incoming.length === 0) {
    throw new Error('That export contains no readable notes.');
  }

  const store = await notesStore();
  if (mode === 'replace') {
    await store.replaceAll(incoming);
    return incoming.length;
  }

  const merged = mergeByNewest(await loadNotes(), incoming);
  await store.replaceAll(merged);
  return merged.length;
}
