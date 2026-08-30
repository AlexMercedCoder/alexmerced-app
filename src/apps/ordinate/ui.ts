import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob, downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { parseInput, SAMPLE_DATA, suggestFields, type Table } from './data';
import { PALETTES, renderChart, type ChartSpec, type ChartType } from './render';
import { registerTools } from '../../lib/webmcp';
import { ordinateTools } from './mcp';
import {
  applyImport, buildExport, clearAll, createChart, deleteChart, loadCharts, loadSelected,
  saveChart, saveSelected, sortCharts, type SavedChart,
} from './store';

const TYPE_LABELS: { id: ChartType; label: string; note: string }[] = [
  { id: 'bar', label: 'Bar', note: 'One bar per row' },
  { id: 'groupedBar', label: 'Grouped bars', note: 'Series side by side' },
  { id: 'stackedBar', label: 'Stacked bars', note: 'Series piled up' },
  { id: 'line', label: 'Line', note: 'Change over a sequence' },
  { id: 'area', label: 'Area', note: 'Line with the space filled' },
  { id: 'scatter', label: 'Scatter', note: 'First column against the rest' },
  { id: 'pie', label: 'Pie', note: 'Parts of a whole' },
  { id: 'doughnut', label: 'Doughnut', note: 'Pie with the middle out' },
];

/** Chart types that only ever show one series, so the picker can say so. */
const SINGLE_SERIES = new Set<ChartType>(['pie', 'doughnut']);

export async function mountOrdinate(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const sourceEl = $<HTMLTextAreaElement>('or-source');
  const canvasEl = $<HTMLDivElement>('or-canvas');
  const warningEl = $<HTMLParagraphElement>('or-warning');
  const seriesEl = $<HTMLDivElement>('or-series');
  const labelEl = $<HTMLSelectElement>('or-label');
  const typesEl = $<HTMLDivElement>('or-types');
  const listEl = $<HTMLDivElement>('or-list');
  const summaryEl = $<HTMLParagraphElement>('or-summary');
  const nameEl = $<HTMLInputElement>('or-name');

  let charts: SavedChart[] = [];
  let current: SavedChart | null = null;
  let table: Table = { columns: [], rows: [] };
  let saveTimer = 0;

  // ------------------------------------------------------------------ saving

  /** Writing on every keystroke would thrash IndexedDB, so it is deferred. */
  function queueSave(): void {
    if (!current) return;
    current.updatedAt = new Date().toISOString();
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      if (current) void saveChart(current);
    }, 350);
  }

  const spec = (): ChartSpec => current!.spec;

  function update(mutate: (spec: ChartSpec) => void): void {
    if (!current) return;
    mutate(current.spec);
    queueSave();
    draw();
  }

  // ------------------------------------------------------------------ drawing

  function draw(): void {
    if (!current) return;
    const result = renderChart(table, spec());
    canvasEl.innerHTML = result.svg;
    warningEl.textContent = result.warning ?? '';
    warningEl.hidden = !result.warning;
  }

  function reparse(keepFields: boolean): void {
    if (!current) return;
    table = parseInput(current.source);

    summaryEl.textContent = table.rows.length
      ? `${table.rows.length} row${table.rows.length === 1 ? '' : 's'}, ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}`
      : 'Nothing readable yet';

    if (!keepFields || spec().series.length === 0) {
      const suggested = suggestFields(table);
      current.spec.labelField = suggested.label;
      current.spec.series = suggested.series;
    } else {
      // Drop any column that no longer exists after an edit.
      current.spec.series = spec().series.filter((index) => index < table.columns.length);
      if (spec().labelField >= table.columns.length) current.spec.labelField = -1;
    }

    renderFields();
    draw();
  }

  // ------------------------------------------------------------------ field pickers

  function renderFields(): void {
    if (!current) return;

    labelEl.innerHTML = '<option value="-1">Row number</option>';
    table.columns.forEach((column, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = column;
      labelEl.append(option);
    });
    labelEl.value = String(spec().labelField);

    const single = SINGLE_SERIES.has(spec().type);
    seriesEl.innerHTML = '';
    table.columns.forEach((column, index) => {
      const chosen = spec().series.includes(index);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'or-chip';
      chip.textContent = column;
      chip.setAttribute('aria-pressed', String(chosen));
      chip.addEventListener('click', () => {
        update((draft) => {
          if (single) {
            draft.series = chosen ? [] : [index];
          } else if (chosen) {
            draft.series = draft.series.filter((entry) => entry !== index);
          } else {
            draft.series = [...draft.series, index].sort((a, b) => a - b);
          }
        });
        renderFields();
      });
      seriesEl.append(chip);
    });

    $<HTMLParagraphElement>('or-series-note').textContent = single
      ? 'A pie shows one column at a time.'
      : spec().type === 'scatter'
        ? 'The first column you pick is the horizontal axis.'
        : 'Pick the columns to plot.';
  }

  // ------------------------------------------------------------------ type picker

  for (const entry of TYPE_LABELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'or-type';
    button.dataset.type = entry.id;
    button.title = entry.note;
    button.innerHTML = `${typeGlyph(entry.id)}<span>${entry.label}</span>`;
    button.addEventListener('click', () => {
      update((draft) => {
        draft.type = entry.id;
        // A pie cannot show four columns, so trim rather than silently ignore them.
        if (SINGLE_SERIES.has(entry.id) && draft.series.length > 1) draft.series = draft.series.slice(0, 1);
      });
      markTypes();
      renderFields();
    });
    typesEl.append(button);
  }

  function markTypes(): void {
    for (const button of typesEl.querySelectorAll<HTMLButtonElement>('.or-type')) {
      button.setAttribute('aria-pressed', String(button.dataset.type === spec().type));
    }
  }

  function typeGlyph(type: ChartType): string {
    const shapes: Record<ChartType, string> = {
      bar: '<rect x="2" y="9" width="4" height="9"/><rect x="8" y="4" width="4" height="14"/><rect x="14" y="12" width="4" height="6"/>',
      groupedBar: '<rect x="2" y="8" width="3" height="10"/><rect x="6" y="4" width="3" height="14"/><rect x="12" y="11" width="3" height="7"/><rect x="16" y="6" width="3" height="12"/>',
      stackedBar: '<rect x="3" y="10" width="5" height="8"/><rect x="3" y="4" width="5" height="5"/><rect x="12" y="8" width="5" height="10"/><rect x="12" y="3" width="5" height="4"/>',
      line: '<polyline points="2,15 7,8 12,11 18,3" fill="none" stroke="currentColor" stroke-width="2"/>',
      area: '<path d="M2 15 L7 8 L12 11 L18 3 L18 18 L2 18 Z" fill="currentColor" opacity="0.35"/><polyline points="2,15 7,8 12,11 18,3" fill="none" stroke="currentColor" stroke-width="2"/>',
      scatter: '<circle cx="4" cy="14" r="2"/><circle cx="9" cy="7" r="2"/><circle cx="13" cy="12" r="2"/><circle cx="17" cy="5" r="2"/>',
      pie: '<path d="M10 10 L10 2 A8 8 0 0 1 17 13 Z"/><path d="M10 10 L17 13 A8 8 0 1 1 10 2 Z" opacity="0.4"/>',
      doughnut: '<path d="M10 2 A8 8 0 0 1 18 10 L13 10 A3 3 0 0 0 10 7 Z"/><path d="M18 10 A8 8 0 1 1 10 2 L10 7 A3 3 0 1 0 13 10 Z" opacity="0.4"/>',
    };
    return `<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">${shapes[type]}</svg>`;
  }

  // ------------------------------------------------------------------ simple controls

  sourceEl.addEventListener('input', () => {
    if (!current) return;
    current.source = sourceEl.value;
    queueSave();
    reparse(true);
  });

  labelEl.addEventListener('change', () => update((draft) => { draft.labelField = Number(labelEl.value); }));

  nameEl.addEventListener('input', () => {
    if (!current) return;
    current.name = nameEl.value;
    queueSave();
    renderList();
  });

  const textFields: [string, keyof ChartSpec][] = [
    ['or-title', 'title'], ['or-subtitle', 'subtitle'], ['or-xlabel', 'xLabel'], ['or-ylabel', 'yLabel'],
  ];
  for (const [id, key] of textFields) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => update((draft) => { (draft[key] as string) = input.value; }));
  }

  const toggles: [string, keyof ChartSpec][] = [
    ['or-legend', 'showLegend'], ['or-grid', 'showGrid'], ['or-values', 'showValues'],
    ['or-smooth', 'smooth'], ['or-horizontal', 'horizontal'],
  ];
  for (const [id, key] of toggles) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => update((draft) => { (draft[key] as boolean) = input.checked; }));
  }

  const sizeFields: [string, 'width' | 'height'][] = [['or-width', 'width'], ['or-height', 'height']];
  for (const [id, key] of sizeFields) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      const clamped = Number.isFinite(value) ? Math.max(240, Math.min(2400, Math.round(value))) : spec()[key];
      input.value = String(clamped);
      update((draft) => { draft[key] = clamped; });
    });
  }

  const backgroundEl = $<HTMLInputElement>('or-background');
  backgroundEl.addEventListener('input', () => update((draft) => { draft.background = backgroundEl.value; }));
  $<HTMLButtonElement>('or-transparent').addEventListener('click', () => {
    // Eight-digit hex with a zero alpha, which SVG understands and PNG respects.
    update((draft) => { draft.background = draft.background === '#ffffff00' ? '#ffffff' : '#ffffff00'; });
    markTransparent();
  });
  function markTransparent(): void {
    $<HTMLButtonElement>('or-transparent').setAttribute('aria-pressed', String(spec().background.length === 9));
  }

  const paletteEl = $<HTMLDivElement>('or-palettes');
  for (const [name, colours] of Object.entries(PALETTES)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'or-palette';
    button.dataset.palette = name;
    button.title = name;
    button.setAttribute('aria-label', `${name} palette`);
    button.innerHTML = colours.slice(0, 5).map((colour) => `<i style="background:${colour}"></i>`).join('');
    button.addEventListener('click', () => {
      update((draft) => { draft.palette = name; });
      markPalettes();
    });
    paletteEl.append(button);
  }
  function markPalettes(): void {
    for (const button of paletteEl.querySelectorAll<HTMLButtonElement>('.or-palette')) {
      button.setAttribute('aria-pressed', String(button.dataset.palette === spec().palette));
    }
  }

  // ------------------------------------------------------------------ chart list

  function renderList(): void {
    listEl.innerHTML = '';
    for (const chart of charts) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'or-row';
      if (current && chart.id === current.id) row.setAttribute('aria-current', 'true');
      row.innerHTML = `<strong>${escapeHtml(chart.name)}</strong><span>${chart.spec.type}</span>`;
      row.addEventListener('click', () => select(chart.id));
      listEl.append(row);
    }
  }

  function select(id: string): void {
    current = charts.find((chart) => chart.id === id) ?? charts[0] ?? null;
    saveSelected(current?.id ?? null);
    if (!current) return;

    sourceEl.value = current.source;
    nameEl.value = current.name;
    for (const [fieldId, key] of textFields) $<HTMLInputElement>(fieldId).value = spec()[key] as string;
    for (const [fieldId, key] of toggles) $<HTMLInputElement>(fieldId).checked = spec()[key] as boolean;
    $<HTMLInputElement>('or-width').value = String(spec().width);
    $<HTMLInputElement>('or-height').value = String(spec().height);
    backgroundEl.value = spec().background.slice(0, 7);

    markTypes();
    markPalettes();
    markTransparent();
    renderList();
    reparse(true);
  }

  $<HTMLButtonElement>('or-new').addEventListener('click', async () => {
    const chart = createChart('Untitled chart', SAMPLE_DATA);
    await saveChart(chart);
    charts = sortCharts([chart, ...charts]);
    select(chart.id);
    nameEl.select();
  });

  $<HTMLButtonElement>('or-delete').addEventListener('click', async () => {
    if (!current || !confirm(`Delete "${current.name}"?`)) return;
    await deleteChart(current.id);
    charts = charts.filter((chart) => chart.id !== current!.id);
    if (!charts.length) {
      const fresh = createChart('Untitled chart', SAMPLE_DATA);
      await saveChart(fresh);
      charts = [fresh];
    }
    select(charts[0].id);
  });

  // ------------------------------------------------------------------ downloads

  function fileStem(): string {
    return (current?.name ?? 'chart').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'chart';
  }

  $<HTMLButtonElement>('or-svg').addEventListener('click', () => {
    if (!current) return;
    downloadFile(`${fileStem()}.svg`, renderChart(table, spec()).svg, 'image/svg+xml');
    toast('SVG saved.', { kind: 'good' });
  });

  $<HTMLButtonElement>('or-png').addEventListener('click', async () => {
    if (!current) return;
    const scale = Number($<HTMLSelectElement>('or-scale').value) || 2;
    try {
      const blob = await toPng(renderChart(table, spec()).svg, spec().width, spec().height, scale);
      downloadBlob(`${fileStem()}.png`, blob);
      toast(`PNG saved at ${scale}x.`, { kind: 'good' });
    } catch {
      toast('The browser could not rasterise this chart. The SVG download always works.', { kind: 'error' });
    }
  });

  $<HTMLButtonElement>('or-copy-svg').addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(renderChart(table, spec()).svg);
      toast('SVG markup copied.', { kind: 'good' });
    } catch {
      toast('The browser would not let this page use the clipboard.', { kind: 'error' });
    }
  });

  $<HTMLButtonElement>('or-sample').addEventListener('click', () => {
    if (!current) return;
    current.source = SAMPLE_DATA;
    sourceEl.value = SAMPLE_DATA;
    queueSave();
    reparse(false);
  });

  // ------------------------------------------------------------------ start

  wireDataMenu(root, {
    app: 'ordinate',
    buildExport,
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `${count} chart${count === 1 ? '' : 's'} in place.`;
    },
    onImported: async () => {
      charts = await loadCharts();
      select(loadSelected() ?? charts[0]?.id ?? '');
    },
    onClearAll: async () => {
      await clearAll();
      charts = await loadCharts();
      select(charts[0]?.id ?? '');
    },
    clearWarning: 'Every saved chart in this browser will be deleted.',
  });

  charts = await loadCharts();
  select(loadSelected() ?? charts[0]?.id ?? '');

  /** Reloads the saved charts, so one an agent saved appears on the page. */
  async function refreshLibrary(): Promise<void> {
    charts = await loadCharts();
    renderList();
  }

  // Everything this app can do, offered to an agent on this page.
  registerTools(ordinateTools(refreshLibrary));
}

/**
 * Rasterises the SVG through an image and a canvas. The SVG has to carry
 * explicit width and height attributes or some browsers rasterise it at zero.
 */
async function toPng(svg: string, width: number, height: number, scale: number): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The SVG would not load as an image.'));
      image.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D context.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Canvas produced nothing.'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
