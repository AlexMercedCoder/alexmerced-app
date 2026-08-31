/**
 * Covering something up that should not have been on screen.
 *
 * An API key, a customer's name, somebody's email in a notification. Until now
 * the only remedy was recording the whole thing again, which for anyone making
 * developer content is a weekly event rather than an edge case.
 *
 * A redaction is a rectangle with a life: it appears, optionally moves, and
 * goes away. Moving matters more than it sounds, because the thing being hidden
 * is usually in a panel that scrolls or a window that gets dragged, and a fixed
 * box either misses it or covers half the screen to be safe.
 *
 * Everything here is in fractions of the cropped region, the same coordinates
 * the zoom focal point uses, so a redaction survives a crop or an output size
 * change without moving off its target.
 */

export type RedactStyle = 'blur' | 'pixelate' | 'solid';

/** Where the box is at a given moment. */
export type RedactPoint = { time: number; x: number; y: number };

export type RedactBlock = {
  id: string;
  start: number;
  end: number;
  style: RedactStyle;
  /** Centre positions over time, in order. At least one. */
  points: RedactPoint[];
  /** Size as a fraction of the frame. */
  width: number;
  height: number;
};

export const MIN_REDACT = 0.2;
export const MIN_SIZE = 0.01;

export const REDACT_STYLES: { id: RedactStyle; label: string }[] = [
  { id: 'blur', label: 'Blur' },
  { id: 'pixelate', label: 'Pixelate' },
  { id: 'solid', label: 'Solid block' },
];

export function sortRedactions(blocks: RedactBlock[]): RedactBlock[] {
  return [...blocks]
    .filter((block) => block.end > block.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Where the box sits at a moment.
 *
 * Positions are interpolated between the points, so a box set at the start and
 * the end of a scroll follows it the whole way. Outside the points it holds
 * still at the nearest one rather than flying off, which is what makes adding a
 * single point produce a plain fixed box.
 */
export function rectAt(
  block: RedactBlock, time: number,
): { x: number; y: number; width: number; height: number } {
  const points = [...block.points].sort((a, b) => a.time - b.time);
  const width = Math.max(MIN_SIZE, block.width);
  const height = Math.max(MIN_SIZE, block.height);
  const centre = centreAt(points, time);
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

function centreAt(points: RedactPoint[], time: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0.5, y: 0.5 };
  if (time <= points[0].time) return { x: points[0].x, y: points[0].y };
  const last = points[points.length - 1];
  if (time >= last.time) return { x: last.x, y: last.y };

  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (time > to.time) continue;
    const span = to.time - from.time;
    // Two points at the same moment would divide by nothing. Take the later.
    const mix = span <= 0 ? 1 : (time - from.time) / span;
    return { x: from.x + (to.x - from.x) * mix, y: from.y + (to.y - from.y) * mix };
  }
  return { x: last.x, y: last.y };
}

/** The redactions covering a moment. */
export function redactionsAt(blocks: RedactBlock[], time: number): RedactBlock[] {
  return sortRedactions(blocks).filter((block) => time >= block.start && time <= block.end);
}

export function addRedaction(
  blocks: RedactBlock[], at: number, duration: number, id: string,
  focus: { x: number; y: number } = { x: 0.5, y: 0.5 },
  seconds = 3,
): RedactBlock[] {
  const start = Math.max(0, Math.min(at, Math.max(0, duration - MIN_REDACT)));
  const end = Math.min(duration, start + Math.max(MIN_REDACT, seconds));
  // Redactions may overlap each other, unlike zooms: two things on screen can
  // both need hiding at once, and refusing that would be perverse.
  return sortRedactions([...blocks, {
    id,
    start,
    end: Math.max(start + MIN_REDACT, end),
    style: 'blur',
    points: [{ time: start, x: focus.x, y: focus.y }],
    width: 0.25,
    height: 0.08,
  }]);
}

export function removeRedaction(blocks: RedactBlock[], id: string): RedactBlock[] {
  return blocks.filter((block) => block.id !== id);
}

/**
 * Records where the box should be at a moment, so it can follow something.
 *
 * A point at a time that already has one replaces it rather than stacking, so
 * dragging the same box repeatedly at one moment adjusts it instead of building
 * a pile of contradictory instructions.
 */
export function setPoint(
  block: RedactBlock, time: number, x: number, y: number,
): RedactBlock {
  const at = Math.max(block.start, Math.min(block.end, time));
  const kept = block.points.filter((point) => Math.abs(point.time - at) > 0.04);
  return {
    ...block,
    points: [...kept, { time: at, x: clamp01(x), y: clamp01(y) }].sort((a, b) => a.time - b.time),
  };
}

/** Drops a following point, never the last one. */
export function removePoint(block: RedactBlock, time: number): RedactBlock {
  if (block.points.length <= 1) return block;
  const nearest = block.points.reduce((best, point) =>
    Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best, block.points[0]);
  return { ...block, points: block.points.filter((point) => point !== nearest) };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function reviveRedactions(value: unknown, makeId: () => string): RedactBlock[] {
  if (!Array.isArray(value)) return [];
  return sortRedactions(value
    .filter((entry): entry is RedactBlock =>
      typeof entry === 'object' && entry !== null
      && Number.isFinite((entry as RedactBlock).start) && Number.isFinite((entry as RedactBlock).end))
    .map((entry) => {
      const points = Array.isArray(entry.points)
        ? entry.points
          .filter((point) => Number.isFinite(point?.time))
          .map((point) => ({ time: point.time, x: clamp01(point.x), y: clamp01(point.y) }))
        : [];
      return {
        id: typeof entry.id === 'string' ? entry.id : makeId(),
        start: Math.max(0, entry.start),
        end: entry.end,
        style: entry.style === 'pixelate' || entry.style === 'solid' ? entry.style : 'blur',
        // A redaction with no positions would cover nothing, which is the one
        // way this feature can fail dangerously. It gets the middle instead.
        points: points.length ? points : [{ time: Math.max(0, entry.start), x: 0.5, y: 0.5 }],
        width: Math.max(MIN_SIZE, Math.min(1, Number(entry.width) || 0.25)),
        height: Math.max(MIN_SIZE, Math.min(1, Number(entry.height) || 0.08)),
      };
    }));
}
