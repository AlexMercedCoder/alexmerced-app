import { createEnvelope, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, reconcile, reviveTable, starterDataset, type Dataset, type OutputFormat, type Table } from './model';

const DATASET_KEY = 'fabler:dataset';
const VIEW_KEY = 'fabler:view';

export type ViewPrefs = { format: OutputFormat; previewRows: number };
const FORMATS = new Set<string>(['json', 'ndjson', 'csv', 'sql', 'ddl']);

export function loadView(): ViewPrefs {
  const raw = readPref<Partial<ViewPrefs>>(VIEW_KEY, {});
  return {
    format: FORMATS.has(raw.format as string) ? (raw.format as OutputFormat) : 'json',
    previewRows: typeof raw.previewRows === 'number' && raw.previewRows > 0 ? Math.min(200, Math.floor(raw.previewRows)) : 10,
  };
}
export function saveView(view: ViewPrefs): void { writePref(VIEW_KEY, view); }

export function loadDataset(): Dataset {
  const raw = readPref<Partial<Dataset>>(DATASET_KEY, {});
  const tables = Array.isArray(raw.tables)
    ? raw.tables.map(reviveTable).filter((table): table is Table => table !== null)
    : [];

  if (!tables.length) return starterDataset();
  return {
    seed: typeof raw.seed === 'string' && raw.seed ? raw.seed : 'alexmerced',
    tables: reconcile(tables),
  };
}

export function saveDataset(dataset: Dataset): void { writePref(DATASET_KEY, dataset); }

export type FablerExport = { dataset: Dataset };

export function buildExport(now: Date = new Date()) {
  const dataset = loadDataset();
  return createEnvelope<FablerExport>(APP_ID, APP_VERSION, { dataset }, { tables: dataset.tables.length }, now);
}

export function applyImport(text: string, mode: ImportMode): number {
  const envelope = parseEnvelope<FablerExport>(text, APP_ID);
  const incoming = envelope.data.dataset;
  const tables = Array.isArray(incoming?.tables)
    ? incoming.tables.map(reviveTable).filter((table): table is Table => table !== null)
    : [];

  if (!tables.length) throw new Error('That export contains no readable tables.');

  if (mode === 'replace') {
    saveDataset({ seed: incoming.seed || 'alexmerced', tables: reconcile(tables) });
  } else {
    const current = loadDataset();
    const byName = new Map(current.tables.map((table) => [table.name, table]));
    for (const table of tables) byName.set(table.name, table);
    saveDataset({ seed: current.seed, tables: reconcile([...byName.values()]) });
  }

  return loadDataset().tables.length;
}

export function clearAll(): void { saveDataset(starterDataset()); }
