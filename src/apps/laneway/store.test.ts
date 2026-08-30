import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, createBoard, createCard, sortedColumns, type Board, type Card } from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deleteBoard,
  loadView,
  loadWorkspace,
  saveBoard,
  saveCard,
  saveView,
} from './store';

const NOW = new Date('2026-06-15T12:00:00Z');

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('first run', () => {
  it('seeds a starter board so the app is never blank', async () => {
    const workspace = await loadWorkspace(NOW);
    expect(workspace.boards).toHaveLength(1);
    expect(workspace.cards.length).toBeGreaterThan(0);
  });

  it('does not re-seed once a board exists', async () => {
    await loadWorkspace(NOW);
    const second = await loadWorkspace(NOW);
    expect(second.boards).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('round trips a board and its cards', async () => {
    await clearAll();
    const board = createBoard('Work', NOW);
    await saveBoard(board);
    const card = createCard(sortedColumns(board)[0].id, 'task', 1, NOW);
    await saveCard(card);

    const workspace = await loadWorkspace(NOW);
    expect(workspace.boards.map((b) => b.name)).toContain('Work');
    expect(workspace.cards.map((c) => c.title)).toContain('task');
  });

  it('drops cards whose column no longer exists', async () => {
    await clearAll();
    const board = createBoard('Work', NOW);
    await saveBoard(board);
    await saveCard(createCard('vanished-column', 'orphan', 1, NOW));
    const workspace = await loadWorkspace(NOW);
    expect(workspace.cards.map((c) => c.title)).not.toContain('orphan');
  });

  it('deletes a board along with its cards', async () => {
    await clearAll();
    const board = createBoard('Doomed', NOW);
    await saveBoard(board);
    const cards = [createCard(sortedColumns(board)[0].id, 'a', 1, NOW)];
    await saveCard(cards[0]);
    await deleteBoard(board.id, cards);

    const workspace = await loadWorkspace(NOW);
    expect(workspace.boards.find((b) => b.id === board.id)).toBeUndefined();
    expect(workspace.cards.find((c) => c.id === cards[0].id)).toBeUndefined();
  });
});

describe('view preferences', () => {
  it('defaults to no board chosen', () => {
    expect(loadView()).toEqual({ boardId: null, showArchive: false, compact: false });
  });

  it('round trips', () => {
    saveView({ boardId: 'abc', showArchive: true, compact: true });
    expect(loadView()).toEqual({ boardId: 'abc', showArchive: true, compact: true });
  });
});

describe('export and import', () => {
  const fileWith = (boards: Board[], cards: Card[]) =>
    JSON.stringify(createEnvelope(APP_ID, 1, { boards, cards }, { boards: boards.length, cards: cards.length }));

  it('exports boards and cards with counts', async () => {
    const workspace = await loadWorkspace(NOW);
    const envelope = await buildExport(NOW);
    expect(envelope.counts.boards).toBe(workspace.boards.length);
    expect(envelope.counts.cards).toBe(workspace.cards.length);
  });

  it('replaces everything on replace', async () => {
    await loadWorkspace(NOW);
    const incoming = createBoard('Imported', NOW);
    const card = createCard(sortedColumns(incoming)[0].id, 'from file', 1, NOW);
    const result = await applyImport(fileWith([incoming], [card]), 'replace');

    expect(result.boards).toBe(1);
    const workspace = await loadWorkspace(NOW);
    expect(workspace.boards.map((b) => b.name)).toEqual(['Imported']);
    expect(workspace.cards.map((c) => c.title)).toEqual(['from file']);
  });

  it('merges boards side by side', async () => {
    const existing = await loadWorkspace(NOW);
    const incoming = createBoard('Second', NOW);
    const result = await applyImport(fileWith([incoming], []), 'merge');
    expect(result.boards).toBe(existing.boards.length + 1);
  });

  it('keeps the newer copy of a board on merge', async () => {
    await clearAll();
    const board = createBoard('Original', NOW);
    await saveBoard(board);
    const older = { ...board, name: 'Older name', updatedAt: '2020-01-01T00:00:00Z' };
    await applyImport(fileWith([older], []), 'merge');
    const workspace = await loadWorkspace(NOW);
    expect(workspace.boards[0].name).toBe('Original');
  });

  it('drops imported cards whose column is missing', async () => {
    await clearAll();
    const incoming = createBoard('Imported', NOW);
    const orphan = createCard('nope', 'orphan', 1, NOW);
    const result = await applyImport(fileWith([incoming], [orphan]), 'replace');
    expect(result.cards).toBe(0);
  });

  it('refuses an export with no readable boards', async () => {
    await expect(applyImport(fileWith([], []), 'replace')).rejects.toThrow(/no readable boards/);
  });

  it('refuses a file from another app', async () => {
    const file = JSON.stringify(createEnvelope('jotterbug', 1, { notes: [] }, {}));
    await expect(applyImport(file, 'merge')).rejects.toThrow(/came from "jotterbug"/);
  });
});
