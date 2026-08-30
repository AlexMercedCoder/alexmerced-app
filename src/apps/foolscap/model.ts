import { createId } from '../../lib/id';
import type { Point } from './geometry';
import type { Finish } from './detect';

export const APP_ID = 'foolscap';
export const APP_VERSION = 1;

/**
 * A scanned page. The image is stored as JPEG bytes, because a full resolution
 * page as raw pixels is thirty megabytes and as a JPEG it is under one.
 */
export type Page = {
  id: string;
  /** JPEG bytes of the finished, straightened page. */
  bytes: Uint8Array;
  width: number;
  height: number;
  finish: Finish;
  createdAt: string;
};

export type PageSize = 'fit' | 'letter' | 'a4' | 'legal';

export const PAGE_SIZE_LABELS: { id: PageSize; label: string; note: string }[] = [
  { id: 'fit', label: 'Fit the scan', note: 'Each PDF page matches its image exactly.' },
  { id: 'letter', label: 'US Letter', note: '8.5 by 11 inches.' },
  { id: 'a4', label: 'A4', note: '210 by 297 millimetres.' },
  { id: 'legal', label: 'US Legal', note: '8.5 by 14 inches.' },
];

export const FINISH_LABELS: { id: Finish; label: string; note: string }[] = [
  { id: 'contrast', label: 'Document', note: 'Flattens uneven lighting and lifts the paper to white.' },
  { id: 'blackAndWhite', label: 'Black and white', note: 'Pure ink on pure paper. Smallest files.' },
  { id: 'grayscale', label: 'Grayscale', note: 'Keeps the shading, drops the colour.' },
  { id: 'colour', label: 'Colour', note: 'Exactly what the camera saw.' },
];

export type Settings = {
  finish: Finish;
  strength: number;
  pageSize: PageSize;
  quality: number;
  /** Longest edge in pixels, so a phone photo does not become a 40 MB PDF. */
  maxEdge: number;
};

export const defaultSettings: Settings = {
  finish: 'contrast',
  strength: 1,
  pageSize: 'fit',
  quality: 0.82,
  maxEdge: 2000,
};

export function reviveSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...defaultSettings };
  const settings = value as Partial<Settings>;
  const clamp = (input: unknown, low: number, high: number, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(low, Math.min(high, input)) : fallback;

  return {
    finish: FINISH_LABELS.some((entry) => entry.id === settings.finish) ? settings.finish! : defaultSettings.finish,
    strength: clamp(settings.strength, 0.2, 3, defaultSettings.strength),
    pageSize: PAGE_SIZE_LABELS.some((entry) => entry.id === settings.pageSize) ? settings.pageSize! : defaultSettings.pageSize,
    quality: clamp(settings.quality, 0.3, 1, defaultSettings.quality),
    maxEdge: Math.round(clamp(settings.maxEdge, 600, 6000, defaultSettings.maxEdge)),
  };
}

export function createPage(bytes: Uint8Array, width: number, height: number, mode: Finish, now: Date = new Date()): Page {
  return { id: createId('page'), bytes, width, height, finish: mode, createdAt: now.toISOString() };
}

export function revivePage(value: unknown): Page | null {
  if (typeof value !== 'object' || value === null) return null;
  const page = value as Partial<Page>;
  if (typeof page.id !== 'string') return null;

  const raw: unknown = page.bytes;
  const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
  if (!bytes || bytes.length === 0) return null;

  const size = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.round(input) : fallback;

  return {
    id: page.id,
    bytes,
    width: size(page.width, 1),
    height: size(page.height, 1),
    finish: FINISH_LABELS.some((entry) => entry.id === page.finish) ? page.finish! : 'contrast',
    createdAt: typeof page.createdAt === 'string' ? page.createdAt : new Date().toISOString(),
  };
}

/** Points as they are stored between sessions, if a scan is left part finished. */
export function reviveCorners(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const points = value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return null;
    const point = entry as Partial<Point>;
    if (typeof point.x !== 'number' || typeof point.y !== 'number') return null;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: point.x, y: point.y };
  });
  return points.every((point): point is Point => point !== null) ? points : null;
}
