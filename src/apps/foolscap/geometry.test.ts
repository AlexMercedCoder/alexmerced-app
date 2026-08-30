import { describe, expect, it } from 'vitest';
import {
  applyMatrix, clampPoint, distance, fullFrame, homography, invert, isConvex, orderCorners,
  polygonArea, scalePoints, solve, targetSize, warp, type Point,
} from './geometry';

const SQUARE: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

describe('orderCorners', () => {
  it('returns top left, top right, bottom right, bottom left', () => {
    expect(orderCorners(SQUARE)).toEqual(SQUARE);
  });

  it('reorders whatever order it is given', () => {
    const shuffled = [SQUARE[2], SQUARE[0], SQUARE[3], SQUARE[1]];
    expect(orderCorners(shuffled)).toEqual(SQUARE);
  });

  it('handles a rotated quadrilateral', () => {
    const tilted: Point[] = [{ x: 5, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 5 }];
    const ordered = orderCorners(tilted);
    // The corner closest to the origin comes first, and the winding is preserved.
    expect(ordered[0]).toEqual({ x: 5, y: 0 });
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map((p) => `${p.x},${p.y}`)).size).toBe(4);
  });

  it('handles a perspective trapezoid', () => {
    const trapezoid: Point[] = [{ x: 30, y: 10 }, { x: 70, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }];
    expect(orderCorners([...trapezoid].reverse())).toEqual(trapezoid);
  });

  it('refuses anything other than four points', () => {
    expect(() => orderCorners(SQUARE.slice(0, 3))).toThrow(/Four corners/);
  });
});

describe('targetSize', () => {
  it('measures a square', () => {
    expect(targetSize(SQUARE)).toEqual({ width: 10, height: 10 });
  });

  it('takes the longer of two opposite edges, since perspective shortens the far one', () => {
    const trapezoid: Point[] = [{ x: 20, y: 0 }, { x: 80, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    expect(targetSize(trapezoid).width).toBe(100);
  });

  it('never returns zero', () => {
    const degenerate = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    expect(targetSize(degenerate)).toEqual({ width: 1, height: 1 });
  });
});

describe('solve', () => {
  it('solves a small system', () => {
    // 2x + y = 5, x - y = 1  gives x = 2, y = 1
    const answer = solve([[2, 1, 5], [1, -1, 1]], 2)!;
    expect(answer[0]).toBeCloseTo(2);
    expect(answer[1]).toBeCloseTo(1);
  });

  it('returns null when the system is singular', () => {
    expect(solve([[1, 1, 2], [2, 2, 4]], 2)).toBeNull();
  });

  it('pivots rather than dividing by a zero on the diagonal', () => {
    const answer = solve([[0, 1, 3], [1, 0, 4]], 2)!;
    expect(answer[0]).toBeCloseTo(4);
    expect(answer[1]).toBeCloseTo(3);
  });
});

describe('homography', () => {
  it('maps each source corner exactly onto its destination', () => {
    const source: Point[] = [{ x: 12, y: 5 }, { x: 92, y: 18 }, { x: 88, y: 74 }, { x: 4, y: 66 }];
    const destination: Point[] = [{ x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 99 }, { x: 0, y: 99 }];
    const matrix = homography(source, destination);
    source.forEach((point, index) => {
      const mapped = applyMatrix(matrix, point);
      expect(mapped.x).toBeCloseTo(destination[index].x, 6);
      expect(mapped.y).toBeCloseTo(destination[index].y, 6);
    });
  });

  it('reduces to a plain scale for a rectangle', () => {
    const matrix = homography(SQUARE, [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]);
    const middle = applyMatrix(matrix, { x: 5, y: 5 });
    expect(middle.x).toBeCloseTo(10, 6);
    expect(middle.y).toBeCloseTo(10, 6);
  });

  it('refuses four collinear points', () => {
    const line: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    expect(() => homography(line, SQUARE)).toThrow(/degenerate/);
  });

  it('needs four pairs', () => {
    expect(() => homography(SQUARE.slice(0, 3), SQUARE)).toThrow(/Four point pairs/);
  });
});

describe('invert', () => {
  it('undoes a transform', () => {
    const source: Point[] = [{ x: 3, y: 7 }, { x: 60, y: 2 }, { x: 71, y: 55 }, { x: 8, y: 49 }];
    const destination: Point[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
    const matrix = homography(source, destination);
    const back = invert(matrix);

    const probe = { x: 25, y: 25 };
    const round = applyMatrix(back, applyMatrix(matrix, probe));
    expect(round.x).toBeCloseTo(probe.x, 5);
    expect(round.y).toBeCloseTo(probe.y, 5);
  });

  it('refuses a singular matrix', () => {
    expect(() => invert([1, 2, 3, 2, 4, 6, 3, 6, 9])).toThrow(/cannot be inverted/);
  });
});

describe('warp', () => {
  /** A gradient image, so a warp can be checked by where the values land. */
  function gradient(width: number, height: number): ImageData {
    const image = new ImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        image.data[at] = Math.round((x / (width - 1)) * 255);
        image.data[at + 1] = Math.round((y / (height - 1)) * 255);
        image.data[at + 2] = 0;
        image.data[at + 3] = 255;
      }
    }
    return image;
  }

  function pixel(image: ImageData, x: number, y: number): number[] {
    const at = (y * image.width + x) * 4;
    return [image.data[at], image.data[at + 1], image.data[at + 2], image.data[at + 3]];
  }

  it('returns an image of the size asked for', () => {
    const result = warp(gradient(40, 40), fullFrame(39, 39), 20, 30);
    expect(result.width).toBe(20);
    expect(result.height).toBe(30);
  });

  it('copies an identity crop through unchanged', () => {
    const source = gradient(16, 16);
    const result = warp(source, [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 0, y: 15 }], 16, 16);
    expect(pixel(result, 0, 0)).toEqual(pixel(source, 0, 0));
    expect(pixel(result, 15, 15)).toEqual(pixel(source, 15, 15));
    expect(pixel(result, 8, 4)).toEqual(pixel(source, 8, 4));
  });

  it('straightens a rotated square back into a rectangle', () => {
    // Take the middle diamond of a gradient and warp it flat.
    const source = gradient(64, 64);
    const diamond: Point[] = [{ x: 32, y: 8 }, { x: 56, y: 32 }, { x: 32, y: 56 }, { x: 8, y: 32 }];
    const result = warp(source, diamond, 32, 32);
    // The output corners should carry the colours from the diamond's corners.
    expect(pixel(result, 0, 0)[0]).toBeCloseTo(pixel(source, 32, 8)[0], -1);
    expect(pixel(result, 31, 0)[0]).toBeCloseTo(pixel(source, 56, 32)[0], -1);
  });

  it('paints white outside the source rather than leaving transparent holes', () => {
    const source = gradient(20, 20);
    // Corners reaching outside the image force sampling off the edge.
    const outside: Point[] = [{ x: -20, y: -20 }, { x: 40, y: -20 }, { x: 40, y: 40 }, { x: -20, y: 40 }];
    const result = warp(source, outside, 20, 20);
    expect(pixel(result, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(result.data[3]).toBe(255);
  });

  it('interpolates rather than stepping, so a scaled gradient stays smooth', () => {
    const source = gradient(8, 8);
    const result = warp(source, fullFrame(7, 7), 32, 32);
    const values = Array.from({ length: 32 }, (_, x) => pixel(result, x, 16)[0]);
    // A nearest neighbour scale would repeat each value four times.
    const distinct = new Set(values).size;
    expect(distinct).toBeGreaterThan(8);
  });
});

describe('helpers', () => {
  it('scales points by a factor', () => {
    expect(scalePoints([{ x: 2, y: 3 }], 2)).toEqual([{ x: 4, y: 6 }]);
  });

  it('clamps a point into the frame', () => {
    expect(clampPoint({ x: -5, y: 200 }, 100, 100)).toEqual({ x: 0, y: 100 });
  });

  it('measures distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('measures polygon area', () => {
    expect(polygonArea(SQUARE)).toBe(100);
    expect(polygonArea(fullFrame(4, 6))).toBe(24);
  });

  it('recognises a convex quadrilateral', () => {
    expect(isConvex(SQUARE)).toBe(true);
    expect(isConvex([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 10 }])).toBe(false);
  });

  it('says a degenerate shape is not convex', () => {
    expect(isConvex([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);
  });
});
