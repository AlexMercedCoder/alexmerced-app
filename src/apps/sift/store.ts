import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, reviveSavedPattern, type SavedPattern } from './model';

const DB_NAME = 'sift';
const DB_VERSION = 1;
const STORE = 'patterns';
const WORKBENCH_KEY = 'sift:workbench';

export type Workbench = { pattern: string; flags: string; sample: string; replacement: string; tab: 'matches' | 'replace' | 'explain' };

export const defaultWorkbench: Workbench = {
  pattern: "(?<user>[A-Za-z0-9._%+-]+)@(?<host>[A-Za-z0-9.-]+\\.[A-Za-z]{2,})",
  flags: 'g',
  sample: 'Write to alex@example.com or support@sub.domain.co.uk.\nThis one is not an address: nobody@ or @nowhere.com',
  replacement: '$<user> at $<host>',
  tab: 'matches',
};

export function loadWorkbench(): Workbench {
  const raw = readPref<Partial<Workbench>>(WORKBENCH_KEY, {});
  return {
    pattern: typeof raw.pattern === 'string' ? raw.pattern : defaultWorkbench.pattern,
    flags: typeof raw.flags === 'string' ? raw.flags : defaultWorkbench.flags,
    sample: typeof raw.sample === 'string' ? raw.sample : defaultWorkbench.sample,
    replacement: typeof raw.replacement === 'string' ? raw.replacement : defaultWorkbench.replacement,
    tab: raw.tab === 'replace' || raw.tab === 'explain' ? raw.tab : 'matches',
  };
}

export function saveWorkbench(workbench: Workbench): void {
  writePref(WORKBENCH_KEY, workbench);
}

let patterns: Collection<SavedPattern> | null = null;

async function connect(): Promise<Collection<SavedPattern>> {
  if (patterns) return patterns;
  const db = await openDatabase(DB_NAME, DB_VERSION, [{ name: STORE, keyPath: 'id' }]);
  patterns = new Collection<SavedPattern>(db, STORE);
  return patterns;
}

export async function loadPatterns(): Promise<SavedPattern[]> {
  const store = await connect();
  return (await store.all())
    .map(reviveSavedPattern)
    .filter((saved): saved is SavedPattern => saved !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function savePattern(saved: SavedPattern): Promise<void> {
  (await connect()).put(saved);
}

export async function deletePattern(id: string): Promise<void> {
  await (await connect()).delete(id);
}

export async function clearAll(): Promise<void> {
  await (await connect()).clear();
}

export type SiftExport = { patterns: SavedPattern[]; workbench: Workbench };

export async function buildExport(now: Date = new Date()) {
  const saved = await loadPatterns();
  return createEnvelope<SiftExport>(APP_ID, APP_VERSION, { patterns: saved, workbench: loadWorkbench() }, { patterns: saved.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<SiftExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.patterns) ? envelope.data.patterns : [])
    .map(reviveSavedPattern)
    .filter((saved): saved is SavedPattern => saved !== null);

  if (incoming.length === 0) throw new Error('That export contains no readable patterns.');

  const store = await connect();
  await store.replaceAll(mode === 'replace' ? incoming : mergeByNewest(await loadPatterns(), incoming));
  if (envelope.data.workbench) saveWorkbench({ ...loadWorkbench(), ...envelope.data.workbench });
  return (await loadPatterns()).length;
}
