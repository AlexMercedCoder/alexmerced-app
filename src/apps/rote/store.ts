import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, reconcile, reviveCard, reviveDeck, starterDeck, type Card, type Deck } from './model';

const DB_NAME = 'rote';
const DB_VERSION = 1;
const VIEW_KEY = 'rote:view';

export type ViewPrefs = { deckId: string | null; mode: 'browse' | 'review' };

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return {
    deckId: typeof raw.deckId === 'string' ? raw.deckId : null,
    mode: raw.mode === 'review' ? 'review' : 'browse',
  };
}

export function saveView(view: ViewPrefs): void { writePref(VIEW_KEY, view); }

let decks: Collection<Deck> | null = null;
let cards: Collection<Card> | null = null;

async function connect() {
  if (decks && cards) return { decks, cards };
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: 'decks', keyPath: 'id' },
    { name: 'cards', keyPath: 'id', indexes: [{ name: 'deckId', keyPath: 'deckId' }] },
  ]);
  decks = new Collection<Deck>(db, 'decks');
  cards = new Collection<Card>(db, 'cards');
  return { decks, cards };
}

export type Workspace = { decks: Deck[]; cards: Card[] };

export async function loadWorkspace(now: Date = new Date()): Promise<Workspace> {
  const store = await connect();
  const loadedDecks = (await store.decks.all()).map(reviveDeck).filter((d): d is Deck => d !== null);

  if (loadedDecks.length === 0) {
    const seed = starterDeck(now);
    await store.decks.put(seed.deck);
    await store.cards.putMany(seed.cards);
    return { decks: [seed.deck], cards: seed.cards };
  }

  const loadedCards = (await store.cards.all()).map(reviveCard).filter((c): c is Card => c !== null);
  return { decks: loadedDecks, cards: reconcile(loadedDecks, loadedCards) };
}

export async function saveDeck(deck: Deck): Promise<void> { (await connect()).decks.put(deck); }
export async function saveCard(card: Card): Promise<void> { (await connect()).cards.put(card); }
export async function saveCards(list: Card[]): Promise<void> { await (await connect()).cards.putMany(list); }
export async function deleteCard(id: string): Promise<void> { await (await connect()).cards.delete(id); }
export async function deleteCards(ids: string[]): Promise<void> { await (await connect()).cards.deleteMany(ids); }

export async function deleteDeck(deckId: string, owned: Card[]): Promise<void> {
  const store = await connect();
  await store.cards.deleteMany(owned.map((card) => card.id));
  await store.decks.delete(deckId);
}

export async function clearAll(): Promise<void> {
  const store = await connect();
  await store.cards.clear();
  await store.decks.clear();
}

export type RoteExport = { decks: Deck[]; cards: Card[] };

export async function buildExport(now: Date = new Date()) {
  const workspace = await loadWorkspace(now);
  return createEnvelope<RoteExport>(APP_ID, APP_VERSION, workspace, { decks: workspace.decks.length, cards: workspace.cards.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<{ decks: number; cards: number }> {
  const envelope = parseEnvelope<RoteExport>(text, APP_ID);
  const incomingDecks = (Array.isArray(envelope.data.decks) ? envelope.data.decks : []).map(reviveDeck).filter((d): d is Deck => d !== null);
  const incomingCards = (Array.isArray(envelope.data.cards) ? envelope.data.cards : []).map(reviveCard).filter((c): c is Card => c !== null);

  if (incomingDecks.length === 0) throw new Error('That export contains no readable decks.');

  const store = await connect();
  if (mode === 'replace') {
    const kept = reconcile(incomingDecks, incomingCards);
    await store.decks.replaceAll(incomingDecks);
    await store.cards.replaceAll(kept);
    return { decks: incomingDecks.length, cards: kept.length };
  }

  const current = await loadWorkspace();
  const mergedDecks = mergeByNewest(current.decks, incomingDecks);
  const mergedCards = reconcile(mergedDecks, mergeByNewest(current.cards, incomingCards));
  await store.decks.replaceAll(mergedDecks);
  await store.cards.replaceAll(mergedCards);
  return { decks: mergedDecks.length, cards: mergedCards.length };
}
