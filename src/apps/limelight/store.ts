import { createId } from '../../lib/id';
import { Collection, openDatabase } from '../../lib/idb';
import { readPref, writePref } from '../../lib/prefs';
import type { ClickSample, PointerSample } from './attention';
import type { KeySample, MarkSample } from './capture';
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
import { mergeSpans, type Span } from './waveform';
import { Scratch, type ScratchChunk, type ScratchSession } from './scratch';
import { reviveSpeeds, type SpeedRegion } from './timeline';
import { reviveRedactions, type RedactBlock } from './redact';
import { reviveCues, type Cue } from './captions';

export type { ScratchSession } from './scratch';

/**
 * Reads cuts back from storage.
 *
 * Merged on the way in, so a stored file that somehow holds overlapping cuts
 * cannot make the edited duration disagree with what the export produces.
 */
function reviveCuts(value: unknown): Span[] {
  if (!Array.isArray(value)) return [];
  const spans = value
    .filter((entry): entry is Span =>
      typeof entry === 'object' && entry !== null
      && Number.isFinite((entry as Span).start) && Number.isFinite((entry as Span).end))
    .map((entry) => ({ start: Math.max(0, entry.start), end: entry.end }));
  return mergeSpans(spans);
}

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
const DB_VERSION = 3;
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
  /** How large a subtitle is drawn, as a fraction of the frame height. */
  captionSize: number;
  /** Whether the subtitles are drawn into the exported picture. */
  burnCaptions: boolean;
  showCursor: boolean;
  /** How large the drawn cursor is, as a multiple of the default. */
  cursorSize: number;
  /** Dims everything but a circle around the pointer. 0 is off. */
  spotlight: number;
  /** Draws the shortcuts that were pressed, for teaching videos. */
  showKeys: boolean;
  keepAudio: boolean;
  countdown: number;
  /** A blip on each number, so you do not have to be watching the screen. */
  countdownSound: boolean;
  /** Ask the platform to blur behind the camera, where it can. */
  cameraBlur: boolean;
  /**
   * Chosen capture devices, or 'default' to let the browser pick.
   *
   * Ids are stable per origin but not across browsers, and they go stale when a
   * device is unplugged, so these are a preference the capture falls back from
   * rather than a requirement.
   */
  microphoneId: string;
  cameraId: string;
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
  captionSize: 0.045,
  burnCaptions: false,
  showCursor: true,
  cursorSize: 1,
  spotlight: 0,
  showKeys: true,
  keepAudio: true,
  countdown: 3,
  countdownSound: true,
  cameraBlur: false,
  microphoneId: 'default',
  cameraId: 'default',
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
  /** Shortcuts pressed during the recording, drawn on the finished frame. */
  keys: KeySample[];
  /** Marked moments, which become chapters. */
  marks: MarkSample[];
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
  /**
   * Stretches taken out of the middle, in source seconds.
   *
   * Trim only ever set an outer start and end, so removing a fumbled passage
   * meant recording the whole thing again. These are the pieces the export
   * skips over.
   */
  cuts: Span[];
  /** Stretches that run faster or slower than they were recorded. */
  speeds: SpeedRegion[];
  /** Rectangles covered over, burnt into the exported picture. */
  redactions: RedactBlock[];
  /** Subtitles, written against the recording's own clock. */
  captions: Cue[];
  /** The derived camera move, kept so a reopened project renders identically. */
  keyframes: ZoomKeyframe[] | null;
  settings: Settings;
  createdAt: string;
  updatedAt: string;
};

export function reviveSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...defaultSettings };
  const stored = value as Partial<Settings>;
  const flag = (key: 'showClicks' | 'showCursor' | 'showKeys' | 'burnCaptions' | 'keepAudio' | 'countdownSound' | 'cameraBlur') =>
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
    showKeys: flag('showKeys'),
    burnCaptions: flag('burnCaptions'),
    captionSize: typeof stored.captionSize === 'number' ? Math.max(0.02, Math.min(0.12, stored.captionSize)) : 0.045,
    cursorSize: typeof stored.cursorSize === 'number' ? Math.max(0.5, Math.min(4, stored.cursorSize)) : 1,
    spotlight: typeof stored.spotlight === 'number' ? Math.max(0, Math.min(1, stored.spotlight)) : 0,
    keepAudio: flag('keepAudio'),
    countdownSound: flag('countdownSound'),
    cameraBlur: flag('cameraBlur'),
    microphoneId: typeof stored.microphoneId === 'string' ? stored.microphoneId : 'default',
    cameraId: typeof stored.cameraId === 'string' ? stored.cameraId : 'default',
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
    cuts: reviveCuts(project.cuts),
    speeds: reviveSpeeds(project.speeds, () => createId('speed')),
    redactions: reviveRedactions(project.redactions, () => createId('redact')),
    captions: reviveCues(project.captions, () => createId('cue')),
    keys: Array.isArray(project.keys) ? (project.keys as KeySample[]) : [],
    marks: Array.isArray(project.marks) ? (project.marks as MarkSample[]) : [],
    keyframes: Array.isArray(project.keyframes) ? (project.keyframes as ZoomKeyframe[]) : null,
    settings: reviveSettings(project.settings),
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : stamp,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : stamp,
  };
}

export function createProject(
  name: string,
  detail: Omit<Project, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'settings' | 'keyframes' | 'start' | 'end' | 'zooms' | 'texts' | 'cuts' | 'speeds' | 'redactions' | 'captions' | 'keys' | 'marks' | 'crop' | 'wallpaper' | 'wallpaperMime'>
    & Partial<Pick<Project,
      'settings' | 'keyframes' | 'start' | 'end' | 'zooms' | 'texts' | 'cuts' | 'speeds' | 'redactions' | 'captions' | 'keys' | 'marks' | 'crop' | 'wallpaper' | 'wallpaperMime'>>,
  now: Date = new Date(),
): Project {
  const stamp = now.toISOString();
  return {
    id: createId('rec'),
    name,
    zooms: [],
    texts: [],
    cuts: [],
    speeds: [],
    redactions: [],
    captions: [],
    keys: [],
    marks: [],
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
let looks: Collection<Look> | null = null;
let database: Promise<IDBDatabase> | null = null;

/**
 * One connection for both stores.
 *
 * Opening the same database twice at different versions is how a blocked
 * upgrade happens, so the handle is shared and the version bumped once.
 */
function db(): Promise<IDBDatabase> {
  if (!database) {
    database = openDatabase(DB_NAME, DB_VERSION, [
      { name: 'projects', keyPath: 'id' },
      { name: 'looks', keyPath: 'id' },
      // Chunks of a recording still being made, plus what is known about it.
      { name: 'scratch', keyPath: 'id' },
      { name: 'scratchSessions', keyPath: 'id' },
    ]);
  }
  return database;
}

async function connect(): Promise<Collection<Project>> {
  if (projects) return projects;
  projects = new Collection<Project>(await db(), 'projects');
  return projects;
}

async function connectLooks(): Promise<Collection<Look>> {
  if (looks) return looks;
  looks = new Collection<Look>(await db(), 'looks');
  return looks;
}

let scratch: Scratch | null = null;

/** The safety net a recording is written into while it is being made. */
export async function openScratch(): Promise<Scratch> {
  if (scratch) return scratch;
  const handle = await db();
  scratch = new Scratch(
    new Collection<ScratchChunk>(handle, 'scratch'),
    new Collection<ScratchSession>(handle, 'scratchSessions'),
  );
  return scratch;
}

/**
 * A saved look: everything about how a recording is presented, with nothing
 * about the recording itself.
 *
 * Trim, crop, zooms and captions all belong to one video and are deliberately
 * left out. What is kept is the part somebody wants their next recording to
 * match: the background, the padding, the shadow, the tilt, the entrance, and
 * the defaults new zooms are built from.
 */
export type Look = {
  id: string;
  name: string;
  composition: Composition;
  zoom: ZoomSettings;
  tilt: Tilt;
  motion: MotionSettings;
  /** The background picture, when the look uses one. */
  wallpaper: Uint8Array | null;
  wallpaperMime: string;
  createdAt: string;
};

export async function loadLooks(): Promise<Look[]> {
  const collection = await connectLooks();
  const all = await collection.all();
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveLook(look: Look): Promise<void> {
  await (await connectLooks()).put(look);
}

export async function deleteLook(id: string): Promise<void> {
  await (await connectLooks()).delete(id);
}

/** Builds a look from the settings in play, taking only the parts that travel. */
export function lookFrom(
  name: string, settings: Settings, wallpaper: Uint8Array | null, wallpaperMime: string,
  now: Date = new Date(),
): Look {
  return {
    id: createId('look'),
    name,
    composition: settings.composition,
    zoom: settings.zoom,
    tilt: settings.tilt,
    motion: settings.motion,
    wallpaper,
    wallpaperMime,
    createdAt: now.toISOString(),
  };
}

/**
 * Lays a look over the current settings.
 *
 * Output size, frame rate, format and quality are left alone on purpose: they
 * are about the file being produced rather than how it looks, and someone
 * applying a look to a portrait recording does not want it made landscape.
 */
export function applyLook(settings: Settings, look: Look): Settings {
  return {
    ...settings,
    composition: {
      ...look.composition,
      width: settings.composition.width,
      height: settings.composition.height,
    },
    zoom: look.zoom,
    tilt: look.tilt,
    motion: look.motion,
  };
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

export class StorageFullError extends Error {}

/**
 * What the browser will let this origin keep, and what is already used.
 *
 * Both numbers are estimates and a browser is free to refuse a write anyway, so
 * this informs rather than decides. Some browsers do not implement it at all,
 * which reads as unknown rather than as full.
 */
export async function storageRoom(): Promise<{ used: number; quota: number } | null> {
  const estimate = navigator.storage?.estimate;
  if (typeof estimate !== 'function') return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    return { used: usage, quota };
  } catch {
    return null;
  }
}

/**
 * Saves a project, turning a full disk into something the caller can act on.
 *
 * A refused write used to reject with whatever the browser threw and the
 * recording was simply gone. Recognising it as a distinct condition is what
 * lets the page offer to make room instead.
 */
export async function saveProject(project: Project): Promise<void> {
  try {
    await (await connect()).put({ ...project, updatedAt: new Date().toISOString() });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      throw new StorageFullError('There is no room left in this browser to keep the recording.');
    }
    throw error;
  }
}

/** The projects that could be removed to make room, oldest first. */
export async function oldestProjects(): Promise<Project[]> {
  return (await loadProjects()).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
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
