import { apps } from '../../data/apps';
import { openDatabase, type StoreSpec } from '../idb';
import { withWorkspaceLock } from './locks';
const specs = (names: string[], indexes: Record<string, string[]> = {}): StoreSpec[] => names.map(name => ({ name, keyPath: 'id', indexes: (indexes[name] ?? []).map(key => ({ name: key, keyPath: key })) }));
export const DATABASES: Record<string, { version: number; stores: StoreSpec[] }> = {
  warren: { version: 1, stores: specs(['pages'], { pages: ['parentId'] }) },
  jotterbug: { version: 1, stores: specs(['notes'], { notes: ['updatedAt', 'archived'] }) },
  laneway: { version: 1, stores: specs(['boards', 'cards'], { cards: ['columnId'] }) },
  rote: { version: 1, stores: specs(['decks', 'cards'], { cards: ['deckId'] }) },
  stint: { version: 1, stores: specs(['projects', 'entries'], { entries: ['start'] }) },
  tessera: { version: 1, stores: specs(['codes'], { codes: ['updatedAt'] }) },
  rostrum: { version: 1, stores: specs(['decks', 'images']) },
  sift: { version: 1, stores: specs(['patterns']) }, quarry: { version: 1, stores: specs(['queries']) },
  ordinate: { version: 1, stores: specs(['charts']) }, tally: { version: 1, stores: specs(['invoices']) },
  cadence: { version: 1, stores: specs(['clips']) }, foolscap: { version: 1, stores: specs(['pages']) },
  limelight: { version: 4, stores: specs(['projects', 'looks', 'scratch', 'scratchSessions', 'media']) },
};
export const MEDIA_APPS = new Set(['limelight', 'cadence', 'foolscap', 'rostrum']);
export type Snapshot = { app: string; stores: Record<string, unknown[]>; preferences: Record<string, string> };
export type Archive = { format: 'alexmerced.app/backup'; version: 1; createdAt: string; workspaces: Snapshot[] };
// Tagged tuples encode every value, so user objects can never impersonate binary data.
export async function encode(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return ['blob', value.type, await encode(new Uint8Array(await value.arrayBuffer()))];
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let raw = ''; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return ['bytes', value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name, btoa(raw)];
  }
  if (Array.isArray(value)) return ['array', await Promise.all(value.map(encode))];
  if (value && typeof value === 'object') return ['object', await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await encode(v)]))];
  return ['value', value ?? null];
}
export function decode(value: any, depth = 0): any {
  if (depth > 100 || !Array.isArray(value)) throw new Error('Invalid backup value.');
  const [tag, data, payload] = value;
  if (tag === 'value' && (data === null || ['string', 'number', 'boolean'].includes(typeof data))) return data;
  if (tag === 'array' && Array.isArray(data)) return data.map(v => decode(v, depth + 1));
  if (tag === 'object' && Array.isArray(data)) return Object.fromEntries(data.map(([k, v]) => { if (typeof k !== 'string') throw new Error('Invalid property.'); return [k, decode(v, depth + 1)]; }));
  if (tag === 'blob' && typeof data === 'string') return new Blob([decode(payload, depth + 1)], { type: data });
  if (tag === 'bytes' && typeof payload === 'string') {
    const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
    const types = { Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };
    if (data === 'ArrayBuffer') return bytes.buffer;
    const Type = types[data as keyof typeof types];
    if (!Type) throw new Error('Unsupported backup byte type.');
    return new Type(bytes.buffer);
  }
  throw new Error('Invalid backup value.');
}
export function validateArchive(value: any): Archive {
  if (value?.format !== 'alexmerced.app/backup' || value.version !== 1 || !Array.isArray(value.workspaces) || !value.workspaces.length) throw new Error('Choose a workspace backup from this site.');
  const seen = new Set<string>();
  for (const item of value.workspaces) {
    if (!apps.some(a => a.slug === item?.app) || seen.has(item.app)) throw new Error('Unknown or duplicate workspace.');
    seen.add(item.app);
    if (!item.stores || !item.preferences || typeof item.stores !== 'object' || typeof item.preferences !== 'object') throw new Error('Incomplete workspace.');
    const expected = DATABASES[item.app]?.stores.map(s => s.name) ?? [];
    if (Object.keys(item.stores).some(s => !expected.includes(s)) || expected.some(s => !Array.isArray(item.stores[s]))) throw new Error('The backup has missing or unknown stores.');
    for (const rows of Object.values(item.stores) as any[][]) {
      const ids = new Set<string>();
      for (const row of rows) { if (typeof row?.id !== 'string' || ids.has(row.id)) throw new Error('Invalid or duplicate record ID.'); ids.add(row.id); }
    }
    for (const [key, v] of Object.entries(item.preferences)) if (!key.startsWith(`${item.app}:`) || typeof v !== 'string') throw new Error('Invalid workspace preference.');
  }
  return value;
}
function storageKeys(): string[] { return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => key !== null); }
async function database(app: string) {
  const spec = DATABASES[app];
  return spec ? openDatabase(app, spec.version, spec.stores) : null;
}
export async function capture(app: string): Promise<Snapshot> {
  const stores: Snapshot['stores'] = {};
  const db = await database(app);
  if (db) try {
    const names = DATABASES[app].stores.map(s => s.name);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, 'readonly');
      for (const name of names) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { stores[name] = request.result; }; }
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
  const preferences = Object.fromEntries(storageKeys().filter(k => k.startsWith(`${app}:`)).map(k => [k, localStorage.getItem(k)!]));
  return { app, stores, preferences };
}
export async function backup(selected: string[]): Promise<Archive> {
  const workspaces: Snapshot[] = [];
  for (const app of selected) workspaces.push(await withWorkspaceLock(app, () => capture(app)));
  return { format: 'alexmerced.app/backup', version: 1, createdAt: new Date().toISOString(), workspaces };
}
async function write(item: Snapshot): Promise<void> {
  const db = await database(item.app);
  if (db) try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(item.stores), 'readwrite');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Restore failed.'));
      try { for (const [name, rows] of Object.entries(item.stores)) { const store = tx.objectStore(name); store.clear(); for (const row of rows) store.put(row); } }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
  for (const key of storageKeys()) if (key.startsWith(`${item.app}:`)) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(item.preferences)) localStorage.setItem(key, value);
}
export async function restore(archive: Archive, selected: string[], progress: (app: string) => void): Promise<void> {
  validateArchive(archive);
  for (const item of archive.workspaces.filter(w => selected.includes(w.app))) {
    await withWorkspaceLock(item.app, async () => {
      const before = await capture(item.app);
      try { await write(item); } catch (error) {
        try { await write(before); } catch { throw new Error(`${item.app}: restore and rollback failed. Keep your recovery backup.`); }
        throw error;
      }
    });
    progress(item.app);
  }
}
