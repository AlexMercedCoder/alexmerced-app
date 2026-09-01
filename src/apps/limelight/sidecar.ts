import { createId } from '../../lib/id';
import { base64Size, fromBase64, toBase64 } from '../../lib/bytes';
import { createEnvelope, ImportError, parseEnvelope, type Envelope } from '../../lib/portable';
import { reviveCrop, type Crop } from './layout';
import { reviveClips, type Clip } from './reel';
import { APP_ID, APP_VERSION, reviveSettings, type Project, type Settings } from './store';
import { reviveTexts, type TextBlock } from './text';
import { reviveBlocks, type ZoomBlock } from './zooms';
import { reviveSpeeds, type SpeedRegion } from './timeline';
import { reviveRedactions, type RedactBlock } from './redact';
import { reviveCues, type Cue } from './captions';
import { reviveShapes, type Shape } from './shapes';
import { mergeSpans, type Span } from './waveform';
import type { ZoomKeyframe } from './zoom';

/**
 * Getting a project off this machine.
 *
 * Every other app on the site exports and imports. This one could only "Save
 * the raw file", which hands back the recording exactly as it came off the
 * camera and loses every edit: the trim, the zooms, the cuts, the captions,
 * the look. Hours of work that existed only inside one browser's IndexedDB.
 *
 * The edits are small, so they travel as the site's ordinary JSON envelope and
 * a video can be attached or not:
 *
 * - Without it the file is a few kilobytes and can be mailed, kept in a repo
 *   or read by eye. It is applied to a recording that is already open.
 * - With it the recording rides along as base64 and the file opens on its own.
 *   That costs a third more than the video itself, which is worth saying out
 *   loud before somebody makes a ninety megabyte JSON file by accident.
 *
 * The recording's shape travels either way, so applying edits to the wrong
 * video is caught and explained rather than silently producing captions that
 * sit four seconds early.
 */

export type SidecarVideo = {
  mime: string;
  bytes: number;
  base64: string;
};

export type Sidecar = {
  name: string;
  /** What the edits were made against, for spotting a mismatch on the way in. */
  source: { duration: number; width: number; height: number; bytes: number; mime: string };
  start: number;
  end: number;
  crop: Crop;
  zooms: ZoomBlock[];
  texts: TextBlock[];
  cuts: Span[];
  speeds: SpeedRegion[];
  redactions: RedactBlock[];
  captions: Cue[];
  shapes: Shape[];
  keyframes: ZoomKeyframe[] | null;
  settings: Settings;
  /**
   * The reel, when the timeline holds more than one recording.
   *
   * Only ever written alongside the recordings it names, since clips pointing
   * at takes that are not in the file would place every edit against a
   * timeline that does not exist.
   */
  clips?: Clip[];
  /** Present only when the recording was carried along. */
  video?: SidecarVideo;
  /** The further recordings the clips name, when they were carried too. */
  takes?: { id: string; mime: string; bytes: number; base64: string }[];
};

/** How far the durations may differ before the two are treated as unrelated. */
const DURATION_SLACK = 0.75;

export function sidecarFilename(name: string, withVideo: boolean, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = (name || 'recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${safe || 'recording'}-${stamp}${withVideo ? '-with-video' : '-edits'}.json`;
}

/** What a file will roughly weigh, for saying so before writing it. */
export function sidecarSize(project: Project, withVideo: boolean): number {
  if (!withVideo) return 8_000;
  const extra = reelTravels(project, withVideo)
    ? (project.takes ?? []).reduce((sum, take) => sum + base64Size(take.bytes.byteLength), 0)
    : 0;
  return base64Size(project.bytes.byteLength) + extra;
}

/** Whether a project's reel can be written into a file of this kind. */
export function reelTravels(project: Project, withVideo: boolean): boolean {
  return withVideo && (project.clips?.length ?? 0) > 1;
}

/** What is lost by writing this file, in words, or nothing. */
export function sidecarLoses(project: Project, withVideo: boolean): string | null {
  const extra = (project.clips?.length ?? 0) > 1;
  if (!extra || reelTravels(project, withVideo)) return null;
  const takes = (project.takes?.length ?? 0) + 1;
  return `This timeline is made of ${takes} recordings, and only edits are being saved. `
    + 'Use Save everything to keep them, or the edits will not line up with anything.';
}

export function toSidecar(project: Project, withVideo: boolean): Sidecar {
  const sidecar: Sidecar = {
    name: project.name,
    source: {
      duration: project.duration,
      width: project.width,
      height: project.height,
      bytes: project.bytes.byteLength,
      mime: project.mime,
    },
    start: project.start,
    end: project.end,
    crop: project.crop,
    zooms: project.zooms,
    texts: project.texts,
    cuts: project.cuts,
    speeds: project.speeds,
    redactions: project.redactions,
    captions: project.captions,
    shapes: project.shapes,
    keyframes: project.keyframes,
    settings: project.settings,
  };
  if (withVideo) {
    sidecar.video = {
      mime: project.mime,
      bytes: project.bytes.byteLength,
      base64: toBase64(project.bytes),
    };
    // The reel travels only with the recordings it names, so a file can never
    // describe a timeline it does not carry.
    if (reelTravels(project, withVideo)) {
      sidecar.clips = project.clips;
      sidecar.takes = (project.takes ?? []).map((take) => ({
        id: take.id,
        mime: take.mime,
        bytes: take.bytes.byteLength,
        base64: toBase64(take.bytes),
      }));
    }
  }
  return sidecar;
}

/** What the envelope's summary line says, which is all most people read. */
export function sidecarCounts(sidecar: Sidecar): Record<string, number> {
  return {
    zooms: sidecar.zooms.length,
    captions: sidecar.texts.length,
    subtitles: sidecar.captions.length,
    cuts: sidecar.cuts.length,
    speedChanges: sidecar.speeds.length,
    coverUps: sidecar.redactions.length,
    shapes: sidecar.shapes.length,
  };
}

export function writeSidecar(project: Project, withVideo: boolean, now?: Date): string {
  const sidecar = toSidecar(project, withVideo);
  return JSON.stringify(
    createEnvelope(APP_ID, APP_VERSION, sidecar, sidecarCounts(sidecar), now),
    null,
    withVideo ? 0 : 2,
  );
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Reads a sidecar back, filling in anything a hand edited file left out.
 *
 * Every list goes through the same revivers the database uses, so a file that
 * has been trimmed by hand or written by an older version cannot put a
 * malformed block on the timeline.
 */
export function reviveSidecar(value: unknown): Sidecar {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ImportError('That export has no project in it.');
  }
  const raw = value as Partial<Sidecar> & { source?: Partial<Sidecar['source']> };
  const duration = numberOr(raw.source?.duration, 0);
  if (!(duration > 0)) {
    throw new ImportError('That export does not say how long its recording was, so it cannot be lined up.');
  }

  const video = raw.video && typeof raw.video.base64 === 'string' && raw.video.base64.length > 0
    ? {
      mime: typeof raw.video.mime === 'string' ? raw.video.mime : 'video/webm',
      bytes: numberOr(raw.video.bytes, 0),
      base64: raw.video.base64,
    }
    : undefined;

  const takes = Array.isArray(raw.takes)
    ? raw.takes.flatMap((entry) => {
      const take = entry as Partial<NonNullable<Sidecar['takes']>[number]>;
      if (typeof take.id !== 'string' || typeof take.base64 !== 'string' || !take.base64) return [];
      return [{
        id: take.id,
        mime: typeof take.mime === 'string' && take.mime ? take.mime : 'video/webm',
        bytes: numberOr(take.bytes, 0),
        base64: take.base64,
      }];
    })
    : [];
  const clips = reviveClips(raw.clips, () => createId('clip'))
    // A clip naming a recording that is not in the file is dropped, and if that
    // leaves fewer than two the reel is not one.
    .filter((clip) => clip.source === 'take-1' || takes.some((take) => take.id === clip.source));

  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Imported recording',
    source: {
      duration,
      width: numberOr(raw.source?.width, 0),
      height: numberOr(raw.source?.height, 0),
      bytes: numberOr(raw.source?.bytes, 0),
      mime: typeof raw.source?.mime === 'string' ? raw.source.mime : 'video/webm',
    },
    start: Math.max(0, numberOr(raw.start, 0)),
    end: numberOr(raw.end, duration),
    crop: reviveCrop(raw.crop),
    zooms: reviveBlocks(raw.zooms),
    texts: reviveTexts(raw.texts),
    cuts: mergeSpans(Array.isArray(raw.cuts)
      ? raw.cuts.filter((span): span is Span =>
        typeof span === 'object' && span !== null
        && Number.isFinite((span as Span).start) && Number.isFinite((span as Span).end))
      : []),
    speeds: reviveSpeeds(raw.speeds, () => createId('speed')),
    redactions: reviveRedactions(raw.redactions, () => createId('redact')),
    captions: reviveCues(raw.captions, () => createId('cue')),
    shapes: reviveShapes(raw.shapes, () => createId('shape')),
    keyframes: Array.isArray(raw.keyframes) ? raw.keyframes as ZoomKeyframe[] : null,
    settings: reviveSettings(raw.settings),
    ...(video ? { video } : {}),
    ...(takes.length > 0 ? { takes } : {}),
    // Clips are kept only when the recordings they name came too. A reel
    // pointing at nothing would put every edit against a timeline that is not
    // there, which is worse than falling back to the one recording.
    ...(takes.length > 0 && clips.length > 1 ? { clips } : {}),
  };
}

export function readSidecar(text: string): Envelope<Sidecar> {
  const envelope = parseEnvelope<unknown>(text, APP_ID);
  return { ...envelope, data: reviveSidecar(envelope.data) };
}

/** The further recordings inside a file, decoded. */
export function sidecarTakes(sidecar: Sidecar): { id: string; bytes: Uint8Array; mime: string }[] {
  return (sidecar.takes ?? []).flatMap((take) => {
    try {
      return [{ id: take.id, bytes: fromBase64(take.base64), mime: take.mime }];
    } catch {
      // One unreadable take should not lose the rest, and the clips that name
      // it are dropped by the caller.
      return [];
    }
  });
}

/** The recording carried inside a file, or null when it only holds edits. */
export function sidecarVideo(sidecar: Sidecar): { bytes: Uint8Array; mime: string } | null {
  if (!sidecar.video) return null;
  try {
    return { bytes: fromBase64(sidecar.video.base64), mime: sidecar.video.mime };
  } catch {
    throw new ImportError('The recording inside that file could not be read. It may have been truncated.');
  }
}

/**
 * Whether these edits belong to this recording, in words.
 *
 * Applying a sidecar to the wrong video does not fail: it produces captions
 * four seconds early and cuts in the wrong places, which reads as the app
 * having broken rather than as the wrong file having been chosen. Length is the
 * cheap check that catches almost all of it, and the frame size catches most of
 * the rest.
 */
export function sidecarMismatch(
  sidecar: Sidecar,
  onto: { duration: number; width: number; height: number },
): string | null {
  const drift = Math.abs(sidecar.source.duration - onto.duration);
  if (drift > DURATION_SLACK) {
    return `Those edits were made against a recording ${sidecar.source.duration.toFixed(1)} seconds long, and this one is ${onto.duration.toFixed(1)}. Everything would land in the wrong place.`;
  }
  if (
    sidecar.source.width > 0 && onto.width > 0
    && (sidecar.source.width !== onto.width || sidecar.source.height !== onto.height)
  ) {
    return `Those edits were made against a ${sidecar.source.width} by ${sidecar.source.height} recording, and this one is ${onto.width} by ${onto.height}. Anything placed on the picture would be in the wrong place.`;
  }
  return null;
}

/** Puts the edits onto a project, keeping the recording it already has. */
export function applySidecar(project: Project, sidecar: Sidecar): Project {
  return {
    ...project,
    start: Math.max(0, Math.min(project.duration, sidecar.start)),
    end: sidecar.end > sidecar.start
      ? Math.min(project.duration, sidecar.end)
      : project.duration,
    crop: sidecar.crop,
    zooms: sidecar.zooms,
    texts: sidecar.texts,
    cuts: sidecar.cuts,
    speeds: sidecar.speeds,
    redactions: sidecar.redactions,
    captions: sidecar.captions,
    shapes: sidecar.shapes,
    keyframes: sidecar.keyframes,
    settings: sidecar.settings,
    ...(sidecar.clips && sidecar.clips.length > 1 ? { clips: sidecar.clips } : {}),
    updatedAt: new Date().toISOString(),
  };
}
