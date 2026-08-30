/**
 * The parts of a SQL workbench that do not need a database: splitting a script
 * into statements, working out what a statement will do, and turning file names
 * into table names.
 */

export const APP_ID = 'quarry';
export const APP_VERSION = 1;

/**
 * Splits a script on semicolons, ignoring the ones inside strings, identifiers,
 * comments, and dollar-quoted blocks. Getting this wrong means a semicolon in a
 * string literal silently cuts a query in half.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < script.length) {
    const character = script[index];
    const next = script[index + 1];

    // Line comment.
    if (character === '-' && next === '-') {
      const end = script.indexOf('\n', index);
      const stop = end === -1 ? script.length : end;
      current += script.slice(index, stop);
      index = stop;
      continue;
    }

    // Block comment, which nests in the SQL standard.
    if (character === '/' && next === '*') {
      let depth = 1;
      let position = index + 2;
      while (position < script.length && depth > 0) {
        if (script[position] === '/' && script[position + 1] === '*') { depth += 1; position += 2; }
        else if (script[position] === '*' && script[position + 1] === '/') { depth -= 1; position += 2; }
        else position += 1;
      }
      current += script.slice(index, position);
      index = position;
      continue;
    }

    // Quoted string or identifier. Doubling the quote escapes it.
    if (character === "'" || character === '"') {
      let position = index + 1;
      while (position < script.length) {
        if (script[position] === character) {
          if (script[position + 1] === character) position += 2;
          else { position += 1; break; }
        } else if (script[position] === '\\' && character === "'") {
          position += 2;
        } else {
          position += 1;
        }
      }
      current += script.slice(index, position);
      index = position;
      continue;
    }

    // Dollar quoting, where the tag between the dollars must match to close.
    if (character === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(index));
      if (match) {
        const tag = match[0];
        const close = script.indexOf(tag, index + tag.length);
        const stop = close === -1 ? script.length : close + tag.length;
        current += script.slice(index, stop);
        index = stop;
        continue;
      }
    }

    if (character === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

export type StatementKind = 'query' | 'command' | 'empty';

/** Whether a statement gives back rows or merely changes something. */
export function statementKind(statement: string): StatementKind {
  const stripped = stripComments(statement).trim();
  if (!stripped) return 'empty';

  // A leading WITH or parenthesis still leads to a SELECT.
  const first = /^\(*\s*([A-Za-z_]+)/.exec(stripped)?.[1]?.toUpperCase() ?? '';
  const returning = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'DESCRIBE', 'SHOW', 'EXPLAIN', 'SUMMARIZE', 'PIVOT', 'UNPIVOT', 'FROM']);
  return returning.has(first) ? 'query' : 'command';
}

export function stripComments(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (character === "'" || character === '"') {
      let position = index + 1;
      while (position < sql.length) {
        if (sql[position] === character) {
          if (sql[position + 1] === character) position += 2;
          else { position += 1; break; }
        } else position += 1;
      }
      out += sql.slice(index, position);
      index = position;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

const RESERVED = new Set([
  'all', 'and', 'any', 'array', 'as', 'asc', 'between', 'by', 'case', 'cast', 'check', 'column',
  'constraint', 'create', 'cross', 'current_date', 'current_time', 'current_timestamp', 'default',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'exists', 'false', 'for', 'foreign', 'from',
  'full', 'grant', 'group', 'having', 'in', 'initially', 'inner', 'intersect', 'into', 'is', 'join',
  'lateral', 'leading', 'left', 'like', 'limit', 'natural', 'not', 'null', 'offset', 'on', 'only',
  'or', 'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right',
  'select', 'similar', 'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union',
  'unique', 'using', 'values', 'when', 'where', 'window', 'with',
]);

/** Turns a file name into a table name that will not need quoting. */
export function tableNameFrom(filename: string): string {
  const stem = filename
    .replace(/\.(csv|tsv|json|jsonl|ndjson|parquet|arrow|txt|gz|zip)$/gi, '')
    .replace(/\.(csv|tsv|json|jsonl|ndjson|parquet|arrow)$/gi, '');

  let name = stem
    .normalize('NFKD')
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  if (!name) name = 'data';
  // A name cannot start with a digit, and cannot collide with a keyword.
  if (/^\d/.test(name)) name = `t_${name}`;
  if (RESERVED.has(name)) name = `${name}_`;
  return name.slice(0, 63);
}

export function uniqueTableName(preferred: string, taken: string[]): string {
  if (!taken.includes(preferred)) return preferred;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${preferred}_${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${preferred}_${taken.length + 1}`;
}

/** Quotes an identifier for SQL, doubling any quote inside it. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type SourceFormat = 'csv' | 'json' | 'parquet' | 'arrow' | 'unknown';

export function formatOf(filename: string): SourceFormat {
  const lower = filename.toLowerCase();
  if (/\.(csv|tsv|txt)(\.gz)?$/.test(lower)) return 'csv';
  if (/\.(json|jsonl|ndjson)(\.gz)?$/.test(lower)) return 'json';
  if (/\.parquet$/.test(lower)) return 'parquet';
  if (/\.(arrow|feather|ipc)$/.test(lower)) return 'arrow';
  return 'unknown';
}

/** The statement that turns a registered file into a queryable view. */
export function registerStatement(table: string, filename: string, format: SourceFormat): string {
  const name = quoteIdentifier(table);
  const path = quoteLiteral(filename);
  if (format === 'parquet') return `CREATE OR REPLACE VIEW ${name} AS SELECT * FROM read_parquet(${path});`;
  if (format === 'json') return `CREATE OR REPLACE VIEW ${name} AS SELECT * FROM read_json_auto(${path});`;
  if (format === 'csv') return `CREATE OR REPLACE VIEW ${name} AS SELECT * FROM read_csv_auto(${path}, sample_size = -1);`;
  // Arrow is registered through the API rather than a path, so nothing to run.
  return '';
}

// --------------------------------------------------------------------- display

/**
 * Turns whatever comes back from the engine into something printable.
 *
 * Arrow hands back BigInt for 64-bit integers, Date objects, typed arrays, and
 * nested structures. Passing those to a template string either throws or prints
 * "[object Object]", so each one is handled deliberately.
 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  if (value instanceof Uint8Array) return `\\x${[...value.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}${value.length > 16 ? '...' : ''}`;
  if (Array.isArray(value)) return `[${value.map(displayValue).join(', ')}]`;

  if (typeof value === 'object') {
    // Arrow rows and structs expose toJSON or toArray rather than plain keys.
    const candidate = value as { toJSON?: () => unknown; toArray?: () => unknown[] };
    if (typeof candidate.toJSON === 'function') return stringifySafely(candidate.toJSON());
    if (typeof candidate.toArray === 'function') return `[${candidate.toArray().map(displayValue).join(', ')}]`;
    return stringifySafely(value);
  }

  return String(value);
}

function stringifySafely(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Right-aligns numeric columns, which is how a result set becomes readable.
 *
 * Both spellings are accepted: DuckDB's own type names, and the Arrow names the
 * result schema actually carries, which are what reach the table.
 */
export function isNumericType(type: string): boolean {
  const name = type.trim();
  if (/^(u?(tiny|small|big|huge)?int|decimal|numeric|float|double|real)/i.test(name)) return true;
  return /^(Int|Uint|Float|Decimal)\d*$/i.test(name);
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1) return 'under a millisecond';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

export function formatCount(rows: number): string {
  return `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}`;
}

// --------------------------------------------------------------------- output

/** Rows and columns as CSV, quoting anything that needs it. */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [columns.map((column) => escape(column)).join(',')];
  for (const row of rows) lines.push(row.map((cell) => escape(displayValue(cell))).join(','));
  return lines.join('\n');
}

export function toJson(columns: string[], rows: unknown[][]): string {
  const objects = rows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const value = row[index];
      record[column] = typeof value === 'bigint' ? value.toString() : value instanceof Date ? value.toISOString() : value;
    });
    return record;
  });
  return JSON.stringify(objects, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
}

export function toMarkdown(columns: string[], rows: unknown[][]): string {
  const cells = rows.map((row) => row.map(displayValue));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => (row[index] ?? '').length), 3));

  const line = (values: string[]) =>
    `| ${values.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;

  return [
    line(columns),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...cells.map(line),
  ].join('\n');
}

export const SAMPLE_QUERIES: { label: string; sql: string }[] = [
  {
    label: 'What is in here',
    sql: 'SHOW TABLES;',
  },
  {
    label: 'Describe a table',
    sql: 'DESCRIBE trips;',
  },
  {
    label: 'First rows',
    sql: 'SELECT * FROM trips LIMIT 20;',
  },
  {
    label: 'Group and count',
    sql: "SELECT city, count(*) AS trips, round(avg(fare), 2) AS average_fare\nFROM trips\nGROUP BY city\nORDER BY trips DESC;",
  },
  {
    label: 'Summarise every column',
    sql: 'SUMMARIZE trips;',
  },
  {
    label: 'A window function',
    sql: "SELECT city, day, fare,\n       sum(fare) OVER (PARTITION BY city ORDER BY day) AS running_total\nFROM trips\nORDER BY city, day\nLIMIT 40;",
  },
];
