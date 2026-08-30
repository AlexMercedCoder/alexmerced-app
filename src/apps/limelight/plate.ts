import type { Rect } from './layout';

/**
 * How the recording sits in the frame: tilted, and arriving.
 *
 * The recording is drawn on a plate, and this decides where that plate's four
 * corners land. A tilt is a real rotation in space followed by a perspective
 * divide rather than a squashed rectangle, because the giveaway of a fake tilt
 * is that the near edge and the far edge are the same height.
 *
 * Canvas has no projective transform, only an affine one, so the drawing side
 * cuts the plate into thin strips and places each with its own affine matrix.
 * A thin strip of a trapezium is close enough to a parallelogram that the
 * error is well under a pixel, and this is what every software texture mapper
 * has done for thirty years.
 */

export type Point = { x: number; y: number };

export type Tilt = {
  /** Degrees about the horizontal axis. Positive leans the top away. */
  x: number;
  /** Degrees about the vertical axis. Positive leans the right side away. */
  y: number;
  /** Degrees of roll in the plane of the frame. */
  rotate: number;
  /**
   * How strong the perspective is: how much nearer things grow. Zero gives an
   * isometric look, where a tilt shrinks the plate but nothing converges.
   */
  depth: number;
};

export const defaultTilt: Tilt = { x: 0, y: 0, rotate: 0, depth: 0.35 };

export function hasTilt(tilt: Tilt): boolean {
  return Math.abs(tilt.x) > 0.01 || Math.abs(tilt.y) > 0.01 || Math.abs(tilt.rotate) > 0.01;
}

export function reviveTilt(value: unknown): Tilt {
  if (typeof value !== 'object' || value === null) return { ...defaultTilt };
  const stored = value as Partial<Tilt>;
  const angle = (input: unknown, limit: number, spare: number) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(-limit, Math.min(limit, input)) : spare;
  return {
    x: angle(stored.x, 45, 0),
    y: angle(stored.y, 45, 0),
    rotate: angle(stored.rotate, 30, 0),
    depth: typeof stored.depth === 'number' && Number.isFinite(stored.depth)
      ? Math.max(0, Math.min(1, stored.depth)) : defaultTilt.depth,
  };
}

/**
 * Where the plate's four corners land, clockwise from the top left.
 *
 * The rectangle is treated as lying in the z = 0 plane, rotated about its own
 * middle, and divided through by depth. The result is scaled back so the plate
 * still fills roughly the space it was given, since a tilt that also shrank the
 * recording would feel like two settings in one.
 */
export function tiltCorners(rect: Rect, tilt: Tilt): [Point, Point, Point, Point] {
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const half = { x: rect.width / 2, y: rect.height / 2 };

  if (!hasTilt(tilt)) {
    return [
      { x: centre.x - half.x, y: centre.y - half.y },
      { x: centre.x + half.x, y: centre.y - half.y },
      { x: centre.x + half.x, y: centre.y + half.y },
      { x: centre.x - half.x, y: centre.y + half.y },
    ];
  }

  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  // Negated so a positive angle leans the top and the right side away from the
  // viewer, which is the direction the settings are described in. Rotating the
  // plate the other way would put the near edge where the far edge belongs.
  const ax = -radians(tilt.x);
  const ay = -radians(tilt.y);
  const roll = radians(tilt.rotate);

  // The eye sits this far back, measured in half-diagonals, so the same angle
  // gives the same look whatever size the plate is.
  const reach = Math.hypot(half.x, half.y);
  const distance = reach / Math.max(0.05, Math.min(1, tilt.depth) * 0.9 + 0.1);

  const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    let x = sx * half.x;
    let y = sy * half.y;
    let z = 0;

    // About the vertical axis, then about the horizontal one.
    const rotatedX = x * Math.cos(ay) + z * Math.sin(ay);
    z = -x * Math.sin(ay) + z * Math.cos(ay);
    x = rotatedX;

    const rotatedY = y * Math.cos(ax) - z * Math.sin(ax);
    z = y * Math.sin(ax) + z * Math.cos(ax);
    y = rotatedY;

    // Perspective divide. A corner leaning away is further, so it draws smaller.
    const scale = distance / Math.max(distance * 0.2, distance + z);
    x *= scale;
    y *= scale;

    // Roll happens in the picture plane, after the projection.
    return {
      x: x * Math.cos(roll) - y * Math.sin(roll),
      y: x * Math.sin(roll) + y * Math.cos(roll),
    };
  });

  // A tilt should turn the plate, not shrink it, so the result is scaled back
  // until its longer side matches what it started with.
  const spanX = Math.max(...corners.map((point) => Math.abs(point.x)));
  const spanY = Math.max(...corners.map((point) => Math.abs(point.y)));
  const fit = Math.min(spanX > 0 ? half.x / spanX : 1, spanY > 0 ? half.y / spanY : 1);

  const placed = corners.map((point) => ({ x: point.x * fit, y: point.y * fit }));

  // Perspective is not linear, so a plate rotated about its middle does not
  // come back symmetric: the near edge grows more than the far edge shrinks.
  // Centring what actually came out keeps the plate where it was put.
  const spread = cornersBounds(placed);
  const shiftX = -(spread.x + spread.width / 2);
  const shiftY = -(spread.y + spread.height / 2);

  return placed.map((point) => ({
    x: centre.x + point.x + shiftX,
    y: centre.y + point.y + shiftY,
  })) as [Point, Point, Point, Point];
}

/** The smallest upright box the tilted plate fits inside. */
export function cornersBounds(corners: Point[]): Rect {
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// --------------------------------------------------------------------- arriving

export type Motion = 'none' | 'fade' | 'rise' | 'grow' | 'slide';

export const MOTIONS: { id: Motion; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'rise', label: 'Rise' },
  { id: 'grow', label: 'Grow' },
  { id: 'slide', label: 'Slide in' },
];

export type MotionSettings = {
  entrance: Motion;
  exit: Motion;
  /** How long each takes. */
  seconds: number;
};

export const defaultMotion: MotionSettings = { entrance: 'none', exit: 'none', seconds: 0.6 };

export function reviveMotion(value: unknown): MotionSettings {
  if (typeof value !== 'object' || value === null) return { ...defaultMotion };
  const stored = value as Partial<MotionSettings>;
  const kind = (input: unknown): Motion =>
    MOTIONS.some((entry) => entry.id === input) ? (input as Motion) : 'none';
  return {
    entrance: kind(stored.entrance),
    exit: kind(stored.exit),
    seconds: typeof stored.seconds === 'number' && Number.isFinite(stored.seconds)
      ? Math.max(0.1, Math.min(3, stored.seconds)) : defaultMotion.seconds,
  };
}

export type PlateMotion = { opacity: number; scale: number; offsetX: number; offsetY: number };

export const STILL: PlateMotion = { opacity: 1, scale: 1, offsetX: 0, offsetY: 0 };

/**
 * Eases out: quick at first, settling at the end.
 *
 * Which is the right way round for something arriving. Easing in would have the
 * plate creep for most of the animation and then arrive all at once.
 */
function ease(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) ** 3;
}

/** How a movement looks at a given progress, where 1 is fully arrived. */
function shape(kind: Motion, progress: number): PlateMotion {
  const t = ease(progress);
  switch (kind) {
    case 'fade': return { opacity: t, scale: 1, offsetX: 0, offsetY: 0 };
    case 'rise': return { opacity: t, scale: 1, offsetX: 0, offsetY: (1 - t) * 0.12 };
    case 'grow': return { opacity: t, scale: 0.88 + t * 0.12, offsetX: 0, offsetY: 0 };
    case 'slide': return { opacity: t, scale: 1, offsetX: (1 - t) * -0.18, offsetY: 0 };
    default: return STILL;
  }
}

/**
 * Where the plate is at a moment, given when the export starts and ends.
 *
 * Times are relative to the export rather than to the recording, because an
 * entrance belongs to the video somebody will watch, not to the part of the
 * capture that was trimmed away.
 */
export function plateMotion(
  settings: MotionSettings, time: number, start: number, end: number,
): PlateMotion {
  const length = end - start;
  if (length <= 0) return STILL;
  // Outside the export there is nothing to animate. Scrubbing past the trim
  // should show the recording plainly rather than frozen mid-entrance.
  if (time < start || time > end) return STILL;

  // Neither animation may take more than half, or they would fight over the
  // middle and the recording would never be shown plainly at all.
  const seconds = Math.max(0.05, Math.min(settings.seconds, length / 2));
  const since = time - start;
  const until = end - time;

  if (settings.entrance !== 'none' && since < seconds) return shape(settings.entrance, since / seconds);
  if (settings.exit !== 'none' && until < seconds) return shape(settings.exit, until / seconds);
  return STILL;
}
