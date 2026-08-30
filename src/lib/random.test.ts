import { describe, expect, it } from 'vitest';
import { Rng, hashSeed } from './random';

describe('hashSeed', () => {
  it('is stable for the same string', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
  });

  it('differs for different strings', () => {
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
  });
});

describe('Rng', () => {
  it('gives the same sequence for the same seed', () => {
    const a = new Rng('seed');
    const b = new Rng('seed');
    const first = Array.from({ length: 20 }, () => a.next());
    const second = Array.from({ length: 20 }, () => b.next());
    expect(first).toEqual(second);
  });

  it('gives a different sequence for a different seed', () => {
    const a = Array.from({ length: 10 }, (() => { const r = new Rng('one'); return () => r.next(); })());
    const b = Array.from({ length: 10 }, (() => { const r = new Rng('two'); return () => r.next(); })());
    expect(a).not.toEqual(b);
  });

  it('stays inside the unit interval', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const rng = new Rng('uniform');
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i += 1) buckets[Math.floor(rng.next() * 10)] += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(1500);
      expect(count).toBeLessThan(2500);
    }
  });

  it('produces integers inside the requested range, inclusive', () => {
    const rng = new Rng('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.int(3, 7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
  });

  it('handles an inverted range without looping forever', () => {
    expect(new Rng().int(10, 5)).toBe(10);
  });

  it('rounds floats to the requested precision', () => {
    const rng = new Rng('floats');
    for (let i = 0; i < 200; i += 1) {
      const value = rng.float(0, 100, 2);
      expect(Number(value.toFixed(2))).toBe(value);
    }
  });

  it('respects a boolean probability', () => {
    const rng = new Rng('bools');
    let trues = 0;
    for (let i = 0; i < 10000; i += 1) if (rng.bool(0.25)) trues += 1;
    expect(trues).toBeGreaterThan(2200);
    expect(trues).toBeLessThan(2800);
  });

  it('picks from a list', () => {
    const rng = new Rng('pick');
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i += 1) expect(items).toContain(rng.pick(items));
  });

  it('samples without replacement', () => {
    const items = [1, 2, 3, 4, 5];
    const sample = new Rng('sample').sample(items, 3);
    expect(sample).toHaveLength(3);
    expect(new Set(sample).size).toBe(3);
  });

  it('caps a sample at the size of the pool', () => {
    expect(new Rng().sample([1, 2], 10)).toHaveLength(2);
  });

  it('shuffles without losing or duplicating items', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = new Rng('shuffle').shuffle(items);
    expect(shuffled).toHaveLength(50);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(shuffled).not.toEqual(items);
  });

  it('returns a date inside the range', () => {
    const from = new Date('2020-01-01');
    const to = new Date('2026-01-01');
    const rng = new Rng('dates');
    for (let i = 0; i < 200; i += 1) {
      const value = rng.date(from, to);
      expect(value.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(value.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });

  it('honours weights', () => {
    const rng = new Rng('weighted');
    const counts: Record<string, number> = { common: 0, rare: 0 };
    for (let i = 0; i < 10000; i += 1) {
      counts[rng.weighted([{ value: 'common', weight: 9 }, { value: 'rare', weight: 1 }])] += 1;
    }
    expect(counts.common).toBeGreaterThan(counts.rare * 5);
  });
});
