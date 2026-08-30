import { createId } from '../../lib/id';

export const APP_ID = 'cadence';
export const APP_VERSION = 1;

/**
 * A clip is the bytes exactly as they arrived, plus what was learned by
 * decoding them once. Keeping the source bytes rather than raw samples means a
 * three minute recording costs a few megabytes instead of thirty.
 */
export type Clip = {
  id: string;
  name: string;
  /** The encoded file: WebM from a recording, or whatever was dropped in. */
  bytes: Uint8Array;
  mime: string;
  duration: number;
  sampleRate: number;
  channelCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ClipMeta = Omit<Clip, 'bytes'>;

export function createClip(
  name: string,
  bytes: Uint8Array,
  mime: string,
  detail: { duration: number; sampleRate: number; channelCount: number },
  now: Date = new Date(),
): Clip {
  const stamp = now.toISOString();
  return {
    id: createId('clip'),
    name,
    bytes,
    mime,
    duration: detail.duration,
    sampleRate: detail.sampleRate,
    channelCount: detail.channelCount,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** Strips the extension and tidies a filename into something readable. */
export function nameFromFile(filename: string): string {
  const stem = filename.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_-]+/g, ' ').trim();
  return stem || 'Untitled clip';
}

/** A filename safe on every filesystem, derived from a clip name. */
export function fileStem(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'audio';
}

/** Picks a name that does not collide with the ones already taken. */
export function uniqueName(preferred: string, taken: string[]): string {
  if (!taken.includes(preferred)) return preferred;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${preferred} ${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${preferred} ${createId()}`;
}

export function reviveClip(value: unknown): Clip | null {
  if (typeof value !== 'object' || value === null) return null;
  const clip = value as Partial<Clip>;
  if (typeof clip.id !== 'string') return null;

  // IndexedDB hands typed arrays back as they went in, but a hand-edited file
  // or an older export may carry a plain ArrayBuffer instead.
  const raw: unknown = clip.bytes;
  const bytes =
    raw instanceof Uint8Array ? raw
    : raw instanceof ArrayBuffer ? new Uint8Array(raw)
    : null;
  if (!bytes || bytes.length === 0) return null;

  const stamp = new Date().toISOString();
  const positive = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    id: clip.id,
    name: typeof clip.name === 'string' && clip.name.trim() ? clip.name : 'Untitled clip',
    bytes,
    mime: typeof clip.mime === 'string' && clip.mime ? clip.mime : 'audio/wav',
    duration: positive(clip.duration, 0),
    sampleRate: Math.round(positive(clip.sampleRate, 48000)),
    channelCount: Math.max(1, Math.round(positive(clip.channelCount, 1))),
    createdAt: typeof clip.createdAt === 'string' ? clip.createdAt : stamp,
    updatedAt: typeof clip.updatedAt === 'string' ? clip.updatedAt : stamp,
  };
}

export type ExportFormat = 'wav16' | 'wav24' | 'wav32';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; note: string; depth: 16 | 24 | 32 }[] = [
  { id: 'wav16', label: 'WAV 16 bit', note: 'What CDs use. Plays everywhere.', depth: 16 },
  { id: 'wav24', label: 'WAV 24 bit', note: 'More headroom for further editing.', depth: 24 },
  { id: 'wav32', label: 'WAV 32 bit float', note: 'Exact, and never clips. Large files.', depth: 32 },
];

export type Settings = {
  format: ExportFormat;
  fadeSeconds: number;
  crossfadeSeconds: number;
  normaliseTargetDb: number;
  silenceThresholdDb: number;
};

export const defaultSettings: Settings = {
  format: 'wav16',
  fadeSeconds: 1,
  crossfadeSeconds: 0.25,
  normaliseTargetDb: -1,
  silenceThresholdDb: -50,
};

export function reviveSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...defaultSettings };
  const settings = value as Partial<Settings>;
  const clamp = (input: unknown, low: number, high: number, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(low, Math.min(high, input)) : fallback;

  return {
    format: EXPORT_FORMATS.some((entry) => entry.id === settings.format) ? settings.format! : defaultSettings.format,
    fadeSeconds: clamp(settings.fadeSeconds, 0, 60, defaultSettings.fadeSeconds),
    crossfadeSeconds: clamp(settings.crossfadeSeconds, 0, 30, defaultSettings.crossfadeSeconds),
    normaliseTargetDb: clamp(settings.normaliseTargetDb, -40, 0, defaultSettings.normaliseTargetDb),
    silenceThresholdDb: clamp(settings.silenceThresholdDb, -90, -10, defaultSettings.silenceThresholdDb),
  };
}
