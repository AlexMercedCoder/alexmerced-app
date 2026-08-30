import { readBoolean, readNumber, readString, readStringArray, requireString, textResult, truncate, type McpTool } from '../../lib/webmcp';
import { createNote, NOTE_COLORS, type Note, type NoteColor } from './model';
import { deleteNote, loadNotes, saveNote } from './store';

/**
 * Jotterbug's tools. These read and write the visitor's own board, which is the
 * point: an agent asked to "put that on my notes" should be able to, rather
 * than telling someone to copy it across by hand.
 */
export function jotterbugTools(onChanged: () => void): McpTool[] {
  const colours: string[] = NOTE_COLORS.map((entry) => entry.id);

  return [
    {
      name: 'jotterbug_list_notes',
      description:
        'List the notes on this board. By default only the active ones, most recently changed first. Returns titles, bodies, labels, colours, and checklist state.',
      inputSchema: {
        type: 'object',
        properties: {
          shelf: { type: 'string', enum: ['active', 'archived', 'trash'], description: 'Which shelf. "active" by default.' },
          label: { type: 'string', description: 'Only notes carrying this label.' },
          limit: { type: 'number', description: 'How many to return. 50 by default.' },
        },
      },
      execute: async (input) => {
        const shelf = readString(input, 'shelf', 'active');
        const label = readString(input, 'label');
        const limit = Math.max(1, Math.min(500, Math.round(readNumber(input, 'limit', 50))));

        const all = await loadNotes();
        const onShelf = all.filter((note) =>
          shelf === 'trash' ? note.trashedAt !== null
          : shelf === 'archived' ? note.archived && note.trashedAt === null
          : !note.archived && note.trashedAt === null);

        const filtered = label ? onShelf.filter((note) => note.labels.includes(label)) : onShelf;
        const sorted = [...filtered].sort((a, b) =>
          Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
        const trimmed = truncate(sorted, limit);

        return textResult({
          shelf,
          total: trimmed.total,
          returned: trimmed.items.length,
          truncated: trimmed.truncated,
          labels: [...new Set(all.flatMap((note) => note.labels))].sort(),
          notes: trimmed.items.map(summarise),
        });
      },
    },
    {
      name: 'jotterbug_search_notes',
      description: 'Search the notes on this board by their titles, bodies, checklist items and labels.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          includeArchived: { type: 'boolean', description: 'Search the archive too. False by default.' },
        },
        required: ['query'],
      },
      execute: async (input) => {
        const terms = requireString(input, 'query').toLowerCase().split(/\s+/).filter(Boolean);
        const includeArchived = readBoolean(input, 'includeArchived', false);

        const notes = (await loadNotes()).filter((note) =>
          note.trashedAt === null && (includeArchived || !note.archived));

        const matched = notes.filter((note) => {
          const haystack = [note.title, note.body, note.labels.join(' '), note.items.map((item) => item.text).join(' ')]
            .join(' ').toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });

        return textResult({ query: terms.join(' '), matches: matched.length, notes: matched.slice(0, 50).map(summarise) });
      },
    },
    {
      name: 'jotterbug_create_note',
      description:
        'Add a note to this board. Give a title and a body, or a list of checklist items. It is saved in this browser straight away and appears on the page.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'For a plain note.' },
          checklist: { type: 'array', items: { type: 'string' }, description: 'For a checklist note, one string per item.' },
          labels: { type: 'array', items: { type: 'string' } },
          colour: { type: 'string', enum: colours },
          pinned: { type: 'boolean' },
        },
      },
      execute: async (input) => {
        const title = readString(input, 'title');
        const body = readString(input, 'body');
        const checklist = readStringArray(input, 'checklist');
        if (!title && !body && checklist.length === 0) {
          throw new Error('A note needs a title, a body, or some checklist items.');
        }

        const colour = readString(input, 'colour');
        const note = createNote({
          title,
          body: checklist.length ? '' : body,
          mode: checklist.length ? 'checklist' : 'text',
          items: checklist.map((text, index) => ({ id: `item_${Date.now()}_${index}`, text, done: false })),
          labels: readStringArray(input, 'labels'),
          color: (colours.includes(colour) ? colour : undefined) as NoteColor | undefined,
          pinned: readBoolean(input, 'pinned', false),
        });

        await saveNote(note);
        onChanged();
        return textResult({ created: summarise(note), note: 'Saved to this browser and now on the board.' });
      },
    },
    {
      name: 'jotterbug_update_note',
      description:
        'Change a note that is already on the board: its title, body, labels, colour, whether it is pinned or archived, or which checklist items are ticked. Pass the id from jotterbug_list_notes.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          colour: { type: 'string', enum: colours },
          pinned: { type: 'boolean' },
          archived: { type: 'boolean' },
          tick: { type: 'array', items: { type: 'string' }, description: 'Checklist item texts to mark done.' },
          untick: { type: 'array', items: { type: 'string' }, description: 'Checklist item texts to mark not done.' },
        },
        required: ['id'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        const notes = await loadNotes();
        const note = notes.find((entry) => entry.id === id);
        if (!note) {
          return textResult({ error: `No note with id "${id}".`, available: notes.slice(0, 20).map((entry) => ({ id: entry.id, title: entry.title })) });
        }

        const updated: Note = { ...note, updatedAt: new Date().toISOString() };
        if (typeof input.title === 'string') updated.title = input.title;
        if (typeof input.body === 'string') updated.body = input.body;
        if (Array.isArray(input.labels)) updated.labels = readStringArray(input, 'labels');
        const colour = readString(input, 'colour');
        if (colours.includes(colour)) updated.color = colour as NoteColor;
        if (typeof input.pinned === 'boolean') updated.pinned = input.pinned;
        if (typeof input.archived === 'boolean') updated.archived = input.archived;

        const tick = new Set(readStringArray(input, 'tick').map((text) => text.toLowerCase()));
        const untick = new Set(readStringArray(input, 'untick').map((text) => text.toLowerCase()));
        if (tick.size || untick.size) {
          updated.items = updated.items.map((item) => {
            const key = item.text.toLowerCase();
            if (tick.has(key)) return { ...item, done: true };
            if (untick.has(key)) return { ...item, done: false };
            return item;
          });
        }

        await saveNote(updated);
        onChanged();
        return textResult({ updated: summarise(updated) });
      },
    },
    {
      name: 'jotterbug_delete_note',
      description:
        'Move a note to the trash, or remove it for good. Trashing is reversible from the page; removing for good is not.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          permanent: { type: 'boolean', description: 'False by default, which only moves it to the trash.' },
        },
        required: ['id'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        const permanent = readBoolean(input, 'permanent', false);
        const note = (await loadNotes()).find((entry) => entry.id === id);
        if (!note) return textResult({ error: `No note with id "${id}".` });

        if (permanent) {
          await deleteNote(id);
          onChanged();
          return textResult({ deleted: id, permanent: true });
        }
        await saveNote({ ...note, trashedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        onChanged();
        return textResult({ trashed: id, note: 'It can be restored from the trash on the page.' });
      },
    },
  ];
}

function summarise(note: Note) {
  return {
    id: note.id,
    title: note.title,
    body: note.mode === 'checklist' ? undefined : note.body,
    checklist: note.mode === 'checklist' ? note.items.map((item) => ({ text: item.text, done: item.done })) : undefined,
    labels: note.labels,
    colour: note.color,
    pinned: note.pinned,
    archived: note.archived,
    updatedAt: note.updatedAt,
  };
}
