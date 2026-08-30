import { createId } from '../../lib/id';

export const APP_ID = 'jotterbug';
export const APP_VERSION = 1;

export const NOTE_COLORS = [
  { id: 'paper', label: 'Paper', swatch: '#ffffff', ink: '#14161c' },
  { id: 'lemon', label: 'Lemon', swatch: '#fff5c9', ink: '#4a3c00' },
  { id: 'peach', label: 'Peach', swatch: '#ffe2d3', ink: '#5a2a12' },
  { id: 'rose', label: 'Rose', swatch: '#ffd9e2', ink: '#5c1c33' },
  { id: 'lilac', label: 'Lilac', swatch: '#e8ddff', ink: '#33215c' },
  { id: 'sky', label: 'Sky', swatch: '#d5ecff', ink: '#123a5c' },
  { id: 'mint', label: 'Mint', swatch: '#d3f2e4', ink: '#0d4634' },
  { id: 'sand', label: 'Sand', swatch: '#eae3d5', ink: '#4a3d22' },
] as const;

export type NoteColor = (typeof NOTE_COLORS)[number]['id'];
export const DEFAULT_COLOR: NoteColor = 'paper';

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type Note = {
  id: string;
  title: string;
  body: string;
  mode: 'text' | 'checklist';
  items: ChecklistItem[];
  color: NoteColor;
  labels: string[];
  pinned: boolean;
  archived: boolean;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Shelf = 'active' | 'archived' | 'trash';

export function createNote(partial: Partial<Note> = {}, now: Date = new Date()): Note {
  const stamp = now.toISOString();
  return {
    id: createId('note'),
    title: '',
    body: '',
    mode: 'text',
    items: [],
    color: DEFAULT_COLOR,
    labels: [],
    pinned: false,
    archived: false,
    trashedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...partial,
  };
}

export function createChecklistItem(text = ''): ChecklistItem {
  return { id: createId('item'), text, done: false };
}

export function touch(note: Note, changes: Partial<Note>, now: Date = new Date()): Note {
  return { ...note, ...changes, updatedAt: now.toISOString() };
}

/** True when a note has nothing worth keeping. */
export function isBlank(note: Note): boolean {
  if (note.title.trim()) return false;
  if (note.mode === 'checklist') return note.items.every((item) => !item.text.trim());
  return !note.body.trim();
}

export function shelfOf(note: Note): Shelf {
  if (note.trashedAt) return 'trash';
  if (note.archived) return 'archived';
  return 'active';
}

/** Converts prose into checklist lines, and checklist lines back into prose. */
export function switchMode(note: Note, mode: 'text' | 'checklist', now: Date = new Date()): Note {
  if (note.mode === mode) return note;

  if (mode === 'checklist') {
    const lines = note.body.split('\n').map((line) => line.trim()).filter(Boolean);
    const items = lines.map((line) => {
      const match = /^[-*•]?\s*\[( |x|X)\]\s*(.*)$/.exec(line);
      if (match) {
        const item = createChecklistItem(match[2]);
        item.done = match[1].toLowerCase() === 'x';
        return item;
      }
      return createChecklistItem(line.replace(/^[-*•]\s*/, ''));
    });
    return touch(note, { mode, items: items.length ? items : [createChecklistItem('')], body: '' }, now);
  }

  const body = note.items
    .filter((item) => item.text.trim())
    .map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`)
    .join('\n');
  return touch(note, { mode, body, items: [] }, now);
}

export function checklistProgress(note: Note): { done: number; total: number } {
  const filled = note.items.filter((item) => item.text.trim());
  return { done: filled.filter((item) => item.done).length, total: filled.length };
}

export type Filters = {
  shelf: Shelf;
  query: string;
  label: string | null;
  color: NoteColor | null;
};

export const emptyFilters: Filters = { shelf: 'active', query: '', label: null, color: null };

function haystack(note: Note): string {
  return [note.title, note.body, ...note.items.map((item) => item.text), ...note.labels]
    .join(' ')
    .toLowerCase();
}

export function matches(note: Note, filters: Filters): boolean {
  if (shelfOf(note) !== filters.shelf) return false;
  if (filters.label && !note.labels.includes(filters.label)) return false;
  if (filters.color && note.color !== filters.color) return false;

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  const words = query.split(/\s+/);
  const hay = haystack(note);
  return words.every((word) => hay.includes(word));
}

/** Pinned notes first, then most recently updated. Trash sorts by when it was binned. */
export function sortNotes(notes: Note[], shelf: Shelf): Note[] {
  return [...notes].sort((a, b) => {
    if (shelf === 'trash') return (b.trashedAt ?? '').localeCompare(a.trashedAt ?? '');
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function selectNotes(notes: Note[], filters: Filters): Note[] {
  return sortNotes(notes.filter((note) => matches(note, filters)), filters.shelf);
}

export function allLabels(notes: Note[]): string[] {
  const set = new Set<string>();
  for (const note of notes) for (const label of note.labels) set.add(label);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function countsByShelf(notes: Note[]): Record<Shelf, number> {
  const counts: Record<Shelf, number> = { active: 0, archived: 0, trash: 0 };
  for (const note of notes) counts[shelfOf(note)] += 1;
  return counts;
}

export function normaliseLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 32);
}

export function addLabel(note: Note, raw: string, now: Date = new Date()): Note {
  const label = normaliseLabel(raw);
  if (!label || note.labels.includes(label)) return note;
  return touch(note, { labels: [...note.labels, label].sort((a, b) => a.localeCompare(b)) }, now);
}

export function removeLabel(note: Note, label: string, now: Date = new Date()): Note {
  if (!note.labels.includes(label)) return note;
  return touch(note, { labels: note.labels.filter((item) => item !== label) }, now);
}

/** Notes binned longer than this are cleaned up on load. */
export const TRASH_RETENTION_DAYS = 30;

export function expiredTrash(notes: Note[], now: Date = new Date()): Note[] {
  const cutoff = now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return notes.filter((note) => note.trashedAt !== null && Date.parse(note.trashedAt) < cutoff);
}

export function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const note = value as Partial<Note>;
  return (
    typeof note.id === 'string' &&
    typeof note.title === 'string' &&
    typeof note.body === 'string' &&
    (note.mode === 'text' || note.mode === 'checklist') &&
    Array.isArray(note.items) &&
    Array.isArray(note.labels) &&
    typeof note.createdAt === 'string' &&
    typeof note.updatedAt === 'string'
  );
}

/** Repairs a note read from an untrusted file so the UI can rely on its shape. */
export function reviveNote(value: unknown): Note | null {
  if (!isNote(value)) return null;
  const known = new Set(NOTE_COLORS.map((color) => color.id));
  return {
    ...value,
    color: known.has(value.color) ? value.color : DEFAULT_COLOR,
    pinned: value.pinned === true,
    archived: value.archived === true,
    trashedAt: typeof value.trashedAt === 'string' ? value.trashedAt : null,
    labels: value.labels.filter((label): label is string => typeof label === 'string').map(normaliseLabel).filter(Boolean),
    items: value.items
      .filter((item): item is ChecklistItem => typeof item === 'object' && item !== null && typeof (item as ChecklistItem).text === 'string')
      .map((item) => ({ id: typeof item.id === 'string' ? item.id : createId('item'), text: item.text, done: item.done === true })),
  };
}
