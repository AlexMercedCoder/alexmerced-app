/**
 * Readers and writers for the formats Decanter converts between.
 *
 * JSON is the pivot: everything is parsed into plain JavaScript values and
 * written back out from there. The YAML and TOML support is a deliberate
 * subset, described honestly in the app rather than pretending to be complete.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class ParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'ParseError';
  }
}

export type FormatId = 'json' | 'ndjson' | 'csv' | 'yaml' | 'toml';

export const FORMATS: { id: FormatId; label: string; note: string }[] = [
  { id: 'json', label: 'JSON', note: 'The pivot format. Everything passes through it.' },
  { id: 'ndjson', label: 'NDJSON', note: 'One JSON value per line. What most log and streaming tools emit.' },
  { id: 'csv', label: 'CSV', note: 'RFC 4180: quoted fields, doubled quotes, embedded newlines.' },
  { id: 'yaml', label: 'YAML', note: 'Maps, lists, scalars, comments, block and flow style. No anchors or tags.' },
  { id: 'toml', label: 'TOML', note: 'Tables, arrays of tables, inline tables, and the common scalar types.' },
];

// --------------------------------------------------------------------- JSON

export function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    const position = /position (\d+)/.exec(message);
    const line = position ? text.slice(0, Number(position[1])).split('\n').length : undefined;
    throw new ParseError(message.replace(/ in JSON at position \d+.*/, ''), line);
  }
}

export function writeJson(value: Json, indent = 2): string {
  return JSON.stringify(value, null, indent);
}

// --------------------------------------------------------------------- NDJSON

export function parseNdjson(text: string): Json {
  const rows: Json[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as Json);
    } catch {
      throw new ParseError('This line is not valid JSON on its own.', i + 1);
    }
  }
  return rows;
}

export function writeNdjson(value: Json): string {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

// --------------------------------------------------------------------- CSV

export type CsvOptions = { delimiter: string; header: boolean; inferTypes: boolean };
export const defaultCsvOptions: CsvOptions = { delimiter: ',', header: true, inferTypes: true };

/** Reads RFC 4180, including quoted fields containing the delimiter or newlines. */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const character = text[i];

    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += character; i += 1; continue;
    }

    if (character === '"' && !started) { quoted = true; started = true; i += 1; continue; }
    if (character === delimiter) { endField(); i += 1; continue; }
    if (character === '\r') { i += 1; continue; }
    if (character === '\n') { endRow(); i += 1; continue; }

    field += character;
    started = true;
    i += 1;
  }

  if (field !== '' || row.length > 0) endRow();
  return rows.filter((entry) => entry.length > 1 || entry.some((value) => value !== ''));
}

/** Turns a CSV string into whatever it looks like: rows of objects, or of arrays. */
export function parseCsv(text: string, options: CsvOptions = defaultCsvOptions): Json {
  const rows = parseCsvRows(text, options.delimiter);
  if (!rows.length) return [];

  const coerce = (value: string): Json => (options.inferTypes ? inferScalar(value) : value);

  if (!options.header) return rows.map((row) => row.map(coerce));

  const header = rows[0].map((name, index) => name.trim() || `column_${index + 1}`);
  return rows.slice(1).map((row) => {
    const record: Record<string, Json> = {};
    header.forEach((name, index) => { record[name] = coerce(row[index] ?? ''); });
    return record;
  });
}

/** Guesses at the type of a bare CSV field, which is what every CSV reader does. */
export function inferScalar(value: string): Json {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^(null|nil|none)$/i.test(trimmed)) return null;
  // Leading zeros usually mean an identifier rather than a number.
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isSafeInteger(asNumber) || !Number.isInteger(asNumber)) return asNumber;
  }
  return value;
}

function csvField(value: Json, delimiter: string): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return new RegExp(`["\\n\\r${escapeForClass(delimiter)}]`).test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function escapeForClass(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

export function writeCsv(value: Json, options: CsvOptions = defaultCsvOptions): string {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length) return '';

  // Arrays of arrays go straight out.
  if (rows.every((row) => Array.isArray(row))) {
    return (rows as Json[][]).map((row) => row.map((cell) => csvField(cell, options.delimiter)).join(options.delimiter)).join('\n');
  }

  const objects = rows.map((row) => (typeof row === 'object' && row !== null && !Array.isArray(row) ? row : { value: row }));
  const columns: string[] = [];
  for (const row of objects) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }

  const lines: string[] = [];
  if (options.header) lines.push(columns.map((name) => csvField(name, options.delimiter)).join(options.delimiter));
  for (const row of objects) {
    lines.push(columns.map((name) => csvField((row as Record<string, Json>)[name] ?? '', options.delimiter)).join(options.delimiter));
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- YAML

/** Parses the subset of YAML that covers ordinary configuration files. */
export function parseYaml(text: string): Json {
  const lines: { indent: number; content: string; line: number }[] = [];

  text.split('\n').forEach((raw, index) => {
    const withoutComment = stripYamlComment(raw);
    if (!withoutComment.trim()) return;
    if (withoutComment.trim() === '---') return;
    if (withoutComment.trim() === '...') return;
    lines.push({ indent: raw.length - raw.trimStart().length, content: withoutComment.trim(), line: index + 1 });
  });

  if (!lines.length) return null;

  const [value] = parseYamlBlock(lines, 0, lines[0].indent);
  return value;
}

function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quote) {
      if (character === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    // A hash only starts a comment when it follows whitespace or begins the line.
    if (character === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function parseYamlBlock(
  lines: { indent: number; content: string; line: number }[],
  start: number,
  indent: number,
): [Json, number] {
  const first = lines[start];
  if (!first) return [null, start];

  if (first.content.startsWith('- ') || first.content === '-') {
    const list: Json[] = [];
    let i = start;

    while (i < lines.length && lines[i].indent === indent && (lines[i].content.startsWith('- ') || lines[i].content === '-')) {
      const rest = lines[i].content === '-' ? '' : lines[i].content.slice(2).trim();
      const childIndent = i + 1 < lines.length ? lines[i + 1].indent : indent;

      if (!rest) {
        if (childIndent > indent) {
          const [value, next] = parseYamlBlock(lines, i + 1, childIndent);
          list.push(value);
          i = next;
        } else { list.push(null); i += 1; }
        continue;
      }

      // A key on the same line as the dash starts a map inside the item.
      const colon = findYamlColon(rest);
      if (colon !== -1) {
        const nested: { indent: number; content: string; line: number }[] = [
          { indent: indent + 2, content: rest, line: lines[i].line },
        ];
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent) {
          nested.push({ ...lines[j], indent: lines[j].indent });
          j += 1;
        }
        const [value] = parseYamlBlock(nested, 0, indent + 2);
        list.push(value);
        i = j;
        continue;
      }

      list.push(parseYamlScalar(rest));
      i += 1;
    }
    return [list, i];
  }

  const map: Record<string, Json> = {};
  let i = start;

  while (i < lines.length && lines[i].indent === indent) {
    const { content, line } = lines[i];
    const colon = findYamlColon(content);
    if (colon === -1) throw new ParseError('Expected "key: value" here.', line);

    const key = unquoteYaml(content.slice(0, colon).trim());
    const rest = content.slice(colon + 1).trim();

    if (rest) { map[key] = parseYamlScalar(rest); i += 1; continue; }

    const childIndent = i + 1 < lines.length ? lines[i + 1].indent : indent;
    if (i + 1 < lines.length && childIndent > indent) {
      const [value, next] = parseYamlBlock(lines, i + 1, childIndent);
      map[key] = value;
      i = next;
    } else {
      map[key] = null;
      i += 1;
    }
  }

  return [map, i];
}

function findYamlColon(content: string): number {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i += 1) {
    const character = content[i];
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ':' && (i + 1 === content.length || /[\s]/.test(content[i + 1]))) return i;
  }
  return -1;
}

function unquoteYaml(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return value;
}

function parseYamlScalar(raw: string): Json {
  const value = raw.trim();
  if (value.startsWith('[') || value.startsWith('{')) return parseYamlFlow(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquoteYaml(value);
  }
  if (value === '~' || value === 'null' || value === 'Null' || value === '') return null;
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^(false|no|off)$/i.test(value)) return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Flow style is JSON with looser quoting, so it is read with a small scanner. */
function parseYamlFlow(text: string): Json {
  let i = 0;

  const skip = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };

  const readValue = (): Json => {
    skip();
    if (text[i] === '[') {
      i += 1;
      const list: Json[] = [];
      skip();
      if (text[i] === ']') { i += 1; return list; }
      while (i < text.length) {
        list.push(readValue());
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; break; }
        throw new ParseError('Expected a comma or a closing bracket in flow style.');
      }
      return list;
    }

    if (text[i] === '{') {
      i += 1;
      const map: Record<string, Json> = {};
      skip();
      if (text[i] === '}') { i += 1; return map; }
      while (i < text.length) {
        skip();
        const key = String(readScalarToken([':']));
        skip();
        if (text[i] !== ':') throw new ParseError('Expected a colon in flow style.');
        i += 1;
        map[key.trim()] = readValue();
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; break; }
        throw new ParseError('Expected a comma or a closing brace in flow style.');
      }
      return map;
    }

    return readScalarToken([',', ']', '}']);
  };

  const readScalarToken = (stops: string[]): Json => {
    skip();
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      i += 1;
      let out = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && quote === '"') { out += text[i + 1]; i += 2; continue; }
        out += text[i];
        i += 1;
      }
      i += 1;
      return out;
    }
    let out = '';
    while (i < text.length && !stops.includes(text[i])) { out += text[i]; i += 1; }
    return parseYamlScalar(out);
  };

  const value = readValue();
  return value;
}

export function writeYaml(value: Json, indent = 0): string {
  const pad = ' '.repeat(indent);

  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return needsYamlQuotes(value) ? JSON.stringify(value) : value;

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const nested = writeYaml(item, indent + 2);
          return `${pad}- ${nested.trimStart()}`;
        }
        return `${pad}- ${writeYaml(item, 0)}`;
      })
      .join('\n');
  }

  const entries = Object.entries(value);
  if (!entries.length) return '{}';

  return entries
    .map(([key, item]) => {
      const name = needsYamlQuotes(key) ? JSON.stringify(key) : key;
      // Every line carries its own indent. The list branch trims the first
      // line's indent when the map has to sit beside a dash.
      if (item !== null && typeof item === 'object' && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
        return `${pad}${name}:\n${writeYaml(item, indent + 2)}`;
      }
      return `${pad}${name}: ${writeYaml(item, 0)}`;
    })
    .join('\n');
}

function needsYamlQuotes(value: string): boolean {
  if (value === '') return true;
  if (/^[\s]|[\s]$/.test(value)) return true;
  if (/^(true|false|yes|no|on|off|null|~)$/i.test(value)) return true;
  if (/^-?\d/.test(value) && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) return true;
  return /[:#\-{}[\],&*?|<>=!%@`"']/.test(value.slice(0, 1)) || /: |\s#/.test(value);
}

// --------------------------------------------------------------------- TOML

export function parseToml(text: string): Json {
  const root: Record<string, Json> = {};
  let current: Record<string, Json> = root;

  text.split('\n').forEach((raw, index) => {
    const line = stripTomlComment(raw).trim();
    if (!line) return;

    const arrayTable = /^\[\[(.+)\]\]$/.exec(line);
    if (arrayTable) {
      const path = splitTomlKey(arrayTable[1]);
      const parent = ensureTomlPath(root, path.slice(0, -1));
      const key = path[path.length - 1];
      const list = Array.isArray(parent[key]) ? (parent[key] as Json[]) : [];
      const entry: Record<string, Json> = {};
      list.push(entry);
      parent[key] = list;
      current = entry;
      return;
    }

    const table = /^\[(.+)\]$/.exec(line);
    if (table) {
      current = ensureTomlPath(root, splitTomlKey(table[1]));
      return;
    }

    const equals = findTomlEquals(line);
    if (equals === -1) throw new ParseError('Expected "key = value" here.', index + 1);

    const path = splitTomlKey(line.slice(0, equals).trim());
    const target = ensureTomlPath(current, path.slice(0, -1));
    target[path[path.length - 1]] = parseTomlValue(line.slice(equals + 1).trim(), index + 1);
  });

  return root;
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quote) { if (character === quote && line[i - 1] !== '\\') quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#') return line.slice(0, i);
  }
  return line;
}

function splitTomlKey(key: string): string[] {
  return key.split('.').map((part) => part.trim().replace(/^["']|["']$/g, ''));
}

function findTomlEquals(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '=') return i;
  }
  return -1;
}

function ensureTomlPath(root: Record<string, Json>, path: string[]): Record<string, Json> {
  let node = root;
  for (const part of path) {
    const existing = node[part];
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      node = last as Record<string, Json>;
    } else if (existing && typeof existing === 'object') {
      node = existing as Record<string, Json>;
    } else {
      const fresh: Record<string, Json> = {};
      node[part] = fresh;
      node = fresh;
    }
  }
  return node;
}

function parseTomlValue(raw: string, line: number): Json {
  const value = raw.trim();
  if (!value) throw new ParseError('This key has no value.', line);

  if (value.startsWith('"')) return JSON.parse(value) as Json;
  if (value.startsWith("'")) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;

  if (value.startsWith('[')) {
    const inner = value.slice(1, value.lastIndexOf(']'));
    return splitTopLevel(inner).map((part) => parseTomlValue(part, line));
  }

  if (value.startsWith('{')) {
    const inner = value.slice(1, value.lastIndexOf('}'));
    const map: Record<string, Json> = {};
    for (const part of splitTopLevel(inner)) {
      const equals = findTomlEquals(part);
      if (equals === -1) continue;
      map[splitTomlKey(part.slice(0, equals).trim()).join('.')] = parseTomlValue(part.slice(equals + 1), line);
    }
    return map;
  }

  // Dates stay as strings, which is the honest thing to do without a date type.
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(value)) return value;
  if (/^[+-]?(0|[1-9](_?\d)*)$/.test(value)) return Number(value.replace(/_/g, ''));
  if (/^[+-]?(\d(_?\d)*)?\.\d(_?\d)*([eE][+-]?\d+)?$/.test(value)) return Number(value.replace(/_/g, ''));
  return value;
}

/** Splits on commas that are not inside a string, bracket, or brace. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (quote) {
      current += character;
      if (character === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === '[' || character === '{') depth += 1;
    if (character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function writeToml(value: Json): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParseError('TOML needs an object at the top level, not an array or a bare value.');
  }

  const lines: string[] = [];
  writeTomlTable(value as Record<string, Json>, [], lines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function writeTomlTable(table: Record<string, Json>, path: string[], lines: string[]): void {
  const scalars: [string, Json][] = [];
  const tables: [string, Record<string, Json>][] = [];
  const arrayTables: [string, Record<string, Json>[]][] = [];

  for (const [key, value] of Object.entries(table)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      tables.push([key, value as Record<string, Json>]);
    } else if (Array.isArray(value) && value.length > 0 && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      arrayTables.push([key, value as Record<string, Json>[]]);
    } else {
      scalars.push([key, value]);
    }
  }

  if (path.length && (scalars.length || (!tables.length && !arrayTables.length))) {
    lines.push(`[${path.map(tomlKey).join('.')}]`);
  }
  for (const [key, value] of scalars) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  if (scalars.length) lines.push('');

  for (const [key, value] of tables) writeTomlTable(value, [...path, key], lines);

  for (const [key, list] of arrayTables) {
    for (const entry of list) {
      lines.push(`[[${[...path, key].map(tomlKey).join('.')}]]`);
      const nested: string[] = [];
      writeTomlTable(entry, [], nested);
      lines.push(...nested.filter((line) => !line.startsWith('[')));
      lines.push('');
    }
  }
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: Json): string {
  if (value === null) return '""';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  return `{ ${Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`).join(', ')} }`;
}

// --------------------------------------------------------------------- dispatch

export function parse(text: string, format: FormatId, csvOptions: CsvOptions = defaultCsvOptions): Json {
  if (!text.trim()) throw new ParseError('There is nothing to parse yet.');
  switch (format) {
    case 'json': return parseJson(text);
    case 'ndjson': return parseNdjson(text);
    case 'csv': return parseCsv(text, csvOptions);
    case 'yaml': return parseYaml(text);
    case 'toml': return parseToml(text);
  }
}

export function write(value: Json, format: FormatId, csvOptions: CsvOptions = defaultCsvOptions): string {
  switch (format) {
    case 'json': return writeJson(value);
    case 'ndjson': return writeNdjson(value);
    case 'csv': return writeCsv(value, csvOptions);
    case 'yaml': return writeYaml(value);
    case 'toml': return writeToml(value);
  }
}

/** A quick guess at what was pasted, so the format does not have to be chosen. */
export function detectFormat(text: string): FormatId {
  const trimmed = text.trim();
  if (!trimmed) return 'json';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not quite JSON */ }
  }

  const lines = trimmed.split('\n').filter((line) => line.trim());
  if (lines.length > 1 && lines.every((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))) return 'ndjson';
  if (/^\s*\[\[?[^\]]+\]\]?\s*$/m.test(trimmed) || /^[A-Za-z0-9_."-]+\s*=\s*/m.test(trimmed)) return 'toml';
  if (/^\s*[-A-Za-z0-9_."'\s]+:\s*(\S|$)/m.test(trimmed) || /^\s*-\s+/m.test(trimmed)) return 'yaml';

  const firstLine = lines[0] ?? '';
  if (firstLine.includes(',') || firstLine.includes('\t')) return 'csv';
  return 'json';
}
