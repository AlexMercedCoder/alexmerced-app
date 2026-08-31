import { keptSpans, mergeSpans, type Span } from './waveform';

/**
 * Where a moment in the finished video came from.
 *
 * Two things now change the relationship between the recording and the export.
 * A cut removes a stretch; a speed region keeps it but runs it faster or
 * slower. Both are the same question asked twice, so both are answered here
 * rather than in the renderer, the audio encoder and the preview separately.
 *
 * A cut is the limiting case of a speed region: infinitely fast. It is kept as
 * its own idea anyway, because "remove this" and "hurry through this" are
 * different intentions and a person should not have to express one as the
 * other.
 */

export type SpeedRegion = {
  id: string;
  start: number;
  end: number;
  /** 2 runs at twice the pace. Below 1 is slow motion. */
  speed: number;
};

/** A piece of the recording that survives, and how fast it plays. */
export type Segment = { start: number; end: number; speed: number };

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 8;
export const MIN_REGION = 0.3;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
}

/** Puts speed regions in order and stops them overlapping each other. */
export function sortSpeeds(regions: SpeedRegion[]): SpeedRegion[] {
  const sorted = [...regions]
    .filter((region) => region.end > region.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: SpeedRegion[] = [];
  for (const region of sorted) {
    const last = out[out.length - 1];
    // Trimmed rather than dropped, so dragging one onto another is forgiving in
    // the same way the zoom track is.
    if (last && region.start < last.end) {
      const start = last.end;
      if (region.end - start < MIN_REGION) continue;
      out.push({ ...region, start, speed: clampSpeed(region.speed) });
      continue;
    }
    out.push({ ...region, speed: clampSpeed(region.speed) });
  }
  return out;
}

/**
 * The kept pieces of the recording, split wherever the speed changes.
 *
 * Cuts are applied first and win: a speed region over a cut stretch has nothing
 * to act on, because those seconds are not in the finished video at all.
 */
export function segmentsOf(
  trim: { start: number; end: number }, cuts: Span[], speeds: SpeedRegion[],
): Segment[] {
  const kept = keptSpans(mergeSpans(cuts), trim.start, trim.end);
  const regions = sortSpeeds(speeds);
  const segments: Segment[] = [];

  for (const span of kept) {
    let cursor = span.start;
    for (const region of regions) {
      if (region.end <= cursor || region.start >= span.end) continue;
      const from = Math.max(cursor, region.start);
      const to = Math.min(span.end, region.end);
      if (from > cursor) segments.push({ start: cursor, end: from, speed: 1 });
      if (to > from) segments.push({ start: from, end: to, speed: clampSpeed(region.speed) });
      cursor = Math.max(cursor, to);
    }
    if (cursor < span.end) segments.push({ start: cursor, end: span.end, speed: 1 });
  }
  return segments;
}

/** How long the finished video runs. */
export function editedDuration(segments: Segment[]): number {
  return segments.reduce((total, part) => total + (part.end - part.start) / part.speed, 0);
}

/**
 * Turns a moment in the finished video into the moment of the recording to draw.
 *
 * Everything downstream works in edited time: the export walks frame by frame
 * through what is left and each frame has to know what to show. Past the end it
 * clamps to the last kept moment, so a rounding error on the final frame cannot
 * ask for a time that is not in the recording.
 */
export function sourceAt(segments: Segment[], edited: number): number {
  if (segments.length === 0) return 0;
  let remaining = Math.max(0, edited);
  for (const part of segments) {
    const length = (part.end - part.start) / part.speed;
    if (remaining < length) return part.start + remaining * part.speed;
    remaining -= length;
  }
  return segments[segments.length - 1].end;
}

/**
 * The reverse: where a moment of the recording lands in the finished video.
 *
 * Used for drawing, where the playhead is known in source time and has to be
 * placed on a timeline that shows the edit. A moment inside a cut has no
 * position in the finished video, so it reports the start of the next piece
 * that does, which is where playback would land anyway.
 */
export function editedAt(segments: Segment[], source: number): number {
  let elapsed = 0;
  for (const part of segments) {
    if (source < part.start) return elapsed;
    if (source <= part.end) return elapsed + (source - part.start) / part.speed;
    elapsed += (part.end - part.start) / part.speed;
  }
  return elapsed;
}

/** The speed in force at a moment of the recording. */
export function speedAt(segments: Segment[], source: number): number {
  for (const part of segments) {
    if (source >= part.start && source < part.end) return part.speed;
  }
  return 1;
}

/** Adds a speed region in the first gap that will hold one at a moment. */
export function addSpeed(
  regions: SpeedRegion[], at: number, duration: number, speed: number, id: string,
  seconds = 2,
): SpeedRegion[] {
  const sorted = sortSpeeds(regions);
  if (sorted.some((region) => at >= region.start && at <= region.end)) return sorted;

  const before = [...sorted].reverse().find((region) => region.end <= at);
  const after = sorted.find((region) => region.start >= at);
  const low = before ? before.end : 0;
  const high = after ? after.start : duration;
  if (high - low < MIN_REGION) return sorted;

  const start = Math.max(low, Math.min(at, high - MIN_REGION));
  const end = Math.min(high, start + Math.max(MIN_REGION, seconds));
  return sortSpeeds([...sorted, { id, start, end, speed: clampSpeed(speed) }]);
}

export function removeSpeed(regions: SpeedRegion[], id: string): SpeedRegion[] {
  return regions.filter((region) => region.id !== id);
}

export function reviveSpeeds(value: unknown, makeId: () => string): SpeedRegion[] {
  if (!Array.isArray(value)) return [];
  return sortSpeeds(value
    .filter((entry): entry is SpeedRegion =>
      typeof entry === 'object' && entry !== null
      && Number.isFinite((entry as SpeedRegion).start) && Number.isFinite((entry as SpeedRegion).end))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : makeId(),
      start: Math.max(0, entry.start),
      end: entry.end,
      speed: clampSpeed(entry.speed),
    })));
}
