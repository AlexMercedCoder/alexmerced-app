import { createId } from '../../lib/id';
import { Rng } from '../../lib/random';
import { generateValue, isKeyKind, type Field, type FieldKind, type Table, type Value } from './generators';

export const APP_ID = 'fabler';
export const APP_VERSION = 1;

export type { Field, FieldKind, Table, Value };

export type Dataset = {
  seed: string;
  tables: Table[];
};

export type Row = Record<string, Value>;
export type Generated = { table: Table; rows: Row[] }[];

export const OUTPUT_FORMATS = ['json', 'ndjson', 'csv', 'sql', 'ddl'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const MAX_ROWS = 100000;

export function createField(name: string, kind: FieldKind): Field {
  return { id: createId('fld'), name, kind, nullRate: 0 };
}

export function createTable(name: string): Table {
  return {
    id: createId('tbl'),
    name,
    rows: 25,
    fields: [createField('id', 'id'), createField('name', 'fullName'), createField('email', 'email')],
  };
}

/**
 * Orders tables so a table is generated after anything it references, which is
 * what lets foreign keys point at rows that actually exist.
 */
export function orderTables(tables: Table[]): Table[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const ordered: Table[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (table: Table) => {
    const status = state.get(table.name);
    if (status === 'done') return;
    // A cycle cannot be ordered, so the table is emitted where it stands and
    // its foreign keys fall back to null.
    if (status === 'visiting') return;

    state.set(table.name, 'visiting');
    for (const field of table.fields) {
      if (field.kind === 'foreignKey' && field.references) {
        const target = byName.get(field.references);
        if (target && target !== table) visit(target);
      }
    }
    state.set(table.name, 'done');
    ordered.push(table);
  };

  for (const table of tables) visit(table);
  return ordered;
}

export function generate(dataset: Dataset): Generated {
  const keys = new Map<string, Value[]>();
  const results = new Map<string, Row[]>();

  for (const table of orderTables(dataset.tables)) {
    // Each table gets its own generator stream, so adding a table does not
    // change the rows of the ones before it.
    const rng = new Rng(`${dataset.seed}::${table.name}`);
    const rows: Row[] = [];
    const count = Math.max(0, Math.min(MAX_ROWS, Math.floor(table.rows)));

    for (let index = 0; index < count; index += 1) {
      const row: Row = {};
      for (const field of table.fields) {
        row[field.name] = generateValue(field, { rng, rowIndex: index, keys });
      }
      rows.push(row);
    }

    const keyField = table.fields.find((field) => isKeyKind(field.kind));
    if (keyField) keys.set(table.name, rows.map((row) => row[keyField.name]).filter((value) => value !== null));

    results.set(table.name, rows);
  }

  // Return in the order the user arranged them, not the dependency order.
  return dataset.tables.map((table) => ({ table, rows: results.get(table.name) ?? [] }));
}

// --------------------------------------------------------------------- output

function csvField(value: Value): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Row[], fields: Field[]): string {
  const lines = [fields.map((field) => csvField(field.name)).join(',')];
  for (const row of rows) lines.push(fields.map((field) => csvField(row[field.name])).join(','));
  return lines.join('\n');
}

export function toJson(rows: Row[]): string {
  return JSON.stringify(rows, null, 2);
}

export function toNdjson(rows: Row[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

function sqlLiteral(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlName(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function toSqlInserts(rows: Row[], table: Table, batchSize = 100): string {
  if (!rows.length) return `-- ${table.name} has no rows.`;
  const columns = table.fields.map((field) => sqlName(field.name)).join(', ');
  const statements: string[] = [];

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values = batch
      .map((row) => `  (${table.fields.map((field) => sqlLiteral(row[field.name])).join(', ')})`)
      .join(',\n');
    statements.push(`INSERT INTO ${sqlName(table.name)} (${columns}) VALUES\n${values};`);
  }

  return statements.join('\n\n');
}

const SQL_TYPES: Partial<Record<FieldKind, string>> = {
  id: 'BIGINT', sequence: 'BIGINT', foreignKey: 'BIGINT', uuid: 'VARCHAR(36)',
  integer: 'BIGINT', decimal: 'DOUBLE', money: 'DECIMAL(12,2)', percent: 'DOUBLE',
  boolean: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMP', time: 'TIME',
  latitude: 'DOUBLE', longitude: 'DOUBLE', paragraph: 'TEXT', sentence: 'VARCHAR(500)',
};

export function toDdl(table: Table): string {
  const columns = table.fields.map((field) => {
    const type = SQL_TYPES[field.kind] ?? 'VARCHAR(255)';
    const constraints: string[] = [];
    if (field.kind === 'id' || field.kind === 'sequence') constraints.push('PRIMARY KEY');
    else if (field.nullRate === 0) constraints.push('NOT NULL');
    return `  ${sqlName(field.name)} ${type}${constraints.length ? ` ${constraints.join(' ')}` : ''}`;
  });

  const references = table.fields
    .filter((field) => field.kind === 'foreignKey' && field.references)
    .map((field) => `  FOREIGN KEY (${sqlName(field.name)}) REFERENCES ${sqlName(field.references!)} (id)`);

  return `CREATE TABLE ${sqlName(table.name)} (\n${[...columns, ...references].join(',\n')}\n);`;
}

export function render(generated: Generated, format: OutputFormat): string {
  if (format === 'ddl') return generated.map(({ table }) => toDdl(table)).join('\n\n');
  if (format === 'sql') return generated.map(({ table, rows }) => toSqlInserts(rows, table)).join('\n\n');

  if (generated.length === 1) {
    const { table, rows } = generated[0];
    if (format === 'csv') return toCsv(rows, table.fields);
    if (format === 'ndjson') return toNdjson(rows);
    return toJson(rows);
  }

  // Several tables need a container, except CSV which has no way to hold them.
  if (format === 'csv') {
    return generated.map(({ table, rows }) => `# ${table.name}\n${toCsv(rows, table.fields)}`).join('\n\n');
  }
  if (format === 'ndjson') {
    return generated.map(({ table, rows }) => rows.map((row) => JSON.stringify({ _table: table.name, ...row })).join('\n')).join('\n');
  }

  const bundle: Record<string, Row[]> = {};
  for (const { table, rows } of generated) bundle[table.name] = rows;
  return JSON.stringify(bundle, null, 2);
}

export function extensionFor(format: OutputFormat): string {
  return format === 'ddl' || format === 'sql' ? 'sql' : format === 'ndjson' ? 'ndjson' : format;
}

// --------------------------------------------------------------------- reviving

const KNOWN_KINDS = new Set<string>([
  'id', 'uuid', 'sequence', 'firstName', 'lastName', 'fullName', 'email', 'username', 'phone',
  'company', 'jobTitle', 'street', 'city', 'country', 'postcode', 'latitude', 'longitude',
  'integer', 'decimal', 'money', 'boolean', 'percent', 'date', 'datetime', 'time',
  'sentence', 'paragraph', 'word', 'slug', 'url', 'ipv4', 'macAddress', 'hexColor',
  'currency', 'status', 'product', 'enum', 'foreignKey', 'constant',
]);

export function reviveField(value: unknown): Field | null {
  if (typeof value !== 'object' || value === null) return null;
  const field = value as Partial<Field>;
  if (typeof field.name !== 'string' || !field.name.trim()) return null;

  return {
    id: typeof field.id === 'string' ? field.id : createId('fld'),
    name: field.name,
    kind: KNOWN_KINDS.has(field.kind as string) ? (field.kind as FieldKind) : 'word',
    nullRate: typeof field.nullRate === 'number' && field.nullRate >= 0 && field.nullRate <= 1 ? field.nullRate : 0,
    min: typeof field.min === 'number' ? field.min : undefined,
    max: typeof field.max === 'number' ? field.max : undefined,
    decimals: typeof field.decimals === 'number' ? Math.max(0, Math.min(10, Math.floor(field.decimals))) : undefined,
    options: typeof field.options === 'string' ? field.options : undefined,
    references: typeof field.references === 'string' ? field.references : undefined,
    unique: field.unique === true,
  };
}

export function reviveTable(value: unknown): Table | null {
  if (typeof value !== 'object' || value === null) return null;
  const table = value as Partial<Table>;
  if (typeof table.name !== 'string' || !table.name.trim()) return null;

  const fields = Array.isArray(table.fields)
    ? table.fields.map(reviveField).filter((field): field is Field => field !== null)
    : [];

  return {
    id: typeof table.id === 'string' ? table.id : createId('tbl'),
    name: table.name,
    rows: typeof table.rows === 'number' && table.rows >= 0 ? Math.min(MAX_ROWS, Math.floor(table.rows)) : 25,
    fields: fields.length ? fields : [createField('id', 'id')],
  };
}

/** A foreign key pointing at a table that is gone would generate nothing useful. */
export function reconcile(tables: Table[]): Table[] {
  const names = new Set(tables.map((table) => table.name));
  return tables.map((table) => ({
    ...table,
    fields: table.fields.map((field) =>
      field.kind === 'foreignKey' && field.references && !names.has(field.references)
        ? { ...field, references: undefined }
        : field,
    ),
  }));
}

export function starterDataset(): Dataset {
  const customers: Table = {
    id: createId('tbl'),
    name: 'customers',
    rows: 20,
    fields: [
      createField('id', 'id'),
      createField('name', 'fullName'),
      createField('email', 'email'),
      createField('city', 'city'),
      createField('country', 'country'),
      { ...createField('signed_up', 'date'), nullRate: 0 },
      { ...createField('status', 'enum'), options: 'active, trial, churned' },
    ],
  };

  const orders: Table = {
    id: createId('tbl'),
    name: 'orders',
    rows: 60,
    fields: [
      createField('id', 'id'),
      { ...createField('customer_id', 'foreignKey'), references: 'customers' },
      createField('product', 'product'),
      { ...createField('quantity', 'integer'), min: 1, max: 12 },
      { ...createField('total', 'money'), min: 5, max: 900 },
      createField('placed_at', 'datetime'),
      { ...createField('note', 'sentence'), nullRate: 0.6 },
    ],
  };

  return { seed: 'alexmerced', tables: [customers, orders] };
}
