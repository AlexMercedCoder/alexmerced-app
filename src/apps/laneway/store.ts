import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import {
  APP_ID,
  APP_VERSION,
  reconcile,
  reviveBoard,
  reviveCard,
  starterBoard,
  type Board,
  type Card,
} from './model';

const DB_NAME = 'laneway';
const DB_VERSION = 1;
const BOARDS = 'boards';
const CARDS = 'cards';
const VIEW_KEY = 'laneway:view';

export type ViewPrefs = {
  boardId: string | null;
  showArchive: boolean;
  compact: boolean;
};

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return {
    boardId: typeof raw.boardId === 'string' ? raw.boardId : null,
    showArchive: raw.showArchive === true,
    compact: raw.compact === true,
  };
}

export function saveView(view: ViewPrefs): void {
  writePref(VIEW_KEY, view);
}

let boardsCollection: Collection<Board> | null = null;
let cardsCollection: Collection<Card> | null = null;

async function connect(): Promise<{ boards: Collection<Board>; cards: Collection<Card> }> {
  if (boardsCollection && cardsCollection) return { boards: boardsCollection, cards: cardsCollection };
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: BOARDS, keyPath: 'id' },
    { name: CARDS, keyPath: 'id', indexes: [{ name: 'columnId', keyPath: 'columnId' }] },
  ]);
  boardsCollection = new Collection<Board>(db, BOARDS);
  cardsCollection = new Collection<Card>(db, CARDS);
  return { boards: boardsCollection, cards: cardsCollection };
}

export type Workspace = { boards: Board[]; cards: Card[] };

/** Reads everything, repairing bad records and seeding a first board if empty. */
export async function loadWorkspace(now: Date = new Date()): Promise<Workspace> {
  const { boards, cards } = await connect();
  const rawBoards = (await boards.all()).map(reviveBoard).filter((board): board is Board => board !== null);

  if (rawBoards.length === 0) {
    const seed = starterBoard(now);
    await boards.put(seed.board);
    await cards.putMany(seed.cards);
    return { boards: [seed.board], cards: seed.cards };
  }

  const rawCards = (await cards.all()).map(reviveCard).filter((card): card is Card => card !== null);
  return { boards: rawBoards, cards: reconcile(rawBoards, rawCards) };
}

export async function saveBoard(board: Board): Promise<void> {
  const { boards } = await connect();
  await boards.put({ ...board, updatedAt: new Date().toISOString() });
}

export async function deleteBoard(boardId: string, boardCards: Card[]): Promise<void> {
  const { boards, cards } = await connect();
  await cards.deleteMany(boardCards.map((card) => card.id));
  await boards.delete(boardId);
}

export async function saveCard(card: Card): Promise<void> {
  const { cards } = await connect();
  await cards.put(card);
}

export async function saveCards(list: Card[]): Promise<void> {
  const { cards } = await connect();
  await cards.putMany(list);
}

export async function deleteCard(id: string): Promise<void> {
  const { cards } = await connect();
  await cards.delete(id);
}

export async function deleteCards(ids: string[]): Promise<void> {
  const { cards } = await connect();
  await cards.deleteMany(ids);
}

export async function clearAll(): Promise<void> {
  const { boards, cards } = await connect();
  await cards.clear();
  await boards.clear();
}

export type LanewayExport = { boards: Board[]; cards: Card[] };

export async function buildExport(now: Date = new Date()) {
  const workspace = await loadWorkspace(now);
  return createEnvelope<LanewayExport>(
    APP_ID,
    APP_VERSION,
    workspace,
    { boards: workspace.boards.length, cards: workspace.cards.length },
    now,
  );
}

export async function applyImport(text: string, mode: ImportMode): Promise<{ boards: number; cards: number }> {
  const envelope = parseEnvelope<LanewayExport>(text, APP_ID);

  const incomingBoards = (Array.isArray(envelope.data.boards) ? envelope.data.boards : [])
    .map(reviveBoard)
    .filter((board): board is Board => board !== null);
  const incomingCards = (Array.isArray(envelope.data.cards) ? envelope.data.cards : [])
    .map(reviveCard)
    .filter((card): card is Card => card !== null);

  if (incomingBoards.length === 0) {
    throw new Error('That export contains no readable boards.');
  }

  const { boards, cards } = await connect();

  if (mode === 'replace') {
    const kept = reconcile(incomingBoards, incomingCards);
    await boards.replaceAll(incomingBoards);
    await cards.replaceAll(kept);
    return { boards: incomingBoards.length, cards: kept.length };
  }

  const current = await loadWorkspace();
  const mergedBoards = mergeByNewest(current.boards, incomingBoards);
  const mergedCards = reconcile(mergedBoards, mergeByNewest(current.cards, incomingCards));

  await boards.replaceAll(mergedBoards);
  await cards.replaceAll(mergedCards);
  return { boards: mergedBoards.length, cards: mergedCards.length };
}
