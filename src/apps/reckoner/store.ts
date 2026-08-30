import { createId } from '../../lib/id';
import { readPref, writePref } from '../../lib/prefs';
import type { AngleMode } from './engine';
import { createEnvelope, mergeById, parseEnvelope, type ImportMode } from '../../lib/portable';

export const APP_ID = 'reckoner';
export const APP_VERSION = 1;
const TAPE_KEY = 'reckoner:tape';
const SETTINGS_KEY = 'reckoner:settings';
const MEMORY_KEY = 'reckoner:memory';

export const TAPE_LIMIT = 300;

export type TapeEntry = {
  id: string;
  expression: string;
  result: number;
  angleMode: AngleMode;
  at: string;
  note?: string;
};

export type Settings = {
  angleMode: AngleMode;
  precision: number;
  showKeypad: boolean;
};

export type MemoryBank = Record<string, number>;

export const MEMORY_SLOTS = ['m1', 'm2', 'm3', 'm4'] as const;

export const defaultSettings: Settings = { angleMode: 'rad', precision: 12, showKeypad: true };

export function loadTape(): TapeEntry[] {
  const raw = readPref<TapeEntry[]>(TAPE_KEY, []);
  return Array.isArray(raw) ? raw.filter(isTapeEntry) : [];
}

export function saveTape(entries: TapeEntry[]): void {
  writePref(TAPE_KEY, entries.slice(0, TAPE_LIMIT));
}

export function loadSettings(): Settings {
  const raw = readPref<Partial<Settings>>(SETTINGS_KEY, {});
  return {
    angleMode: raw.angleMode === 'deg' ? 'deg' : 'rad',
    precision: typeof raw.precision === 'number' && raw.precision >= 4 && raw.precision <= 15 ? raw.precision : 12,
    showKeypad: raw.showKeypad !== false,
  };
}

export function saveSettings(settings: Settings): void {
  writePref(SETTINGS_KEY, settings);
}

export function loadMemory(): MemoryBank {
  const raw = readPref<MemoryBank>(MEMORY_KEY, {});
  const clean: MemoryBank = {};
  for (const slot of MEMORY_SLOTS) {
    if (typeof raw?.[slot] === 'number' && Number.isFinite(raw[slot])) clean[slot] = raw[slot];
  }
  return clean;
}

export function saveMemory(memory: MemoryBank): void {
  writePref(MEMORY_KEY, memory);
}

export function addTapeEntry(
  entries: TapeEntry[],
  expression: string,
  result: number,
  angleMode: AngleMode,
  now: Date = new Date(),
): TapeEntry[] {
  const entry: TapeEntry = {
    id: createId('tape'),
    expression,
    result,
    angleMode,
    at: now.toISOString(),
  };
  return [entry, ...entries].slice(0, TAPE_LIMIT);
}

function isTapeEntry(value: unknown): value is TapeEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<TapeEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.expression === 'string' &&
    typeof entry.result === 'number' &&
    typeof entry.at === 'string'
  );
}

export type ReckonerExport = {
  tape: TapeEntry[];
  settings: Settings;
  memory: MemoryBank;
};

export function buildExport(now: Date = new Date()) {
  const tape = loadTape();
  return createEnvelope<ReckonerExport>(
    APP_ID,
    APP_VERSION,
    { tape, settings: loadSettings(), memory: loadMemory() },
    { tape: tape.length },
    now,
  );
}

export function applyImport(text: string, mode: ImportMode): { tape: number } {
  const envelope = parseEnvelope<ReckonerExport>(text, APP_ID);
  const incoming = Array.isArray(envelope.data.tape) ? envelope.data.tape.filter(isTapeEntry) : [];

  const tape =
    mode === 'replace'
      ? incoming
      : mergeById(loadTape(), incoming).sort((a, b) => b.at.localeCompare(a.at));

  saveTape(tape.slice(0, TAPE_LIMIT));

  if (envelope.data.settings) {
    saveSettings({ ...loadSettings(), ...envelope.data.settings });
  }
  if (envelope.data.memory && typeof envelope.data.memory === 'object') {
    const memory = mode === 'replace' ? {} : loadMemory();
    for (const slot of MEMORY_SLOTS) {
      const value = envelope.data.memory[slot];
      if (typeof value === 'number' && Number.isFinite(value)) memory[slot] = value;
    }
    saveMemory(memory);
  }

  return { tape: Math.min(tape.length, TAPE_LIMIT) };
}

/** Plain text version of the tape, for people who want it in a document. */
export function tapeToText(entries: TapeEntry[]): string {
  return entries
    .slice()
    .reverse()
    .map((entry) => `${entry.expression} = ${entry.result}`)
    .join('\n');
}
