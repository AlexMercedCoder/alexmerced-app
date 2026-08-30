import { fromBase64, toBase64 } from '../../lib/bytes';
import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, defaultSettings, revivePage, reviveSettings, type Page, type Settings } from './model';

const DB_NAME = 'foolscap';
const DB_VERSION = 1;
const SETTINGS_KEY = 'foolscap:settings';

let pages: Collection<Page> | null = null;

async function connect(): Promise<Collection<Page>> {
  if (pages) return pages;
  const db = await openDatabase(DB_NAME, DB_VERSION, [{ name: 'pages', keyPath: 'id' }]);
  pages = new Collection<Page>(db, 'pages');
  return pages;
}

export function loadSettings(): Settings { return reviveSettings(readPref(SETTINGS_KEY, defaultSettings)); }
export function saveSettings(settings: Settings): void { writePref(SETTINGS_KEY, settings); }

export async function loadPages(): Promise<Page[]> {
  const store = await connect();
  return (await store.all())
    .map(revivePage)
    .filter((page): page is Page => page !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function savePage(page: Page): Promise<void> { await (await connect()).put(page); }
export async function savePages(list: Page[]): Promise<void> { await (await connect()).replaceAll(list); }
export async function deletePage(id: string): Promise<void> { await (await connect()).delete(id); }
export async function clearAll(): Promise<void> { await (await connect()).clear(); }

export async function storedBytes(): Promise<number> {
  return (await loadPages()).reduce((sum, page) => sum + page.bytes.length, 0);
}

type PortablePage = Omit<Page, 'bytes'> & { bytes: string };

export type FoolscapExport = { pages: PortablePage[]; settings: Settings };

export function toPortable(page: Page): PortablePage {
  return { ...page, bytes: toBase64(page.bytes) };
}

export function fromPortable(value: unknown): Page | null {
  if (typeof value !== 'object' || value === null) return null;
  const portable = value as Partial<PortablePage>;
  if (typeof portable.bytes !== 'string') return null;
  try {
    return revivePage({ ...portable, bytes: fromBase64(portable.bytes) });
  } catch {
    return null;
  }
}

export async function buildExport(now: Date = new Date()) {
  const list = await loadPages();
  return createEnvelope<FoolscapExport>(
    APP_ID, APP_VERSION,
    { pages: list.map(toPortable), settings: loadSettings() },
    { pages: list.length },
    now,
  );
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<FoolscapExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.pages) ? envelope.data.pages : [])
    .map(fromPortable)
    .filter((page): page is Page => page !== null);
  if (!incoming.length) throw new Error('That export contains no readable pages.');

  if (envelope.data.settings) saveSettings(reviveSettings(envelope.data.settings));

  const store = await connect();
  if (mode === 'replace') {
    await store.replaceAll(incoming);
    return incoming.length;
  }

  const current = await loadPages();
  const byId = new Map(current.map((page) => [page.id, page]));
  for (const page of incoming) if (!byId.has(page.id)) byId.set(page.id, page);
  const merged = [...byId.values()];
  await store.replaceAll(merged);
  return merged.length;
}
