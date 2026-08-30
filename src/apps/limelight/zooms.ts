import { createId } from '../../lib/id';
import type { Interest } from './attention';
import { buildZoomTrack, type ZoomKeyframe, type ZoomSettings } from './zoom';

/**
 * Zoom as a list of blocks a person can edit.
 *
 * The automatic detection is good at finding moments and bad at knowing which
 * ones matter, so its output is turned into blocks that can be moved, resized,
 * rescaled, added and deleted. Anything touched by hand is marked, and a fresh
 * analysis leaves those alone rather than throwing the work away.
 */

export type ZoomBlock = {
  id: string;
  /** Seconds into the recording. */
  start: number;
  end: number;
  scale: number;
  /** Where to look, 0 to 1 across the frame. */
  x: number;
  y: number;
  /** True once a person has changed it, which protects it from re-analysis. */
  pinned: boolean;
};

export const MIN_BLOCK = 0.3;

/** Turns detected moments into blocks, one per moment. */
export function blocksFromInterest(
  points: Interest[], duration: number, settings: ZoomSettings,
): ZoomBlock[] {
  if (!settings.enabled) return [];

  const hold = Math.max(0.2, settings.holdSeconds);
  const lead = Math.max(0, settings.leadSeconds);

  const blocks: ZoomBlock[] = [];
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    let start = Math.max(0, point.time - lead);
    const end = Math.min(duration, start + hold);

    // A moment near the end has no room to hold for the full time. Pull the
    // start back rather than dropping it, so a click on the last thing that
    // happens still gets a zoom.
    if (end - start < MIN_BLOCK) {
      const previous = blocks[blocks.length - 1];
      const floor = previous ? previous.end : 0;
      start = Math.max(floor, end - MIN_BLOCK);
      if (end - start < MIN_BLOCK) continue;
    }

    const last = blocks[blocks.length - 1];
    // A moment inside the block before it extends that one instead of stacking
    // a second on top, which would make the camera fight itself.
    if (last && start < last.end) {
      last.end = Math.max(last.end, end);
      continue;
    }
    blocks.push({
      id: createId('zoom'),
      start,
      end,
      scale: settings.scale,
      x: point.x,
      y: point.y,
      pinned: false,
    });
  }
  return blocks;
}

/**
 * Merges a fresh analysis into what is already there.
 *
 * Blocks a person has touched are kept exactly. New ones are taken only where
 * they do not overlap something pinned, because the alternative is a
 * re-analysis quietly undoing somebody's work.
 */
export function mergeBlocks(existing: ZoomBlock[], fresh: ZoomBlock[]): ZoomBlock[] {
  const pinned = existing.filter((block) => block.pinned);
  const kept = fresh.filter((block) => !pinned.some((held) => overlaps(held, block)));
  return sortBlocks([...pinned, ...kept]);
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

export function sortBlocks(blocks: ZoomBlock[]): ZoomBlock[] {
  return [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Keeps a block inside the recording and off its neighbours.
 *
 * Two zooms at once has no meaning, so an edit that would overlap is trimmed
 * back rather than refused, which is what makes dragging feel forgiving.
 */
export function constrain(blocks: ZoomBlock[], id: string, duration: number): ZoomBlock[] {
  const sorted = sortBlocks(blocks);
  const index = sorted.findIndex((block) => block.id === id);
  if (index === -1) return sorted;

  const block = { ...sorted[index] };
  const before = sorted[index - 1];
  const after = sorted[index + 1];

  block.start = Math.max(0, block.start);
  block.end = Math.min(duration, block.end);
  if (before) block.start = Math.max(block.start, before.end);
  if (after) block.end = Math.min(block.end, after.start);

  if (block.end - block.start < MIN_BLOCK) {
    // Not enough room left. Give it the minimum from wherever it starts, or
    // drop it if even that will not fit.
    const room = (after ? after.start : duration) - block.start;
    if (room < MIN_BLOCK) return sorted.filter((entry) => entry.id !== id);
    block.end = block.start + MIN_BLOCK;
  }

  block.scale = Math.max(1, Math.min(4, block.scale));
  block.x = Math.max(0, Math.min(1, block.x));
  block.y = Math.max(0, Math.min(1, block.y));

  return sortBlocks(sorted.map((entry) => (entry.id === id ? block : entry)));
}

/** Adds a block at a moment, in whatever gap is available there. */
export function addBlock(
  blocks: ZoomBlock[], at: number, duration: number, settings: ZoomSettings,
): ZoomBlock[] {
  const sorted = sortBlocks(blocks);
  if (sorted.some((block) => at >= block.start && at <= block.end)) return sorted;

  const before = [...sorted].reverse().find((block) => block.end <= at);
  const after = sorted.find((block) => block.start >= at);

  const low = before ? before.end : 0;
  const high = after ? after.start : duration;
  if (high - low < MIN_BLOCK) return sorted;

  const wanted = Math.max(0.2, settings.holdSeconds);
  const start = Math.max(low, Math.min(at, high - MIN_BLOCK));
  const end = Math.min(high, start + wanted);

  return sortBlocks([...sorted, {
    id: createId('zoom'),
    start,
    end: Math.max(start + MIN_BLOCK, end),
    scale: settings.scale,
    x: 0.5,
    y: 0.5,
    pinned: true,
  }]);
}

export function removeBlock(blocks: ZoomBlock[], id: string): ZoomBlock[] {
  return blocks.filter((block) => block.id !== id);
}

/**
 * Turns blocks into the keyframe track the renderer reads.
 *
 * Each block becomes: pull in over the move time, hold, pull back out. Where
 * two blocks are closer together than a move apart, the camera slides straight
 * from one to the next instead of going wide in between.
 */
export function trackFromBlocks(
  blocks: ZoomBlock[], duration: number, settings: ZoomSettings,
): ZoomKeyframe[] {
  const sorted = sortBlocks(blocks).filter((block) => block.end > block.start);
  if (sorted.length === 0 || duration <= 0) return [{ time: 0, scale: 1, x: 0.5, y: 0.5 }];

  const move = Math.max(0.05, settings.moveSeconds);
  const track: ZoomKeyframe[] = [{ time: 0, scale: 1, x: 0.5, y: 0.5 }];

  const push = (frame: ZoomKeyframe) => {
    const last = track[track.length - 1];
    if (frame.time < last.time) return;
    if (frame.time === last.time) { track[track.length - 1] = frame; return; }
    track.push(frame);
  };

  sorted.forEach((block, index) => {
    const previous = sorted[index - 1];
    const next = sorted[index + 1];
    const last = track[track.length - 1];

    // Begin the move a move-length before the block, unless the block before
    // it is still running, in which case slide across from where we are.
    const slidingFrom = previous && block.start - previous.end < move;
    if (!slidingFrom) {
      const wide = Math.max(last.time, block.start - move);
      push({ time: wide, scale: 1, x: 0.5, y: 0.5 });
    }
    push({ time: Math.max(track[track.length - 1].time + 0.001, block.start), scale: block.scale, x: block.x, y: block.y });
    push({ time: Math.max(track[track.length - 1].time, block.end), scale: block.scale, x: block.x, y: block.y });

    const slidingTo = next && next.start - block.end < move;
    if (!slidingTo) {
      push({ time: Math.min(duration, block.end + move), scale: 1, x: 0.5, y: 0.5 });
    }
  });

  if (track[track.length - 1].time < duration) {
    push({ time: duration, scale: track[track.length - 1].scale > 1 ? 1 : 1, x: 0.5, y: 0.5 });
  }
  return track;
}

export function reviveBlocks(value: unknown): ZoomBlock[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): ZoomBlock | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const block = entry as Partial<ZoomBlock>;
      const number = (input: unknown, fallback: number) =>
        typeof input === 'number' && Number.isFinite(input) ? input : fallback;
      if (typeof block.start !== 'number' || typeof block.end !== 'number') return null;
      if (block.end <= block.start) return null;
      return {
        id: typeof block.id === 'string' ? block.id : createId('zoom'),
        start: Math.max(0, block.start),
        end: block.end,
        scale: Math.max(1, Math.min(4, number(block.scale, 1.8))),
        x: Math.max(0, Math.min(1, number(block.x, 0.5))),
        y: Math.max(0, Math.min(1, number(block.y, 0.5))),
        pinned: block.pinned === true,
      };
    })
    .filter((block): block is ZoomBlock => block !== null);
}

/** Kept so the automatic path and the edited path cannot diverge. */
export { buildZoomTrack };

/**
 * Cuts a zoom in two at a moment.
 *
 * Both halves have to be worth having, so a cut too near either end is refused
 * rather than producing a sliver that cannot be grabbed. The list comes back
 * unchanged in that case, which the caller can notice by its length.
 */
export function splitBlock(blocks: ZoomBlock[], id: string, at: number): ZoomBlock[] {
  const block = blocks.find((entry) => entry.id === id);
  if (!block) return blocks;
  if (at - block.start < MIN_BLOCK || block.end - at < MIN_BLOCK) return blocks;

  return sortBlocks([
    ...blocks.filter((entry) => entry.id !== id),
    { ...block, end: at, pinned: true },
    { ...block, id: createId('zoom'), start: at, pinned: true },
  ]);
}

/**
 * Copies a zoom into the first gap that will hold it.
 *
 * Zooms may not overlap, so a copy has to go somewhere free. The gap after the
 * original is tried first, since that is where a copy is usually wanted, and
 * the search then walks the rest of the timeline before giving up.
 */
export function duplicateBlock(blocks: ZoomBlock[], id: string, duration: number): ZoomBlock[] {
  const block = blocks.find((entry) => entry.id === id);
  if (!block) return blocks;

  const length = Math.min(block.end - block.start, duration);
  const sorted = sortBlocks(blocks);

  // Every gap between blocks, plus the one before the first and after the last.
  const gaps: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const entry of sorted) {
    if (entry.start - cursor >= length) gaps.push({ start: cursor, end: entry.start });
    cursor = Math.max(cursor, entry.end);
  }
  if (duration - cursor >= length) gaps.push({ start: cursor, end: duration });

  // Nearest gap that starts at or after the original, else the nearest before.
  const after = gaps.filter((gap) => gap.start >= block.start).sort((a, b) => a.start - b.start)[0];
  const before = gaps.filter((gap) => gap.start < block.start).sort((a, b) => b.start - a.start)[0];
  const gap = after ?? before;
  if (!gap) return blocks;

  return sortBlocks([
    ...blocks,
    { ...block, id: createId('zoom'), start: gap.start, end: gap.start + length, pinned: true },
  ]);
}
