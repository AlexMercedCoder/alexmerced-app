import { describe, expect, it } from 'vitest';
import {
  LABEL_COLORS,
  addColumn,
  archiveCard,
  archiveColumn,
  boardStats,
  cardsInColumn,
  checklistProgress,
  createBoard,
  createCard,
  dueState,
  emptyCardFilters,
  isOverLimit,
  liveCards,
  matchesFilters,
  moveCard,
  moveColumn,
  reconcile,
  removeColumn,
  restoreCard,
  reviveBoard,
  reviveCard,
  sortedColumns,
  starterBoard,
  stepCard,
  type Board,
  type Card,
} from './model';

const NOW = new Date('2026-06-15T12:00:00Z');

function fixture() {
  const board = createBoard('Test', NOW);
  const [a, b] = sortedColumns(board);
  const cards: Card[] = [
    { ...createCard(a.id, 'one', 1, NOW) },
    { ...createCard(a.id, 'two', 2, NOW) },
    { ...createCard(a.id, 'three', 3, NOW) },
    { ...createCard(b.id, 'other', 1, NOW) },
  ];
  return { board, cards, a, b };
}

describe('createBoard', () => {
  it('ships four columns and four labels', () => {
    const board = createBoard('New', NOW);
    expect(board.columns).toHaveLength(4);
    expect(board.labels).toHaveLength(4);
    expect(sortedColumns(board).map((c) => c.title)).toEqual(['Backlog', 'Next up', 'Doing', 'Done']);
  });

  it('sets work-in-progress limits on the middle columns only', () => {
    const [backlog, next, doing, done] = sortedColumns(createBoard('New', NOW));
    expect(backlog.wipLimit).toBeNull();
    expect(next.wipLimit).toBe(5);
    expect(doing.wipLimit).toBe(3);
    expect(done.wipLimit).toBeNull();
  });
});

describe('starterBoard', () => {
  it('gives a new visitor something to look at', () => {
    const { board, cards } = starterBoard(NOW);
    expect(cards.length).toBeGreaterThan(2);
    expect(cards.every((card) => board.columns.some((column) => column.id === card.columnId))).toBe(true);
  });
});

describe('cardsInColumn', () => {
  it('returns only that column, in rank order', () => {
    const { cards, a } = fixture();
    expect(cardsInColumn(cards, a.id).map((c) => c.title)).toEqual(['one', 'two', 'three']);
  });

  it('leaves archived cards out', () => {
    const { cards, a } = fixture();
    const archived = archiveCard(cards, cards[0].id, NOW);
    expect(cardsInColumn(archived, a.id).map((c) => c.title)).toEqual(['two', 'three']);
    expect(liveCards(archived)).toHaveLength(3);
  });
});

describe('moveCard', () => {
  it('moves a card to another column at the requested index', () => {
    const { cards, a, b } = fixture();
    const moved = moveCard(cards, cards[0].id, { columnId: b.id, index: 0 }, NOW);
    expect(cardsInColumn(moved, b.id).map((c) => c.title)).toEqual(['one', 'other']);
    expect(cardsInColumn(moved, a.id).map((c) => c.title)).toEqual(['two', 'three']);
  });

  it('appends when the index is past the end', () => {
    const { cards, b } = fixture();
    const moved = moveCard(cards, cards[0].id, { columnId: b.id, index: 99 }, NOW);
    expect(cardsInColumn(moved, b.id).map((c) => c.title)).toEqual(['other', 'one']);
  });

  it('reorders within a column without disturbing the others', () => {
    const { cards, a } = fixture();
    const moved = moveCard(cards, cards[2].id, { columnId: a.id, index: 0 }, NOW);
    expect(cardsInColumn(moved, a.id).map((c) => c.title)).toEqual(['three', 'one', 'two']);
  });

  it('survives many reorders without rank collisions', () => {
    let { cards, a } = fixture();
    for (let i = 0; i < 40; i += 1) {
      const list = cardsInColumn(cards, a.id);
      cards = moveCard(cards, list[list.length - 1].id, { columnId: a.id, index: 0 }, NOW);
    }
    const ranks = cardsInColumn(cards, a.id).map((c) => c.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it('ignores an unknown card', () => {
    const { cards, b } = fixture();
    expect(moveCard(cards, 'nope', { columnId: b.id, index: 0 }, NOW)).toBe(cards);
  });

  it('stamps updatedAt on the moved card only', () => {
    const { cards, b } = fixture();
    const later = new Date('2026-07-01T00:00:00Z');
    const moved = moveCard(cards, cards[0].id, { columnId: b.id, index: 0 }, later);
    expect(moved.find((c) => c.id === cards[0].id)?.updatedAt).toBe(later.toISOString());
    expect(moved.find((c) => c.id === cards[1].id)?.updatedAt).toBe(cards[1].updatedAt);
  });
});

describe('stepCard', () => {
  it('moves right into the next column', () => {
    const { board, cards, b } = fixture();
    const moved = stepCard(board, cards, cards[0].id, 'right', NOW);
    expect(moved.find((c) => c.id === cards[0].id)?.columnId).toBe(b.id);
  });

  it('will not move past the first column', () => {
    const { board, cards } = fixture();
    expect(stepCard(board, cards, cards[0].id, 'left', NOW)).toBe(cards);
  });

  it('will not move past the last column', () => {
    const { board, cards } = fixture();
    const last = sortedColumns(board)[3];
    const onLast = [...cards, createCard(last.id, 'end', 1, NOW)];
    const target = onLast[onLast.length - 1];
    expect(stepCard(board, onLast, target.id, 'right', NOW)).toBe(onLast);
  });

  it('moves up and down within a column', () => {
    const { board, cards, a } = fixture();
    const up = stepCard(board, cards, cards[1].id, 'up', NOW);
    expect(cardsInColumn(up, a.id).map((c) => c.title)).toEqual(['two', 'one', 'three']);
    const down = stepCard(board, cards, cards[0].id, 'down', NOW);
    expect(cardsInColumn(down, a.id).map((c) => c.title)).toEqual(['two', 'one', 'three']);
  });

  it('will not move above the top or below the bottom', () => {
    const { board, cards } = fixture();
    expect(stepCard(board, cards, cards[0].id, 'up', NOW)).toBe(cards);
    expect(stepCard(board, cards, cards[2].id, 'down', NOW)).toBe(cards);
  });

  it('keeps roughly the same position when changing column', () => {
    const { board, cards, b } = fixture();
    const moved = stepCard(board, cards, cards[2].id, 'right', NOW);
    expect(cardsInColumn(moved, b.id).map((c) => c.title)).toEqual(['other', 'three']);
  });
});

describe('columns', () => {
  it('adds a column at the end', () => {
    const board = addColumn(createBoard('b', NOW), 'Review');
    expect(sortedColumns(board).map((c) => c.title)).toEqual(['Backlog', 'Next up', 'Doing', 'Done', 'Review']);
  });

  it('moves a column left and right', () => {
    const board = createBoard('b', NOW);
    const doing = sortedColumns(board)[2];
    expect(sortedColumns(moveColumn(board, doing.id, 'left')).map((c) => c.title))
      .toEqual(['Backlog', 'Doing', 'Next up', 'Done']);
    expect(sortedColumns(moveColumn(board, doing.id, 'right')).map((c) => c.title))
      .toEqual(['Backlog', 'Next up', 'Done', 'Doing']);
  });

  it('will not move a column off the end', () => {
    const board = createBoard('b', NOW);
    const first = sortedColumns(board)[0];
    expect(moveColumn(board, first.id, 'left')).toBe(board);
  });

  it('takes the cards with it when a column is removed', () => {
    const { board, cards, a } = fixture();
    const result = removeColumn(board, cards, a.id);
    expect(result.board.columns).toHaveLength(3);
    expect(result.cards).toHaveLength(1);
  });
});

describe('archiving', () => {
  it('archives and restores one card', () => {
    const { cards } = fixture();
    const archived = archiveCard(cards, cards[0].id, NOW);
    expect(archived[0].archivedAt).toBe(NOW.toISOString());
    expect(restoreCard(archived, cards[0].id, NOW)[0].archivedAt).toBeNull();
  });

  it('archives a whole column at once', () => {
    const { cards, a } = fixture();
    const archived = archiveColumn(cards, a.id, NOW);
    expect(cardsInColumn(archived, a.id)).toHaveLength(0);
    expect(liveCards(archived)).toHaveLength(1);
  });

  it('does not re-stamp cards that were already archived', () => {
    const { cards, a } = fixture();
    const once = archiveColumn(cards, a.id, NOW);
    const later = new Date('2026-08-01T00:00:00Z');
    const twice = archiveColumn(once, a.id, later);
    expect(twice[0].archivedAt).toBe(NOW.toISOString());
  });
});

describe('work-in-progress limits', () => {
  it('flags a column that is over its limit', () => {
    const board = createBoard('b', NOW);
    const doing = sortedColumns(board)[2];
    const cards = [1, 2, 3, 4].map((n) => createCard(doing.id, `c${n}`, n, NOW));
    expect(isOverLimit(doing, cards.slice(0, 3))).toBe(false);
    expect(isOverLimit(doing, cards)).toBe(true);
  });

  it('never flags a column without a limit', () => {
    const board = createBoard('b', NOW);
    const backlog = sortedColumns(board)[0];
    const cards = Array.from({ length: 50 }, (_, n) => createCard(backlog.id, `c${n}`, n, NOW));
    expect(isOverLimit(backlog, cards)).toBe(false);
  });
});

describe('dueState', () => {
  it('reports no date', () => {
    expect(dueState(createCard('c', 't', 1, NOW), NOW)).toBe('none');
  });

  it('classifies past, today, soon, and later', () => {
    const card = (due: string) => ({ ...createCard('c', 't', 1, NOW), due });
    expect(dueState(card('2026-06-14'), NOW)).toBe('overdue');
    expect(dueState(card('2026-06-15'), NOW)).toBe('today');
    expect(dueState(card('2026-06-17'), NOW)).toBe('soon');
    expect(dueState(card('2026-07-01'), NOW)).toBe('later');
  });
});

describe('matchesFilters', () => {
  const board = createBoard('b', NOW);
  const label = board.labels[0];
  const base = { ...createCard('col', 'Write the docs', 1, NOW), notes: 'about exporting', labelIds: [label.id] };

  it('passes everything with empty filters', () => {
    expect(matchesFilters(base, emptyCardFilters, NOW)).toBe(true);
  });

  it('searches title, notes, and checklist text', () => {
    expect(matchesFilters(base, { ...emptyCardFilters, query: 'docs' }, NOW)).toBe(true);
    expect(matchesFilters(base, { ...emptyCardFilters, query: 'exporting' }, NOW)).toBe(true);
    const withList = { ...base, checklist: [{ id: '1', text: 'screenshots', done: false }] };
    expect(matchesFilters(withList, { ...emptyCardFilters, query: 'screenshots' }, NOW)).toBe(true);
  });

  it('requires every search word', () => {
    expect(matchesFilters(base, { ...emptyCardFilters, query: 'write docs' }, NOW)).toBe(true);
    expect(matchesFilters(base, { ...emptyCardFilters, query: 'write tests' }, NOW)).toBe(false);
  });

  it('requires every selected label', () => {
    expect(matchesFilters(base, { ...emptyCardFilters, labelIds: [label.id] }, NOW)).toBe(true);
    expect(matchesFilters(base, { ...emptyCardFilters, labelIds: [label.id, board.labels[1].id] }, NOW)).toBe(false);
  });

  it('filters by due window', () => {
    const overdue = { ...base, due: '2026-06-01' };
    const later = { ...base, due: '2026-12-01' };
    expect(matchesFilters(overdue, { ...emptyCardFilters, due: 'overdue' }, NOW)).toBe(true);
    expect(matchesFilters(later, { ...emptyCardFilters, due: 'overdue' }, NOW)).toBe(false);
    expect(matchesFilters(overdue, { ...emptyCardFilters, due: 'week' }, NOW)).toBe(true);
    expect(matchesFilters(later, { ...emptyCardFilters, due: 'week' }, NOW)).toBe(false);
    expect(matchesFilters(base, { ...emptyCardFilters, due: 'none' }, NOW)).toBe(true);
    expect(matchesFilters(later, { ...emptyCardFilters, due: 'none' }, NOW)).toBe(false);
  });
});

describe('checklistProgress', () => {
  it('counts only rows with text', () => {
    const card = { ...createCard('c', 't', 1, NOW), checklist: [
      { id: '1', text: 'a', done: true },
      { id: '2', text: '', done: true },
      { id: '3', text: 'b', done: false },
    ] };
    expect(checklistProgress(card)).toEqual({ done: 1, total: 2 });
  });
});

describe('boardStats', () => {
  it('summarises the board', () => {
    const { board, cards, a } = fixture();
    const withDue = cards.map((card, index) => (index === 0 ? { ...card, due: '2026-01-01' } : card));
    const archived = archiveCard(withDue, cards[1].id, NOW);
    const stats = boardStats(board, archived, NOW);
    expect(stats.total).toBe(3);
    expect(stats.archived).toBe(1);
    expect(stats.overdue).toBe(1);
    expect(stats.perColumn.find((c) => c.columnId === a.id)?.count).toBe(2);
  });
});

describe('reviving imported data', () => {
  it('rejects a board with no columns', () => {
    expect(reviveBoard({ id: 'b', name: 'x', columns: [] })).toBeNull();
    expect(reviveBoard({ id: 'b' })).toBeNull();
  });

  it('repairs a nonsense work-in-progress limit', () => {
    const revived = reviveBoard({ id: 'b', name: 'x', columns: [{ id: 'c', title: 'C', wipLimit: -4, rank: 1 }] });
    expect(revived?.columns[0].wipLimit).toBeNull();
  });

  it('falls back to slate for an unknown label colour', () => {
    const revived = reviveBoard({
      id: 'b', name: 'x',
      columns: [{ id: 'c', title: 'C', rank: 1 }],
      labels: [{ id: 'l', name: 'Odd', color: 'chartreuse' }],
    });
    expect(revived?.labels[0].color).toBe('slate');
  });

  it('accepts every colour the app ships', () => {
    for (const color of LABEL_COLORS) {
      const revived = reviveBoard({
        id: 'b', name: 'x',
        columns: [{ id: 'c', title: 'C', rank: 1 }],
        labels: [{ id: 'l', name: 'L', color: color.id }],
      });
      expect(revived?.labels[0].color).toBe(color.id);
    }
  });

  it('rejects a card with no column', () => {
    expect(reviveCard({ id: 'c' })).toBeNull();
  });

  it('drops a malformed due date', () => {
    expect(reviveCard({ id: 'c', columnId: 'x', due: 'tomorrow' })?.due).toBeNull();
    expect(reviveCard({ id: 'c', columnId: 'x', due: '2026-06-15' })?.due).toBe('2026-06-15');
  });

  it('repairs a missing rank', () => {
    expect(reviveCard({ id: 'c', columnId: 'x' })?.rank).toBe(1);
    expect(reviveCard({ id: 'c', columnId: 'x', rank: Number.NaN })?.rank).toBe(1);
  });

  it('drops cards whose column vanished', () => {
    const board = createBoard('b', NOW);
    const good = createCard(board.columns[0].id, 'keep', 1, NOW);
    const orphan = createCard('gone', 'drop', 1, NOW);
    expect(reconcile([board], [good, orphan]).map((c) => c.title)).toEqual(['keep']);
  });
});
