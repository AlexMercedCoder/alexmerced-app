import { createId } from '../../lib/id';
import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, SAMPLE_DATA } from './data';
import { defaultSpec, PALETTES, type ChartSpec, type ChartType } from './render';

const DB_NAME = 'ordinate';
const DB_VERSION = 1;
const SELECTED_KEY = 'ordinate:selected';

export type SavedChart = {
  id: string;
  name: string;
  /** The raw text the visitor pasted, kept verbatim so it can be edited again. */
  source: string;
  spec: ChartSpec;
  createdAt: string;
  updatedAt: string;
};

const TYPES: ChartType[] = ['bar', 'groupedBar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'doughnut'];

export function reviveSpec(value: unknown): ChartSpec {
  const base = defaultSpec();
  if (typeof value !== 'object' || value === null) return base;
  const spec = value as Partial<ChartSpec>;

  const flag = (key: keyof ChartSpec) => (typeof spec[key] === 'boolean' ? (spec[key] as boolean) : base[key] as boolean);
  const text = (key: keyof ChartSpec) => (typeof spec[key] === 'string' ? (spec[key] as string) : base[key] as string);
  const size = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(240, Math.min(2400, Math.round(value))) : fallback;

  return {
    type: TYPES.includes(spec.type as ChartType) ? (spec.type as ChartType) : base.type,
    title: text('title'),
    subtitle: text('subtitle'),
    xLabel: text('xLabel'),
    yLabel: text('yLabel'),
    labelField: typeof spec.labelField === 'number' ? Math.round(spec.labelField) : base.labelField,
    series: Array.isArray(spec.series) ? spec.series.filter((index): index is number => typeof index === 'number') : [],
    palette: typeof spec.palette === 'string' && spec.palette in PALETTES ? spec.palette : base.palette,
    width: size(spec.width, base.width),
    height: size(spec.height, base.height),
    showLegend: flag('showLegend'),
    showGrid: flag('showGrid'),
    showValues: flag('showValues'),
    smooth: flag('smooth'),
    horizontal: flag('horizontal'),
    background: /^#[0-9a-f]{3,8}$/i.test(String(spec.background)) ? String(spec.background) : base.background,
  };
}

export function reviveChart(value: unknown): SavedChart | null {
  if (typeof value !== 'object' || value === null) return null;
  const chart = value as Partial<SavedChart>;
  if (typeof chart.id !== 'string') return null;
  const stamp = new Date().toISOString();
  return {
    id: chart.id,
    name: typeof chart.name === 'string' && chart.name.trim() ? chart.name : 'Untitled chart',
    source: typeof chart.source === 'string' ? chart.source : '',
    spec: reviveSpec(chart.spec),
    createdAt: typeof chart.createdAt === 'string' ? chart.createdAt : stamp,
    updatedAt: typeof chart.updatedAt === 'string' ? chart.updatedAt : stamp,
  };
}

export function createChart(name = 'Untitled chart', source = '', now: Date = new Date()): SavedChart {
  const stamp = now.toISOString();
  return { id: createId('chart'), name, source, spec: defaultSpec(), createdAt: stamp, updatedAt: stamp };
}

let charts: Collection<SavedChart> | null = null;

async function connect(): Promise<Collection<SavedChart>> {
  if (charts) return charts;
  const db = await openDatabase(DB_NAME, DB_VERSION, [{ name: 'charts', keyPath: 'id' }]);
  charts = new Collection<SavedChart>(db, 'charts');
  return charts;
}

export function loadSelected(): string | null { return readPref<string | null>(SELECTED_KEY, null); }
export function saveSelected(id: string | null): void { writePref(SELECTED_KEY, id); }

export async function loadCharts(now: Date = new Date()): Promise<SavedChart[]> {
  const store = await connect();
  let list = (await store.all()).map(reviveChart).filter((chart): chart is SavedChart => chart !== null);
  if (list.length === 0) {
    const seed = createChart('Revenue by channel', SAMPLE_DATA, now);
    seed.spec = { ...seed.spec, type: 'line', labelField: 0, series: [1, 2, 3], title: 'Revenue by channel', yLabel: 'Thousands' };
    await store.put(seed);
    list = [seed];
  }
  return sortCharts(list);
}

export function sortCharts(list: SavedChart[]): SavedChart[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveChart(chart: SavedChart): Promise<void> { await (await connect()).put(chart); }
export async function deleteChart(id: string): Promise<void> { await (await connect()).delete(id); }
export async function clearAll(): Promise<void> { await (await connect()).clear(); }

export type OrdinateExport = { charts: SavedChart[] };

export async function buildExport(now: Date = new Date()) {
  const list = await loadCharts(now);
  return createEnvelope<OrdinateExport>(APP_ID, APP_VERSION, { charts: list }, { charts: list.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<OrdinateExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.charts) ? envelope.data.charts : [])
    .map(reviveChart)
    .filter((chart): chart is SavedChart => chart !== null);
  if (!incoming.length) throw new Error('That export contains no readable charts.');

  const store = await connect();
  if (mode === 'replace') {
    await store.replaceAll(incoming);
    return incoming.length;
  }
  const current = (await store.all()).map(reviveChart).filter((chart): chart is SavedChart => chart !== null);
  const merged = mergeByNewest(current, incoming);
  await store.replaceAll(merged);
  return merged.length;
}
