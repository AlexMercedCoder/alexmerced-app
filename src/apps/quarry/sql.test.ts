import { describe, expect, it } from 'vitest';
import {
  displayValue, formatCount, formatDuration, formatOf, isNumericType, quoteIdentifier,
  quoteLiteral, registerStatement, splitStatements, statementKind, stripComments, tableNameFrom,
  toCsv, toJson, toMarkdown, uniqueTableName,
} from './sql';

describe('splitStatements', () => {
  it('splits on semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not need a trailing semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('ignores blank statements between semicolons', () => {
    expect(splitStatements('SELECT 1;;  ;SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a semicolon inside a string literal', () => {
    expect(splitStatements("SELECT 'a;b' AS x; SELECT 2")).toEqual(["SELECT 'a;b' AS x", 'SELECT 2']);
  });

  it('keeps a semicolon inside a quoted identifier', () => {
    expect(splitStatements('SELECT "odd;name" FROM t')).toEqual(['SELECT "odd;name" FROM t']);
  });

  it('handles a doubled quote inside a string', () => {
    expect(splitStatements("SELECT 'it''s here; really' AS x")).toEqual(["SELECT 'it''s here; really' AS x"]);
  });

  it('handles a backslash escaped quote', () => {
    expect(splitStatements("SELECT 'a\\'b; c' AS x")).toHaveLength(1);
  });

  it('keeps a semicolon inside a line comment', () => {
    const script = 'SELECT 1 -- a comment; not a split\n; SELECT 2';
    expect(splitStatements(script)).toHaveLength(2);
    expect(splitStatements(script)[0]).toContain('not a split');
  });

  it('keeps a semicolon inside a block comment', () => {
    expect(splitStatements('SELECT 1 /* one; two */ ; SELECT 2')).toHaveLength(2);
  });

  it('handles nested block comments', () => {
    expect(splitStatements('SELECT 1 /* outer /* inner; */ still; */ ; SELECT 2')).toHaveLength(2);
  });

  it('keeps a semicolon inside a dollar quoted block', () => {
    expect(splitStatements('SELECT $$a; b$$ AS x; SELECT 2')).toEqual(['SELECT $$a; b$$ AS x', 'SELECT 2']);
  });

  it('respects a tagged dollar quote', () => {
    expect(splitStatements('SELECT $tag$a; $$ b$tag$ AS x')).toHaveLength(1);
  });

  it('does not choke on an unterminated string', () => {
    expect(splitStatements("SELECT 'unfinished")).toHaveLength(1);
  });

  it('does not choke on an unterminated comment', () => {
    expect(splitStatements('SELECT 1 /* forever')).toHaveLength(1);
  });

  it('returns nothing for an empty script', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   \n  ')).toEqual([]);
  });

  it('leaves a lone dollar sign alone', () => {
    expect(splitStatements("SELECT '$' AS money; SELECT 2")).toHaveLength(2);
  });
});

describe('statementKind', () => {
  it('recognises statements that give back rows', () => {
    for (const sql of ['SELECT 1', 'select 1', 'WITH a AS (SELECT 1) SELECT * FROM a', 'VALUES (1)',
      'DESCRIBE t', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'SUMMARIZE t', 'FROM t SELECT *']) {
      expect(statementKind(sql), sql).toBe('query');
    }
  });

  it('recognises statements that only change things', () => {
    for (const sql of ['CREATE TABLE t (a INT)', 'INSERT INTO t VALUES (1)', 'DROP TABLE t',
      'UPDATE t SET a = 1', 'DELETE FROM t', 'SET threads = 2', 'PRAGMA version']) {
      expect(statementKind(sql), sql).toBe('command');
    }
  });

  it('sees past a leading comment', () => {
    expect(statementKind('-- get the rows\nSELECT 1')).toBe('query');
    expect(statementKind('/* header */ SELECT 1')).toBe('query');
  });

  it('sees past leading parentheses', () => {
    expect(statementKind('(SELECT 1) UNION (SELECT 2)')).toBe('query');
  });

  it('reports an empty statement', () => {
    expect(statementKind('')).toBe('empty');
    expect(statementKind('-- nothing but a comment')).toBe('empty');
  });
});

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments('SELECT 1 -- note\nFROM t').trim()).toBe('SELECT 1 \nFROM t'.trim());
    expect(stripComments('SELECT /* mid */ 1')).toContain('SELECT');
    expect(stripComments('SELECT /* mid */ 1')).not.toContain('mid');
  });

  it('leaves comment characters inside strings alone', () => {
    expect(stripComments("SELECT '-- not a comment'")).toContain('-- not a comment');
  });
});

describe('tableNameFrom', () => {
  it('drops the extension and tidies separators', () => {
    expect(tableNameFrom('Taxi Trips 2026.csv')).toBe('taxi_trips_2026');
    expect(tableNameFrom('sales-by-region.parquet')).toBe('sales_by_region');
  });

  it('handles a compressed file', () => {
    expect(tableNameFrom('events.json.gz')).toBe('events');
  });

  it('never starts with a digit', () => {
    expect(tableNameFrom('2026-report.csv')).toBe('t_2026_report');
  });

  it('avoids colliding with a keyword', () => {
    expect(tableNameFrom('order.csv')).toBe('order_');
    expect(tableNameFrom('select.parquet')).toBe('select_');
  });

  it('falls back when nothing usable is left', () => {
    expect(tableNameFrom('---.csv')).toBe('data');
    expect(tableNameFrom('')).toBe('data');
  });

  it('keeps the name short enough for an identifier', () => {
    expect(tableNameFrom(`${'a'.repeat(200)}.csv`).length).toBeLessThanOrEqual(63);
  });

  it('numbers a collision rather than overwriting', () => {
    expect(uniqueTableName('trips', ['other'])).toBe('trips');
    expect(uniqueTableName('trips', ['trips'])).toBe('trips_2');
    expect(uniqueTableName('trips', ['trips', 'trips_2'])).toBe('trips_3');
  });
});

describe('quoting', () => {
  it('doubles a quote inside an identifier', () => {
    expect(quoteIdentifier('odd"name')).toBe('"odd""name"');
  });

  it('doubles a quote inside a literal', () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });

  it('makes an injection attempt inert', () => {
    // A file called this would otherwise close the string and run a command.
    const nasty = "x'; DROP TABLE t; --";
    expect(quoteLiteral(nasty)).toBe("'x''; DROP TABLE t; --'");
    expect(splitStatements(`SELECT ${quoteLiteral(nasty)}`)).toHaveLength(1);
  });
});

describe('formatOf and registerStatement', () => {
  it('recognises the formats it can read', () => {
    expect(formatOf('a.csv')).toBe('csv');
    expect(formatOf('a.TSV')).toBe('csv');
    expect(formatOf('a.csv.gz')).toBe('csv');
    expect(formatOf('a.ndjson')).toBe('json');
    expect(formatOf('a.parquet')).toBe('parquet');
    expect(formatOf('a.arrow')).toBe('arrow');
    expect(formatOf('a.docx')).toBe('unknown');
  });

  it('builds a view over each format', () => {
    expect(registerStatement('t', 'a.csv', 'csv')).toContain('read_csv_auto');
    expect(registerStatement('t', 'a.json', 'json')).toContain('read_json_auto');
    expect(registerStatement('t', 'a.parquet', 'parquet')).toContain('read_parquet');
    expect(registerStatement('t', 'a.arrow', 'arrow')).toBe('');
  });

  it('quotes both the table name and the path', () => {
    const sql = registerStatement('odd name', "it's.csv", 'csv');
    expect(sql).toContain('"odd name"');
    expect(sql).toContain("'it''s.csv'");
  });
});

describe('displayValue', () => {
  it('shows nothing for null and undefined', () => {
    expect(displayValue(null)).toBe('');
    expect(displayValue(undefined)).toBe('');
  });

  it('prints a bigint in full rather than losing precision', () => {
    expect(displayValue(9007199254740993n)).toBe('9007199254740993');
  });

  it('prints numbers, including the awkward ones', () => {
    expect(displayValue(42)).toBe('42');
    expect(displayValue(-0.5)).toBe('-0.5');
    expect(displayValue(NaN)).toBe('NaN');
    expect(displayValue(Infinity)).toBe('Infinity');
  });

  it('prints booleans as words', () => {
    expect(displayValue(true)).toBe('true');
    expect(displayValue(false)).toBe('false');
  });

  it('prints a date without the T and Z', () => {
    expect(displayValue(new Date('2026-03-04T05:06:07Z'))).toBe('2026-03-04 05:06:07.000');
  });

  it('shows a blob as hex, truncated', () => {
    expect(displayValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('\\xdeadbeef');
    expect(displayValue(new Uint8Array(40))).toContain('...');
  });

  it('prints a list', () => {
    expect(displayValue([1, 2, 3])).toBe('[1, 2, 3]');
    expect(displayValue([1n, null])).toBe('[1, ]');
  });

  it('uses toJSON when a value offers one, as Arrow structs do', () => {
    expect(displayValue({ toJSON: () => ({ a: 1 }) })).toBe('{"a":1}');
  });

  it('does not re-quote a toJSON that already gave back a string', () => {
    expect(displayValue({ toJSON: () => '305' })).toBe('305');
    expect(displayValue({ toJSON: () => 42 })).toBe('42');
    expect(displayValue({ toJSON: () => null })).toBe('');
  });

  it('unwraps a decimal, whose toJSON hands back a JSON-encoded string', () => {
    // This is exactly what Arrow's DecimalBigNum does: sum(amount) over a
    // BIGINT column comes back as the five characters "305", quotes included.
    expect(displayValue({ toJSON: () => '"305"' })).toBe('305');
    expect(displayValue({ toJSON: () => '"-1.25"' })).toBe('-1.25');
  });

  it('leaves a plain string from toJSON alone', () => {
    expect(displayValue({ toJSON: () => 'North' })).toBe('North');
  });

  it('uses toArray when a value offers one', () => {
    expect(displayValue({ toArray: () => [1, 2] })).toBe('[1, 2]');
  });

  it('falls back to JSON for a plain object', () => {
    expect(displayValue({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('survives a circular object rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => displayValue(circular)).not.toThrow();
  });

  it('survives a bigint nested inside an object', () => {
    expect(displayValue({ big: 1n })).toBe('{"big":"1"}');
  });
});

describe('isNumericType', () => {
  it('recognises the numeric types', () => {
    for (const type of ['INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'DECIMAL(10,2)', 'DOUBLE', 'FLOAT', 'REAL']) {
      expect(isNumericType(type), type).toBe(true);
    }
  });

  it('recognises the Arrow spellings, which are what the result schema carries', () => {
    for (const type of ['Int64', 'Int32', 'Uint8', 'Float64', 'Float32', 'Decimal128']) {
      expect(isNumericType(type), type).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const type of ['VARCHAR', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'BLOB', 'STRUCT(a INT)', 'Utf8', 'Bool', 'Date32', 'List<Int64>']) {
      expect(isNumericType(type), type).toBe(false);
    }
  });
});

describe('output formats', () => {
  const columns = ['name', 'count'];
  const rows: unknown[][] = [['Alice', 3n], ['Bob, Jr', 5]];

  it('writes CSV, quoting what needs it', () => {
    const csv = toCsv(columns, rows).split('\n');
    expect(csv[0]).toBe('name,count');
    expect(csv[1]).toBe('Alice,3');
    expect(csv[2]).toBe('"Bob, Jr",5');
  });

  it('doubles a quote inside a CSV value', () => {
    expect(toCsv(['a'], [['say "hi"']])).toContain('"say ""hi"""');
  });

  it('writes JSON with bigints as strings so it stays valid', () => {
    const parsed = JSON.parse(toJson(columns, rows));
    expect(parsed[0]).toEqual({ name: 'Alice', count: '3' });
    expect(parsed[1]).toEqual({ name: 'Bob, Jr', count: 5 });
  });

  it('writes JSON dates in ISO form', () => {
    const parsed = JSON.parse(toJson(['when'], [[new Date('2026-01-01T00:00:00Z')]]));
    expect(parsed[0].when).toBe('2026-01-01T00:00:00.000Z');
  });

  it('writes an aligned Markdown table', () => {
    const lines = toMarkdown(columns, rows).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^\| -+ \| -+ \|$/);
    // Every line is the same width once the columns are padded.
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it('handles no rows at all', () => {
    expect(toCsv(columns, [])).toBe('name,count');
    expect(JSON.parse(toJson(columns, []))).toEqual([]);
    expect(toMarkdown(columns, []).split('\n')).toHaveLength(2);
  });
});

describe('formatting', () => {
  it('reads durations the way a person would say them', () => {
    expect(formatDuration(0.2)).toBe('under a millisecond');
    expect(formatDuration(45.6)).toBe('46 ms');
    expect(formatDuration(2500)).toBe('2.50 s');
  });

  it('counts rows with a thousands separator', () => {
    expect(formatCount(1)).toBe('1 row');
    expect(formatCount(0)).toBe('0 rows');
    expect(formatCount(1234567)).toBe('1,234,567 rows');
  });
});
