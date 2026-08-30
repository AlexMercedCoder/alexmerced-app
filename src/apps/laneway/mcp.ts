import { nextRank } from '../../lib/id';
import { readBoolean, readNumber, readString, readStringArray, requireString, textResult, type McpTool } from '../../lib/webmcp';
import {
  archiveCard, cardsInColumn, checklistProgress, createCard, dueState, isOverLimit, liveCards,
  moveCard, sortedColumns, type Board, type Card,
} from './model';
import { loadWorkspace, saveCard, saveCards } from './store';

/**
 * Laneway's tools. The useful shape here is not "read my board" but "put this
 * on my board and tell me what is now overdue", so the tools cover both.
 */
export function lanewayTools(onChanged: () => void): McpTool[] {
  return [
    {
      name: 'laneway_get_board',
      description:
        'Read a kanban board: its columns, the cards in each, work in progress limits and whether any are exceeded, due dates and which are overdue, checklist progress, and the labels in use. Call this before adding or moving anything so the column names and card ids are right.',
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Board name or id. The first board when omitted.' },
          includeArchived: { type: 'boolean', description: 'Include archived cards. False by default.' },
        },
      },
      execute: async (input) => {
        const { board, cards } = await pick(readString(input, 'board'));
        const includeArchived = readBoolean(input, 'includeArchived', false);
        const now = new Date();

        return textResult({
          board: board.name,
          boardId: board.id,
          labels: board.labels.map((label) => ({ id: label.id, name: label.name })),
          columns: sortedColumns(board).map((column) => {
            const inColumn = cardsInColumn(includeArchived ? cards : liveCards(cards), column.id);
            return {
              id: column.id,
              title: column.title,
              wipLimit: column.wipLimit,
              overLimit: isOverLimit(column, liveCards(cards)),
              cardCount: inColumn.length,
              cards: inColumn.map((card) => describeCard(card, board, now)),
            };
          }),
        });
      },
    },
    {
      name: 'laneway_add_card',
      description:
        'Put a card on a board. Name the column by its title or id. Notes, a due date, labels and a checklist can all be set at the same time. It is saved to this browser and appears on the page.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          column: { type: 'string', description: 'Column title or id. The first column when omitted.' },
          board: { type: 'string', description: 'Board name or id. The first board when omitted.' },
          notes: { type: 'string' },
          due: { type: 'string', description: 'A date as YYYY-MM-DD.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label names that already exist on the board.' },
          checklist: { type: 'array', items: { type: 'string' } },
        },
        required: ['title'],
      },
      execute: async (input) => {
        const title = requireString(input, 'title');
        const { board, cards } = await pick(readString(input, 'board'));

        const wanted = readString(input, 'column');
        const columns = sortedColumns(board);
        const column = wanted
          ? columns.find((entry) => entry.id === wanted || entry.title.toLowerCase() === wanted.toLowerCase())
          : columns[0];
        if (!column) {
          return textResult({ error: `No column called "${wanted}".`, columns: columns.map((entry) => entry.title) });
        }

        const existing = cardsInColumn(liveCards(cards), column.id);
        const card = createCard(column.id, title, nextRank(existing));
        card.notes = readString(input, 'notes');

        const due = readString(input, 'due');
        if (/^\d{4}-\d{2}-\d{2}$/.test(due)) card.due = due;

        const names = readStringArray(input, 'labels').map((name) => name.toLowerCase());
        card.labelIds = board.labels.filter((label) => names.includes(label.name.toLowerCase())).map((label) => label.id);

        card.checklist = readStringArray(input, 'checklist').map((text, index) => ({
          id: `check_${Date.now()}_${index}`, text, done: false,
        }));

        await saveCard(card);
        onChanged();
        return textResult({
          added: describeCard(card, board, new Date()),
          column: column.title,
          overLimit: isOverLimit(column, [...liveCards(cards), card]),
        });
      },
    },
    {
      name: 'laneway_move_card',
      description:
        'Move a card to another column, or to the top or bottom of the one it is in. Use the card id from laneway_get_board.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          column: { type: 'string', description: 'Column title or id to move it into.' },
          position: { type: 'string', enum: ['top', 'bottom'], description: 'Where in the column. Bottom by default.' },
          board: { type: 'string' },
        },
        required: ['id', 'column'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        const wanted = requireString(input, 'column');
        const { board, cards } = await pick(readString(input, 'board'));

        const card = cards.find((entry) => entry.id === id);
        if (!card) return textResult({ error: `No card with id "${id}".` });

        const columns = sortedColumns(board);
        const column = columns.find((entry) => entry.id === wanted || entry.title.toLowerCase() === wanted.toLowerCase());
        if (!column) return textResult({ error: `No column called "${wanted}".`, columns: columns.map((entry) => entry.title) });

        const inColumn = cardsInColumn(liveCards(cards), column.id).filter((entry) => entry.id !== id);
        const position = readString(input, 'position', 'bottom');
        const index = position === 'top' ? 0 : inColumn.length;

        // moveCard rewrites the ranks of everything in the destination column,
        // so every one of them has to be written back, not just the card moved.
        const updated = moveCard(cards, id, { columnId: column.id, index });
        const changed = updated.filter((card) => {
          const before = cards.find((entry) => entry.id === card.id);
          return !before || before.rank !== card.rank || before.columnId !== card.columnId;
        });
        await saveCards(changed);
        onChanged();
        return textResult({ moved: id, into: column.title, position, cardsRewritten: changed.length });
      },
    },
    {
      name: 'laneway_archive_card',
      description: 'Archive a card, taking it off the board without deleting it. It stays in the archive on the page.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, board: { type: 'string' } },
        required: ['id'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        const { cards } = await pick(readString(input, 'board'));
        if (!cards.some((entry) => entry.id === id)) return textResult({ error: `No card with id "${id}".` });

        const updated = archiveCard(cards, id);
        await saveCards(updated.filter((entry) => entry.id === id));
        onChanged();
        return textResult({ archived: id });
      },
    },
    {
      name: 'laneway_whats_due',
      description:
        'List cards with a due date, across every board, sorted by how soon. Says which are overdue, which are due today, and which are coming. Use this to answer "what needs doing".',
      inputSchema: {
        type: 'object',
        properties: { withinDays: { type: 'number', description: 'Only cards due within this many days. All of them when omitted.' } },
      },
      execute: async (input) => {
        const workspace = await loadWorkspace();
        const within = readNumber(input, 'withinDays', Infinity);
        const now = new Date();
        const today = now.toISOString().slice(0, 10);

        const found = workspace.boards.flatMap((board) => {
          const cards = liveCards(workspace.cards.filter((card) =>
            board.columns.some((column) => column.id === card.columnId)));
          return cards
            .filter((card) => card.due !== null)
            .filter((card) => {
              if (!Number.isFinite(within)) return true;
              const days = (Date.parse(`${card.due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
              return days <= within;
            })
            .map((card) => ({
              board: board.name,
              column: board.columns.find((column) => column.id === card.columnId)?.title ?? '',
              ...describeCard(card, board, now),
            }));
        });

        found.sort((a, b) => String(a.due).localeCompare(String(b.due)));
        return textResult({
          today,
          overdue: found.filter((card) => card.dueState === 'overdue').length,
          dueToday: found.filter((card) => card.due === today).length,
          cards: found.slice(0, 100),
        });
      },
    },
  ];
}

async function pick(wanted: string): Promise<{ board: Board; cards: Card[] }> {
  const workspace = await loadWorkspace();
  if (workspace.boards.length === 0) throw new Error('There are no boards yet.');

  const board = wanted
    ? workspace.boards.find((entry) => entry.id === wanted || entry.name.toLowerCase() === wanted.toLowerCase())
    : workspace.boards[0];
  if (!board) {
    throw new Error(`No board called "${wanted}". There is ${workspace.boards.map((entry) => `"${entry.name}"`).join(', ')}.`);
  }

  const columnIds = new Set(board.columns.map((column) => column.id));
  return { board, cards: workspace.cards.filter((card) => columnIds.has(card.columnId)) };
}

function describeCard(card: Card, board: Board, now: Date) {
  const progress = checklistProgress(card);
  return {
    id: card.id,
    title: card.title,
    notes: card.notes || undefined,
    due: card.due,
    dueState: card.due ? dueState(card, now) : null,
    labels: card.labelIds
      .map((id) => board.labels.find((label) => label.id === id)?.name)
      .filter((name): name is string => Boolean(name)),
    checklist: progress.total > 0 ? `${progress.done} of ${progress.total}` : undefined,
    archived: card.archivedAt !== null,
  };
}
