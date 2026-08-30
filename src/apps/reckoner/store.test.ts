import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ID,
  MEMORY_SLOTS,
  TAPE_LIMIT,
  addTapeEntry,
  applyImport,
  buildExport,
  loadMemory,
  loadSettings,
  loadTape,
  saveMemory,
  saveSettings,
  saveTape,
  tapeToText,
  type TapeEntry,
} from './store';
import { createEnvelope } from '../../lib/portable';

const entry = (id: string, expression: string, result: number, at: string): TapeEntry => ({
  id, expression, result, angleMode: 'rad', at,
});

beforeEach(() => {
  localStorage.clear();
});

describe('tape', () => {
  it('starts empty and round trips', () => {
    expect(loadTape()).toEqual([]);
    saveTape([entry('a', '1+1', 2, '2026-01-01T00:00:00Z')]);
    expect(loadTape()).toHaveLength(1);
  });

  it('adds newest first', () => {
    let tape = addTapeEntry([], '1+1', 2, 'rad');
    tape = addTapeEntry(tape, '2+2', 4, 'rad');
    expect(tape[0].expression).toBe('2+2');
    expect(tape).toHaveLength(2);
  });

  it('caps the tape length', () => {
    let tape: TapeEntry[] = [];
    for (let i = 0; i < TAPE_LIMIT + 25; i += 1) tape = addTapeEntry(tape, `${i}+0`, i, 'rad');
    expect(tape).toHaveLength(TAPE_LIMIT);
    expect(tape[0].expression).toBe(`${TAPE_LIMIT + 24}+0`);
  });

  it('drops malformed rows rather than crashing', () => {
    localStorage.setItem('reckoner:tape', JSON.stringify([{ nope: true }, entry('a', '1', 1, 'x')]));
    expect(loadTape()).toHaveLength(1);
  });

  it('survives a corrupt value', () => {
    localStorage.setItem('reckoner:tape', 'not json');
    expect(loadTape()).toEqual([]);
  });

  it('renders as plain text oldest first', () => {
    const tape = [entry('b', '2+2', 4, '2026-01-02T00:00:00Z'), entry('a', '1+1', 2, '2026-01-01T00:00:00Z')];
    expect(tapeToText(tape)).toBe('1+1 = 2\n2+2 = 4');
  });
});

describe('settings', () => {
  it('falls back to sane defaults', () => {
    expect(loadSettings()).toEqual({ angleMode: 'rad', precision: 12, showKeypad: true });
  });

  it('clamps a nonsense precision', () => {
    saveSettings({ angleMode: 'deg', precision: 99, showKeypad: false });
    const loaded = loadSettings();
    expect(loaded.precision).toBe(12);
    expect(loaded.angleMode).toBe('deg');
    expect(loaded.showKeypad).toBe(false);
  });
});

describe('memory', () => {
  it('keeps only known finite slots', () => {
    saveMemory({ m1: 5, m9: 3, m2: Number.POSITIVE_INFINITY } as Record<string, number>);
    const memory = loadMemory();
    expect(memory.m1).toBe(5);
    expect(memory.m9).toBeUndefined();
    expect(memory.m2).toBeUndefined();
  });

  it('exposes four slots', () => {
    expect(MEMORY_SLOTS).toHaveLength(4);
  });
});

describe('export and import', () => {
  it('exports what is stored', () => {
    saveTape([entry('a', '1+1', 2, '2026-01-01T00:00:00Z')]);
    saveMemory({ m1: 7 });
    const envelope = buildExport(new Date('2026-03-01T00:00:00Z'));
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts.tape).toBe(1);
    expect(envelope.data.memory.m1).toBe(7);
  });

  it('replaces on replace', () => {
    saveTape([entry('local', '9+9', 18, '2026-01-01T00:00:00Z')]);
    const file = JSON.stringify(
      createEnvelope(APP_ID, 1, { tape: [entry('file', '1+1', 2, '2026-02-01T00:00:00Z')], settings: loadSettings(), memory: {} }, { tape: 1 }),
    );
    applyImport(file, 'replace');
    const tape = loadTape();
    expect(tape).toHaveLength(1);
    expect(tape[0].id).toBe('file');
  });

  it('merges on merge, newest first', () => {
    saveTape([entry('local', '9+9', 18, '2026-01-01T00:00:00Z')]);
    const file = JSON.stringify(
      createEnvelope(APP_ID, 1, { tape: [entry('file', '1+1', 2, '2026-02-01T00:00:00Z')], settings: loadSettings(), memory: {} }, { tape: 1 }),
    );
    const result = applyImport(file, 'merge');
    expect(result.tape).toBe(2);
    expect(loadTape()[0].id).toBe('file');
  });

  it('refuses a file from another app', () => {
    const file = JSON.stringify(createEnvelope('warren', 1, { pages: [] }, {}));
    expect(() => applyImport(file, 'merge')).toThrow(/came from "warren"/);
  });

  it('ignores malformed tape rows inside a valid envelope', () => {
    const file = JSON.stringify(
      createEnvelope(APP_ID, 1, { tape: [{ junk: 1 }, entry('ok', '1', 1, '2026-01-01T00:00:00Z')], settings: loadSettings(), memory: {} }, { tape: 2 }),
    );
    expect(applyImport(file, 'replace').tape).toBe(1);
  });
});
