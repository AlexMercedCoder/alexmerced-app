/**
 * Projective geometry shared by anything that has to read a flat thing seen at
 * an angle: a photographed page, a QR code held off square.
 *
 * A plane photographed from any viewpoint is a projective transform of itself,
 * and four point correspondences are exactly enough to pin that transform down.
 */

export type Point = { x: number; y: number };

/** A 3x3 matrix in row-major order. */
export type Matrix = number[];

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
