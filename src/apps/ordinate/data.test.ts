import { describe, expect, it } from 'vitest';
import {
  columnKind, columnLabels, columnValues, detectDelimiter, labelColumns, looksNumeric,
  numericColumns, parseDelimited, parseInput, SAMPLE_DATA, splitRow, suggestFields,
} from './data';

describe('splitRow', () => {
  it('splits on the delimiter', () => {
    expect(splitRow('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a delimiter that sits inside quotes', () => {
    expect(splitRow('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });

  it('turns a doubled quote into one quote', () => {
    expect(splitRow('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('preserves empty cells', () => {
    expect(splitRow('a,,c', ',')).toEqual(['a', '', 'c']);
  });
});

describe('detectDelimiter', () => {
  it('finds tabs in pasted spreadsheet data', () => {
    expect(detectDelimiter(['a\tb\tc', '1\t2\t3'])).toBe('\t');
  });

  it('finds semicolons', () => {
    expect(detectDelimiter(['a;b;c', '1;2;3'])).toBe(';');
  });

  it('prefers the delimiter that splits every row the same way', () => {
    // Commas appear inside the values but only pipes split consistently.
    expect(detectDelimiter(['name|note', 'a|one, two', 'b|three, four, five'])).toBe('|');
  });

  it('falls back to a comma when nothing splits', () => {
    expect(detectDelimiter(['single', 'column'])).toBe(',');
  });
});

describe('parseDelimited', () => {
  it('reads a header row and typed cells', () => {
    const table = parseDelimited(SAMPLE_DATA);
    expect(table.columns).toEqual(['Quarter', 'Cloud', 'On premise', 'Support']);
    expect(table.rows).toHaveLength(6);
    expect(table.rows[0]).toEqual(['Q1 2025', 412, 318, 96]);
  });

  it('invents column names when the first row is already data', () => {
    const table = parseDelimited('1,2\n3,4');
    expect(table.columns).toEqual(['Column 1', 'Column 2']);
    expect(table.rows).toHaveLength(2);
  });

  it('strips currency symbols and thousands separators', () => {
    const table = parseDelimited('label,amount\na,"$1,200.50"');
    expect(table.rows[0][1]).toBe(1200.5);
  });

  it('keeps a percentage as the number that was typed', () => {
    const table = parseDelimited('label,share\na,45%');
    expect(table.rows[0][1]).toBe(45);
  });

  it('pads short rows so every row is the same width', () => {
    const table = parseDelimited('a,b,c\n1,2');
    expect(table.rows[0]).toHaveLength(3);
    expect(table.rows[0][2]).toBeNull();
  });

  it('names an unlabelled header cell', () => {
    const table = parseDelimited('name,,other\na,b,c');
    expect(table.columns[1]).toBe('Column 2');
  });
});

describe('parseInput with JSON', () => {
  it('reads an array of objects, gathering every key', () => {
    const table = parseInput('[{"a":1,"b":2},{"a":3,"c":4}]');
    expect(table.columns).toEqual(['a', 'b', 'c']);
    expect(table.rows[1]).toEqual([3, null, 4]);
  });

  it('reads an array of arrays with a header row', () => {
    const table = parseInput('[["x","y"],[1,2],[3,4]]');
    expect(table.columns).toEqual(['x', 'y']);
    expect(table.rows).toEqual([[1, 2], [3, 4]]);
  });

  it('treats an all-numeric first row as data, not a header', () => {
    const table = parseInput('[[1,2],[3,4]]');
    expect(table.columns).toEqual(['Column 1', 'Column 2']);
    expect(table.rows).toHaveLength(2);
  });

  it('turns a bare list of numbers into one column', () => {
    const table = parseInput('[10, 20, 30]');
    expect(table.columns).toEqual(['Value']);
    expect(table.rows).toEqual([[10], [20], [30]]);
  });

  it('treats a single object as one row', () => {
    const table = parseInput('{"a":1,"b":2}');
    expect(table.rows).toEqual([[1, 2]]);
  });

  it('falls back to delimited parsing when the JSON is broken', () => {
    const table = parseInput('[broken\na,b');
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it('flattens a nested value rather than dropping it', () => {
    const table = parseInput('[{"a":{"deep":1}}]');
    expect(table.rows[0][0]).toBe('{"deep":1}');
  });

  it('returns an empty table for empty input', () => {
    expect(parseInput('   ')).toEqual({ columns: [], rows: [] });
    expect(parseInput('[]')).toEqual({ columns: [], rows: [] });
  });
});

describe('column typing', () => {
  const table = parseDelimited(SAMPLE_DATA);

  it('separates the label column from the number columns', () => {
    expect(columnKind(table, 0)).toBe('text');
    expect(columnKind(table, 1)).toBe('number');
    expect(numericColumns(table)).toEqual([1, 2, 3]);
    expect(labelColumns(table)).toEqual([0]);
  });

  it('still calls a column numeric when a few cells are not', () => {
    const mixed = parseDelimited('a\n1\n2\n3\n4\n5\n6\n7\n8\n9\nn/a');
    expect(columnKind(mixed, 0)).toBe('number');
  });

  it('calls a column text once a fifth of it is not numeric', () => {
    const mixed = parseDelimited('a\n1\n2\nx\ny');
    expect(columnKind(mixed, 0)).toBe('text');
  });

  it('reports an all-blank column as empty', () => {
    const blanks = parseDelimited('a,b\n1,\n2,');
    expect(columnKind(blanks, 1)).toBe('empty');
  });
});

describe('suggestFields', () => {
  it('picks the first text column for labels and the numbers for series', () => {
    expect(suggestFields(parseDelimited(SAMPLE_DATA))).toEqual({ label: 0, series: [1, 2, 3] });
  });

  it('caps the suggestion at four series', () => {
    const wide = parseDelimited(`l,${'abcdef'.split('').join(',')}\nx,1,2,3,4,5,6`);
    expect(suggestFields(wide).series).toHaveLength(4);
  });

  it('reports no label column when everything is numeric', () => {
    expect(suggestFields(parseDelimited('1,2\n3,4')).label).toBe(-1);
  });
});

describe('column access', () => {
  const table = parseDelimited(SAMPLE_DATA);

  it('reads a numeric column as numbers', () => {
    expect(columnValues(table, 1)).toEqual([412, 468, 530, 611, 702, 798]);
  });

  it('turns a non-numeric cell into NaN rather than zero', () => {
    const mixed = parseDelimited('a\n1\nx');
    expect(Number.isNaN(columnValues(mixed, 0)[1])).toBe(true);
  });

  it('numbers the rows when there is no label column', () => {
    expect(columnLabels(table, -1)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('reads a label column as text', () => {
    expect(columnLabels(table, 0)[0]).toBe('Q1 2025');
  });
});

describe('looksNumeric', () => {
  it('accepts numbers people actually type', () => {
    expect(looksNumeric('1,200')).toBe(true);
    expect(looksNumeric('$40')).toBe(true);
    expect(looksNumeric('-3.5')).toBe(true);
    expect(looksNumeric('1e4')).toBe(true);
  });

  it('rejects text', () => {
    expect(looksNumeric('')).toBe(false);
    expect(looksNumeric('Q1')).toBe(false);
    expect(looksNumeric('n/a')).toBe(false);
  });
});
