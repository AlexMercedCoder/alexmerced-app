import { Collection, openDatabase } from '../../lib/idb';
import { createId } from '../../lib/id';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import type { EcLevel } from './qr';
import type { PayloadKind } from './payloads';

export const APP_ID = 'tessera';
export const APP_VERSION = 1;

const DB_NAME = 'tessera';
const DB_VERSION = 1;
const STORE = 'codes';
const STYLE_KEY = 'tessera:style';

export type Style = {
  ec: EcLevel;
  scale: number;
  quietZone: number;
  dark: string;
  light: string;
  transparent: boolean;
  minVersion: number;
};

export const defaultStyle: Style = {
  ec: 'M',
  scale: 8,
  quietZone: 4,
  dark: '#0d1020',
  light: '#ffffff',
  transparent: false,
  minVersion: 1,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function loadStyle(): Style {
  const raw = readPref<Partial<Style>>(STYLE_KEY, {});
  const levels: EcLevel[] = ['L', 'M', 'Q', 'H'];
  return {
    ec: levels.includes(raw.ec as EcLevel) ? (raw.ec as EcLevel) : defaultStyle.ec,
    scale: clamp(raw.scale, 2, 40, defaultStyle.scale),
    quietZone: clamp(raw.quietZone, 0, 16, defaultStyle.quietZone),
    dark: HEX.test(raw.dark ?? '') ? raw.dark! : defaultStyle.dark,
    light: HEX.test(raw.light ?? '') ? raw.light! : defaultStyle.light,
    transparent: raw.transparent === true,
    minVersion: clamp(raw.minVersion, 1, 40, defaultStyle.minVersion),
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function saveStyle(style: Style): void {
  writePref(STYLE_KEY, style);
}

export type SavedCode = {
  id: string;
  name: string;
  kind: PayloadKind;
  values: Record<string, string>;
  payload: string;
  style: Style;
  createdAt: string;
  updatedAt: string;
};

export function createSavedCode(
  name: string,
  kind: PayloadKind,
  values: Record<string, string>,
  payload: string,
  style: Style,
  now: Date = new Date(),
): SavedCode {
  const stamp = now.toISOString();
  return { id: createId('qr'), name, kind, values, payload, style, createdAt: stamp, updatedAt: stamp };
}

export function reviveSavedCode(value: unknown): SavedCode | null {
  if (typeof value !== 'object' || value === null) return null;
  const code = value as Partial<SavedCode>;
  if (typeof code.id !== 'string' || typeof code.payload !== 'string' || !code.payload) return null;
  const stamp = new Date().toISOString();
  return {
    id: code.id,
    name: typeof code.name === 'string' && code.name.trim() ? code.name : 'Untitled code',
    kind: (typeof code.kind === 'string' ? code.kind : 'text') as PayloadKind,
    values: typeof code.values === 'object' && code.values !== null ? (code.values as Record<string, string>) : {},
    payload: code.payload,
    style: { ...defaultStyle, ...(typeof code.style === 'object' && code.style !== null ? code.style : {}) },
    createdAt: typeof code.createdAt === 'string' ? code.createdAt : stamp,
    updatedAt: typeof code.updatedAt === 'string' ? code.updatedAt : stamp,
  };
}

let codes: Collection<SavedCode> | null = null;

async function connect(): Promise<Collection<SavedCode>> {
  if (codes) return codes;
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: STORE, keyPath: 'id', indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }] },
  ]);
  codes = new Collection<SavedCode>(db, STORE);
  return codes;
}

export async function loadCodes(): Promise<SavedCode[]> {
  const store = await connect();
  return (await store.all())
    .map(reviveSavedCode)
    .filter((code): code is SavedCode => code !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveCode(code: SavedCode): Promise<void> {
  const store = await connect();
  await store.put(code);
}

export async function deleteCode(id: string): Promise<void> {
  const store = await connect();
  await store.delete(id);
}

export async function clearAll(): Promise<void> {
  const store = await connect();
  await store.clear();
}

export type TesseraExport = { codes: SavedCode[]; style: Style };

export async function buildExport(now: Date = new Date()) {
  const saved = await loadCodes();
  return createEnvelope<TesseraExport>(
    APP_ID,
    APP_VERSION,
    { codes: saved, style: loadStyle() },
    { codes: saved.length },
    now,
  );
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<TesseraExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.codes) ? envelope.data.codes : [])
    .map(reviveSavedCode)
    .filter((code): code is SavedCode => code !== null);

  if (incoming.length === 0) throw new Error('That export contains no readable codes.');

  const store = await connect();
  if (mode === 'replace') {
    await store.replaceAll(incoming);
  } else {
    await store.replaceAll(mergeByNewest(await loadCodes(), incoming));
  }

  if (envelope.data.style) saveStyle({ ...loadStyle(), ...envelope.data.style });

  return (await loadCodes()).length;
}
