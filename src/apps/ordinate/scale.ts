/**
 * Axis maths. Kept apart from anything that draws, so the tick choices and the
 * scale arithmetic can be tested without a DOM.
 */

export type Scale = {
  /** Maps a data value onto a pixel position. */
  (value: number): number;
  domain: [number, number];
  range: [number, number];
};

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((value: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0))) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/**
 * Rounds a raw step up to the nearest 1, 2, 5, or 10 times a power of ten.
 * Ticks land on numbers people recognise instead of 3.7142857.
 */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

export type Ticks = { values: number[]; domain: [number, number]; step: number };

/**
 * Picks tick values and widens the domain out to them, so the top gridline is
 * the top of the plot rather than floating somewhere below it.
 */
export function niceTicks(min: number, max: number, count = 5): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { values: [0, 1], domain: [0, 1], step: 1 };

  if (min === max) {
    // A flat series still needs somewhere to sit. Give it room either side.
    const pad = Math.abs(min) > 0 ? Math.abs(min) / 2 : 1;
    min -= pad;
    max += pad;
  }

  const step = niceStep((max - min) / Math.max(1, count));
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;

  const values: number[] = [];
  // Counting in integers and multiplying avoids the drift you get from
  // repeatedly adding a fractional step.
  const steps = Math.round((high - low) / step);
  for (let index = 0; index <= steps; index += 1) {
    values.push(round(low + index * step, step));
  }
  return { values, domain: [low, high], step };
}

/** Trims floating point fuzz relative to the step size. */
function round(value: number, step: number): number {
  const places = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const factor = 10 ** Math.min(12, places);
  return Math.round(value * factor) / factor;
}

/** Bar and column charts have to include zero or they lie about proportion. */
export function includeZero(min: number, max: number): [number, number] {
  return [Math.min(0, min), Math.max(0, max)];
}

export function extent(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === Infinity) return [0, 1];
  return [min, max];
}

/** Short axis labels: 1200 becomes 1.2k, 3400000 becomes 3.4M. */
export function formatTick(value: number, step: number): string {
  if (value === 0) return '0';
  const absolute = Math.abs(value);
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [size, suffix] of units) {
    if (absolute >= size && step >= size / 100) {
      const scaled = value / size;
      return `${trim(scaled)}${suffix}`;
    }
  }
  const places = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  return trim(Number(value.toFixed(places)));
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * Chooses how many category labels to draw so they do not collide. Returns the
 * stride: every nth label is kept.
 */
export function labelStride(count: number, available: number, longest: number): number {
  if (count === 0) return 1;
  const perLabel = Math.max(24, longest * 6.2 + 12);
  const fits = Math.max(1, Math.floor(available / perLabel));
  return Math.max(1, Math.ceil(count / fits));
}

/**
 * Catmull-Rom to cubic Bezier, which is how a smoothed line gets drawn without
 * overshooting the way a naive spline does.
 */
export function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return '';
  if (points.length < 3) return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fixed(x)} ${fixed(y)}`).join(' ');

  const parts = [`M${fixed(points[0][0])} ${fixed(points[0][1])}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    parts.push(`C${fixed(c1x)} ${fixed(c1y)} ${fixed(c2x)} ${fixed(c2y)} ${fixed(p2[0])} ${fixed(p2[1])}`);
  }
  return parts.join(' ');
}

export function straightPath(points: [number, number][]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${fixed(x)} ${fixed(y)}`).join(' ');
}

export function fixed(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Slice geometry for a pie or doughnut, starting at twelve o'clock. */
export function pieSlices(values: number[], radius: number, inner = 0): { path: string; midAngle: number; fraction: number }[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return [];

  let angle = -Math.PI / 2;
  return values.map((raw) => {
    const value = Math.max(0, raw);
    const fraction = value / total;
    const sweep = fraction * Math.PI * 2;
    const end = angle + sweep;
    const midAngle = angle + sweep / 2;
    // A slice covering the whole circle cannot be drawn as one arc, because the
    // start and end points coincide and the renderer draws nothing.
    const path = fraction >= 0.9999 ? fullRing(radius, inner) : slicePath(angle, end, radius, inner);
    angle = end;
    return { path, midAngle, fraction };
  });
}

function point(angle: number, radius: number): string {
  return `${fixed(Math.cos(angle) * radius)} ${fixed(Math.sin(angle) * radius)}`;
}

function slicePath(start: number, end: number, radius: number, inner: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  if (inner <= 0) {
    return `M0 0 L${point(start, radius)} A${fixed(radius)} ${fixed(radius)} 0 ${large} 1 ${point(end, radius)} Z`;
  }
  return [
    `M${point(start, inner)}`,
    `L${point(start, radius)}`,
    `A${fixed(radius)} ${fixed(radius)} 0 ${large} 1 ${point(end, radius)}`,
    `L${point(end, inner)}`,
    `A${fixed(inner)} ${fixed(inner)} 0 ${large} 0 ${point(start, inner)}`,
    'Z',
  ].join(' ');
}

function fullRing(radius: number, inner: number): string {
  const circle = (r: number, sweep: number) =>
    `M0 ${fixed(-r)} A${fixed(r)} ${fixed(r)} 0 1 ${sweep} 0 ${fixed(r)} A${fixed(r)} ${fixed(r)} 0 1 ${sweep} 0 ${fixed(-r)} Z`;
  return inner > 0 ? `${circle(radius, 1)} ${circle(inner, 0)}` : circle(radius, 1);
}
