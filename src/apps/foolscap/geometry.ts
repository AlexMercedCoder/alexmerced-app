/**
 * Page geometry: putting four corners into a known order, working out the
 * rectangle they came from, and warping the pixels onto it.
 *
 * The projective maths itself lives in the shared library, because reading a QR
 * code held off square needs exactly the same thing.
 */
import { applyMatrix, distance, homography, invert, solve, type Matrix, type Point } from '../../lib/homography';

export { applyMatrix, distance, homography, invert, solve };
export type { Matrix, Point };

/**
 * Puts four corners into a known order: top left, top right, bottom right,
 * bottom left. Without this the output can come out rotated or mirrored
 * depending on which corner the detector happened to find first.
 */
export function orderCorners(points: Point[]): Point[] {
  if (points.length !== 4) throw new Error('Four corners are needed.');

  const centre = {
    x: points.reduce((sum, point) => sum + point.x, 0) / 4,
    y: points.reduce((sum, point) => sum + point.y, 0) / 4,
  };

  // Sorting by angle around the centre gives a consistent winding, and then the
  // corner nearest the origin decides where the sequence starts.
  const byAngle = [...points].sort(
    (a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x),
  );

  let startIndex = 0;
  let best = Infinity;
  byAngle.forEach((point, index) => {
    const score = point.x + point.y;
    if (score < best) {
      best = score;
      startIndex = index;
    }
  });

  return [0, 1, 2, 3].map((offset) => byAngle[(startIndex + offset) % 4]);
}

/**
 * Estimates the rectangle the corners came from. Opposite edges are averaged,
 * because perspective makes the near edge longer than the far one.
 */
export function targetSize(corners: Point[]): { width: number; height: number } {
  const [tl, tr, br, bl] = corners;
  const width = Math.max(distance(tl, tr), distance(bl, br));
  const height = Math.max(distance(tl, bl), distance(tr, br));
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * Warps the source pixels into a rectangle of the given size using bilinear
 * sampling, which keeps text legible where nearest neighbour would not.
 */
export function warp(
  source: ImageData, corners: Point[], width: number, height: number,
): ImageData {
  const destination = [
    { x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 },
  ];
  const inverse = invert(homography(corners, destination));

  const output = new ImageData(width, height);
  const src = source.data;
  const dst = output.data;
  const [a, b, c, d, e, f, g, h, i] = inverse;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const w = g * x + h * y + i;
      const sx = (a * x + b * y + c) / w;
      const sy = (d * x + e * y + f) / w;
      const at = (y * width + x) * 4;

      if (sx < 0 || sy < 0 || sx > source.width - 1 || sy > source.height - 1) {
        dst[at] = 255; dst[at + 1] = 255; dst[at + 2] = 255; dst[at + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const y1 = Math.min(source.height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;

      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = src[(y0 * source.width + x0) * 4 + channel];
        const p10 = src[(y0 * source.width + x1) * 4 + channel];
        const p01 = src[(y1 * source.width + x0) * 4 + channel];
        const p11 = src[(y1 * source.width + x1) * 4 + channel];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        dst[at + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }

  return output;
}

/** Scales corner positions between a preview and the full resolution image. */
export function scalePoints(points: Point[], factor: number): Point[] {
  return points.map((point) => ({ x: point.x * factor, y: point.y * factor }));
}

export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  };
}

/** The corners of the whole frame, used when detection finds nothing. */
export function fullFrame(width: number, height: number): Point[] {
  return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
}

/** Twice the signed area, which is positive for a counter-clockwise winding. */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** True if no interior angle folds back, which is what a page outline must satisfy. */
export function isConvex(points: Point[]): boolean {
  if (points.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}
