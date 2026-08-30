import { createId, nextRank, rankBetween } from '../../lib/id';

export const APP_ID = 'laneway';
export const APP_VERSION = 1;

export const LABEL_COLORS = [
  { id: 'slate', label: 'Slate', hex: '#64748b' },
  { id: 'red', label: 'Red', hex: '#dc4b45' },
  { id: 'amber', label: 'Amber', hex: '#d08512' },
  { id: 'green', label: 'Green', hex: '#2c9463' },
  { id: 'blue', label: 'Blue', hex: '#2f6f9f' },
  { id: 'violet', label: 'Violet', hex: '#7255c4' },
  { id: 'pink', label: 'Pink', hex: '#c14a86' },
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number]['id'];

export type Label = {
  id: string;
  name: string;
  color: LabelColor;
};

export type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

export type Card = {
  id: string;
  columnId: string;
  title: string;
  notes: string;
  labelIds: string[];
  checklist: ChecklistItem[];
  due: string | null;
  rank: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Column = {
  id: string;
  title: string;
  /** null means no limit. */
  wipLimit: number | null;
  rank: number;
};

export type Board = {
  id: string;
  name: string;
  columns: Column[];
  labels: Label[];
  createdAt: string;
  updatedAt: string;
};

export type BoardState = {
  board: Board;
  cards: Card[];
};

export function createColumn(title: string, rank: number, wipLimit: number | null = null): Column {
  return { id: createId('col'), title, wipLimit, rank };
}

export function createLabel(name: string, color: LabelColor): Label {
  return { id: createId('lab'), name, color };
}

export function createCard(columnId: string, title: string, rank: number, now: Date = new Date()): Card {
  const stamp = now.toISOString();
  return {
    id: createId('card'),
    columnId,
    title,
    notes: '',
    labelIds: [],
    checklist: [],
    due: null,
    rank,
    archivedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function createBoard(name: string, now: Date = new Date()): Board {
  const stamp = now.toISOString();
  return {
    id: createId('board'),
    name,
    columns: [
      createColumn('Backlog', 1),
      createColumn('Next up', 2, 5),
      createColumn('Doing', 3, 3),
      createColumn('Done', 4),
    ],
    labels: [
      createLabel('Bug', 'red'),
      createLabel('Feature', 'blue'),
      createLabel('Chore', 'slate'),
      createLabel('Blocked', 'amber'),
    ],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** A first board with enough on it to show what the app does. */
export function starterBoard(now: Date = new Date()): BoardState {
  const board = createBoard('My work', now);
  const [backlog, next, doing] = board.columns;
  const [, feature, chore] = board.labels;

  const cards: Card[] = [
    { ...createCard(doing.id, 'Try moving this card with the arrow keys', 1, now),
      notes: 'Click a card to select it, then hold Shift and press the arrow keys. Left and right change column, up and down change position.',
      labelIds: [feature.id],
      checklist: [
        { id: createId('chk'), text: 'Select a card', done: true },
        { id: createId('chk'), text: 'Shift plus arrow to move it', done: false },
      ] },
    { ...createCard(next.id, 'Set a work-in-progress limit', 1, now),
      notes: 'Columns can carry a limit. When a column goes over it, the header turns amber. It is a nudge, not a lock.',
      labelIds: [chore.id] },
    { ...createCard(backlog.id, 'Export this board to a file', 1, now),
      notes: 'Export writes a JSON file you can keep or move to another browser. Import reads it back.',
      labelIds: [] },
    { ...createCard(backlog.id, 'Everything here stays on this device', 2, now),
      notes: 'Laneway stores boards and cards in IndexedDB, and which board you had open in localStorage. There is no account and no server.',
      labelIds: [] },
  ];

  return { board, cards };
}

// --------------------------------------------------------------------- queries

export function liveCards(cards: Card[]): Card[] {
  return cards.filter((card) => card.archivedAt === null);
}

export function cardsInColumn(cards: Card[], columnId: string): Card[] {
  return liveCards(cards)
    .filter((card) => card.columnId === columnId)
    .sort((a, b) => a.rank - b.rank);
}

export function sortedColumns(board: Board): Column[] {
  return [...board.columns].sort((a, b) => a.rank - b.rank);
}

export function checklistProgress(card: Card): { done: number; total: number } {
  const filled = card.checklist.filter((item) => item.text.trim());
  return { done: filled.filter((item) => item.done).length, total: filled.length };
}

export type DueState = 'none' | 'overdue' | 'today' | 'soon' | 'later';

export function dueState(card: Card, now: Date = new Date()): DueState {
  if (!card.due) return 'none';
  const due = new Date(`${card.due}T23:59:59`);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor((due.getTime() - startOfToday.getTime()) / dayMs);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 3) return 'soon';
  return 'later';
}

export function isOverLimit(column: Column, cards: Card[]): boolean {
  if (column.wipLimit === null) return false;
  return cardsInColumn(cards, column.id).length > column.wipLimit;
}

export type CardFilters = {
  query: string;
  labelIds: string[];
  due: 'any' | 'overdue' | 'week' | 'none';
};

export const emptyCardFilters: CardFilters = { query: '', labelIds: [], due: 'any' };

export function matchesFilters(card: Card, filters: CardFilters, now: Date = new Date()): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const hay = [card.title, card.notes, ...card.checklist.map((item) => item.text)].join(' ').toLowerCase();
    if (!query.split(/\s+/).every((word) => hay.includes(word))) return false;
  }

  if (filters.labelIds.length && !filters.labelIds.every((id) => card.labelIds.includes(id))) return false;

  if (filters.due === 'none' && card.due) return false;
  if (filters.due === 'overdue' && dueState(card, now) !== 'overdue') return false;
  if (filters.due === 'week') {
    const state = dueState(card, now);
    if (state === 'none' || state === 'later') return false;
  }

  return true;
}

// --------------------------------------------------------------------- moves

export type MoveTarget = {
  columnId: string;
  /** Where the card lands: index within the destination column's live cards. */
  index: number;
};

/**
 * Works out the new rank for a card dropped at a given index, then returns the
 * updated card. Ranks are fractional so neighbouring cards never need rewriting.
 */
export function moveCard(cards: Card[], cardId: string, target: MoveTarget, now: Date = new Date()): Card[] {
  const card = cards.find((item) => item.id === cardId);
  if (!card) return cards;

  const destination = cardsInColumn(cards, target.columnId).filter((item) => item.id !== cardId);
  const index = Math.max(0, Math.min(target.index, destination.length));

  const before = index > 0 ? destination[index - 1].rank : null;
  const after = index < destination.length ? destination[index].rank : null;
  const rank = rankBetween(before, after);

  return cards.map((item) =>
    item.id === cardId
      ? { ...item, columnId: target.columnId, rank, updatedAt: now.toISOString() }
      : item,
  );
}

/** Keyboard movement: one step in a direction, staying inside the board. */
export function stepCard(
  board: Board,
  cards: Card[],
  cardId: string,
  direction: 'left' | 'right' | 'up' | 'down',
  now: Date = new Date(),
): Card[] {
  const card = cards.find((item) => item.id === cardId);
  if (!card) return cards;

  const columns = sortedColumns(board);
  const columnIndex = columns.findIndex((column) => column.id === card.columnId);
  if (columnIndex === -1) return cards;

  if (direction === 'left' || direction === 'right') {
    const targetIndex = columnIndex + (direction === 'left' ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= columns.length) return cards;
    const currentPosition = cardsInColumn(cards, card.columnId).findIndex((item) => item.id === cardId);
    return moveCard(cards, cardId, { columnId: columns[targetIndex].id, index: Math.max(0, currentPosition) }, now);
  }

  const inColumn = cardsInColumn(cards, card.columnId);
  const position = inColumn.findIndex((item) => item.id === cardId);
  const targetPosition = position + (direction === 'up' ? -1 : 1);
  if (targetPosition < 0 || targetPosition >= inColumn.length) return cards;

  return moveCard(cards, cardId, { columnId: card.columnId, index: targetPosition }, now);
}

export function moveColumn(board: Board, columnId: string, direction: 'left' | 'right'): Board {
  const columns = sortedColumns(board);
  const index = columns.findIndex((column) => column.id === columnId);
  const target = index + (direction === 'left' ? -1 : 1);
  if (index === -1 || target < 0 || target >= columns.length) return board;

  const reordered = [...columns];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(target, 0, moved);

  return { ...board, columns: reordered.map((column, position) => ({ ...column, rank: position + 1 })) };
}

export function addColumn(board: Board, title: string): Board {
  return { ...board, columns: [...board.columns, createColumn(title, nextRank(board.columns))] };
}

/** Removing a column takes its cards with it, so callers must handle both. */
export function removeColumn(board: Board, cards: Card[], columnId: string): { board: Board; cards: Card[] } {
  return {
    board: { ...board, columns: board.columns.filter((column) => column.id !== columnId) },
    cards: cards.filter((card) => card.columnId !== columnId),
  };
}

export function archiveCard(cards: Card[], cardId: string, now: Date = new Date()): Card[] {
  return cards.map((card) =>
    card.id === cardId ? { ...card, archivedAt: now.toISOString(), updatedAt: now.toISOString() } : card,
  );
}

export function restoreCard(cards: Card[], cardId: string, now: Date = new Date()): Card[] {
  return cards.map((card) =>
    card.id === cardId ? { ...card, archivedAt: null, updatedAt: now.toISOString() } : card,
  );
}

export function archiveColumn(cards: Card[], columnId: string, now: Date = new Date()): Card[] {
  const stamp = now.toISOString();
  return cards.map((card) =>
    card.columnId === columnId && card.archivedAt === null
      ? { ...card, archivedAt: stamp, updatedAt: stamp }
      : card,
  );
}

export type BoardStats = {
  total: number;
  archived: number;
  overdue: number;
  perColumn: { columnId: string; title: string; count: number; limit: number | null; over: boolean }[];
};

export function boardStats(board: Board, cards: Card[], now: Date = new Date()): BoardStats {
  const live = liveCards(cards);
  return {
    total: live.length,
    archived: cards.length - live.length,
    overdue: live.filter((card) => dueState(card, now) === 'overdue').length,
    perColumn: sortedColumns(board).map((column) => {
      const count = cardsInColumn(cards, column.id).length;
      return {
        columnId: column.id,
        title: column.title,
        count,
        limit: column.wipLimit,
        over: column.wipLimit !== null && count > column.wipLimit,
      };
    }),
  };
}

// --------------------------------------------------------------------- reviving

export function isBoard(value: unknown): value is Board {
  if (typeof value !== 'object' || value === null) return false;
  const board = value as Partial<Board>;
  return typeof board.id === 'string' && typeof board.name === 'string' && Array.isArray(board.columns);
}

export function reviveBoard(value: unknown): Board | null {
  if (!isBoard(value)) return null;
  const knownColors = new Set(LABEL_COLORS.map((color) => color.id));
  const stamp = new Date().toISOString();

  const columns = value.columns
    .filter((column): column is Column => typeof column === 'object' && column !== null && typeof (column as Column).id === 'string')
    .map((column, index) => ({
      id: column.id,
      title: typeof column.title === 'string' ? column.title : 'Untitled',
      wipLimit: typeof column.wipLimit === 'number' && column.wipLimit > 0 ? Math.floor(column.wipLimit) : null,
      rank: typeof column.rank === 'number' ? column.rank : index + 1,
    }));

  if (columns.length === 0) return null;

  return {
    id: value.id,
    name: value.name,
    columns,
    labels: (Array.isArray(value.labels) ? value.labels : [])
      .filter((label): label is Label => typeof label === 'object' && label !== null && typeof (label as Label).id === 'string')
      .map((label) => ({
        id: label.id,
        name: typeof label.name === 'string' ? label.name : 'Label',
        color: knownColors.has(label.color) ? label.color : 'slate',
      })),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : stamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : stamp,
  };
}

export function reviveCard(value: unknown): Card | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Partial<Card>;
  if (typeof card.id !== 'string' || typeof card.columnId !== 'string') return null;
  const stamp = new Date().toISOString();

  return {
    id: card.id,
    columnId: card.columnId,
    title: typeof card.title === 'string' ? card.title : 'Untitled card',
    notes: typeof card.notes === 'string' ? card.notes : '',
    labelIds: Array.isArray(card.labelIds) ? card.labelIds.filter((id): id is string => typeof id === 'string') : [],
    checklist: Array.isArray(card.checklist)
      ? card.checklist
          .filter((item): item is ChecklistItem => typeof item === 'object' && item !== null && typeof (item as ChecklistItem).text === 'string')
          .map((item) => ({ id: typeof item.id === 'string' ? item.id : createId('chk'), text: item.text, done: item.done === true }))
      : [],
    due: typeof card.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.due) ? card.due : null,
    rank: typeof card.rank === 'number' && Number.isFinite(card.rank) ? card.rank : 1,
    archivedAt: typeof card.archivedAt === 'string' ? card.archivedAt : null,
    createdAt: typeof card.createdAt === 'string' ? card.createdAt : stamp,
    updatedAt: typeof card.updatedAt === 'string' ? card.updatedAt : stamp,
  };
}

/** Drops cards whose column no longer exists, so an import cannot orphan them. */
export function reconcile(boards: Board[], cards: Card[]): Card[] {
  const columnIds = new Set(boards.flatMap((board) => board.columns.map((column) => column.id)));
  return cards.filter((card) => columnIds.has(card.columnId));
}
