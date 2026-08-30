import { formatBytes } from '../../lib/bytes';
import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob, downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import {
  canRun, Engine, engine, EngineError, engineStarted, ENGINE_BYTES, SAMPLE_CSV,
  type QueryResult, type TableInfo,
} from './engine';
import { registerTools } from '../../lib/webmcp';
import { quarryTools } from './mcp';
import {
  APP_ID, displayValue, formatCount, formatDuration, isNumericType, SAMPLE_QUERIES, tableNameFrom,
  toCsv, toJson, toMarkdown, uniqueTableName,
} from './sql';
import {
  applyImport, buildExport, clearAll, createQuery, deleteQuery, loadDraft, loadLimit, loadQueries,
  saveDraft, saveLimit, saveQuery, type SavedQuery,
} from './store';

type Loaded = { table: string; file: string | null; bytes: number };

export async function mountQuarry(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const editor = $<HTMLTextAreaElement>('qy-sql');
  const runButton = $<HTMLButtonElement>('qy-run');
  const statusEl = $<HTMLParagraphElement>('qy-status');
  const tableEl = $<HTMLDivElement>('qy-table');
  const schemaEl = $<HTMLDivElement>('qy-schema');
  const queriesEl = $<HTMLDivElement>('qy-queries');
  const bootEl = $<HTMLDivElement>('qy-boot');
  const workspaceEl = $<HTMLDivElement>('qy-workspace');
  const limitEl = $<HTMLSelectElement>('qy-limit');

  let database: Engine | null = null;
  let loaded: Loaded[] = [];
  let queries: SavedQuery[] = [];
  let current: QueryResult | null = null;
  let limit = loadLimit();
  let draftTimer = 0;

  const setStatus = (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => {
    statusEl.textContent = message;
    statusEl.dataset.state = state;
  };

  // ------------------------------------------------------------------ starting

  async function ready(): Promise<Engine> {
    if (database) return database;
    setStatus('Starting the database.', 'busy');
    bootEl.dataset.state = 'loading';
    try {
      database = await engine((stage) => { $<HTMLSpanElement>('qy-boot-stage').textContent = stage; });
      bootEl.hidden = true;
      workspaceEl.hidden = false;
      setStatus('Ready.', 'idle');
      await refreshSchema();
      return database;
    } catch (error) {
      bootEl.dataset.state = 'failed';
      const message = error instanceof EngineError ? error.message : 'The database would not start.';
      $<HTMLParagraphElement>('qy-boot-error').textContent = message;
      $<HTMLParagraphElement>('qy-boot-error').hidden = false;
      setStatus(message, 'bad');
      throw error;
    }
  }

  $<HTMLButtonElement>('qy-start').addEventListener('click', async () => {
    try {
      const db = await ready();
      // Give a first-time visitor something to run straight away.
      if (loaded.length === 0) {
        await load('trips.csv', new TextEncoder().encode(SAMPLE_CSV));
        if (!editor.value.trim()) {
          editor.value = 'SELECT city, count(*) AS trips, round(avg(fare), 2) AS average_fare\nFROM trips\nGROUP BY city\nORDER BY trips DESC;';
          persistDraft();
        }
      }
      void db;
    } catch {
      // The failure is already on screen.
    }
  });

  // ------------------------------------------------------------------ loading files

  async function load(name: string, bytes: Uint8Array): Promise<void> {
    const db = await ready();
    const table = uniqueTableName(tableNameFrom(name), loaded.map((entry) => entry.table));
    setStatus(`Reading ${name}.`, 'busy');
    try {
      const info = await db.addFile(name, bytes, table);
      loaded.push({ table, file: name, bytes: info.bytes ?? 0 });
      await refreshSchema();
      setStatus(`Loaded ${name} as ${table}.`, 'good');
    } catch (error) {
      setStatus(error instanceof EngineError ? error.message : `${name} could not be read.`, 'bad');
    }
  }

  const fileInput = $<HTMLInputElement>('qy-file');
  $<HTMLButtonElement>('qy-add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const file of Array.from(fileInput.files ?? [])) {
      await load(file.name, new Uint8Array(await file.arrayBuffer()));
    }
    fileInput.value = '';
  });

  const dropZone = $<HTMLDivElement>('qy-drop');
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('is-over'); });
  }
  dropZone.addEventListener('drop', async (event) => {
    for (const file of Array.from((event as DragEvent).dataTransfer?.files ?? [])) {
      await load(file.name, new Uint8Array(await file.arrayBuffer()));
    }
  });

  $<HTMLButtonElement>('qy-sample').addEventListener('click', async () => {
    await load('trips.csv', new TextEncoder().encode(SAMPLE_CSV));
  });

  // ------------------------------------------------------------------ schema

  async function refreshSchema(): Promise<void> {
    if (!database) return;
    let tables: TableInfo[] = [];
    try {
      tables = await database.tables();
    } catch {
      tables = [];
    }

    schemaEl.innerHTML = '';
    if (tables.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qy-note';
      empty.textContent = 'No tables yet. Drop a file in, or load the sample.';
      schemaEl.append(empty);
      return;
    }

    for (const table of tables) {
      const source = loaded.find((entry) => entry.table === table.name);
      const block = document.createElement('details');
      block.className = 'qy-table-info';
      block.open = tables.length <= 3;

      const summary = document.createElement('summary');
      summary.innerHTML = `<strong>${escapeHtml(table.name)}</strong><span>${
        table.rows === null ? '' : formatCount(table.rows)
      }${source ? ` · ${formatBytes(source.bytes)}` : ''}</span>`;
      block.append(summary);

      const list = document.createElement('ul');
      list.className = 'qy-columns';
      for (const column of table.columns) {
        const item = document.createElement('li');
        item.innerHTML = `<code>${escapeHtml(column.name)}</code><span>${escapeHtml(column.type)}</span>`;
        item.title = 'Click to put this column in the editor';
        item.addEventListener('click', () => insertAtCursor(column.name));
        list.append(item);
      }
      block.append(list);

      const actions = document.createElement('div');
      actions.className = 'qy-table-actions';

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'btn btn--sm';
      preview.textContent = 'First rows';
      preview.addEventListener('click', () => {
        editor.value = `SELECT * FROM ${quoteIfNeeded(table.name)} LIMIT 50;`;
        persistDraft();
        void run();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--sm btn--danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        if (!database) return;
        await database.dropTable(table.name, source?.file ?? null);
        loaded = loaded.filter((entry) => entry.table !== table.name);
        await refreshSchema();
        setStatus(`Removed ${table.name}.`, 'idle');
      });

      actions.append(preview, remove);
      block.append(actions);
      schemaEl.append(block);
    }
  }

  function quoteIfNeeded(name: string): string {
    return /^[a-z_][a-z0-9_]*$/i.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
  }

  function insertAtCursor(text: string): void {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
    editor.selectionStart = start + text.length;
    editor.selectionEnd = editor.selectionStart;
    editor.focus();
    persistDraft();
  }

  // ------------------------------------------------------------------ running

  async function run(): Promise<void> {
    const script = editor.value.trim();
    if (!script) { setStatus('There is nothing to run.', 'bad'); return; }

    let db: Engine;
    try {
      db = await ready();
    } catch {
      return;
    }

    runButton.disabled = true;
    setStatus('Running.', 'busy');
    try {
      const { results, commands } = await db.runScript(script, limit);
      current = results.at(-1) ?? null;

      if (current) {
        renderTable(current);
        const parts = [
          formatCount(current.total),
          `in ${formatDuration(current.elapsed)}`,
        ];
        if (current.truncated) parts.push(`showing the first ${current.rows.length.toLocaleString('en-US')}`);
        if (commands > 0) parts.push(`${commands} statement${commands === 1 ? '' : 's'} also ran`);
        setStatus(parts.join(', '), 'good');
      } else {
        tableEl.innerHTML = '';
        setStatus(`${commands} statement${commands === 1 ? '' : 's'} ran. Nothing to show.`, 'good');
      }
      await refreshSchema();
    } catch (error) {
      tableEl.innerHTML = '';
      current = null;
      setStatus(error instanceof EngineError ? error.message : 'The query failed.', 'bad');
    } finally {
      runButton.disabled = false;
      updateExportButtons();
    }
  }

  runButton.addEventListener('click', () => void run());

  editor.addEventListener('keydown', (event) => {
    // Control or Command with Enter runs, which is what every SQL tool does.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void run();
      return;
    }
    // Tab indents rather than leaving the editor.
    if (event.key === 'Tab') {
      event.preventDefault();
      insertAtCursor('  ');
    }
  });

  editor.addEventListener('input', persistDraft);

  function persistDraft(): void {
    window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => saveDraft(editor.value), 400);
  }

  // ------------------------------------------------------------------ results

  function renderTable(result: QueryResult): void {
    tableEl.innerHTML = '';
    if (result.columns.length === 0) return;

    const table = document.createElement('table');
    table.className = 'qy-grid';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'qy-rownum';
    headRow.append(corner);
    for (const column of result.columns) {
      const cell = document.createElement('th');
      cell.innerHTML = `${escapeHtml(column.name)}<span>${escapeHtml(column.type)}</span>`;
      if (isNumericType(column.type)) cell.classList.add('is-number');
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement('tbody');
    result.rows.forEach((row, index) => {
      const line = document.createElement('tr');
      const number = document.createElement('td');
      number.className = 'qy-rownum';
      number.textContent = String(index + 1);
      line.append(number);

      row.forEach((value, column) => {
        const cell = document.createElement('td');
        const text = displayValue(value);
        cell.textContent = text;
        if (value === null || value === undefined) {
          cell.classList.add('is-null');
          cell.textContent = 'null';
        }
        if (isNumericType(result.columns[column].type)) cell.classList.add('is-number');
        // A long value would otherwise stretch the column past the window.
        if (text.length > 120) cell.title = text;
        line.append(cell);
      });
      body.append(line);
    });
    table.append(body);
    tableEl.append(table);
  }

  function updateExportButtons(): void {
    const disabled = current === null || current.rows.length === 0;
    for (const id of ['qy-csv', 'qy-json', 'qy-markdown', 'qy-parquet', 'qy-copy']) {
      $<HTMLButtonElement>(id).disabled = disabled;
    }
  }

  const exports: [string, () => void][] = [
    ['qy-csv', () => {
      if (!current) return;
      downloadFile('result.csv', toCsv(current.columns.map((column) => column.name), current.rows), 'text/csv');
      toast('CSV saved.', { kind: 'good' });
    }],
    ['qy-json', () => {
      if (!current) return;
      downloadFile('result.json', toJson(current.columns.map((column) => column.name), current.rows), 'application/json');
      toast('JSON saved.', { kind: 'good' });
    }],
    ['qy-markdown', () => {
      if (!current) return;
      downloadFile('result.md', toMarkdown(current.columns.map((column) => column.name), current.rows), 'text/markdown');
      toast('Markdown saved.', { kind: 'good' });
    }],
  ];
  for (const [id, handler] of exports) $<HTMLButtonElement>(id).addEventListener('click', handler);

  $<HTMLButtonElement>('qy-parquet').addEventListener('click', async () => {
    if (!current || !database) return;
    try {
      setStatus('Writing Parquet.', 'busy');
      // The rows go from the engine straight to a file, so the full result is
      // exported rather than only the rows the table is showing.
      const bytes = await database.toParquet(current.statement);
      downloadBlob('result.parquet', new Blob([bytes as unknown as BlobPart], { type: 'application/vnd.apache.parquet' }));
      setStatus(`Parquet saved, ${formatBytes(bytes.length)}.`, 'good');
    } catch (error) {
      setStatus(error instanceof EngineError ? error.message : 'The export failed.', 'bad');
    }
  });

  $<HTMLButtonElement>('qy-copy').addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(toMarkdown(current.columns.map((column) => column.name), current.rows));
      toast('Copied as a Markdown table.', { kind: 'good' });
    } catch {
      toast('The browser would not let this page use the clipboard.', { kind: 'error' });
    }
  });

  limitEl.addEventListener('change', () => {
    limit = Number(limitEl.value) || 5000;
    saveLimit(limit);
  });

  // ------------------------------------------------------------------ saved queries

  function renderQueries(): void {
    queriesEl.innerHTML = '';
    for (const query of queries) {
      const row = document.createElement('div');
      row.className = 'qy-query';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'qy-query__open';
      open.innerHTML = `<strong>${escapeHtml(query.name)}</strong><span>${escapeHtml(query.sql.replace(/\s+/g, ' ').slice(0, 60))}</span>`;
      open.addEventListener('click', () => {
        editor.value = query.sql;
        persistDraft();
        editor.focus();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'qy-query__remove';
      remove.innerHTML = '&times;';
      remove.title = `Delete ${query.name}`;
      remove.setAttribute('aria-label', `Delete ${query.name}`);
      remove.addEventListener('click', async () => {
        await deleteQuery(query.id);
        queries = queries.filter((entry) => entry.id !== query.id);
        renderQueries();
      });

      row.append(open, remove);
      queriesEl.append(row);
    }
    $<HTMLDivElement>('qy-queries-empty').hidden = queries.length > 0;
  }

  $<HTMLButtonElement>('qy-save-query').addEventListener('click', async () => {
    const sql = editor.value.trim();
    if (!sql) { toast('There is nothing to save.', { kind: 'error' }); return; }
    const name = prompt('Name this query', suggestName(sql));
    if (name === null) return;
    const query = createQuery(name.trim() || 'Untitled query', sql);
    await saveQuery(query);
    queries = [query, ...queries];
    renderQueries();
    toast('Saved.', { kind: 'good' });
  });

  const examplesEl = $<HTMLDivElement>('qy-examples');
  for (const example of SAMPLE_QUERIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'qy-example';
    button.textContent = example.label;
    button.title = example.sql;
    button.addEventListener('click', () => {
      editor.value = example.sql;
      persistDraft();
      editor.focus();
    });
    examplesEl.append(button);
  }

  // ------------------------------------------------------------------ start

  /**
   * Reloads everything from storage and redraws. Shared by the import
   * flow and by the agent tools, so a change an agent makes shows up on
   * the page rather than sitting invisibly in the database.
   */
  async function refreshFromStore(): Promise<void> {
    queries = await loadQueries();
    renderQueries();
    // An agent tool can start the engine and load data without the page's own
    // controls being touched, so the workspace has to be revealed here too.
    if (!database && engineStarted()) database = await engine();
    if (database) {
      bootEl.hidden = true;
      workspaceEl.hidden = false;
      await refreshSchema();
    }
  }

  wireDataMenu(root, {
    app: APP_ID,
    buildExport,
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `${count} quer${count === 1 ? 'y' : 'ies'} in place.`;
    },
    onImported: refreshFromStore,
    onClearAll: async () => {
      await clearAll();
      queries = [];
      renderQueries();
    },
    clearWarning: 'Every saved query in this browser will be deleted. Loaded files are already gone when the tab closes.',
  });

  $<HTMLSpanElement>('qy-boot-size').textContent = formatBytes(ENGINE_BYTES);
  if (!canRun()) {
    bootEl.dataset.state = 'failed';
    $<HTMLParagraphElement>('qy-boot-error').textContent =
      'This browser cannot run the WebAssembly build this needs. Chrome, Edge, Firefox, and Safari have all supported it since 2021.';
    $<HTMLParagraphElement>('qy-boot-error').hidden = false;
    $<HTMLButtonElement>('qy-start').disabled = true;
  }

  editor.value = loadDraft();
  limitEl.value = String(limit);
  queries = await loadQueries();
  renderQueries();
  updateExportButtons();

  // Everything this app can do, offered to an agent on this page.
  registerTools(quarryTools(() => loaded.map((entry) => entry.table), refreshFromStore));
}

function suggestName(sql: string): string {
  const first = sql.replace(/\s+/g, ' ').trim().slice(0, 40);
  return first || 'Untitled query';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
