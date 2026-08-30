import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_FORMAT,
  ImportError,
  createEnvelope,
  exportFilename,
  mergeById,
  mergeByNewest,
  parseEnvelope,
  readEnvelope,
} from './portable';

describe('createEnvelope', () => {
  it('stamps the format, app, and counts', () => {
    const envelope = createEnvelope('warren', 2, { pages: [] }, { pages: 0 }, new Date('2026-01-02T03:04:05Z'));
    expect(envelope.format).toBe(ENVELOPE_FORMAT);
    expect(envelope.version).toBe(1);
    expect(envelope.app).toBe('warren');
    expect(envelope.appVersion).toBe(2);
    expect(envelope.exportedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(envelope.counts).toEqual({ pages: 0 });
  });
});

describe('readEnvelope', () => {
  const good = createEnvelope('laneway', 1, { boards: [] }, { boards: 0 });

  it('accepts a well formed envelope', () => {
    expect(readEnvelope(good, 'laneway').app).toBe('laneway');
  });

  it('rejects a non-object', () => {
    expect(() => readEnvelope('nope', 'laneway')).toThrow(ImportError);
    expect(() => readEnvelope([], 'laneway')).toThrow(/export object/);
  });

  it('rejects a file from somewhere else', () => {
    expect(() => readEnvelope({ ...good, format: 'other' }, 'laneway')).toThrow(/not exported from alexmerced.app/);
  });

  it('rejects a newer format version', () => {
    expect(() => readEnvelope({ ...good, version: 99 }, 'laneway')).toThrow(/cannot read yet/);
  });

  it('names the app when the file belongs to a different one', () => {
    expect(() => readEnvelope(good, 'warren')).toThrow(/came from "laneway", not warren/);
  });

  it('rejects an envelope with no data', () => {
    expect(() => readEnvelope({ ...good, data: null }, 'laneway')).toThrow(/no data/);
  });
});

describe('parseEnvelope', () => {
  it('round trips through JSON', () => {
    const envelope = createEnvelope('jotterbug', 1, { notes: [{ id: 'a' }] }, { notes: 1 });
    const parsed = parseEnvelope<{ notes: { id: string }[] }>(JSON.stringify(envelope), 'jotterbug');
    expect(parsed.data.notes).toHaveLength(1);
  });

  it('explains malformed JSON in plain language', () => {
    expect(() => parseEnvelope('{ not json', 'jotterbug')).toThrow(/not valid JSON/);
  });
});

describe('mergeById', () => {
  it('keeps records only present on one side and lets the import win on conflict', () => {
    const merged = mergeById(
      [{ id: 'a', v: 1 }, { id: 'b', v: 1 }],
      [{ id: 'b', v: 2 }, { id: 'c', v: 2 }],
    );
    expect(merged).toHaveLength(3);
    expect(merged.find((r) => r.id === 'b')?.v).toBe(2);
    expect(merged.find((r) => r.id === 'a')?.v).toBe(1);
  });
});

describe('mergeByNewest', () => {
  it('keeps whichever copy was updated last', () => {
    const merged = mergeByNewest(
      [{ id: 'a', updatedAt: '2026-05-01T00:00:00Z', v: 'local' }],
      [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', v: 'file' }],
    );
    expect(merged[0].v).toBe('local');
  });

  it('takes the incoming record when it is newer', () => {
    const merged = mergeByNewest(
      [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', v: 'local' }],
      [{ id: 'a', updatedAt: '2026-05-01T00:00:00Z', v: 'file' }],
    );
    expect(merged[0].v).toBe('file');
  });

  it('adds records the local side has never seen', () => {
    const merged = mergeByNewest([], [{ id: 'z', updatedAt: '2026-01-01T00:00:00Z' }]);
    expect(merged).toHaveLength(1);
  });
});

describe('exportFilename', () => {
  it('builds a filename that sorts by time', () => {
    expect(exportFilename('warren', new Date('2026-08-30T12:34:56Z'))).toBe('warren-2026-08-30-12-34-56.json');
  });
});
