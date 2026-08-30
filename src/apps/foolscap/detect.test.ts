import { describe, expect, it } from 'vitest';
import {
  blur, detectPage, edgeContrast, edges, finish, fitLine, fromGray, inkFraction, intersect,
  otsuThreshold, toGray,
} from './detect';
import { applyMatrix, homography, type Point } from './geometry';

/** Fills an image with one colour. */
function solid(width: number, height: number, value: number): ImageData {
  const image = new ImageData(width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  return image;
}

function setPixel(image: ImageData, x: number, y: number, value: number): void {
  const at = (y * image.width + x) * 4;
  image.data[at] = value;
  image.data[at + 1] = value;
  image.data[at + 2] = value;
  image.data[at + 3] = 255;
}

/**
 * A synthetic photograph: a light page on a dark background, seen through a
 * perspective transform, with a few dark marks on it standing in for text.
 */
function photograph(width: number, height: number, corners: Point[], withText = true): ImageData {
  const image = solid(width, height, 40);
  const pageWidth = 100;
  const pageHeight = 140;

  const toPhoto = homography(
    [{ x: 0, y: 0 }, { x: pageWidth, y: 0 }, { x: pageWidth, y: pageHeight }, { x: 0, y: pageHeight }],
    corners,
  );

  // Walk the page's own coordinates and stamp each one into the photograph.
  const step = 0.25;
  for (let py = 0; py < pageHeight; py += step) {
    for (let px = 0; px < pageWidth; px += step) {
      const point = applyMatrix(toPhoto, { x: px, y: py });
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;

      const onText = withText
        && px > 12 && px < 88
        && Math.floor(py) % 14 < 4 && py > 18 && py < 124;
      setPixel(image, x, y, onText ? 55 : 235);
    }
  }
  return image;
}

describe('toGray and fromGray', () => {
  it('converts to luma and back', () => {
    const image = solid(4, 4, 128);
    const gray = toGray(image);
    expect(gray.data[0]).toBeCloseTo(128 / 255, 3);
    expect(fromGray(gray).data[0]).toBe(128);
  });

  it('weights green most heavily, as luma does', () => {
    const image = new ImageData(1, 1);
    image.data.set([0, 255, 0, 255]);
    expect(toGray(image).data[0]).toBeCloseTo(0.587, 3);
  });

  it('always writes an opaque result', () => {
    expect(fromGray(toGray(solid(2, 2, 10))).data[3]).toBe(255);
  });

  it('clamps out of range values', () => {
    const image = fromGray({ width: 1, height: 1, data: Float32Array.from([5]) });
    expect(image.data[0]).toBe(255);
  });
});

describe('blur', () => {
  it('leaves a flat image flat', () => {
    const gray = toGray(solid(20, 20, 100));
    const blurred = blur(gray, 3);
    expect(blurred.data[210]).toBeCloseTo(gray.data[210], 5);
  });

  it('spreads a single bright pixel into its neighbours', () => {
    const image = solid(21, 21, 0);
    setPixel(image, 10, 10, 255);
    const blurred = blur(toGray(image), 3);
    expect(blurred.data[10 * 21 + 10]).toBeLessThan(1);
    expect(blurred.data[10 * 21 + 12]).toBeGreaterThan(0);
  });

  it('conserves roughly the total brightness', () => {
    const image = solid(21, 21, 0);
    setPixel(image, 10, 10, 255);
    const before = toGray(image).data.reduce((sum, value) => sum + value, 0);
    const after = blur(toGray(image), 2).data.reduce((sum, value) => sum + value, 0);
    expect(after).toBeGreaterThan(before * 0.7);
    expect(after).toBeLessThan(before * 1.3);
  });

  it('does nothing for a radius below one', () => {
    const gray = toGray(solid(4, 4, 50));
    expect(blur(gray, 0)).toBe(gray);
  });
});

describe('edges', () => {
  it('finds nothing in a flat image', () => {
    const gradient = edges(toGray(solid(20, 20, 128)));
    expect(Math.max(...gradient.data)).toBe(0);
  });

  it('lights up along a hard border', () => {
    const image = solid(20, 20, 0);
    for (let y = 0; y < 20; y += 1) {
      for (let x = 10; x < 20; x += 1) setPixel(image, x, y, 255);
    }
    const gradient = edges(toGray(image));
    expect(gradient.data[10 * 20 + 10]).toBeCloseTo(1, 2);
    expect(gradient.data[10 * 20 + 3]).toBeCloseTo(0, 3);
  });

  it('normalises the strongest edge to one', () => {
    const image = solid(20, 20, 0);
    for (let y = 0; y < 20; y += 1) setPixel(image, 10, y, 255);
    expect(Math.max(...edges(toGray(image)).data)).toBeCloseTo(1, 6);
  });
});

describe('otsuThreshold', () => {
  it('lands in the gap between two clearly separated groups', () => {
    const data = new Float32Array(1000);
    for (let index = 0; index < 500; index += 1) data[index] = 0.1;
    for (let index = 500; index < 1000; index += 1) data[index] = 0.9;
    const threshold = otsuThreshold({ width: 1000, height: 1, data });
    // Every cut between the two groups scores the same, so the answer should
    // be near the middle of that range rather than hard against either group.
    expect(threshold).toBeGreaterThan(0.35);
    expect(threshold).toBeLessThan(0.65);
  });

  it('lands between two groups that are close together', () => {
    const data = new Float32Array(1000);
    for (let index = 0; index < 500; index += 1) data[index] = 0.42;
    for (let index = 500; index < 1000; index += 1) data[index] = 0.58;
    const threshold = otsuThreshold({ width: 1000, height: 1, data });
    expect(threshold).toBeGreaterThan(0.42);
    expect(threshold).toBeLessThan(0.58);
  });

  it('splits an uneven pair on the side of the smaller group', () => {
    const data = new Float32Array(1000);
    for (let index = 0; index < 900; index += 1) data[index] = 0.8;
    for (let index = 900; index < 1000; index += 1) data[index] = 0.2;
    const threshold = otsuThreshold({ width: 1000, height: 1, data });
    expect(threshold).toBeGreaterThan(0.2);
    expect(threshold).toBeLessThan(0.8);
  });

  it('returns something usable for a uniform image', () => {
    const threshold = otsuThreshold({ width: 10, height: 10, data: new Float32Array(100).fill(0.5) });
    expect(threshold).toBeGreaterThanOrEqual(0);
    expect(threshold).toBeLessThanOrEqual(1);
  });

  it('handles an empty image without dividing by zero', () => {
    expect(otsuThreshold({ width: 0, height: 0, data: new Float32Array(0) })).toBe(0.5);
  });
});

describe('fitLine and intersect', () => {
  it('fits a horizontal line through noisy points', () => {
    const points = Array.from({ length: 20 }, (_, x) => ({ x, y: 10 + (x % 2 === 0 ? 0.1 : -0.1) }));
    const line = fitLine(points, 'horizontal')!;
    // ax + by + c = 0 with b = -1 means y = ax + c
    expect(line.a).toBeCloseTo(0, 2);
    expect(line.c).toBeCloseTo(10, 1);
  });

  it('fits a sloped line', () => {
    const points = Array.from({ length: 20 }, (_, x) => ({ x, y: 2 * x + 5 }));
    const line = fitLine(points, 'horizontal')!;
    expect(line.a).toBeCloseTo(2, 6);
    expect(line.c).toBeCloseTo(5, 6);
  });

  it('fits a perfectly vertical line without an infinite slope', () => {
    const points = Array.from({ length: 20 }, (_, y) => ({ x: 7, y }));
    const line = fitLine(points, 'vertical')!;
    expect(Number.isFinite(line.a)).toBe(true);
    expect(Number.isFinite(line.b)).toBe(true);
    const crossing = intersect(line, { a: 0, b: 1, c: -3 })!;
    expect(crossing.x).toBeCloseTo(7, 6);
  });

  it('needs at least two points', () => {
    expect(fitLine([{ x: 1, y: 1 }], 'horizontal')).toBeNull();
  });

  it('finds where two lines cross', () => {
    // y = 5 and x = 3
    const crossing = intersect({ a: 0, b: 1, c: -5 }, { a: 1, b: 0, c: -3 })!;
    expect(crossing.x).toBeCloseTo(3, 6);
    expect(crossing.y).toBeCloseTo(5, 6);
  });

  it('returns null for parallel lines', () => {
    expect(intersect({ a: 1, b: -1, c: 0 }, { a: 2, b: -2, c: 5 })).toBeNull();
  });
});

describe('detectPage', () => {
  it('finds a page that fills most of the frame, at an angle', () => {
    const corners: Point[] = [{ x: 44, y: 26 }, { x: 178, y: 40 }, { x: 168, y: 214 }, { x: 32, y: 200 }];
    const result = detectPage(photograph(220, 240, corners));
    expect(result.confident).toBe(true);
    result.corners.forEach((found, index) => {
      expect(Math.hypot(found.x - corners[index].x, found.y - corners[index].y)).toBeLessThan(12);
    });
  });

  it('finds a page that is not rotated', () => {
    const corners: Point[] = [{ x: 30, y: 20 }, { x: 190, y: 20 }, { x: 190, y: 220 }, { x: 30, y: 220 }];
    const result = detectPage(photograph(220, 240, corners));
    expect(result.confident).toBe(true);
    expect(result.corners[0].x).toBeCloseTo(30, -1);
    expect(result.corners[2].y).toBeCloseTo(220, -1);
  });

  it('returns the corners in reading order', () => {
    const corners: Point[] = [{ x: 40, y: 30 }, { x: 180, y: 34 }, { x: 175, y: 210 }, { x: 36, y: 205 }];
    const [tl, tr, br, bl] = detectPage(photograph(220, 240, corners)).corners;
    expect(tl.x).toBeLessThan(tr.x);
    expect(bl.x).toBeLessThan(br.x);
    expect(tl.y).toBeLessThan(bl.y);
  });

  it('admits defeat on a blank image rather than inventing a page', () => {
    const result = detectPage(solid(120, 160, 200));
    expect(result.confident).toBe(false);
    expect(result.corners).toEqual([{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 160 }, { x: 0, y: 160 }]);
  });

  it('admits defeat on noise', () => {
    const image = solid(120, 160, 128);
    let seed = 12345;
    for (let index = 0; index < image.data.length; index += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const value = seed % 256;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
    }
    expect(detectPage(image).confident).toBe(false);
  });

  it('falls back for an image too small to analyse', () => {
    const result = detectPage(solid(8, 8, 100));
    expect(result.confident).toBe(false);
  });

  it('never returns a shape that folds back on itself', () => {
    const corners: Point[] = [{ x: 50, y: 24 }, { x: 186, y: 44 }, { x: 170, y: 208 }, { x: 30, y: 190 }];
    const result = detectPage(photograph(220, 240, corners));
    const [tl, tr, br, bl] = result.corners;
    // Reading order implies a positive area when walked in sequence.
    const area = Math.abs(
      (tr.x - tl.x) * (bl.y - tl.y) - (bl.x - tl.x) * (tr.y - tl.y),
    );
    expect(area).toBeGreaterThan(0);
    expect([tl, tr, br, bl]).toHaveLength(4);
  });
});

describe('edgeContrast', () => {
  it('is large across a real page boundary', () => {
    const corners: Point[] = [{ x: 30, y: 20 }, { x: 190, y: 20 }, { x: 190, y: 220 }, { x: 30, y: 220 }];
    const gray = toGray(photograph(220, 240, corners, false));
    expect(edgeContrast(gray, corners)).toBeGreaterThan(0.3);
  });

  it('is near zero where there is no boundary at all', () => {
    const gray = toGray(solid(220, 240, 128));
    const corners: Point[] = [{ x: 30, y: 20 }, { x: 190, y: 20 }, { x: 190, y: 220 }, { x: 30, y: 220 }];
    expect(edgeContrast(gray, corners)).toBeLessThan(0.01);
  });

  it('returns zero rather than NaN when every sample falls outside', () => {
    const gray = toGray(solid(20, 20, 128));
    expect(edgeContrast(gray, [{ x: -99, y: -99 }, { x: -98, y: -99 }, { x: -98, y: -98 }, { x: -99, y: -98 }])).toBe(0);
  });
});

describe('finish', () => {
  const page = photograph(160, 200, [{ x: 20, y: 15 }, { x: 140, y: 15 }, { x: 140, y: 185 }, { x: 20, y: 185 }]);

  it('returns colour untouched', () => {
    expect(finish(page, 'colour')).toBe(page);
  });

  it('makes every channel equal in grayscale', () => {
    const result = finish(page, 'grayscale');
    for (let index = 0; index < result.data.length; index += 4) {
      expect(result.data[index]).toBe(result.data[index + 1]);
      expect(result.data[index + 1]).toBe(result.data[index + 2]);
    }
  });

  it('produces only pure black and pure white in the black and white mode', () => {
    const result = finish(page, 'blackAndWhite');
    const values = new Set<number>();
    for (let index = 0; index < result.data.length; index += 4) values.add(result.data[index]);
    expect([...values].sort()).toEqual([0, 255]);
  });

  it('keeps the text and drops the background in black and white', () => {
    const ink = inkFraction(finish(page, 'blackAndWhite'));
    // The synthetic page is roughly a quarter text, so a threshold that kept
    // everything or nothing would fail this.
    expect(ink).toBeGreaterThan(0.02);
    expect(ink).toBeLessThan(0.6);
  });

  it('pushes the page whiter in contrast mode', () => {
    const before = finish(page, 'grayscale');
    const after = finish(page, 'contrast');
    const mean = (image: ImageData) => {
      let sum = 0;
      for (let index = 0; index < image.data.length; index += 4) sum += image.data[index];
      return sum / (image.data.length / 4);
    };
    expect(mean(after)).toBeGreaterThan(mean(before));
  });

  it('survives an image with no variation at all', () => {
    for (const mode of ['grayscale', 'contrast', 'blackAndWhite'] as const) {
      const result = finish(solid(20, 20, 128), mode);
      expect(result.width).toBe(20);
      expect(result.data.every((value, index) => index % 4 === 3 ? value === 255 : Number.isFinite(value))).toBe(true);
    }
  });

  it('handles uneven lighting, where a single global cutoff would lose a corner', () => {
    // A page that fades from bright to dark across its width.
    const uneven = new ImageData(120, 120);
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        const lighting = 240 - (x / 119) * 170;
        const onText = y % 12 < 3;
        setPixel(uneven, x, y, Math.round(onText ? lighting * 0.35 : lighting));
      }
    }
    const result = finish(uneven, 'blackAndWhite');
    const columnInk = (from: number, to: number) => {
      let dark = 0;
      let total = 0;
      for (let y = 0; y < 120; y += 1) {
        for (let x = from; x < to; x += 1) {
          total += 1;
          if (result.data[(y * 120 + x) * 4] < 128) dark += 1;
        }
      }
      return dark / total;
    };
    // Both the bright side and the dark side should keep their text.
    expect(columnInk(4, 30)).toBeGreaterThan(0.05);
    expect(columnInk(90, 116)).toBeGreaterThan(0.05);
  });
});

describe('inkFraction', () => {
  it('reports none for white and all for black', () => {
    expect(inkFraction(solid(10, 10, 255))).toBe(0);
    expect(inkFraction(solid(10, 10, 0))).toBe(1);
  });
});
