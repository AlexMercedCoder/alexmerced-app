import { wireDataMenu } from '../../lib/dataMenu';
import { downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { APP_ID } from './constants';
import {
  FORMATS, ParseError, detectFormat, parse, write, type FormatId, type Json,
} from './formats';
import {
  describe as describeData, flatten, inferSchema, query, toIcebergSchema, toJsonSchema, toSqlDdl, unflatten,
} from './transform';
import {
  SAMPLE, applyImport, buildExport, clearAll, createSnippet, loadSnippets, loadWorkbench,
  saveSnippets, saveWorkbench, type Snippet, type Workbench,
} from './store';

const EXTENSIONS: Record<FormatId, string> = { json: 'json', ndjson: 'ndjson', csv: 'csv', yaml: 'yaml', toml: 'toml' };

export async function mountDecanter(root: HTMLElement): Promise<void> {
  let workbench: Workbench = loadWorkbench();
  let snippets: Snippet[] = loadSnippets();
  let parsed: Json = null;

  const input = root.querySelector<HTMLTextAreaElement>('#dc-input')!;
  const output = root.querySelector<HTMLElement>('#dc-output')!;
  const status = root.querySelector<HTMLElement>('#dc-status')!;
  const stats = root.querySelector<HTMLElement>('#dc-stats')!;
  const inFormat = root.querySelector<HTMLSelectElement>('#dc-in-format')!;
  const outFormat = root.querySelector<HTMLSelectElement>('#dc-out-format')!;
  const detected = root.querySelector<HTMLElement>('#dc-detected')!;
  const transformSelect = root.querySelector<HTMLSelectElement>('#dc-transform')!;
  const pathInput = root.querySelector<HTMLInputElement>('#dc-path')!;
  const separatorInput = root.querySelector<HTMLInputElement>('#dc-separator')!;
  const csvDelimiter = root.querySelector<HTMLInputElement>('#dc-delimiter')!;
  const csvHeader = root.querySelector<HTMLInputElement>('#dc-header')!;
  const csvInfer = root.querySelector<HTMLInputElement>('#dc-infer')!;
  const tableName = root.querySelector<HTMLInputElement>('#dc-table')!;
  const schemaOut = root.querySelector<HTMLElement>('#dc-schema')!;
  const schemaTabs = root.querySelector<HTMLElement>('#dc-schema-tabs')!;
  const snippetList = root.querySelector<HTMLElement>('#dc-snippets')!;

  let schemaTab: 'fields' | 'sql' | 'iceberg' | 'jsonschema' = 'fields';

  const effectiveInputFormat = (): FormatId =>
    workbench.inputFormat === 'auto' ? detectFormat(workbench.input) : workbench.inputFormat;

  function run(): void {
    saveWorkbench(workbench);
    const format = effectiveInputFormat();
    detected.textContent = workbench.inputFormat === 'auto' ? `detected: ${format}` : '';

    try {
      parsed = parse(workbench.input, format, workbench.csv);
    } catch (error) {
      status.dataset.state = 'error';
      status.textContent = error instanceof ParseError || error instanceof Error ? error.message : 'That could not be parsed.';
      output.textContent = '';
      stats.textContent = '';
      schemaOut.textContent = '';
      return;
    }

    let value = parsed;
    try {
      if (workbench.transform === 'flatten') value = flatten(value, workbench.separator) as Json;
      else if (workbench.transform === 'unflatten') {
        if (Array.isArray(value)) value = value.map((row) => unflatten(row as Record<string, Json>, workbench.separator));
        else value = unflatten(value as Record<string, Json>, workbench.separator);
      } else if (workbench.transform === 'query') {
        const results = query(value, workbench.path);
        value = results.length === 1 ? results[0] : results;
      }
    } catch (error) {
      status.dataset.state = 'error';
      status.textContent = error instanceof Error ? error.message : 'That transform failed.';
      return;
    }

    try {
      output.textContent = write(value, workbench.outputFormat, workbench.csv);
      status.dataset.state = 'ok';
      status.textContent = `${format} → ${workbench.outputFormat}`;
    } catch (error) {
      status.dataset.state = 'error';
      status.textContent = error instanceof Error ? error.message : 'That could not be written.';
      output.textContent = '';
      return;
    }

    const summary = describeData(parsed, workbench.input);
    stats.textContent = `${summary.records} record${summary.records === 1 ? '' : 's'} · ${summary.fields} field${summary.fields === 1 ? '' : 's'} · depth ${summary.depth} · ${summary.bytes} bytes in`;

    renderSchema();
  }

  function renderSchema(): void {
    const fields = inferSchema(parsed);

    for (const button of schemaTabs.querySelectorAll<HTMLElement>('[data-schema-tab]')) {
      button.classList.toggle('is-active', button.dataset.schemaTab === schemaTab);
    }

    if (!fields.length) {
      schemaOut.textContent = 'A schema needs an array of objects. Convert to an array of records first, or flatten a nested document.';
      return;
    }

    if (schemaTab === 'sql') { schemaOut.textContent = toSqlDdl(fields, workbench.tableName); return; }
    if (schemaTab === 'iceberg') { schemaOut.textContent = toIcebergSchema(fields); return; }
    if (schemaTab === 'jsonschema') { schemaOut.textContent = toJsonSchema(fields, workbench.tableName); return; }

    const lines = fields.map((field) => {
      const nullable = field.nullable ? '?' : '';
      const presence = field.presence < 1 ? ` (present in ${Math.round(field.presence * 100)}%)` : '';
      const examples = field.examples.length ? `  e.g. ${field.examples.join(', ')}` : '';
      return `${field.name}${nullable}: ${field.types.join(' | ')}${presence}${examples}`;
    });
    schemaOut.textContent = lines.join('\n');
  }

  function renderControls(): void {
    inFormat.value = workbench.inputFormat;
    outFormat.value = workbench.outputFormat;
    transformSelect.value = workbench.transform;
    pathInput.value = workbench.path;
    separatorInput.value = workbench.separator;
    csvDelimiter.value = workbench.csv.delimiter === '\t' ? '\\t' : workbench.csv.delimiter;
    csvHeader.checked = workbench.csv.header;
    csvInfer.checked = workbench.csv.inferTypes;
    tableName.value = workbench.tableName;
    root.dataset.transform = workbench.transform;
    root.dataset.csv = effectiveInputFormat() === 'csv' || workbench.outputFormat === 'csv' ? 'true' : 'false';
  }

  function renderSnippets(): void {
    snippetList.innerHTML = '';
    if (!snippets.length) {
      snippetList.innerHTML = '<p class="dc-note">Nothing saved. Paste something you use often and press Save.</p>';
      return;
    }
    for (const snippet of snippets) {
      const row = document.createElement('div');
      row.className = 'dc-snippet';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'dc-snippet__open';
      open.dataset.loadSnippet = snippet.id;
      open.textContent = snippet.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dc-snippet__remove';
      remove.dataset.deleteSnippet = snippet.id;
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Delete ${snippet.name}`);
      row.append(open, remove);
      snippetList.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ events
  input.addEventListener('input', () => { workbench = { ...workbench, input: input.value }; run(); renderControls(); });
  inFormat.addEventListener('change', () => { workbench = { ...workbench, inputFormat: inFormat.value as Workbench['inputFormat'] }; renderControls(); run(); });
  outFormat.addEventListener('change', () => { workbench = { ...workbench, outputFormat: outFormat.value as FormatId }; renderControls(); run(); });
  transformSelect.addEventListener('change', () => { workbench = { ...workbench, transform: transformSelect.value as Workbench['transform'] }; renderControls(); run(); });
  pathInput.addEventListener('input', () => { workbench = { ...workbench, path: pathInput.value }; run(); });
  separatorInput.addEventListener('input', () => { workbench = { ...workbench, separator: separatorInput.value || '.' }; run(); });
  tableName.addEventListener('input', () => { workbench = { ...workbench, tableName: tableName.value || 'my_table' }; renderSchema(); });

  csvDelimiter.addEventListener('input', () => {
    const raw = csvDelimiter.value;
    const delimiter = raw === '\\t' ? '\t' : raw.slice(0, 1) || ',';
    workbench = { ...workbench, csv: { ...workbench.csv, delimiter } };
    run();
  });
  csvHeader.addEventListener('change', () => { workbench = { ...workbench, csv: { ...workbench.csv, header: csvHeader.checked } }; run(); });
  csvInfer.addEventListener('change', () => { workbench = { ...workbench, csv: { ...workbench.csv, inferTypes: csvInfer.checked } }; run(); });

  schemaTabs.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-schema-tab]');
    if (!target?.dataset.schemaTab) return;
    schemaTab = target.dataset.schemaTab as typeof schemaTab;
    renderSchema();
  });

  root.querySelector('#dc-swap')?.addEventListener('click', () => {
    const currentIn = effectiveInputFormat();
    workbench = { ...workbench, input: output.textContent ?? '', inputFormat: workbench.outputFormat, outputFormat: currentIn };
    input.value = workbench.input;
    renderControls();
    run();
  });

  root.querySelector('#dc-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.textContent ?? '');
      toast('Output copied.', { kind: 'good' });
    } catch { toast('The browser would not let us reach the clipboard.', { kind: 'error' }); }
  });

  root.querySelector('#dc-download')?.addEventListener('click', () => {
    const text = output.textContent ?? '';
    if (!text) { toast('There is nothing to download yet.', { kind: 'error' }); return; }
    downloadFile(`decanter.${EXTENSIONS[workbench.outputFormat]}`, text, 'text/plain');
    toast('Saved.', { kind: 'good' });
  });

  root.querySelector('#dc-copy-schema')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(schemaOut.textContent ?? '');
      toast('Schema copied.', { kind: 'good' });
    } catch { toast('The browser would not let us reach the clipboard.', { kind: 'error' }); }
  });

  root.querySelector('#dc-sample')?.addEventListener('click', () => {
    workbench = { ...workbench, input: SAMPLE, inputFormat: 'auto' };
    input.value = SAMPLE;
    renderControls();
    run();
  });

  root.querySelector('#dc-save-snippet')?.addEventListener('click', () => {
    if (!workbench.input.trim()) { toast('There is nothing to save.', { kind: 'error' }); return; }
    const name = window.prompt('Name this snippet', 'My data');
    if (!name?.trim()) return;
    snippets = [createSnippet(name.trim(), workbench.input, workbench.inputFormat), ...snippets];
    saveSnippets(snippets);
    renderSnippets();
    toast('Saved to this device.', { kind: 'good' });
  });

  snippetList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-load-snippet], [data-delete-snippet]');
    if (!target) return;

    if (target.dataset.loadSnippet) {
      const snippet = snippets.find((item) => item.id === target.dataset.loadSnippet);
      if (!snippet) return;
      workbench = { ...workbench, input: snippet.input, inputFormat: snippet.inputFormat };
      input.value = snippet.input;
      renderControls();
      run();
      return;
    }

    if (target.dataset.deleteSnippet) {
      const snippet = snippets.find((item) => item.id === target.dataset.deleteSnippet);
      if (!snippet) return;
      snippets = snippets.filter((item) => item.id !== snippet.id);
      saveSnippets(snippets);
      renderSnippets();
      toast(`Deleted "${snippet.name}".`, {
        actionLabel: 'Undo',
        onAction: () => { snippets = [snippet, ...snippets]; saveSnippets(snippets); renderSnippets(); },
      });
    }
  });

  const dropZone = root.querySelector<HTMLElement>('#dc-input-wrap')!;
  for (const name of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.dataset.over = 'true'; });
  }
  for (const name of ['dragleave', 'drop'] as const) {
    dropZone.addEventListener(name, () => { delete dropZone.dataset.over; });
  }
  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    const text = await file.text();
    workbench = { ...workbench, input: text, inputFormat: 'auto' };
    input.value = text;
    renderControls();
    run();
    toast(`Loaded ${file.name}.`, { kind: 'good' });
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: (text, mode) => {
      const count = applyImport(text, mode);
      return `Imported. You now have ${count} snippet${count === 1 ? '' : 's'}.`;
    },
    onImported: () => {
      workbench = loadWorkbench();
      snippets = loadSnippets();
      input.value = workbench.input;
      renderControls();
      renderSnippets();
      run();
    },
    onClearAll: () => { clearAll(); workbench = loadWorkbench(); snippets = []; },
    clearWarning: 'This clears every saved snippet and resets the workbench. Export first if you want a copy. Continue?',
  });

  input.value = workbench.input;
  renderControls();
  renderSnippets();
  run();
}
