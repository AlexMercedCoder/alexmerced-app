import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import {
  APP_ID, APP_VERSION, createProject, defaultSettings, reconcile, reviveEntry, reviveProject,
  reviveSettings, stopExtraTimers, type Entry, type Project, type Settings,
} from './model';

const DB_NAME = 'stint';
const DB_VERSION = 1;
const SETTINGS_KEY = 'stint:settings';
const VIEW_KEY = 'stint:view';

export type ViewPrefs = { range: 'day' | 'week'; anchor: string | null };

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return { range: raw.range === 'week' ? 'week' : 'day', anchor: typeof raw.anchor === 'string' ? raw.anchor : null };
}
export function saveView(view: ViewPrefs): void { writePref(VIEW_KEY, view); }

export function loadSettings(): Settings { return reviveSettings(readPref(SETTINGS_KEY, defaultSettings)); }
export function saveSettings(settings: Settings): void { writePref(SETTINGS_KEY, settings); }

let projects: Collection<Project> | null = null;
let entries: Collection<Entry> | null = null;

async function connect() {
  if (projects && entries) return { projects, entries };
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: 'projects', keyPath: 'id' },
    { name: 'entries', keyPath: 'id', indexes: [{ name: 'start', keyPath: 'start' }] },
  ]);
  projects = new Collection<Project>(db, 'projects');
  entries = new Collection<Entry>(db, 'entries');
  return { projects, entries };
}

export type Workspace = { projects: Project[]; entries: Entry[] };

export async function loadWorkspace(now: Date = new Date()): Promise<Workspace> {
  const store = await connect();
  let loadedProjects = (await store.projects.all()).map(reviveProject).filter((p): p is Project => p !== null);

  if (loadedProjects.length === 0) {
    const seed = [createProject('Client work', 'blue', now), createProject('Admin', 'slate', now)];
    seed[0].rate = 100;
    await store.projects.putMany(seed);
    loadedProjects = seed;
  }

  const loadedEntries = (await store.entries.all()).map(reviveEntry).filter((e): e is Entry => e !== null);
  return { projects: loadedProjects, entries: stopExtraTimers(reconcile(loadedProjects, loadedEntries), now) };
}

export async function saveProject(project: Project): Promise<void> { (await connect()).projects.put(project); }
export async function saveEntry(entry: Entry): Promise<void> { (await connect()).entries.put(entry); }
export async function saveEntries(list: Entry[]): Promise<void> { await (await connect()).entries.putMany(list); }
export async function deleteEntry(id: string): Promise<void> { await (await connect()).entries.delete(id); }
export async function deleteProject(id: string): Promise<void> { await (await connect()).projects.delete(id); }

export async function clearAll(): Promise<void> {
  const store = await connect();
  await store.entries.clear();
  await store.projects.clear();
}

export type StintExport = { projects: Project[]; entries: Entry[]; settings: Settings };

export async function buildExport(now: Date = new Date()) {
  const workspace = await loadWorkspace(now);
  return createEnvelope<StintExport>(
    APP_ID, APP_VERSION,
    { ...workspace, settings: loadSettings() },
    { projects: workspace.projects.length, entries: workspace.entries.length },
    now,
  );
}

export async function applyImport(text: string, mode: ImportMode): Promise<{ projects: number; entries: number }> {
  const envelope = parseEnvelope<StintExport>(text, APP_ID);
  const incomingProjects = (Array.isArray(envelope.data.projects) ? envelope.data.projects : []).map(reviveProject).filter((p): p is Project => p !== null);
  const incomingEntries = (Array.isArray(envelope.data.entries) ? envelope.data.entries : []).map(reviveEntry).filter((e): e is Entry => e !== null);

  if (!incomingProjects.length && !incomingEntries.length) throw new Error('That export contains no readable projects or entries.');

  const store = await connect();
  if (mode === 'replace') {
    const kept = stopExtraTimers(reconcile(incomingProjects, incomingEntries));
    await store.projects.replaceAll(incomingProjects);
    await store.entries.replaceAll(kept);
    if (envelope.data.settings) saveSettings(reviveSettings(envelope.data.settings));
    return { projects: incomingProjects.length, entries: kept.length };
  }

  const current = await loadWorkspace();
  const mergedProjects = mergeByNewest(current.projects, incomingProjects);
  const mergedEntries = stopExtraTimers(reconcile(mergedProjects, mergeByNewest(current.entries, incomingEntries)));
  await store.projects.replaceAll(mergedProjects);
  await store.entries.replaceAll(mergedEntries);
  return { projects: mergedProjects.length, entries: mergedEntries.length };
}
