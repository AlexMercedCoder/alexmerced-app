export const APP_ID = 'ordinate';
export const APP_VERSION = 1;

export type Table = {
  columns: string[];
  rows: (string | number | null)[][];
};

export type ColumnKind = 'number' | 'text' | 'empty';

/**
 * Reads whatever got pasted in. Delimited text, a JSON array of objects, or a
 * JSON array of arrays all end up as the same table.
 */
export function parseInput(text: string): Table {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], rows: [] };

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const fromJson = tryJson(trimmed);
    if (fromJson) return fromJson;
  }
  return parseDelimited(trimmed);
}

function tryJson(text: string): Table | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  // A bare object is treated as one row, which is what a single record looks like.
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return { columns: [], rows: [] };

  if (list.every((row) => Array.isArray(row))) {
    const grid = list as unknown[][];
    const header = grid[0].map((cell) => String(cell ?? ''));
    // Treat the first row as a header only if none of it looks numeric.
    const headerIsData = grid[0].some((cell) => typeof cell === 'number');
    return headerIsData
      ? { columns: grid[0].map((_, index) => `Column ${index + 1}`), rows: grid.map(normaliseRow) }
      : { columns: header, rows: grid.slice(1).map(normaliseRow) };
  }

  if (list.every((row) => typeof row === 'object' && row !== null)) {
    const columns: string[] = [];
    for (const row of list as Record<string, unknown>[]) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    return {
      columns,
      rows: (list as Record<string, unknown>[]).map((row) => columns.map((key) => normaliseCell(row[key]))),
    };
  }

  // A plain array of numbers or strings is a single column.
  return { columns: ['Value'], rows: list.map((cell) => [normaliseCell(cell)]) };
}

function normaliseRow(row: unknown[]): (string | number | null)[] {
  return row.map(normaliseCell);
}

function normaliseCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Picks whichever of tab, comma, semicolon, or pipe splits the rows most evenly. */
export function detectDelimiter(lines: string[]): string {
  const candidates = ['\t', ',', ';', '|'];
  let best = ',';
  let bestScore = -1;

  for (const delimiter of candidates) {
    const counts = lines.slice(0, 12).map((line) => splitRow(line, delimiter).length);
    if (counts.length === 0) continue;
    const first = counts[0];
    if (first < 2) continue;
    // Consistency matters more than column count: a delimiter that splits every
    // row the same way is the real one.
    const consistent = counts.every((count) => count === first);
    const score = (consistent ? 100 : 0) + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** A CSV row splitter that respects quotes and doubled quotes inside them. */
export function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

export function parseDelimited(text: string): Table {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { columns: [], rows: [] };

  const delimiter = detectDelimiter(lines);
  const grid = lines.map((line) => splitRow(line, delimiter).map((cell) => cell.trim()));
  const width = Math.max(...grid.map((row) => row.length));

  // A first row with no numbers in it is a header. One with numbers is data.
  const first = grid[0];
  const headerLooksLikeData = first.some((cell) => cell !== '' && looksNumeric(cell));
  const columns = headerLooksLikeData
    ? Array.from({ length: width }, (_, index) => `Column ${index + 1}`)
    : padTo(first, width).map((cell, index) => cell || `Column ${index + 1}`);
  const body = headerLooksLikeData ? grid : grid.slice(1);

  return {
    columns,
    rows: body.map((row) => padTo(row, width).map(parseCell)),
  };
}

function padTo<T>(row: T[], width: number): (T | string)[] {
  return row.length >= width ? row.slice(0, width) : [...row, ...Array(width - row.length).fill('')];
}

export function looksNumeric(text: string): boolean {
  const cleaned = text.replace(/[,\s$£€%]/g, '');
  return cleaned !== '' && Number.isFinite(Number(cleaned));
}

function parseCell(raw: string): string | number | null {
  const text = String(raw).trim();
  if (text === '') return null;
  if (looksNumeric(text)) {
    const cleaned = text.replace(/[,\s$£€]/g, '');
    // A trailing percent sign is kept as the number people typed, not as a
    // fraction, because that is what they expect to see on the axis.
    return Number(cleaned.replace('%', ''));
  }
  return text;
}

export function columnKind(table: Table, index: number): ColumnKind {
  let numbers = 0;
  let filled = 0;
  for (const row of table.rows) {
    const cell = row[index];
    if (cell === null || cell === '') continue;
    filled += 1;
    if (typeof cell === 'number') numbers += 1;
  }
  if (filled === 0) return 'empty';
  return numbers / filled >= 0.8 ? 'number' : 'text';
}

export function numericColumns(table: Table): number[] {
  return table.columns.map((_, index) => index).filter((index) => columnKind(table, index) === 'number');
}

export function labelColumns(table: Table): number[] {
  return table.columns.map((_, index) => index).filter((index) => columnKind(table, index) !== 'number');
}

/** Guesses a sensible starting chart: first text column for labels, rest for series. */
export function suggestFields(table: Table): { label: number; series: number[] } {
  const numbers = numericColumns(table);
  const labels = labelColumns(table);
  const label = labels.length ? labels[0] : -1;
  return { label, series: numbers.slice(0, 4) };
}

export function columnValues(table: Table, index: number): number[] {
  return table.rows.map((row) => {
    const cell = row[index];
    return typeof cell === 'number' ? cell : NaN;
  });
}

export function columnLabels(table: Table, index: number): string[] {
  if (index < 0) return table.rows.map((_, row) => String(row + 1));
  return table.rows.map((row) => {
    const cell = row[index];
    return cell === null ? '' : String(cell);
  });
}

export const SAMPLE_DATA = `Quarter,Cloud,On premise,Support
Q1 2025,412,318,96
Q2 2025,468,301,104
Q3 2025,530,287,111
Q4 2025,611,265,118
Q1 2026,702,244,127
Q2 2026,798,229,133`;
