/**
 * The maths behind straightening a photographed page.
 *
 * A page shot at an angle is a projective transform of a rectangle. Given the
 * four corners in the photo, a homography maps them back onto a rectangle. All
 * of this is pure arithmetic, which is the only reason it can be tested.
 */

export type Point = { x: number; y: number };

/** A 3x3 matrix in row-major order. */
export type Matrix = number[];

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

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
 * Solves for the homography taking four source points to four destination
 * points, by setting up the eight linear equations and eliminating.
 */
export function homography(from: Point[], to: Point[]): Matrix {
  if (from.length !== 4 || to.length !== 4) throw new Error('Four point pairs are needed.');

  // Each correspondence gives two rows. The ninth element is fixed at 1, which
  // is what makes eight unknowns rather than nine.
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = from[index];
    const { x: u, y: v } = to[index];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  const solution = solve(rows, 8);
  if (!solution) throw new Error('These corners are degenerate, so no transform exists.');
  return [...solution, 1];
}

/** Gaussian elimination with partial pivoting on an augmented matrix. */
export function solve(rows: number[][], size: number): number[] | null {
  const matrix = rows.map((row) => [...row]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-12) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];

    const lead = matrix[column][column];
    for (let index = column; index <= size; index += 1) matrix[column][index] /= lead;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      if (factor === 0) continue;
      for (let index = column; index <= size; index += 1) matrix[row][index] -= factor * matrix[column][index];
    }
  }

  return matrix.slice(0, size).map((row) => row[size]);
}

export function applyMatrix(matrix: Matrix, point: Point): Point {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const w = g * point.x + h * point.y + i;
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (a * point.x + b * point.y + c) / w,
    y: (d * point.x + e * point.y + f) / w,
  };
}

/** Inverts a 3x3 matrix, which is what maps output pixels back to source pixels. */
export function invert(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (Math.abs(determinant) < 1e-12) throw new Error('This transform cannot be inverted.');

  return [
    A / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant,
    B / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant,
    C / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant,
  ];
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
