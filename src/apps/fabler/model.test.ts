import { describe, expect, it } from 'vitest';
import { Rng } from '../../lib/random';
import { generateValue, isKeyKind, type Field } from './generators';
import {
  MAX_ROWS, createField, createTable, extensionFor, generate, orderTables, reconcile,
  render, reviveField, reviveTable, starterDataset, toCsv, toDdl, toNdjson, toSqlInserts,
  type Dataset, type Table,
} from './model';

const field = (over: Partial<Field> = {}): Field => ({ ...createField('x', 'word'), ...over });
const context = (seed = 'test', rowIndex = 0) => ({ rng: new Rng(seed), rowIndex, keys: new Map() });

describe('generateValue', () => {
  it('numbers sequential ids from one', () => {
    expect(generateValue(field({ kind: 'id' }), context('a', 0))).toBe(1);
    expect(generateValue(field({ kind: 'id' }), context('a', 41))).toBe(42);
  });

  it('produces a well formed UUID', () => {
    const value = generateValue(field({ kind: 'uuid' }), context());
    expect(String(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produces an email with one at sign', () => {
    const value = String(generateValue(field({ kind: 'email' }), context()));
    expect(value.split('@')).toHaveLength(2);
    expect(value).toMatch(/@[a-z.]+$/);
  });

  it('respects integer bounds', () => {
    for (let i = 0; i < 200; i += 1) {
      const value = generateValue(field({ kind: 'integer', min: 5, max: 9 }), context(`s${i}`)) as number;
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(9);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('respects decimal places', () => {
    for (let i = 0; i < 50; i += 1) {
      const value = generateValue(field({ kind: 'decimal', min: 0, max: 10, decimals: 3 }), context(`d${i}`)) as number;
      expect(Number(value.toFixed(3))).toBe(value);
    }
  });

  it('produces an ISO date and timestamp', () => {
    expect(String(generateValue(field({ kind: 'date' }), context()))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(generateValue(field({ kind: 'datetime' }), context()))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('produces a valid IPv4 address', () => {
    const value = String(generateValue(field({ kind: 'ipv4' }), context()));
    const octets = value.split('.').map(Number);
    expect(octets).toHaveLength(4);
    for (const octet of octets) { expect(octet).toBeGreaterThanOrEqual(0); expect(octet).toBeLessThanOrEqual(255); }
  });

  it('produces a six digit hex colour', () => {
    expect(String(generateValue(field({ kind: 'hexColor' }), context()))).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('produces a MAC address', () => {
    expect(String(generateValue(field({ kind: 'macAddress' }), context()))).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  });

  it('picks from an enum list', () => {
    const value = generateValue(field({ kind: 'enum', options: 'red, green, blue' }), context());
    expect(['red', 'green', 'blue']).toContain(value);
  });

  it('returns null for an enum with no options', () => {
    expect(generateValue(field({ kind: 'enum', options: '' }), context())).toBeNull();
  });

  it('returns the constant every time', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(generateValue(field({ kind: 'constant', options: 'fixed' }), context(`c${i}`))).toBe('fixed');
    }
  });

  it('honours the null rate', () => {
    let nulls = 0;
    const rng = new Rng('nulls');
    for (let i = 0; i < 4000; i += 1) {
      if (generateValue(field({ kind: 'word', nullRate: 0.3 }), { rng, rowIndex: i, keys: new Map() }) === null) nulls += 1;
    }
    expect(nulls / 4000).toBeGreaterThan(0.25);
    expect(nulls / 4000).toBeLessThan(0.35);
  });

  it('never returns null when the rate is zero', () => {
    const rng = new Rng('nonull');
    for (let i = 0; i < 500; i += 1) {
      expect(generateValue(field({ kind: 'word', nullRate: 0 }), { rng, rowIndex: i, keys: new Map() })).not.toBeNull();
    }
  });

  it('draws a foreign key from the pool it references', () => {
    const keys = new Map([['customers', [1, 2, 3]]]);
    const value = generateValue(field({ kind: 'foreignKey', references: 'customers' }), { rng: new Rng('fk'), rowIndex: 0, keys });
    expect([1, 2, 3]).toContain(value);
  });

  it('returns null when the referenced table has no rows', () => {
    expect(generateValue(field({ kind: 'foreignKey', references: 'missing' }), context())).toBeNull();
  });

  it('knows which kinds can be referenced', () => {
    expect(isKeyKind('id')).toBe(true);
    expect(isKeyKind('uuid')).toBe(true);
    expect(isKeyKind('email')).toBe(false);
  });
});

describe('reproducibility', () => {
  it('gives identical rows for the same seed', () => {
    const dataset = starterDataset();
    expect(generate(dataset)).toEqual(generate(dataset));
  });

  it('gives different rows for a different seed', () => {
    const a = generate({ ...starterDataset(), seed: 'one' });
    const b = generate({ ...starterDataset(), seed: 'two' });
    expect(a[0].rows[0]).not.toEqual(b[0].rows[0]);
  });

  it('does not disturb one table when another changes', () => {
    const dataset = starterDataset();
    const before = generate(dataset).find((entry) => entry.table.name === 'customers')!.rows;

    const withExtra: Dataset = {
      ...dataset,
      tables: [...dataset.tables, { ...createTable('extra'), name: 'extra' }],
    };
    const after = generate(withExtra).find((entry) => entry.table.name === 'customers')!.rows;
    expect(after).toEqual(before);
  });
});

describe('referential integrity', () => {
  it('only emits foreign keys that exist in the parent table', () => {
    const generated = generate(starterDataset());
    const customers = generated.find((entry) => entry.table.name === 'customers')!;
    const orders = generated.find((entry) => entry.table.name === 'orders')!;
    const ids = new Set(customers.rows.map((row) => row.id));

    expect(orders.rows.length).toBeGreaterThan(0);
    for (const row of orders.rows) {
      expect(row.customer_id).not.toBeNull();
      expect(ids.has(row.customer_id)).toBe(true);
    }
  });

  it('orders a child table after its parent', () => {
    const parent: Table = { ...createTable('parent'), name: 'parent' };
    const child: Table = {
      ...createTable('child'),
      name: 'child',
      fields: [createField('id', 'id'), { ...createField('parent_id', 'foreignKey'), references: 'parent' }],
    };
    // Declared child first, so the ordering has to move it.
    expect(orderTables([child, parent]).map((table) => table.name)).toEqual(['parent', 'child']);
  });

  it('does not hang on a cycle between two tables', () => {
    const a: Table = { ...createTable('a'), name: 'a', fields: [createField('id', 'id'), { ...createField('b_id', 'foreignKey'), references: 'b' }] };
    const b: Table = { ...createTable('b'), name: 'b', fields: [createField('id', 'id'), { ...createField('a_id', 'foreignKey'), references: 'a' }] };
    expect(orderTables([a, b])).toHaveLength(2);
  });

  it('returns tables in the order the user arranged them', () => {
    const generated = generate(starterDataset());
    expect(generated.map((entry) => entry.table.name)).toEqual(['customers', 'orders']);
  });
});

describe('row counts', () => {
  it('generates the requested number', () => {
    const dataset: Dataset = { seed: 'x', tables: [{ ...createTable('t'), name: 't', rows: 7 }] };
    expect(generate(dataset)[0].rows).toHaveLength(7);
  });

  it('handles zero rows', () => {
    const dataset: Dataset = { seed: 'x', tables: [{ ...createTable('t'), name: 't', rows: 0 }] };
    expect(generate(dataset)[0].rows).toEqual([]);
  });

  it('caps at the maximum', () => {
    expect(reviveTable({ name: 't', rows: 9_000_000 })?.rows).toBe(MAX_ROWS);
  });
});

describe('output', () => {
  const dataset: Dataset = {
    seed: 'out',
    tables: [{
      id: 't1', name: 'people', rows: 3,
      fields: [createField('id', 'id'), { ...createField('name', 'fullName') }, { ...createField('note', 'sentence'), nullRate: 1 }],
    }],
  };
  const generated = generate(dataset);
  const rows = generated[0].rows;

  it('writes CSV with a header and empty cells for null', () => {
    const csv = toCsv(rows, dataset.tables[0].fields);
    expect(csv.split('\n')[0]).toBe('id,name,note');
    expect(csv.split('\n')[1].endsWith(',')).toBe(true);
  });

  it('quotes CSV values containing a comma', () => {
    const csv = toCsv([{ a: 'one, two' }], [createField('a', 'word')]);
    expect(csv).toContain('"one, two"');
  });

  it('writes one JSON object per NDJSON line', () => {
    const lines = toNdjson(rows).split('\n');
    expect(lines).toHaveLength(3);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('writes SQL inserts with escaped quotes and NULL', () => {
    const sql = toSqlInserts([{ id: 1, name: "O'Brien", note: null }], dataset.tables[0]);
    expect(sql).toContain('INSERT INTO people (id, name, note) VALUES');
    expect(sql).toContain("'O''Brien'");
    expect(sql).toContain('NULL');
  });

  it('batches long insert statements', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: i, name: 'x', note: null }));
    expect(toSqlInserts(many, dataset.tables[0]).match(/INSERT INTO/g)).toHaveLength(3);
  });

  it('writes DDL with a primary key and a foreign key', () => {
    const ddl = toDdl({
      id: 't', name: 'orders', rows: 1,
      fields: [createField('id', 'id'), { ...createField('customer_id', 'foreignKey'), references: 'customers' }],
    });
    expect(ddl).toContain('CREATE TABLE orders');
    expect(ddl).toContain('id BIGINT PRIMARY KEY');
    expect(ddl).toContain('FOREIGN KEY (customer_id) REFERENCES customers (id)');
  });

  it('quotes an identifier that needs it', () => {
    expect(toDdl({ id: 't', name: 'my table', rows: 1, fields: [createField('id', 'id')] })).toContain('"my table"');
  });

  it('bundles several tables into one JSON object', () => {
    const bundle = JSON.parse(render(generate(starterDataset()), 'json'));
    expect(Object.keys(bundle)).toEqual(['customers', 'orders']);
  });

  it('returns a bare array for a single table', () => {
    expect(Array.isArray(JSON.parse(render(generated, 'json')))).toBe(true);
  });

  it('maps formats to file extensions', () => {
    expect(extensionFor('sql')).toBe('sql');
    expect(extensionFor('ddl')).toBe('sql');
    expect(extensionFor('ndjson')).toBe('ndjson');
    expect(extensionFor('csv')).toBe('csv');
  });
});

describe('reviving imported schemas', () => {
  it('rejects a field with no name', () => {
    expect(reviveField({ kind: 'word' })).toBeNull();
  });

  it('falls back for an unknown kind', () => {
    expect(reviveField({ name: 'a', kind: 'telepathy' })?.kind).toBe('word');
  });

  it('clamps a nonsense null rate', () => {
    expect(reviveField({ name: 'a', nullRate: 5 })?.nullRate).toBe(0);
    expect(reviveField({ name: 'a', nullRate: 0.4 })?.nullRate).toBe(0.4);
  });

  it('gives a table with no fields something to generate', () => {
    expect(reviveTable({ name: 't', fields: [] })?.fields).toHaveLength(1);
  });

  it('drops a reference to a table that is gone', () => {
    const tables = reconcile([{
      id: 't', name: 'orders', rows: 1,
      fields: [{ ...createField('customer_id', 'foreignKey'), references: 'vanished' }],
    }]);
    expect(tables[0].fields[0].references).toBeUndefined();
  });

  it('keeps a reference that resolves', () => {
    const tables = reconcile([
      { id: 'a', name: 'customers', rows: 1, fields: [createField('id', 'id')] },
      { id: 'b', name: 'orders', rows: 1, fields: [{ ...createField('customer_id', 'foreignKey'), references: 'customers' }] },
    ]);
    expect(tables[1].fields[0].references).toBe('customers');
  });
});

describe('starterDataset', () => {
  it('demonstrates a relationship out of the box', () => {
    const dataset = starterDataset();
    expect(dataset.tables).toHaveLength(2);
    const foreignKey = dataset.tables[1].fields.find((f) => f.kind === 'foreignKey');
    expect(foreignKey?.references).toBe('customers');
  });
});
