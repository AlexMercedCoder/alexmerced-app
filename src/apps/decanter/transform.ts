/**
 * The operations that make Decanter more than a converter: reshaping nested
 * data, querying it by path, and describing its schema.
 */
import type { Json } from './formats';

// --------------------------------------------------------------------- flatten

export function flatten(value: Json, separator = '.', prefix = ''): Record<string, Json> {
  const out: Record<string, Json> = {};

  const walk = (node: Json, path: string) => {
    if (node !== null && typeof node === 'object') {
      const entries = Array.isArray(node)
        ? node.map((item, index) => [String(index), item] as const)
        : Object.entries(node);

      if (!entries.length) { out[path] = Array.isArray(node) ? [] : {}; return; }
      for (const [key, item] of entries) walk(item as Json, path ? `${path}${separator}${key}` : key);
      return;
    }
    out[path] = node;
  };

  walk(value, prefix);
  return out;
}

/** Rebuilds nesting from dotted keys, recreating arrays where keys are indexes. */
export function unflatten(flat: Record<string, Json>, separator = '.'): Json {
  const root: Record<string, Json> = {};

  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(separator);
    let node: Record<string, Json> = root;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) { node[part] = value; return; }
      if (node[part] === undefined || node[part] === null || typeof node[part] !== 'object') {
        node[part] = {};
      }
      node = node[part] as Record<string, Json>;
    });
  }

  return arraysFromIndexes(root);
}

function arraysFromIndexes(value: Json): Json {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(arraysFromIndexes);

  const entries = Object.entries(value);
  const looksLikeArray = entries.length > 0 && entries.every(([key], index) => key === String(index));

  if (looksLikeArray) return entries.map(([, item]) => arraysFromIndexes(item));

  const out: Record<string, Json> = {};
  for (const [key, item] of entries) out[key] = arraysFromIndexes(item);
  return out;
}

// --------------------------------------------------------------------- query

/**
 * A path query in the shape people expect from JSONPath, covering the parts
 * that get used: dot access, indexes, wildcards, and a recursive descent.
 */
export function query(value: Json, path: string): Json[] {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$') return [value];

  const tokens = tokenizePath(trimmed);
  let current: Json[] = [value];

  for (const token of tokens) {
    const next: Json[] = [];

    for (const node of current) {
      if (token.kind === 'recurse') {
        collectAll(node, next);
        continue;
      }
      if (token.kind === 'wildcard') {
        if (Array.isArray(node)) next.push(...node);
        else if (node !== null && typeof node === 'object') next.push(...Object.values(node));
        continue;
      }
      if (token.kind === 'index') {
        if (Array.isArray(node)) {
          const index = token.value < 0 ? node.length + token.value : token.value;
          if (index >= 0 && index < node.length) next.push(node[index]);
        }
        continue;
      }
      if (token.kind === 'slice') {
        if (Array.isArray(node)) next.push(...node.slice(token.from, token.to));
        continue;
      }
      if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
        const found = (node as Record<string, Json>)[token.name];
        if (found !== undefined) next.push(found);
      }
    }

    current = next;
  }

  return current;
}

type PathToken =
  | { kind: 'name'; name: string }
  | { kind: 'index'; value: number }
  | { kind: 'slice'; from: number; to: number }
  | { kind: 'wildcard' }
  | { kind: 'recurse' };

function tokenizePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  let i = 0;
  if (path.startsWith('$')) i = 1;

  while (i < path.length) {
    if (path.startsWith('..', i)) { tokens.push({ kind: 'recurse' }); i += 2; continue; }
    if (path[i] === '.') { i += 1; continue; }

    if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) throw new Error('That path has an unclosed bracket.');
      const inner = path.slice(i + 1, close).trim();
      i = close + 1;

      if (inner === '*') { tokens.push({ kind: 'wildcard' }); continue; }
      if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        tokens.push({ kind: 'name', name: inner.slice(1, -1) });
        continue;
      }
      if (inner.includes(':')) {
        const [from, to] = inner.split(':');
        tokens.push({ kind: 'slice', from: from ? Number(from) : 0, to: to ? Number(to) : Number.MAX_SAFE_INTEGER });
        continue;
      }
      const index = Number(inner);
      if (!Number.isFinite(index)) throw new Error(`"${inner}" is not an index.`);
      tokens.push({ kind: 'index', value: index });
      continue;
    }

    if (path[i] === '*') { tokens.push({ kind: 'wildcard' }); i += 1; continue; }

    let name = '';
    while (i < path.length && !'.[*'.includes(path[i])) { name += path[i]; i += 1; }
    if (name) tokens.push({ kind: 'name', name });
  }

  return tokens;
}

function collectAll(node: Json, into: Json[]): void {
  into.push(node);
  if (node === null || typeof node !== 'object') return;
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) collectAll(child as Json, into);
}

// --------------------------------------------------------------------- schema

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'date' | 'timestamp' | 'mixed';

export type FieldSchema = {
  name: string;
  types: FieldType[];
  nullable: boolean;
  /** Share of records where the field was present, 0 to 1. */
  presence: number;
  examples: string[];
  maxLength?: number;
};

export function inferType(value: Json): FieldType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return 'timestamp';
  return 'string';
}

/** Describes the shape of an array of records, which is what data tools want. */
export function inferSchema(value: Json, sampleLimit = 1000): FieldSchema[] {
  const rows = (Array.isArray(value) ? value : [value])
    .filter((row): row is Record<string, Json> => row !== null && typeof row === 'object' && !Array.isArray(row))
    .slice(0, sampleLimit);

  if (!rows.length) return [];

  const fields = new Map<string, { types: Set<FieldType>; present: number; examples: string[]; maxLength: number }>();
  const order: string[] = [];

  for (const row of rows) {
    for (const [key, item] of Object.entries(row)) {
      if (!fields.has(key)) { fields.set(key, { types: new Set(), present: 0, examples: [], maxLength: 0 }); order.push(key); }
      const field = fields.get(key)!;
      field.present += 1;
      field.types.add(inferType(item));
      if (typeof item === 'string') field.maxLength = Math.max(field.maxLength, item.length);
      if (field.examples.length < 3 && item !== null && item !== '') {
        const text = typeof item === 'object' ? JSON.stringify(item) : String(item);
        if (!field.examples.includes(text)) field.examples.push(text.slice(0, 40));
      }
    }
  }

  return order.map((name) => {
    const field = fields.get(name)!;
    const types = [...field.types];
    const nullable = types.includes('null') || field.present < rows.length;
    const concrete = types.filter((type) => type !== 'null');

    return {
      name,
      types: concrete.length ? concrete : ['null'],
      nullable,
      presence: field.present / rows.length,
      examples: field.examples,
      maxLength: field.maxLength || undefined,
    };
  });
}

const SQL_TYPES: Record<FieldType, string> = {
  string: 'VARCHAR', integer: 'BIGINT', number: 'DOUBLE', boolean: 'BOOLEAN',
  date: 'DATE', timestamp: 'TIMESTAMP', array: 'VARCHAR', object: 'VARCHAR', null: 'VARCHAR', mixed: 'VARCHAR',
};

function sqlTypeFor(field: FieldSchema): string {
  if (field.types.length !== 1) return 'VARCHAR';
  const type = field.types[0];
  if (type === 'string' && field.maxLength) return `VARCHAR(${Math.max(16, Math.ceil(field.maxLength * 1.5))})`;
  return SQL_TYPES[type];
}

function sqlName(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function toSqlDdl(fields: FieldSchema[], table = 'my_table'): string {
  if (!fields.length) return '-- No records to describe.';
  const columns = fields.map((field) => `  ${sqlName(field.name)} ${sqlTypeFor(field)}${field.nullable ? '' : ' NOT NULL'}`);
  return `CREATE TABLE ${sqlName(table)} (\n${columns.join(',\n')}\n);`;
}

const ICEBERG_TYPES: Record<FieldType, string> = {
  string: 'string', integer: 'long', number: 'double', boolean: 'boolean',
  date: 'date', timestamp: 'timestamp', array: 'string', object: 'string', null: 'string', mixed: 'string',
};

/** An Iceberg schema, since that is what a lot of this data is destined for. */
export function toIcebergSchema(fields: FieldSchema[]): string {
  if (!fields.length) return '{}';
  return JSON.stringify({
    type: 'struct',
    'schema-id': 0,
    fields: fields.map((field, index) => ({
      id: index + 1,
      name: field.name,
      required: !field.nullable,
      type: field.types.length === 1 ? ICEBERG_TYPES[field.types[0]] : 'string',
    })),
  }, null, 2);
}

export function toJsonSchema(fields: FieldSchema[], title = 'Record'): string {
  const jsonTypes: Record<FieldType, string> = {
    string: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
    date: 'string', timestamp: 'string', array: 'array', object: 'object', null: 'null', mixed: 'string',
  };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    const types = [...new Set(field.types.map((type) => jsonTypes[type]))];
    const entry: Record<string, unknown> = { type: field.nullable ? [...types, 'null'] : types.length === 1 ? types[0] : types };
    if (field.types.includes('date')) entry.format = 'date';
    if (field.types.includes('timestamp')) entry.format = 'date-time';
    if (field.examples.length) entry.examples = field.examples;
    properties[field.name] = entry;
    if (!field.nullable) required.push(field.name);
  }

  return JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }, null, 2);
}

// --------------------------------------------------------------------- stats

export type Stats = { records: number; fields: number; depth: number; bytes: number };

export function describe(value: Json, text: string): Stats {
  const records = Array.isArray(value) ? value.length : 1;
  const fields = Object.keys(flatten(value)).length;

  const depthOf = (node: Json): number => {
    if (node === null || typeof node !== 'object') return 0;
    const children = Array.isArray(node) ? node : Object.values(node);
    if (!children.length) return 1;
    return 1 + Math.max(...children.map((child) => depthOf(child as Json)));
  };

  return { records, fields, depth: depthOf(value), bytes: new TextEncoder().encode(text).length };
}
