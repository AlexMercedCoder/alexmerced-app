import { createId } from '../../lib/id';
import { Collection, openDatabase } from '../../lib/idb';
import { readPref, writePref } from '../../lib/prefs';
import type { ClickSample, PointerSample } from './attention';
import {
  CAMERA_SHAPES, defaultComposition, FULL_CROP, reviveCrop,
  type CameraShape, type Composition, type Crop,
} from './layout';
import { defaultZoom, type ZoomKeyframe, type ZoomSettings } from './zoom';
import {
  defaultMotion, defaultTilt, reviveMotion, reviveTilt, type MotionSettings, type Tilt,
} from './plate';
import { reviveTexts, type TextBlock } from './text';
import { reviveBlocks, type ZoomBlock } from './zooms';

/**
 * Keeping a recording between visits.
 *
 * A screen recording is expensive to make and impossible to make again the same
 * way, so losing one to a reload is the worst thing this app could do. The
 * bytes, the pointer track and every setting go into IndexedDB as work
 * happens, and the project list is what makes several of them manageable.
 */

export const APP_ID = 'limelight';
export const APP_VERSION = 1;

const DB_NAME = 'limelight';
const DB_VERSION = 1;
const SETTINGS_KEY = 'limelight:settings';
const CURRENT_KEY = 'limelight:current';

export type Settings = {
  composition: Composition;
  zoom: ZoomSettings;
  /** How the recording plate leans in space. */
  tilt: Tilt;
  /** How the plate arrives and leaves. */
  motion: MotionSettings;
  frameRate: number;
  showClicks: boolean;
  showCursor: boolean;
  keepAudio: boolean;
  countdown: number;
  /** A blip on each number, so you do not have to be watching the screen. */
  countdownSound: boolean;
  /** Ask the platform to blur behind the camera, where it can. */
  cameraBlur: boolean;
  format: 'webm' | 'mp4' | 'gif';
  quality: 'low' | 'medium' | 'high';
};

export const defaultSettings: Settings = {
  composition: defaultComposition,
  zoom: defaultZoom,
  tilt: defaultTilt,
  motion: defaultMotion,
  frameRate: 30,
  showClicks: true,
  showCursor: true,
  keepAudio: true,
  countdown: 3,
  countdownSound: true,
  cameraBlur: false,
  format: 'webm',
  quality: 'high',
};

export type Project = {
  id: string;
  name: string;
  /** The recording exactly as it came off MediaRecorder. */
  bytes: Uint8Array;
  mime: string;
  /** A separate camera recording, when one was made. */
  cameraBytes: Uint8Array | null;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  pointer: PointerSample[];
  clicks: ClickSample[];
  /** Where the export begins and ends, in seconds. */
  start: number;
  end: number;
  /** The part of the picture to keep, as fractions of the source. */
  crop: Crop;
  /** A background picture, when one was chosen. */
  wallpaper: Uint8Array | null;
  wallpaperMime: string;
  /**
   * The zoom blocks, which are what a person edits. The keyframe track is
   * derived from these, so these are what has to be kept.
   */
  zooms: ZoomBlock[];
  /** Captions laid over the finished frame. */
  texts: TextBlock[];
  /** The derived camera move, kept so a reopened project renders identically. */
  keyframes: ZoomKeyframe[] | null;
  settings: Settings;
  createdAt: string;
  updatedAt: string;
};

export function reviveSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...defaultSettings };
  const stored = value as Partial<Settings>;
  const flag = (key: 'showClicks' | 'showCursor' | 'keepAudio' | 'countdownSound' | 'cameraBlur') =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : defaultSettings[key];

  return {
    composition: {
      ...defaultComposition,
      ...(stored.composition ?? {}),
      // Built field by field rather than spread, so a setting that no longer
      // exists does not ride along forever in everybody's stored projects.
      camera: cameraSettings(stored.composition?.camera),
    },
    zoom: { ...defaultZoom, ...(stored.zoom ?? {}) },
    tilt: reviveTilt(stored.tilt),
    motion: reviveMotion(stored.motion),
    frameRate: typeof stored.frameRate === 'number' && stored.frameRate > 0 ? stored.frameRate : 30,
    showClicks: flag('showClicks'),
    showCursor: flag('showCursor'),
    keepAudio: flag('keepAudio'),
    countdownSound: flag('countdownSound'),
    cameraBlur: flag('cameraBlur'),
    countdown: typeof stored.countdown === 'number' ? Math.max(0, Math.min(10, Math.round(stored.countdown))) : 3,
    format: stored.format === 'mp4' || stored.format === 'gif' ? stored.format : 'webm',
    quality: stored.quality === 'low' || stored.quality === 'medium' ? stored.quality : 'high',
  };
}

/**
 * The bubble's shape, reading a setting from before there was a choice.
 *
 * It used to be a single "round" flag, so an existing project says true or
 * false and means circle or rounded rectangle. Dropping that would quietly
 * reshape somebody's saved recording.
 */
function cameraSettings(value: unknown): Composition['camera'] {
  const fallback = defaultComposition.camera;
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<Composition['camera']>;
  const number = (input: unknown, low: number, high: number, spare: number) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(low, Math.min(high, input)) : spare;

  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : fallback.enabled,
    corner: ['bottomRight', 'bottomLeft', 'topRight', 'topLeft'].includes(stored.corner as string)
      ? (stored.corner as Composition['camera']['corner']) : fallback.corner,
    size: number(stored.size, 0.05, 0.5, fallback.size),
    shape: cameraShape(value),
    margin: number(stored.margin, 0, 0.2, fallback.margin),
  };
}

function cameraShape(camera: unknown): CameraShape {
  if (typeof camera !== 'object' || camera === null) return defaultComposition.camera.shape;
  const stored = camera as { shape?: unknown; round?: unknown };
  if (typeof stored.shape === 'string' && CAMERA_SHAPES.some((entry) => entry.id === stored.shape)) {
    return stored.shape as CameraShape;
  }
  if (typeof stored.round === 'boolean') return stored.round ? 'circle' : 'rounded';
  return defaultComposition.camera.shape;
}

export function reviveProject(value: unknown): Project | null {
  if (typeof value !== 'object' || value === null) return null;
  const project = value as Partial<Project>;
  if (typeof project.id !== 'string') return null;

  const asBytes = (input: unknown): Uint8Array | null =>
    input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;

  const bytes = asBytes(project.bytes);
  if (!bytes || bytes.length === 0) return null;

  const positive = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : fallback;
  const points = (input: unknown): { time: number; x: number; y: number }[] =>
    Array.isArray(input)
      ? input.filter((entry): entry is { time: number; x: number; y: number } =>
          typeof entry === 'object' && entry !== null
          && typeof (entry as { time?: unknown }).time === 'number'
          && typeof (entry as { x?: unknown }).x === 'number'
          && typeof (entry as { y?: unknown }).y === 'number')
      : [];

  const stamp = new Date().toISOString();
  const duration = positive(project.duration, 0);

  return {
    id: project.id,
    name: typeof project.name === 'string' && project.name.trim() ? project.name : 'Untitled recording',
    bytes,
    mime: typeof project.mime === 'string' && project.mime ? project.mime : 'video/webm',
    cameraBytes: asBytes(project.cameraBytes),
    duration,
    width: Math.round(positive(project.width, 1920)),
    height: Math.round(positive(project.height, 1080)),
    hasAudio: project.hasAudio === true,
    pointer: points(project.pointer),
    clicks: points(project.clicks),
    start: Math.max(0, typeof project.start === 'number' ? project.start : 0),
    end: typeof project.end === 'number' && project.end > 0 ? project.end : duration,
    crop: reviveCrop(project.crop),
    wallpaper: asBytes(project.wallpaper),
    wallpaperMime: typeof project.wallpaperMime === 'string' && project.wallpaperMime
      ? project.wallpaperMime : 'image/png',
    zooms: reviveBlocks(project.zooms),
    texts: reviveTexts(project.texts),
    keyframes: Array.isArray(project.keyframes) ? (project.keyframes as ZoomKeyframe[]) : null,
    settings: reviveSettings(project.settings),
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : stamp,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : stamp,
  };
}

export function createProject(
  name: string,
  detail: Omit<Project, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'settings' | 'keyframes' | 'start' | 'end' | 'zooms' | 'texts' | 'crop' | 'wallpaper' | 'wallpaperMime'>
    & Partial<Pick<Project,
      'settings' | 'keyframes' | 'start' | 'end' | 'zooms' | 'texts' | 'crop' | 'wallpaper' | 'wallpaperMime'>>,
  now: Date = new Date(),
): Project {
  const stamp = now.toISOString();
  return {
    id: createId('rec'),
    name,
    zooms: [],
    texts: [],
    keyframes: null,
    crop: { ...FULL_CROP },
    wallpaper: null,
    wallpaperMime: 'image/png',
    start: 0,
    end: detail.duration,
    settings: { ...defaultSettings },
    ...detail,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// --------------------------------------------------------------------- storage

let projects: Collection<Project> | null = null;

async function connect(): Promise<Collection<Project>> {
  if (projects) return projects;
  const db = await openDatabase(DB_NAME, DB_VERSION, [{ name: 'projects', keyPath: 'id' }]);
  projects = new Collection<Project>(db, 'projects');
  return projects;
}

export function loadSettings(): Settings { return reviveSettings(readPref(SETTINGS_KEY, defaultSettings)); }
export function saveSettings(settings: Settings): void { writePref(SETTINGS_KEY, settings); }

export function loadCurrentId(): string | null { return readPref<string | null>(CURRENT_KEY, null); }
export function saveCurrentId(id: string | null): void { writePref(CURRENT_KEY, id); }

export async function loadProjects(): Promise<Project[]> {
  const store = await connect();
  return (await store.all())
    .map(reviveProject)
    .filter((project): project is Project => project !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadProject(id: string): Promise<Project | null> {
  const store = await connect();
  return reviveProject(await store.get(id));
}

export async function saveProject(project: Project): Promise<void> {
  await (await connect()).put({ ...project, updatedAt: new Date().toISOString() });
}

export async function deleteProject(id: string): Promise<void> { await (await connect()).delete(id); }
export async function clearAll(): Promise<void> { await (await connect()).clear(); }

export async function storedBytes(): Promise<number> {
  return (await loadProjects()).reduce(
    (sum, project) => sum + project.bytes.length + (project.cameraBytes?.length ?? 0)
      + (project.wallpaper?.length ?? 0),
    0,
  );
}

/**
 * Saves without blocking, and without writing on every keystroke.
 *
 * A recording is tens of megabytes, so writing it again for a slider nudge
 * would make the interface stutter. The bytes are written once when the project
 * is first stored; after that only the settings change, and those are cheap.
 */
export function autosave(project: Project, delayMs = 600): () => void {
  let timer = 0;
  const run = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void saveProject(project); }, delayMs);
  };
  return run;
}
