/**
 * Pointing at things.
 *
 * Text overlays say something; a shape shows where. In a screen recording that
 * is usually the whole explanation: the arrow lands on the button, the box goes
 * round the line of output that matters, and nothing needs to be said about
 * where to look.
 *
 * One geometry serves every kind. A shape is a start point and an offset, so an
 * arrow runs from one to the other and a box spans between them. Negative
 * offsets are allowed and mean the shape was drawn right to left, which is how
 * people actually drag.
 */

export type ShapeKind = 'arrow' | 'box' | 'ellipse' | 'highlight';

export type Shape = {
  id: string;
  start: number;
  end: number;
  kind: ShapeKind;
  /** Tail of an arrow, or a corner of a box. Fractions of the frame. */
  x: number;
  y: number;
  /** Offset to the head, or the opposite corner. May be negative. */
  width: number;
  height: number;
  colour: string;
  /** Line weight as a fraction of the smaller side of the frame. */
  thickness: number;
  /** Seconds of fade at each end. */
  fade: number;
};

export const MIN_SHAPE = 0.2;

export const SHAPE_KINDS: { id: ShapeKind; label: string }[] = [
  { id: 'arrow', label: 'Arrow' },
  { id: 'box', label: 'Box' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'highlight', label: 'Highlight' },
];

export const SHAPE_COLOURS = ['#e0a458', '#e0796f', '#7fb0dd', '#74b98d', '#f6f4ef', '#101014'];

export function sortShapes(shapes: Shape[]): Shape[] {
  return [...shapes]
    .filter((shape) => shape.end > shape.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The shapes visible at a moment, with how far faded in they are.
 *
 * Opacity rather than a boolean, because a shape that appears and vanishes
 * instantly reads as a glitch. Kept alongside the shape so the renderer does
 * not have to work it out twice.
 */
export function shapesAt(shapes: Shape[], time: number): { shape: Shape; opacity: number }[] {
  const out: { shape: Shape; opacity: number }[] = [];
  for (const shape of sortShapes(shapes)) {
    if (time < shape.start || time > shape.end) continue;
    const fade = Math.max(0, shape.fade);
    if (fade <= 0) { out.push({ shape, opacity: 1 }); continue; }

    const since = time - shape.start;
    const until = shape.end - time;
    // A shape shorter than two fades would never reach full strength, so the
    // fade is shared out rather than letting the two ends fight.
    const room = Math.min(fade, (shape.end - shape.start) / 2);
    const opacity = Math.min(1, Math.min(since, until) / Math.max(1e-6, room));
    out.push({ shape, opacity: Math.max(0, opacity) });
  }
  return out;
}

/** The rectangle a shape covers, normalised so width and height are positive. */
export function boundsOf(shape: Shape): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(shape.x, shape.x + shape.width),
    y: Math.min(shape.y, shape.y + shape.height),
    width: Math.abs(shape.width),
    height: Math.abs(shape.height),
  };
}

export function addShape(
  shapes: Shape[], at: number, duration: number, kind: ShapeKind, id: string, seconds = 3,
): Shape[] {
  const start = Math.max(0, Math.min(at, Math.max(0, duration - MIN_SHAPE)));
  const end = Math.min(duration, start + Math.max(MIN_SHAPE, seconds));
  return sortShapes([...shapes, {
    id,
    start,
    end: Math.max(start + MIN_SHAPE, end),
    kind,
    // A sensible default in the middle, since a shape drawn nowhere is no use
    // and the person is about to drag it anyway.
    x: 0.35,
    y: 0.4,
    width: kind === 'arrow' ? 0.2 : 0.3,
    height: kind === 'arrow' ? 0.12 : 0.2,
    colour: SHAPE_COLOURS[0],
    thickness: 0.006,
    fade: 0.25,
  }]);
}

export function removeShape(shapes: Shape[], id: string): Shape[] {
  return shapes.filter((shape) => shape.id !== id);
}

export function updateShape(shapes: Shape[], id: string, change: Partial<Shape>): Shape[] {
  return sortShapes(shapes.map((shape) => (shape.id === id ? { ...shape, ...change } : shape)));
}

export function reviveShapes(value: unknown, makeId: () => string): Shape[] {
  if (!Array.isArray(value)) return [];
  const clamp = (input: unknown, fallback: number, low = -1, high = 2) => {
    const number = Number(input);
    return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
  };
  return sortShapes(value
    .filter((entry): entry is Shape =>
      typeof entry === 'object' && entry !== null
      && Number.isFinite((entry as Shape).start) && Number.isFinite((entry as Shape).end))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : makeId(),
      start: Math.max(0, entry.start),
      end: entry.end,
      kind: SHAPE_KINDS.some((kind) => kind.id === entry.kind) ? entry.kind : 'box',
      x: clamp(entry.x, 0.35),
      y: clamp(entry.y, 0.4),
      width: clamp(entry.width, 0.3),
      height: clamp(entry.height, 0.2),
      colour: typeof entry.colour === 'string' && /^#[0-9a-f]{6}$/i.test(entry.colour)
        ? entry.colour : SHAPE_COLOURS[0],
      thickness: clamp(entry.thickness, 0.006, 0.001, 0.05),
      fade: clamp(entry.fade, 0.25, 0, 3),
    })));
}
