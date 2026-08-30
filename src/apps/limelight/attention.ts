/**
 * Working out where to point the camera.
 *
 * A screen recording is mostly still. What matters is the small part that just
 * changed: a menu opening, a field being typed into, a button being pressed.
 * Finding that part is what lets the export zoom in on the right thing.
 *
 * The browser will not tell you where the pointer is while it records another
 * window. The operating system draws the cursor into the frames and the
 * position is never exposed. So there are two sources here, and the app is
 * plain about which one it has:
 *
 *   - A real pointer track, when the recording is of this page, where pointer
 *     events are available.
 *   - Otherwise, where the picture changed between one frame and the next.
 *
 * The second works on any recording at all, including one that was dropped in.
 */

export type Point = { x: number; y: number };

/** A moment worth looking at, in normalised coordinates from 0 to 1. */
export type Interest = {
  time: number;
  x: number;
  y: number;
  /** How much changed, 0 to 1. A click is reported as 1. */
  weight: number;
  source: 'pointer' | 'click' | 'motion';
};

export type PointerSample = { time: number; x: number; y: number };
export type ClickSample = { time: number; x: number; y: number };

// --------------------------------------------------------------------- motion

export type MotionGrid = { columns: number; rows: number; cells: Float32Array };

/**
 * Compares two frames on a coarse grid and reports how much each cell changed.
 *
 * A grid rather than per-pixel, because a cursor moving over a static page
 * changes a handful of pixels and a scroll changes all of them, and the useful
 * signal is somewhere in between. Coarse cells also make this cheap enough to
 * run on every frame of a long recording.
 */
export function motionGrid(
  previous: Uint8ClampedArray, current: Uint8ClampedArray,
  width: number, height: number, columns = 16, rows = 9,
): MotionGrid {
  const cells = new Float32Array(columns * rows);
  const counts = new Uint32Array(columns * rows);

  // Every fourth pixel in each direction. Sixteen times cheaper, and a change
  // small enough to hide from that sample is too small to zoom to.
  const step = 4;

  for (let y = 0; y < height; y += step) {
    const row = Math.min(rows - 1, Math.floor((y / height) * rows));
    for (let x = 0; x < width; x += step) {
      const column = Math.min(columns - 1, Math.floor((x / width) * columns));
      const at = (y * width + x) * 4;
      // Luma difference only. Colour shifts that keep brightness are rare on a
      // screen and cost three times as much to look for.
      const before = previous[at] * 0.299 + previous[at + 1] * 0.587 + previous[at + 2] * 0.114;
      const after = current[at] * 0.299 + current[at + 1] * 0.587 + current[at + 2] * 0.114;
      const index = row * columns + column;
      cells[index] += Math.abs(after - before);
      counts[index] += 1;
    }
  }

  for (let index = 0; index < cells.length; index += 1) {
    cells[index] = counts[index] > 0 ? cells[index] / counts[index] / 255 : 0;
  }
  return { columns, rows, cells };
}

/** How much of the frame changed at all, which is how a scroll is spotted. */
export function motionSpread(grid: MotionGrid, threshold = 0.02): number {
  let active = 0;
  for (const value of grid.cells) if (value >= threshold) active += 1;
  return active / grid.cells.length;
}

/**
 * The centre of the change, weighted by how much each cell moved.
 *
 * Returns null when nothing moved, and also when almost everything did: a
 * scroll or a slide transition has no single place worth looking at, and
 * zooming to the middle of one would be worse than not zooming at all.
 */
export function motionCentre(grid: MotionGrid, threshold = 0.02, spreadLimit = 0.35): Interest | null {
  const spread = motionSpread(grid, threshold);
  if (spread === 0 || spread > spreadLimit) return null;

  let sumX = 0;
  let sumY = 0;
  let total = 0;

  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const value = grid.cells[row * grid.columns + column];
      if (value < threshold) continue;
      // Cell centres, so a single active cell reports its middle.
      sumX += ((column + 0.5) / grid.columns) * value;
      sumY += ((row + 0.5) / grid.rows) * value;
      total += value;
    }
  }

  if (total === 0) return null;
  return {
    time: 0,
    x: sumX / total,
    y: sumY / total,
    weight: Math.min(1, total / grid.cells.length * 8),
    source: 'motion',
  };
}

// --------------------------------------------------------------------- smoothing

/**
 * Smooths a path with a critically damped spring, which is what makes a
 * recorded cursor stop looking like it is being flicked around.
 *
 * A moving average would lag behind and overshoot at the ends. A spring settles
 * without oscillating, which is the behaviour a viewer reads as deliberate.
 */
export function smoothPath(points: Point[], stiffness = 0.18): Point[] {
  if (points.length < 2) return [...points];
  const factor = Math.max(0.01, Math.min(1, stiffness));

  const forward: Point[] = [];
  let current = { ...points[0] };
  for (const point of points) {
    current = {
      x: current.x + (point.x - current.x) * factor,
      y: current.y + (point.y - current.y) * factor,
    };
    forward.push({ ...current });
  }

  // A second pass backwards cancels the lag the first pass introduced, so the
  // smoothed path sits on the original rather than trailing it.
  const smoothed: Point[] = new Array(forward.length);
  current = { ...forward[forward.length - 1] };
  for (let index = forward.length - 1; index >= 0; index -= 1) {
    current = {
      x: current.x + (forward[index].x - current.x) * factor,
      y: current.y + (forward[index].y - current.y) * factor,
    };
    smoothed[index] = { ...current };
  }
  return smoothed;
}

/** Where the pointer was at a given moment, interpolated between samples. */
export function sampleAt(samples: PointerSample[], time: number): Point | null {
  if (samples.length === 0) return null;
  if (time <= samples[0].time) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (time >= last.time) return { x: last.x, y: last.y };

  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (samples[middle].time <= time) low = middle;
    else high = middle;
  }

  const before = samples[low];
  const after = samples[high];
  const span = after.time - before.time;
  const mix = span <= 0 ? 0 : (time - before.time) / span;
  return {
    x: before.x + (after.x - before.x) * mix,
    y: before.y + (after.y - before.y) * mix,
  };
}

// --------------------------------------------------------------------- gathering

/**
 * Turns a pointer track into moments worth looking at. A click always counts.
 * Between clicks, only the places the pointer settled for a moment, because
 * somewhere it passed through on the way is not somewhere to zoom to.
 */
export function interestFromPointer(
  pointer: PointerSample[], clicks: ClickSample[], dwellSeconds = 0.35, moveLimit = 0.03,
): Interest[] {
  const found: Interest[] = clicks.map((click) => ({
    time: click.time, x: click.x, y: click.y, weight: 1, source: 'click' as const,
  }));

  let anchor = pointer[0] ?? null;
  let anchorIndex = 0;

  for (let index = 1; index < pointer.length; index += 1) {
    const sample = pointer[index];
    if (!anchor) { anchor = sample; anchorIndex = index; continue; }

    const moved = Math.hypot(sample.x - anchor.x, sample.y - anchor.y);
    if (moved > moveLimit) {
      // It set off again. If it had been still long enough, that was a rest.
      const rested = pointer[index - 1].time - anchor.time;
      if (rested >= dwellSeconds && index - 1 > anchorIndex) {
        found.push({ time: anchor.time, x: anchor.x, y: anchor.y, weight: 0.6, source: 'pointer' });
      }
      anchor = sample;
      anchorIndex = index;
    }
  }

  return found.sort((a, b) => a.time - b.time);
}

/**
 * Merges moments that are close in time and place into one, so a flurry of
 * clicks on the same button produces a single hold rather than a stutter.
 */
export function mergeInterest(points: Interest[], withinSeconds = 0.8, withinDistance = 0.12): Interest[] {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const merged: Interest[] = [];

  for (const point of sorted) {
    const last = merged[merged.length - 1];
    if (
      last
      && point.time - last.time <= withinSeconds
      && Math.hypot(point.x - last.x, point.y - last.y) <= withinDistance
    ) {
      // Keep the earlier time so the zoom arrives before the action, and the
      // stronger source, so a click is not demoted by nearby motion.
      const weight = Math.max(last.weight, point.weight);
      const total = last.weight + point.weight;
      last.x = (last.x * last.weight + point.x * point.weight) / total;
      last.y = (last.y * last.weight + point.y * point.weight) / total;
      last.weight = weight;
      if (point.source === 'click') last.source = 'click';
      continue;
    }
    merged.push({ ...point });
  }

  return merged;
}
