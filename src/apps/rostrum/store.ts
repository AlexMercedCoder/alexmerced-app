import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, reviveDeck, starterDeck, type Deck } from './model';

const DB_NAME = 'rostrum';
const DB_VERSION = 1;
const VIEW_KEY = 'rostrum:view';

export type StoredImage = { id: string; blob: Blob; name: string };

export type ViewPrefs = { deckId: string | null; slideIndex: number };

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return {
    deckId: typeof raw.deckId === 'string' ? raw.deckId : null,
    slideIndex: typeof raw.slideIndex === 'number' && raw.slideIndex >= 0 ? Math.floor(raw.slideIndex) : 0,
  };
}
export function saveView(view: ViewPrefs): void { writePref(VIEW_KEY, view); }

let decks: Collection<Deck> | null = null;
let images: Collection<StoredImage> | null = null;

async function connect() {
  if (decks && images) return { decks, images };
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: 'decks', keyPath: 'id' },
    { name: 'images', keyPath: 'id' },
  ]);
  decks = new Collection<Deck>(db, 'decks');
  images = new Collection<StoredImage>(db, 'images');
  return { decks, images };
}

export async function loadDecks(now: Date = new Date()): Promise<Deck[]> {
  const store = await connect();
  const loaded = (await store.decks.all()).map(reviveDeck).filter((deck): deck is Deck => deck !== null);
  if (loaded.length) return loaded.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const seed = starterDeck(now);
  await store.decks.put(seed);
  return [seed];
}

export async function saveDeck(deck: Deck): Promise<void> {
  const store = await connect();
  await store.decks.put({ ...deck, updatedAt: new Date().toISOString() });
}

export async function deleteDeck(id: string): Promise<void> {
  const store = await connect();
  await store.decks.delete(id);
}

export async function saveImage(image: StoredImage): Promise<void> {
  const store = await connect();
  await store.images.put(image);
}

export async function loadImage(id: string): Promise<StoredImage | undefined> {
  const store = await connect();
  return store.images.get(id);
}

export async function loadImages(): Promise<StoredImage[]> {
  const store = await connect();
  return store.images.all();
}

export async function clearAll(): Promise<void> {
  const store = await connect();
  await store.images.clear();
  await store.decks.clear();
}

export type RostrumExport = { decks: Deck[] };

export async function buildExport(now: Date = new Date()) {
  const all = await loadDecks(now);
  return createEnvelope<RostrumExport>(APP_ID, APP_VERSION, { decks: all }, { decks: all.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<RostrumExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.decks) ? envelope.data.decks : [])
    .map(reviveDeck)
    .filter((deck): deck is Deck => deck !== null);

  if (!incoming.length) throw new Error('That export contains no readable decks.');

  const store = await connect();
  // Images live in their own store and are not carried in the JSON, so an
  // imported deck may reference pictures this device does not have.
  await store.decks.replaceAll(mode === 'replace' ? incoming : mergeByNewest(await loadDecks(), incoming));
  return (await loadDecks()).length;
}
