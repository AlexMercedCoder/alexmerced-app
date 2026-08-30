import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, breakCycles, reparentOrphans, revivePage, starterPages, type Page } from './model';

const DB_NAME = 'warren';
const DB_VERSION = 1;
const STORE = 'pages';
const VIEW_KEY = 'warren:view';

export type ViewPrefs = {
  openPageId: string | null;
  sidebarOpen: boolean;
  showTrash: boolean;
};

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return {
    openPageId: typeof raw.openPageId === 'string' ? raw.openPageId : null,
    sidebarOpen: raw.sidebarOpen !== false,
    showTrash: raw.showTrash === true,
  };
}

export function saveView(view: ViewPrefs): void {
  writePref(VIEW_KEY, view);
}

let pagesCollection: Collection<Page> | null = null;

async function connect(): Promise<Collection<Page>> {
  if (pagesCollection) return pagesCollection;
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: STORE, keyPath: 'id', indexes: [{ name: 'parentId', keyPath: 'parentId' }] },
  ]);
  pagesCollection = new Collection<Page>(db, STORE);
  return pagesCollection;
}

/** Reads every page, repairing the tree and seeding a first page if empty. */
export async function loadPages(now: Date = new Date()): Promise<Page[]> {
  const store = await connect();
  const raw = (await store.all()).map(revivePage).filter((page): page is Page => page !== null);

  if (raw.length === 0) {
    const seed = starterPages(now);
    await store.putMany(seed);
    return seed;
  }

  return breakCycles(reparentOrphans(raw));
}

export async function savePage(page: Page): Promise<void> {
  const store = await connect();
  await store.put(page);
}

export async function savePages(pages: Page[]): Promise<void> {
  const store = await connect();
  await store.putMany(pages);
}

export async function deletePages(ids: string[]): Promise<void> {
  const store = await connect();
  await store.deleteMany(ids);
}

export async function clearAll(): Promise<void> {
  const store = await connect();
  await store.clear();
}

export type WarrenExport = { pages: Page[] };

export async function buildExport(now: Date = new Date()) {
  const pages = await loadPages(now);
  return createEnvelope<WarrenExport>(APP_ID, APP_VERSION, { pages }, { pages: pages.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<WarrenExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.pages) ? envelope.data.pages : [])
    .map(revivePage)
    .filter((page): page is Page => page !== null);

  if (incoming.length === 0) throw new Error('That export contains no readable pages.');

  const store = await connect();
  const next = mode === 'replace' ? incoming : mergeByNewest(await loadPages(), incoming);
  const repaired = breakCycles(reparentOrphans(next));

  await store.replaceAll(repaired);
  return repaired.length;
}
