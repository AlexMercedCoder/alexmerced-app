import { wireDataMenu } from '../../lib/dataMenu';
import { downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { zipBlob } from '../../lib/zip';
import { downloadBlob } from '../../lib/portable';
import { createId } from '../../lib/id';
import { FIELD_KINDS, type FieldKind } from './generators';
import {
  APP_ID, MAX_ROWS, createField, createTable, extensionFor, generate, render, toCsv, toDdl,
  toNdjson, toSqlInserts, type Dataset, type Field, type OutputFormat, type Table,
} from './model';
import { applyImport, buildExport, clearAll, loadDataset, loadView, saveDataset, saveView, type ViewPrefs } from './store';
import { registerTools } from '../../lib/webmcp';
import { fablerTools } from './mcp';

export async function mountFabler(root: HTMLElement): Promise<void> {
  let dataset: Dataset = loadDataset();
  let view: ViewPrefs = loadView();

  const seedInput = root.querySelector<HTMLInputElement>('#fb-seed')!;
  const tableList = root.querySelector<HTMLElement>('#fb-tables')!;
  const preview = root.querySelector<HTMLElement>('#fb-preview')!;
  const output = root.querySelector<HTMLElement>('#fb-output')!;
  const formatSelect = root.querySelector<HTMLSelectElement>('#fb-format')!;
  const rowsPreview = root.querySelector<HTMLInputElement>('#fb-preview-rows')!;
  const stats = root.querySelector<HTMLElement>('#fb-stats')!;

  const grouped = FIELD_KINDS.reduce<Record<string, typeof FIELD_KINDS>>((groups, kind) => {
    (groups[kind.group] ??= []).push(kind);
    return groups;
  }, {});

  function kindSelect(field: Field): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'fb-kind';
    select.dataset.editKind = field.id;
    for (const [group, kinds] of Object.entries(grouped)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group;
      for (const kind of kinds) {
        const option = document.createElement('option');
        option.value = kind.id;
        option.textContent = kind.label;
        option.selected = kind.id === field.kind;
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
    return select;
  }

  function renderTables(): void {
    tableList.innerHTML = '';

    for (const table of dataset.tables) {
      const card = document.createElement('section');
      card.className = 'fb-table';

      const head = document.createElement('header');
      head.className = 'fb-table__head';

      const name = document.createElement('input');
      name.className = 'fb-table__name';
      name.value = table.name;
      name.dataset.editTableName = table.id;

      const rows = document.createElement('input');
      rows.className = 'fb-table__rows';
      rows.type = 'number';
      rows.min = '0';
      rows.max = String(MAX_ROWS);
      rows.value = String(table.rows);
      rows.dataset.editTableRows = table.id;
      rows.title = 'How many rows to generate';

      const rowsLabel = document.createElement('span');
      rowsLabel.className = 'fb-table__rowslabel';
      rowsLabel.textContent = 'rows';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'fb-icon';
      remove.dataset.deleteTable = table.id;
      remove.textContent = '×';
      remove.title = 'Delete this table';

      head.append(name, rows, rowsLabel, remove);
      card.appendChild(head);

      const fields = document.createElement('div');
      fields.className = 'fb-fields';

      for (const field of table.fields) {
        const row = document.createElement('div');
        row.className = 'fb-field';

        const fieldName = document.createElement('input');
        fieldName.className = 'fb-field__name';
        fieldName.value = field.name;
        fieldName.dataset.editFieldName = field.id;

        row.append(fieldName, kindSelect(field));

        // Only show the settings the chosen kind actually uses.
        if (['integer', 'decimal', 'money', 'percent'].includes(field.kind)) {
          const min = document.createElement('input');
          min.className = 'fb-field__num';
          min.type = 'number';
          min.placeholder = 'min';
          min.value = field.min === undefined ? '' : String(field.min);
          min.dataset.editFieldMin = field.id;
          const max = document.createElement('input');
          max.className = 'fb-field__num';
          max.type = 'number';
          max.placeholder = 'max';
          max.value = field.max === undefined ? '' : String(field.max);
          max.dataset.editFieldMax = field.id;
          row.append(min, max);
        } else if (field.kind === 'enum' || field.kind === 'constant') {
          const options = document.createElement('input');
          options.className = 'fb-field__options';
          options.placeholder = field.kind === 'enum' ? 'red, green, blue' : 'the value';
          options.value = field.options ?? '';
          options.dataset.editFieldOptions = field.id;
          row.append(options);
        } else if (field.kind === 'foreignKey') {
          const references = document.createElement('select');
          references.className = 'fb-field__ref';
          references.dataset.editFieldRef = field.id;
          references.innerHTML = '<option value="">choose a table</option>';
          for (const other of dataset.tables) {
            if (other.id === table.id) continue;
            const option = document.createElement('option');
            option.value = other.name;
            option.textContent = other.name;
            option.selected = other.name === field.references;
            references.appendChild(option);
          }
          row.append(references);
        } else {
          row.append(document.createElement('span'));
        }

        const nullRate = document.createElement('input');
        nullRate.className = 'fb-field__null';
        nullRate.type = 'number';
        nullRate.min = '0';
        nullRate.max = '100';
        nullRate.step = '5';
        nullRate.value = String(Math.round(field.nullRate * 100));
        nullRate.dataset.editFieldNull = field.id;
        nullRate.title = 'Percentage of rows where this is null';

        const removeField = document.createElement('button');
        removeField.type = 'button';
        removeField.className = 'fb-icon';
        removeField.dataset.deleteField = field.id;
        removeField.textContent = '×';

        row.append(nullRate, removeField);
        fields.appendChild(row);
      }

      const addField = document.createElement('button');
      addField.type = 'button';
      addField.className = 'fb-addfield';
      addField.dataset.addField = table.id;
      addField.textContent = '+ add a column';
      fields.appendChild(addField);

      card.appendChild(fields);
      tableList.appendChild(card);
    }
  }

  function renderOutput(): void {
    const generated = generate(dataset);
    const totalRows = generated.reduce((sum, entry) => sum + entry.rows.length, 0);
    stats.textContent = `${dataset.tables.length} table${dataset.tables.length === 1 ? '' : 's'} · ${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'}`;

    // The preview is capped, since a hundred thousand rows in the DOM helps nobody.
    const limited = generated.map((entry) => ({ ...entry, rows: entry.rows.slice(0, view.previewRows) }));

    preview.innerHTML = '';
    for (const { table, rows } of limited) {
      if (!table.fields.length) continue;
      const wrap = document.createElement('div');
      wrap.className = 'fb-preview-table';

      const caption = document.createElement('h3');
      caption.className = 'fb-preview-caption';
      caption.textContent = `${table.name} (showing ${rows.length} of ${table.rows})`;
      wrap.appendChild(caption);

      const scroller = document.createElement('div');
      scroller.className = 'fb-scroll';
      const element = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const field of table.fields) {
        const th = document.createElement('th');
        th.textContent = field.name;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      element.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        for (const field of table.fields) {
          const td = document.createElement('td');
          const value = row[field.name];
          if (value === null) { td.textContent = 'null'; td.dataset.null = 'true'; }
          else td.textContent = String(value);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      element.appendChild(tbody);
      scroller.appendChild(element);
      wrap.appendChild(scroller);
      preview.appendChild(wrap);
    }

    output.textContent = render(limited, view.format);
  }

  function update(): void {
    saveDataset(dataset);
    renderTables();
    renderOutput();
  }

  function findField(id: string): { table: Table; field: Field } | null {
    for (const table of dataset.tables) {
      const field = table.fields.find((item) => item.id === id);
      if (field) return { table, field };
    }
    return null;
  }

  function patchField(id: string, changes: Partial<Field>): void {
    dataset = {
      ...dataset,
      tables: dataset.tables.map((table) => ({
        ...table,
        fields: table.fields.map((field) => (field.id === id ? { ...field, ...changes } : field)),
      })),
    };
  }

  // ------------------------------------------------------------------ events
  seedInput.addEventListener('input', () => { dataset = { ...dataset, seed: seedInput.value || 'alexmerced' }; update(); });

  root.querySelector('#fb-reseed')?.addEventListener('click', () => {
    const seed = Math.random().toString(36).slice(2, 10);
    dataset = { ...dataset, seed };
    seedInput.value = seed;
    update();
  });

  formatSelect.addEventListener('change', () => {
    view = { ...view, format: formatSelect.value as OutputFormat };
    saveView(view);
    renderOutput();
  });

  rowsPreview.addEventListener('change', () => {
    view = { ...view, previewRows: Math.max(1, Math.min(200, Number(rowsPreview.value) || 10)) };
    saveView(view);
    rowsPreview.value = String(view.previewRows);
    renderOutput();
  });

  tableList.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;

    if (target.dataset.editTableName) {
      const oldName = dataset.tables.find((t) => t.id === target.dataset.editTableName)?.name;
      const newName = target.value;
      dataset = {
        ...dataset,
        tables: dataset.tables.map((table) => {
          const renamed = table.id === target.dataset.editTableName ? { ...table, name: newName } : table;
          // Keep foreign keys pointing at the table after a rename.
          return {
            ...renamed,
            fields: renamed.fields.map((field) =>
              field.kind === 'foreignKey' && field.references === oldName ? { ...field, references: newName } : field,
            ),
          };
        }),
      };
      saveDataset(dataset);
      renderOutput();
      return;
    }

    if (target.dataset.editTableRows) {
      const rows = Math.max(0, Math.min(MAX_ROWS, Number(target.value) || 0));
      dataset = { ...dataset, tables: dataset.tables.map((table) => (table.id === target.dataset.editTableRows ? { ...table, rows } : table)) };
      saveDataset(dataset);
      renderOutput();
      return;
    }

    if (target.dataset.editFieldName) { patchField(target.dataset.editFieldName, { name: target.value }); saveDataset(dataset); renderOutput(); return; }
    if (target.dataset.editFieldMin) { patchField(target.dataset.editFieldMin, { min: target.value === '' ? undefined : Number(target.value) }); saveDataset(dataset); renderOutput(); return; }
    if (target.dataset.editFieldMax) { patchField(target.dataset.editFieldMax, { max: target.value === '' ? undefined : Number(target.value) }); saveDataset(dataset); renderOutput(); return; }
    if (target.dataset.editFieldOptions) { patchField(target.dataset.editFieldOptions, { options: target.value }); saveDataset(dataset); renderOutput(); return; }
    if (target.dataset.editFieldNull) {
      patchField(target.dataset.editFieldNull, { nullRate: Math.max(0, Math.min(100, Number(target.value) || 0)) / 100 });
      saveDataset(dataset);
      renderOutput();
    }
  });

  tableList.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.editKind) {
      const found = findField(target.dataset.editKind);
      patchField(target.dataset.editKind, { kind: target.value as FieldKind, references: undefined });
      void found;
      update();
      return;
    }
    if (target.dataset.editFieldRef) {
      patchField(target.dataset.editFieldRef, { references: target.value || undefined });
      update();
    }
  });

  tableList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-add-field], [data-delete-field], [data-delete-table]');
    if (!target) return;

    if (target.dataset.addField) {
      dataset = {
        ...dataset,
        tables: dataset.tables.map((table) =>
          table.id === target.dataset.addField ? { ...table, fields: [...table.fields, createField(`column_${table.fields.length + 1}`, 'word')] } : table,
        ),
      };
      update();
      return;
    }

    if (target.dataset.deleteField) {
      dataset = {
        ...dataset,
        tables: dataset.tables.map((table) => ({ ...table, fields: table.fields.filter((field) => field.id !== target.dataset.deleteField) })),
      };
      update();
      return;
    }

    if (target.dataset.deleteTable) {
      if (dataset.tables.length === 1) { toast('There has to be at least one table.', { kind: 'error' }); return; }
      const table = dataset.tables.find((item) => item.id === target.dataset.deleteTable);
      if (!table) return;
      dataset = { ...dataset, tables: dataset.tables.filter((item) => item.id !== table.id) };
      update();
      toast(`Deleted "${table.name}".`, {
        actionLabel: 'Undo',
        onAction: () => { dataset = { ...dataset, tables: [...dataset.tables, table] }; update(); },
      });
    }
  });

  root.querySelector('#fb-add-table')?.addEventListener('click', () => {
    const table = createTable(`table_${dataset.tables.length + 1}`);
    table.id = createId('tbl');
    dataset = { ...dataset, tables: [...dataset.tables, table] };
    update();
  });

  root.querySelector('#fb-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.textContent ?? '');
      toast('Preview copied. Use Download for the full set.', { kind: 'good' });
    } catch { toast('The browser would not let us reach the clipboard.', { kind: 'error' }); }
  });

  root.querySelector('#fb-download')?.addEventListener('click', () => {
    const generated = generate(dataset);
    const extension = extensionFor(view.format);

    if (dataset.tables.length === 1 || view.format === 'sql' || view.format === 'ddl') {
      downloadFile(`fabler.${extension}`, render(generated, view.format), 'text/plain');
      toast('Saved.', { kind: 'good' });
      return;
    }

    // Several tables in a row-oriented format go out as separate files.
    const entries = generated.map(({ table, rows }) => ({
      name: `${table.name}.${extension}`,
      bytes: new TextEncoder().encode(
        view.format === 'csv' ? toCsv(rows, table.fields) : view.format === 'ndjson' ? toNdjson(rows) : JSON.stringify(rows, null, 2),
      ),
    }));
    downloadBlob('fabler-tables.zip', zipBlob(entries));
    toast(`${entries.length} files saved as a ZIP.`, { kind: 'good' });
  });

  root.querySelector('#fb-download-all')?.addEventListener('click', () => {
    const generated = generate(dataset);
    const entries = [
      { name: 'schema.sql', bytes: new TextEncoder().encode(generated.map(({ table }) => toDdl(table)).join('\n\n')) },
      { name: 'inserts.sql', bytes: new TextEncoder().encode(generated.map(({ table, rows }) => toSqlInserts(rows, table)).join('\n\n')) },
      ...generated.map(({ table, rows }) => ({ name: `${table.name}.csv`, bytes: new TextEncoder().encode(toCsv(rows, table.fields)) })),
      ...generated.map(({ table, rows }) => ({ name: `${table.name}.json`, bytes: new TextEncoder().encode(JSON.stringify(rows, null, 2)) })),
    ];
    downloadBlob('fabler-everything.zip', zipBlob(entries));
    toast('DDL, inserts, CSV and JSON saved as a ZIP.', { kind: 'good' });
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: (text, mode) => {
      const count = applyImport(text, mode);
      return `Imported. You now have ${count} table${count === 1 ? '' : 's'}.`;
    },
    onImported: () => { dataset = loadDataset(); seedInput.value = dataset.seed; update(); },
    onClearAll: () => { clearAll(); dataset = loadDataset(); },
    clearWarning: 'This resets Fabler back to its starter schema. Export first if you want a copy. Continue?',
  });

  seedInput.value = dataset.seed;
  formatSelect.value = view.format;
  rowsPreview.value = String(view.previewRows);
  update();

  // Everything this app can do, offered to an agent on this page.
  registerTools(fablerTools());
}
