import { createEnvelope, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { createId } from '../../lib/id';
import { APP_ID, APP_VERSION } from './constants';
import { defaultCsvOptions, type CsvOptions, type FormatId } from './formats';

const WORKBENCH_KEY = 'decanter:workbench';
const SNIPPETS_KEY = 'decanter:snippets';

export type Workbench = {
  input: string;
  inputFormat: FormatId | 'auto';
  outputFormat: FormatId;
  csv: CsvOptions;
  transform: 'none' | 'flatten' | 'unflatten' | 'query';
  path: string;
  separator: string;
  tableName: string;
};

export const SAMPLE = `[
  { "id": 1, "name": "Alex", "joined": "2026-01-14", "score": 9.5, "tags": ["lakehouse", "iceberg"] },
  { "id": 2, "name": "Sam", "joined": "2026-02-02", "score": 8, "tags": ["arrow"] },
  { "id": 3, "name": "Ravi", "joined": "2026-03-19", "score": null, "tags": [] }
]`;

export const defaultWorkbench: Workbench = {
  input: SAMPLE,
  inputFormat: 'auto',
  outputFormat: 'yaml',
  csv: defaultCsvOptions,
  transform: 'none',
  path: '$',
  separator: '.',
  tableName: 'my_table',
};

const FORMAT_IDS = new Set<string>(['json', 'ndjson', 'csv', 'yaml', 'toml']);

export function loadWorkbench(): Workbench {
  const raw = readPref<Partial<Workbench>>(WORKBENCH_KEY, {});
  const csv = (typeof raw.csv === 'object' && raw.csv !== null ? raw.csv : {}) as Partial<CsvOptions>;
  return {
    input: typeof raw.input === 'string' ? raw.input : defaultWorkbench.input,
    inputFormat: raw.inputFormat === 'auto' || FORMAT_IDS.has(raw.inputFormat as string) ? raw.inputFormat! : 'auto',
    outputFormat: FORMAT_IDS.has(raw.outputFormat as string) ? (raw.outputFormat as FormatId) : 'yaml',
    csv: {
      delimiter: typeof csv.delimiter === 'string' && csv.delimiter.length === 1 ? csv.delimiter : ',',
      header: csv.header !== false,
      inferTypes: csv.inferTypes !== false,
    },
    transform: ['none', 'flatten', 'unflatten', 'query'].includes(raw.transform as string) ? raw.transform! : 'none',
    path: typeof raw.path === 'string' ? raw.path : '$',
    separator: typeof raw.separator === 'string' && raw.separator ? raw.separator.slice(0, 3) : '.',
    tableName: typeof raw.tableName === 'string' && raw.tableName.trim() ? raw.tableName : 'my_table',
  };
}

export function saveWorkbench(workbench: Workbench): void { writePref(WORKBENCH_KEY, workbench); }

export type Snippet = { id: string; name: string; input: string; inputFormat: FormatId | 'auto'; createdAt: string };

export function loadSnippets(): Snippet[] {
  const raw = readPref<unknown[]>(SNIPPETS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Snippet => typeof item === 'object' && item !== null && typeof (item as Snippet).id === 'string' && typeof (item as Snippet).input === 'string')
    .map((snippet) => ({
      id: snippet.id,
      name: String(snippet.name ?? 'Untitled'),
      input: snippet.input,
      inputFormat: FORMAT_IDS.has(snippet.inputFormat as string) || snippet.inputFormat === 'auto' ? snippet.inputFormat : 'auto',
      createdAt: typeof snippet.createdAt === 'string' ? snippet.createdAt : new Date().toISOString(),
    }));
}

export function saveSnippets(snippets: Snippet[]): void { writePref(SNIPPETS_KEY, snippets); }

export function createSnippet(name: string, input: string, inputFormat: FormatId | 'auto'): Snippet {
  return { id: createId('snip'), name, input, inputFormat, createdAt: new Date().toISOString() };
}

export type DecanterExport = { workbench: Workbench; snippets: Snippet[] };

export function buildExport(now: Date = new Date()) {
  const snippets = loadSnippets();
  return createEnvelope<DecanterExport>(APP_ID, APP_VERSION, { workbench: loadWorkbench(), snippets }, { snippets: snippets.length }, now);
}

export function applyImport(text: string, mode: ImportMode): number {
  const envelope = parseEnvelope<DecanterExport>(text, APP_ID);
  const incoming = Array.isArray(envelope.data.snippets) ? envelope.data.snippets : [];
  if (!incoming.length && !envelope.data.workbench) throw new Error('That export contains nothing readable.');

  if (mode === 'replace') {
    saveSnippets(incoming);
  } else {
    const byId = new Map(loadSnippets().map((snippet) => [snippet.id, snippet]));
    for (const snippet of incoming) byId.set(snippet.id, snippet);
    saveSnippets([...byId.values()]);
  }

  if (envelope.data.workbench) saveWorkbench({ ...loadWorkbench(), ...envelope.data.workbench });
  return loadSnippets().length;
}

export function clearAll(): void {
  saveSnippets([]);
  saveWorkbench(defaultWorkbench);
}
