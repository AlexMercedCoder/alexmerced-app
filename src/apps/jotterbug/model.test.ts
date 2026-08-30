import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLOR,
  NOTE_COLORS,
  TRASH_RETENTION_DAYS,
  addLabel,
  allLabels,
  checklistProgress,
  countsByShelf,
  createChecklistItem,
  createNote,
  emptyFilters,
  expiredTrash,
  isBlank,
  matches,
  normaliseLabel,
  removeLabel,
  reviveNote,
  selectNotes,
  shelfOf,
  sortNotes,
  switchMode,
  touch,
  type Note,
} from './model';

const at = (iso: string) => new Date(iso);

const note = (overrides: Partial<Note> = {}) =>
  createNote(overrides, at('2026-01-01T00:00:00Z'));

describe('createNote', () => {
  it('starts blank, unpinned, and on the active shelf', () => {
    const fresh = note();
    expect(fresh.title).toBe('');
    expect(fresh.pinned).toBe(false);
    expect(shelfOf(fresh)).toBe('active');
    expect(fresh.color).toBe(DEFAULT_COLOR);
  });

  it('gives every note a distinct id', () => {
    expect(note().id).not.toBe(note().id);
  });
});

describe('isBlank', () => {
  it('treats an empty note as blank', () => {
    expect(isBlank(note())).toBe(true);
  });

  it('a title alone is enough to keep', () => {
    expect(isBlank(note({ title: 'Groceries' }))).toBe(false);
  });

  it('a checklist with only empty rows is blank', () => {
    expect(isBlank(note({ mode: 'checklist', items: [createChecklistItem(''), createChecklistItem('  ')] }))).toBe(true);
  });

  it('a checklist with one filled row is not blank', () => {
    expect(isBlank(note({ mode: 'checklist', items: [createChecklistItem('milk')] }))).toBe(false);
  });
});

describe('shelfOf', () => {
  it('puts trashed notes in the trash even when archived', () => {
    expect(shelfOf(note({ archived: true, trashedAt: '2026-02-01T00:00:00Z' }))).toBe('trash');
  });

  it('puts archived notes on the archive shelf', () => {
    expect(shelfOf(note({ archived: true }))).toBe('archived');
  });
});

describe('switchMode', () => {
  it('turns prose lines into checklist items', () => {
    const converted = switchMode(note({ body: 'milk\nbread\n\neggs' }), 'checklist');
    expect(converted.items.map((item) => item.text)).toEqual(['milk', 'bread', 'eggs']);
    expect(converted.body).toBe('');
  });

  it('reads existing checkbox markers', () => {
    const converted = switchMode(note({ body: '[x] milk\n[ ] bread' }), 'checklist');
    expect(converted.items[0].done).toBe(true);
    expect(converted.items[0].text).toBe('milk');
    expect(converted.items[1].done).toBe(false);
  });

  it('strips bullet markers', () => {
    const converted = switchMode(note({ body: '- milk\n* bread\n• eggs' }), 'checklist');
    expect(converted.items.map((item) => item.text)).toEqual(['milk', 'bread', 'eggs']);
  });

  it('gives an empty note one blank row to type into', () => {
    expect(switchMode(note(), 'checklist').items).toHaveLength(1);
  });

  it('turns a checklist back into prose with markers', () => {
    const list = note({ mode: 'checklist', items: [
      { id: '1', text: 'milk', done: true },
      { id: '2', text: 'bread', done: false },
      { id: '3', text: '   ', done: false },
    ] });
    const converted = switchMode(list, 'text');
    expect(converted.body).toBe('[x] milk\n[ ] bread');
    expect(converted.items).toEqual([]);
  });

  it('is a no-op when the mode already matches', () => {
    const original = note({ body: 'hello' });
    expect(switchMode(original, 'text')).toBe(original);
  });
});

describe('checklistProgress', () => {
  it('ignores blank rows', () => {
    const list = note({ mode: 'checklist', items: [
      { id: '1', text: 'a', done: true },
      { id: '2', text: 'b', done: false },
      { id: '3', text: '', done: true },
    ] });
    expect(checklistProgress(list)).toEqual({ done: 1, total: 2 });
  });
});

describe('matches', () => {
  const haystackNote = note({
    title: 'Trip packing',
    body: 'passport and charger',
    labels: ['travel'],
    color: 'sky',
  });

  it('matches on the title', () => {
    expect(matches(haystackNote, { ...emptyFilters, query: 'packing' })).toBe(true);
  });

  it('matches on the body', () => {
    expect(matches(haystackNote, { ...emptyFilters, query: 'charger' })).toBe(true);
  });

  it('requires every word in the query', () => {
    expect(matches(haystackNote, { ...emptyFilters, query: 'trip charger' })).toBe(true);
    expect(matches(haystackNote, { ...emptyFilters, query: 'trip bicycle' })).toBe(false);
  });

  it('matches checklist item text', () => {
    const list = note({ mode: 'checklist', items: [createChecklistItem('sunscreen')] });
    expect(matches(list, { ...emptyFilters, query: 'sunscreen' })).toBe(true);
  });

  it('filters by label and colour', () => {
    expect(matches(haystackNote, { ...emptyFilters, label: 'travel' })).toBe(true);
    expect(matches(haystackNote, { ...emptyFilters, label: 'work' })).toBe(false);
    expect(matches(haystackNote, { ...emptyFilters, color: 'sky' })).toBe(true);
    expect(matches(haystackNote, { ...emptyFilters, color: 'mint' })).toBe(false);
  });

  it('keeps shelves separate', () => {
    const archived = note({ archived: true, title: 'old' });
    expect(matches(archived, { ...emptyFilters, shelf: 'active' })).toBe(false);
    expect(matches(archived, { ...emptyFilters, shelf: 'archived' })).toBe(true);
  });

  it('is case insensitive', () => {
    expect(matches(haystackNote, { ...emptyFilters, query: 'PASSPORT' })).toBe(true);
  });
});

describe('sortNotes', () => {
  it('floats pinned notes to the top', () => {
    const notes = [
      note({ id: 'a', pinned: false, updatedAt: '2026-05-01T00:00:00Z' }),
      note({ id: 'b', pinned: true, updatedAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(sortNotes(notes, 'active').map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('orders the rest by most recently updated', () => {
    const notes = [
      note({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }),
      note({ id: 'new', updatedAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(sortNotes(notes, 'active').map((n) => n.id)).toEqual(['new', 'old']);
  });

  it('orders the trash by when each note was binned', () => {
    const notes = [
      note({ id: 'first', trashedAt: '2026-01-01T00:00:00Z' }),
      note({ id: 'second', trashedAt: '2026-02-01T00:00:00Z' }),
    ];
    expect(sortNotes(notes, 'trash').map((n) => n.id)).toEqual(['second', 'first']);
  });
});

describe('selectNotes', () => {
  it('filters then sorts', () => {
    const notes = [
      note({ id: 'a', title: 'alpha', updatedAt: '2026-01-01T00:00:00Z' }),
      note({ id: 'b', title: 'alpha two', pinned: true, updatedAt: '2026-01-02T00:00:00Z' }),
      note({ id: 'c', title: 'beta', updatedAt: '2026-01-03T00:00:00Z' }),
    ];
    expect(selectNotes(notes, { ...emptyFilters, query: 'alpha' }).map((n) => n.id)).toEqual(['b', 'a']);
  });
});

describe('labels', () => {
  it('normalises whitespace and length', () => {
    expect(normaliseLabel('  work   stuff ')).toBe('work stuff');
    expect(normaliseLabel('x'.repeat(50))).toHaveLength(32);
  });

  it('adds a label once and keeps them sorted', () => {
    let target = addLabel(note(), 'zeta');
    target = addLabel(target, 'alpha');
    target = addLabel(target, 'alpha');
    expect(target.labels).toEqual(['alpha', 'zeta']);
  });

  it('ignores an empty label', () => {
    const target = note();
    expect(addLabel(target, '   ')).toBe(target);
  });

  it('removes a label', () => {
    const target = addLabel(note(), 'work');
    expect(removeLabel(target, 'work').labels).toEqual([]);
  });

  it('collects every label in use', () => {
    expect(allLabels([note({ labels: ['b'] }), note({ labels: ['a', 'b'] })])).toEqual(['a', 'b']);
  });
});

describe('countsByShelf', () => {
  it('counts each shelf', () => {
    const counts = countsByShelf([
      note(),
      note({ archived: true }),
      note({ trashedAt: '2026-01-01T00:00:00Z' }),
      note({ trashedAt: '2026-01-02T00:00:00Z' }),
    ]);
    expect(counts).toEqual({ active: 1, archived: 1, trash: 2 });
  });
});

describe('expiredTrash', () => {
  it('finds notes binned longer ago than the retention window', () => {
    const now = at('2026-03-01T00:00:00Z');
    const old = note({ id: 'old', trashedAt: '2026-01-01T00:00:00Z' });
    const recent = note({ id: 'recent', trashedAt: '2026-02-27T00:00:00Z' });
    expect(expiredTrash([old, recent], now).map((n) => n.id)).toEqual(['old']);
  });

  it('leaves live notes alone', () => {
    expect(expiredTrash([note()], at('2030-01-01T00:00:00Z'))).toEqual([]);
  });

  it('keeps a sane retention window', () => {
    expect(TRASH_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
  });
});

describe('touch', () => {
  it('stamps updatedAt', () => {
    const updated = touch(note(), { title: 'new' }, at('2026-07-07T07:07:07Z'));
    expect(updated.title).toBe('new');
    expect(updated.updatedAt).toBe('2026-07-07T07:07:07.000Z');
  });
});

describe('reviveNote', () => {
  it('rejects something that is not a note', () => {
    expect(reviveNote({ id: 'x' })).toBeNull();
    expect(reviveNote(null)).toBeNull();
  });

  it('falls back to the default colour when the file names an unknown one', () => {
    const revived = reviveNote({ ...note(), color: 'chartreuse' });
    expect(revived?.color).toBe(DEFAULT_COLOR);
  });

  it('accepts every colour the app ships', () => {
    for (const color of NOTE_COLORS) {
      expect(reviveNote({ ...note(), color: color.id })?.color).toBe(color.id);
    }
  });

  it('coerces loose booleans', () => {
    const revived = reviveNote({ ...note(), pinned: 'yes', archived: 1, trashedAt: 5 });
    expect(revived?.pinned).toBe(false);
    expect(revived?.archived).toBe(false);
    expect(revived?.trashedAt).toBeNull();
  });

  it('drops malformed labels and checklist rows', () => {
    const revived = reviveNote({
      ...note(),
      labels: ['keep', 42, '   '],
      items: [{ id: 'a', text: 'ok', done: true }, { nope: true }],
    });
    expect(revived?.labels).toEqual(['keep']);
    expect(revived?.items).toHaveLength(1);
    expect(revived?.items[0].done).toBe(true);
  });
});
