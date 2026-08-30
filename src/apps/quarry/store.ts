import { createId } from '../../lib/id';
import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION } from './sql';

/**
 * Queries are worth keeping between visits. The data they run against is not:
 * a loaded file lives in the engine's memory and goes when the tab does, which
 * is the honest behaviour for something you dropped in to look at once.
 */

const DB_NAME = 'quarry';
const DB_VERSION = 1;
const DRAFT_KEY = 'quarry:draft';
const LIMIT_KEY = 'quarry:limit';

export type SavedQuery = {
  id: string;
  name: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
};

export function createQuery(name: string, sql: string, now: Date = new Date()): SavedQuery {
  const stamp = now.toISOString();
  return { id: createId('query'), name, sql, createdAt: stamp, updatedAt: stamp };
}

export function reviveQuery(value: unknown): SavedQuery | null {
  if (typeof value !== 'object' || value === null) return null;
  const query = value as Partial<SavedQuery>;
  if (typeof query.id !== 'string') return null;
  if (typeof query.sql !== 'string' || !query.sql.trim()) return null;
  const stamp = new Date().toISOString();
  return {
    id: query.id,
    name: typeof query.name === 'string' && query.name.trim() ? query.name : 'Untitled query',
    sql: query.sql,
    createdAt: typeof query.createdAt === 'string' ? query.createdAt : stamp,
    updatedAt: typeof query.updatedAt === 'string' ? query.updatedAt : stamp,
  };
}

let queries: Collection<SavedQuery> | null = null;

async function connect(): Promise<Collection<SavedQuery>> {
  if (queries) return queries;
  const db = await openDatabase(DB_NAME, DB_VERSION, [{ name: 'queries', keyPath: 'id' }]);
  queries = new Collection<SavedQuery>(db, 'queries');
  return queries;
}

export function loadDraft(): string { return readPref<string>(DRAFT_KEY, ''); }
export function saveDraft(sql: string): void { writePref(DRAFT_KEY, sql); }

export function loadLimit(): number {
  const stored = readPref<number>(LIMIT_KEY, 5000);
  return Number.isFinite(stored) ? Math.max(10, Math.min(200000, Math.round(stored))) : 5000;
}
export function saveLimit(limit: number): void { writePref(LIMIT_KEY, limit); }

export async function loadQueries(): Promise<SavedQuery[]> {
  const store = await connect();
  return (await store.all())
    .map(reviveQuery)
    .filter((query): query is SavedQuery => query !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveQuery(query: SavedQuery): Promise<void> { await (await connect()).put(query); }
export async function deleteQuery(id: string): Promise<void> { await (await connect()).delete(id); }
export async function clearAll(): Promise<void> { await (await connect()).clear(); }

export type QuarryExport = { queries: SavedQuery[] };

export async function buildExport(now: Date = new Date()) {
  const list = await loadQueries();
  return createEnvelope<QuarryExport>(APP_ID, APP_VERSION, { queries: list }, { queries: list.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<QuarryExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.queries) ? envelope.data.queries : [])
    .map(reviveQuery)
    .filter((query): query is SavedQuery => query !== null);
  if (!incoming.length) throw new Error('That export contains no readable queries.');

  const store = await connect();
  if (mode === 'replace') {
    await store.replaceAll(incoming);
    return incoming.length;
  }
  const current = await loadQueries();
  const merged = mergeByNewest(current, incoming);
  await store.replaceAll(merged);
  return merged.length;
}
