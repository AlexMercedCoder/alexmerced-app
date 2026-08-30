import { describe, expect, it } from 'vitest';
import {
  ParseError, defaultCsvOptions, detectFormat, inferScalar, parse, parseCsv, parseCsvRows,
  parseJson, parseNdjson, parseToml, parseYaml, write, writeCsv, writeNdjson, writeToml, writeYaml,
  type Json,
} from './formats';
import {
  describe as describeData, flatten, inferSchema, inferType, query,
  toIcebergSchema, toJsonSchema, toSqlDdl, unflatten,
} from './transform';

describe('JSON', () => {
  it('parses and writes', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(write({ a: 1 }, 'json')).toBe('{\n  "a": 1\n}');
  });

  it('reports the line of a syntax error', () => {
    try { parseJson('{\n  "a": 1,\n  bad\n}'); expect.unreachable(); }
    catch (error) { expect((error as ParseError).message).toMatch(/Line \d+/); }
  });
});

describe('NDJSON', () => {
  it('reads one value per line', () => {
    expect(parseNdjson('{"a":1}\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips blank lines', () => {
    expect(parseNdjson('{"a":1}\n\n\n{"a":2}\n')).toHaveLength(2);
  });

  it('names the line that failed', () => {
    expect(() => parseNdjson('{"a":1}\nnot json')).toThrow(/Line 2/);
  });

  it('writes one line per record', () => {
    expect(writeNdjson([{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}');
  });

  it('round trips', () => {
    const text = '{"a":1,"b":"x"}\n{"a":2,"b":"y"}';
    expect(writeNdjson(parseNdjson(text))).toBe(text);
  });
});

describe('CSV', () => {
  it('reads quoted fields containing the delimiter', () => {
    expect(parseCsvRows('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('reads doubled quotes', () => {
    expect(parseCsvRows('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('reads embedded newlines', () => {
    expect(parseCsvRows('"one\ntwo",x')).toEqual([['one\ntwo', 'x']]);
  });

  it('honours a different delimiter', () => {
    expect(parseCsvRows('a\tb\tc', '\t')).toEqual([['a', 'b', 'c']]);
  });

  it('turns rows into objects using the header', () => {
    expect(parseCsv('name,age\nAlex,40')).toEqual([{ name: 'Alex', age: 40 }]);
  });

  it('infers types when asked', () => {
    expect(parseCsv('a,b,c,d\n1,1.5,true,')).toEqual([{ a: 1, b: 1.5, c: true, d: '' }]);
  });

  it('leaves everything as text when inference is off', () => {
    expect(parseCsv('a\n1', { ...defaultCsvOptions, inferTypes: false })).toEqual([{ a: '1' }]);
  });

  it('keeps leading zeros as text, since they identify rather than count', () => {
    expect(inferScalar('007')).toBe('007');
    expect(inferScalar('7')).toBe(7);
  });

  it('keeps a very long digit string as text rather than losing precision', () => {
    expect(inferScalar('12345678901234567890')).toBe('12345678901234567890');
  });

  it('returns arrays of arrays with no header', () => {
    expect(parseCsv('1,2\n3,4', { ...defaultCsvOptions, header: false })).toEqual([[1, 2], [3, 4]]);
  });

  it('names blank header columns', () => {
    expect(Object.keys((parseCsv('a,,c\n1,2,3') as Record<string, Json>[])[0])).toEqual(['a', 'column_2', 'c']);
  });

  it('writes a header and quotes what needs it', () => {
    const csv = writeCsv([{ name: 'Alex, A', note: 'say "hi"' }]);
    expect(csv.split('\n')[0]).toBe('name,note');
    expect(csv).toContain('"Alex, A"');
    expect(csv).toContain('"say ""hi"""');
  });

  it('unions the columns across records', () => {
    expect(writeCsv([{ a: 1 }, { b: 2 }]).split('\n')[0]).toBe('a,b');
  });

  it('round trips a simple table', () => {
    const original = 'name,age\nAlex,40\nSam,31';
    expect(writeCsv(parseCsv(original))).toBe(original);
  });
});

describe('YAML', () => {
  it('reads a flat map', () => {
    expect(parseYaml('name: Alex\nage: 40')).toEqual({ name: 'Alex', age: 40 });
  });

  it('reads nesting by indentation', () => {
    expect(parseYaml('server:\n  host: localhost\n  port: 8080'))
      .toEqual({ server: { host: 'localhost', port: 8080 } });
  });

  it('reads a list of scalars', () => {
    expect(parseYaml('items:\n  - one\n  - two')).toEqual({ items: ['one', 'two'] });
  });

  it('reads a list of maps', () => {
    expect(parseYaml('people:\n  - name: Alex\n    age: 40\n  - name: Sam\n    age: 31'))
      .toEqual({ people: [{ name: 'Alex', age: 40 }, { name: 'Sam', age: 31 }] });
  });

  it('reads the booleans YAML allows', () => {
    expect(parseYaml('a: true\nb: yes\nc: off\nd: no')).toEqual({ a: true, b: true, c: false, d: false });
  });

  it('reads null in its several spellings', () => {
    expect(parseYaml('a: null\nb: ~\nc:')).toEqual({ a: null, b: null, c: null });
  });

  it('strips comments but not hashes inside strings', () => {
    expect(parseYaml('a: 1 # a comment\nb: "has # inside"')).toEqual({ a: 1, b: 'has # inside' });
  });

  it('reads flow style', () => {
    expect(parseYaml('a: [1, 2, 3]\nb: {x: 1, y: 2}')).toEqual({ a: [1, 2, 3], b: { x: 1, y: 2 } });
  });

  it('ignores document markers', () => {
    expect(parseYaml('---\na: 1\n...')).toEqual({ a: 1 });
  });

  it('keeps a quoted number as text', () => {
    expect(parseYaml('version: "1.0"')).toEqual({ version: '1.0' });
  });

  it('writes a nested map back', () => {
    expect(writeYaml({ server: { host: 'localhost', port: 8080 } }))
      .toBe('server:\n  host: localhost\n  port: 8080');
  });

  it('writes a list', () => {
    expect(writeYaml({ items: ['one', 'two'] })).toBe('items:\n  - one\n  - two');
  });

  it('quotes strings that would otherwise read as another type', () => {
    expect(writeYaml({ a: 'true', b: '123', c: 'plain' })).toBe('a: "true"\nb: "123"\nc: plain');
  });

  it('round trips a realistic document', () => {
    const original = {
      name: 'my-service',
      replicas: 3,
      enabled: true,
      ports: [80, 443],
      env: { LOG_LEVEL: 'debug', REGION: 'us-east-1' },
      hosts: [{ name: 'a', weight: 1 }, { name: 'b', weight: 2 }],
    };
    expect(parseYaml(writeYaml(original))).toEqual(original);
  });
});

describe('TOML', () => {
  it('reads top level keys', () => {
    expect(parseToml('title = "My app"\nport = 8080')).toEqual({ title: 'My app', port: 8080 });
  });

  it('reads a table', () => {
    expect(parseToml('[server]\nhost = "localhost"\nport = 8080'))
      .toEqual({ server: { host: 'localhost', port: 8080 } });
  });

  it('reads a nested table', () => {
    expect(parseToml('[a.b.c]\nx = 1')).toEqual({ a: { b: { c: { x: 1 } } } });
  });

  it('reads an array of tables', () => {
    expect(parseToml('[[items]]\nname = "one"\n\n[[items]]\nname = "two"'))
      .toEqual({ items: [{ name: 'one' }, { name: 'two' }] });
  });

  it('reads arrays and inline tables', () => {
    expect(parseToml('ports = [80, 443]\npoint = { x = 1, y = 2 }'))
      .toEqual({ ports: [80, 443], point: { x: 1, y: 2 } });
  });

  it('reads booleans and floats', () => {
    expect(parseToml('a = true\nb = 1.5\nc = -3')).toEqual({ a: true, b: 1.5, c: -3 });
  });

  it('reads underscores in numbers', () => {
    expect(parseToml('big = 1_000_000')).toEqual({ big: 1000000 });
  });

  it('keeps a date as text rather than guessing at a type', () => {
    expect(parseToml('when = 2026-08-30')).toEqual({ when: '2026-08-30' });
  });

  it('strips comments outside strings', () => {
    expect(parseToml('a = 1 # comment\nb = "has # inside"')).toEqual({ a: 1, b: 'has # inside' });
  });

  it('refuses to write an array at the top level', () => {
    expect(() => writeToml([1, 2] as Json)).toThrow(/object at the top level/);
  });

  it('round trips a realistic document', () => {
    const original = {
      title: 'My app',
      port: 8080,
      debug: true,
      server: { host: 'localhost', threads: 4 },
      items: [{ name: 'one', size: 1 }, { name: 'two', size: 2 }],
    };
    expect(parseToml(writeToml(original))).toEqual(original);
  });
});

describe('conversion between formats', () => {
  const record = [{ id: 1, name: 'Alex', active: true }, { id: 2, name: 'Sam', active: false }];

  it('goes from JSON to every other format and back', () => {
    for (const format of ['json', 'ndjson', 'csv', 'yaml'] as const) {
      const text = write(record, format);
      expect(parse(text, format)).toEqual(record);
    }
  });

  it('carries a nested object from YAML to JSON', () => {
    const yaml = 'app:\n  name: test\n  tags:\n    - a\n    - b';
    expect(write(parse(yaml, 'yaml'), 'json')).toBe(JSON.stringify({ app: { name: 'test', tags: ['a', 'b'] } }, null, 2));
  });

  it('refuses an empty input with a readable message', () => {
    expect(() => parse('   ', 'json')).toThrow(/nothing to parse/);
  });
});

describe('detectFormat', () => {
  it('spots JSON', () => {
    expect(detectFormat('{"a": 1}')).toBe('json');
    expect(detectFormat('[1, 2, 3]')).toBe('json');
  });

  it('spots NDJSON', () => {
    expect(detectFormat('{"a":1}\n{"a":2}')).toBe('ndjson');
  });

  it('spots TOML by its tables', () => {
    expect(detectFormat('[server]\nhost = "x"')).toBe('toml');
  });

  it('spots YAML', () => {
    expect(detectFormat('name: Alex\nage: 40')).toBe('yaml');
    expect(detectFormat('- one\n- two')).toBe('yaml');
  });

  it('spots CSV', () => {
    expect(detectFormat('name,age\nAlex,40')).toBe('csv');
  });

  it('defaults to JSON for nothing', () => {
    expect(detectFormat('')).toBe('json');
  });
});

describe('flatten and unflatten', () => {
  it('flattens nesting to dotted keys', () => {
    expect(flatten({ a: { b: { c: 1 } } })).toEqual({ 'a.b.c': 1 });
  });

  it('flattens arrays by index', () => {
    expect(flatten({ items: [1, 2] })).toEqual({ 'items.0': 1, 'items.1': 2 });
  });

  it('keeps empty containers visible', () => {
    expect(flatten({ a: {}, b: [] })).toEqual({ a: {}, b: [] });
  });

  it('honours a custom separator', () => {
    expect(flatten({ a: { b: 1 } }, '__')).toEqual({ a__b: 1 });
  });

  it('rebuilds nesting', () => {
    expect(unflatten({ 'a.b.c': 1 })).toEqual({ a: { b: { c: 1 } } });
  });

  it('rebuilds arrays from index keys', () => {
    expect(unflatten({ 'items.0': 'a', 'items.1': 'b' })).toEqual({ items: ['a', 'b'] });
  });

  it('round trips', () => {
    const original = { a: 1, b: { c: [1, 2, { d: 'x' }] }, e: true };
    expect(unflatten(flatten(original))).toEqual(original);
  });
});

describe('query', () => {
  const data: Json = {
    store: {
      books: [
        { title: 'One', price: 10, tags: ['a'] },
        { title: 'Two', price: 20, tags: ['b', 'c'] },
      ],
      open: true,
    },
  };

  it('returns the root for $', () => {
    expect(query(data, '$')).toEqual([data]);
  });

  it('follows a dotted path', () => {
    expect(query(data, '$.store.open')).toEqual([true]);
  });

  it('indexes into an array', () => {
    expect(query(data, '$.store.books[0].title')).toEqual(['One']);
  });

  it('supports a negative index', () => {
    expect(query(data, '$.store.books[-1].title')).toEqual(['Two']);
  });

  it('expands a wildcard', () => {
    expect(query(data, '$.store.books[*].price')).toEqual([10, 20]);
  });

  it('slices', () => {
    expect(query(data, '$.store.books[0:1]')).toHaveLength(1);
  });

  it('supports bracketed names', () => {
    expect(query(data, "$['store']['open']")).toEqual([true]);
  });

  it('returns nothing for a path that does not exist', () => {
    expect(query(data, '$.nope.here')).toEqual([]);
  });

  it('reports an unclosed bracket', () => {
    expect(() => query(data, '$.store.books[0')).toThrow(/unclosed bracket/);
  });
});

describe('inferType', () => {
  it('separates integers from other numbers', () => {
    expect(inferType(1)).toBe('integer');
    expect(inferType(1.5)).toBe('number');
  });

  it('recognises dates and timestamps in strings', () => {
    expect(inferType('2026-08-30')).toBe('date');
    expect(inferType('2026-08-30T12:00:00Z')).toBe('timestamp');
    expect(inferType('not a date')).toBe('string');
  });

  it('handles containers and null', () => {
    expect(inferType([])).toBe('array');
    expect(inferType({})).toBe('object');
    expect(inferType(null)).toBe('null');
  });
});

describe('inferSchema', () => {
  const rows: Json = [
    { id: 1, name: 'Alex', joined: '2026-01-01', score: 9.5 },
    { id: 2, name: 'Sam', joined: '2026-02-01', score: 8 },
    { id: 3, name: null, joined: '2026-03-01' },
  ];

  it('lists fields in the order first seen', () => {
    expect(inferSchema(rows).map((field) => field.name)).toEqual(['id', 'name', 'joined', 'score']);
  });

  it('marks a field nullable when a value was null', () => {
    expect(inferSchema(rows).find((f) => f.name === 'name')?.nullable).toBe(true);
  });

  it('marks a field nullable when it was sometimes absent', () => {
    const score = inferSchema(rows).find((f) => f.name === 'score')!;
    expect(score.nullable).toBe(true);
    expect(score.presence).toBeCloseTo(2 / 3, 5);
  });

  it('detects a date column', () => {
    expect(inferSchema(rows).find((f) => f.name === 'joined')?.types).toEqual(['date']);
  });

  it('reports mixed integer and number as both', () => {
    expect(inferSchema(rows).find((f) => f.name === 'score')?.types.sort()).toEqual(['integer', 'number']);
  });

  it('collects examples', () => {
    expect(inferSchema(rows).find((f) => f.name === 'name')?.examples).toContain('Alex');
  });

  it('returns nothing for a value with no records', () => {
    expect(inferSchema([1, 2, 3])).toEqual([]);
  });
});

describe('schema output', () => {
  const fields = inferSchema([
    { id: 1, name: 'Alex', active: true, joined: '2026-01-01', score: 1.5 },
    { id: 2, name: 'Sam', active: false, joined: '2026-02-01', score: 2.5 },
  ]);

  it('writes SQL DDL with sensible types', () => {
    const ddl = toSqlDdl(fields, 'people');
    expect(ddl).toContain('CREATE TABLE people');
    expect(ddl).toContain('id BIGINT NOT NULL');
    expect(ddl).toContain('active BOOLEAN');
    expect(ddl).toContain('joined DATE');
    expect(ddl).toContain('score DOUBLE');
    expect(ddl).toMatch(/name VARCHAR\(\d+\)/);
  });

  it('quotes a column name that needs it', () => {
    const odd = inferSchema([{ 'first name': 'x' }]);
    expect(toSqlDdl(odd)).toContain('"first name"');
  });

  it('quotes a reserved word, which would otherwise not run', () => {
    const reserved = inferSchema([{ when: '2026-01-01', order: 1, select: 'x' }]);
    const ddl = toSqlDdl(reserved);
    expect(ddl).toContain('"when"');
    expect(ddl).toContain('"order"');
    expect(ddl).toContain('"select"');
  });

  it('writes an Iceberg schema with ids and required flags', () => {
    const schema = JSON.parse(toIcebergSchema(fields));
    expect(schema.type).toBe('struct');
    expect(schema.fields[0]).toMatchObject({ id: 1, name: 'id', required: true, type: 'long' });
    expect(schema.fields.find((f: { name: string }) => f.name === 'joined').type).toBe('date');
  });

  it('writes a JSON Schema with formats', () => {
    const schema = JSON.parse(toJsonSchema(fields, 'Person'));
    expect(schema.title).toBe('Person');
    expect(schema.properties.joined.format).toBe('date');
    expect(schema.required).toContain('id');
  });

  it('says so when there is nothing to describe', () => {
    expect(toSqlDdl([])).toContain('No records');
  });
});

describe('describe', () => {
  it('counts records, fields and depth', () => {
    const value: Json = [{ a: { b: 1 } }, { a: { b: 2 } }];
    const stats = describeData(value, JSON.stringify(value));
    expect(stats.records).toBe(2);
    expect(stats.fields).toBe(2);
    expect(stats.depth).toBe(3);
    expect(stats.bytes).toBeGreaterThan(0);
  });
});
