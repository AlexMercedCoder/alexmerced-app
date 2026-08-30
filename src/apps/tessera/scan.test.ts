import { describe, expect, it } from 'vitest';
import { applyMatrix, homography, type Point } from '../../lib/homography';
import { encodeQr, type EcLevel } from './qr';
import {
  binarise, clusterFinders, estimateVersion, findFinders, invert, isFinderRatio, matrixToImage,
  nearbyVersions, orientFinders, sampleGrid, scanImage, ScanError, symbolCorners, toLuma,
  type Binary, type Finder,
} from './scan';

function picture(text: string, options: { ec?: EcLevel; scale?: number; minVersion?: number } = {}): ImageData {
  const code = encodeQr(text, { ec: options.ec ?? 'M', minVersion: options.minVersion ?? 1 });
  return matrixToImage(code.modules, options.scale ?? 6);
}

/** Redraws an image through a projective transform, standing in for a camera angle. */
function skew(image: ImageData, corners: Point[]): ImageData {
  const output = new ImageData(image.width, image.height);
  // Walk the destination and pull from the source, so no pixel is left unwritten.
  const toSource = homography(
    [{ x: 0, y: 0 }, { x: image.width - 1, y: 0 }, { x: image.width - 1, y: image.height - 1 }, { x: 0, y: image.height - 1 }],
    corners,
  );
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const source = applyMatrix(toSource, { x, y });
      const sx = Math.round(source.x);
      const sy = Math.round(source.y);
      const at = (y * image.width + x) * 4;
      const inside = sx >= 0 && sy >= 0 && sx < image.width && sy < image.height;
      const value = inside ? image.data[(sy * image.width + sx) * 4] : 255;
      output.data[at] = value;
      output.data[at + 1] = value;
      output.data[at + 2] = value;
      output.data[at + 3] = 255;
    }
  }
  return output;
}

/** Multiplies brightness by a gradient, standing in for uneven lighting. */
function shade(image: ImageData, from: number, to: number): ImageData {
  const output = new ImageData(image.width, image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      const factor = from + ((to - from) * x) / Math.max(1, image.width - 1);
      const value = Math.max(0, Math.min(255, Math.round(image.data[at] * factor)));
      output.data[at] = value;
      output.data[at + 1] = value;
      output.data[at + 2] = value;
      output.data[at + 3] = 255;
    }
  }
  return output;
}

describe('isFinderRatio', () => {
  it('accepts the exact ratio at any scale', () => {
    expect(isFinderRatio([1, 1, 3, 1, 1])).toBe(true);
    expect(isFinderRatio([4, 4, 12, 4, 4])).toBe(true);
    expect(isFinderRatio([10, 10, 30, 10, 10])).toBe(true);
  });

  it('allows the slack that blur introduces', () => {
    expect(isFinderRatio([4, 5, 12, 4, 4])).toBe(true);
    expect(isFinderRatio([4, 4, 13, 5, 4])).toBe(true);
  });

  it('rejects an even run, which is a plain stripe', () => {
    expect(isFinderRatio([4, 4, 4, 4, 4])).toBe(false);
  });

  it('rejects a middle that is too wide or too narrow', () => {
    expect(isFinderRatio([4, 4, 30, 4, 4])).toBe(false);
    expect(isFinderRatio([8, 8, 6, 8, 8])).toBe(false);
  });

  it('rejects the wrong number of runs', () => {
    expect(isFinderRatio([1, 1, 3, 1])).toBe(false);
    expect(isFinderRatio([1, 1, 3, 1, 1, 1])).toBe(false);
  });

  it('rejects a run too small to measure', () => {
    expect(isFinderRatio([1, 0, 1, 0, 1])).toBe(false);
  });
});

describe('binarise', () => {
  function gradientImage(width: number, height: number): { luma: Uint8Array; width: number; height: number } {
    const luma = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // Dark bars on a background that fades from bright to dim.
        const lighting = 250 - (x / (width - 1)) * 170;
        luma[y * width + x] = Math.round(y % 8 < 4 ? lighting * 0.25 : lighting);
      }
    }
    return { luma, width, height };
  }

  it('keeps the bars on both the bright and the dim side', () => {
    const { luma, width, height } = gradientImage(128, 64);
    const binary = binarise(luma, width, height);
    const darkIn = (from: number, to: number) => {
      let dark = 0;
      let total = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = from; x < to; x += 1) { total += 1; dark += binary.data[y * width + x]; }
      }
      return dark / total;
    };
    expect(darkIn(4, 30)).toBeGreaterThan(0.3);
    expect(darkIn(96, 124)).toBeGreaterThan(0.3);
  });

  it('leaves a blank image blank instead of turning it into noise', () => {
    const luma = new Uint8Array(64 * 64).fill(240);
    const binary = binarise(luma, 64, 64);
    expect(binary.data.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it('inverts every pixel and nothing else', () => {
    const binary: Binary = { width: 2, height: 1, data: Uint8Array.from([1, 0]) };
    expect(Array.from(invert(binary).data)).toEqual([0, 1]);
  });
});

describe('finder location', () => {
  it('finds three finders in a clean code', () => {
    const image = picture('FIND ME');
    const binary = binarise(toLuma(image), image.width, image.height);
    expect(findFinders(binary).length).toBeGreaterThanOrEqual(3);
  });

  it('finds them in a larger symbol too', () => {
    const image = picture('A much longer payload that needs a bigger symbol to hold it all', { scale: 4 });
    const binary = binarise(toLuma(image), image.width, image.height);
    expect(findFinders(binary).length).toBeGreaterThanOrEqual(3);
  });

  it('finds nothing in a blank picture', () => {
    const luma = new Uint8Array(120 * 120).fill(255);
    expect(findFinders(binarise(luma, 120, 120))).toHaveLength(0);
  });

  it('merges the many hits one finder produces into a single point', () => {
    const candidates: Finder[] = Array.from({ length: 8 }, (_, index) => ({
      x: 40 + index * 0.2, y: 40 + index * 0.3, moduleSize: 4,
    }));
    const clustered = clusterFinders(candidates);
    expect(clustered).toHaveLength(1);
    expect(clustered[0].x).toBeCloseTo(40.7, 0);
  });

  it('discards a cluster seen only once, which is noise', () => {
    expect(clusterFinders([{ x: 10, y: 10, moduleSize: 3 }])).toHaveLength(0);
  });

  it('keeps two finders far enough apart as separate clusters', () => {
    const candidates: Finder[] = [
      { x: 10, y: 10, moduleSize: 3 }, { x: 10.1, y: 10.1, moduleSize: 3 },
      { x: 90, y: 10, moduleSize: 3 }, { x: 90.1, y: 10.2, moduleSize: 3 },
    ];
    expect(clusterFinders(candidates)).toHaveLength(2);
  });
});

describe('orientFinders', () => {
  const size = 100;

  it('picks out the corner opposite the longest side', () => {
    const finders: Finder[] = [
      { x: 0, y: 0, moduleSize: 4 },
      { x: size, y: 0, moduleSize: 4 },
      { x: 0, y: size, moduleSize: 4 },
    ];
    const oriented = orientFinders(finders);
    expect(oriented.topLeft).toEqual(finders[0]);
    expect(oriented.topRight).toEqual(finders[1]);
    expect(oriented.bottomLeft).toEqual(finders[2]);
  });

  it('gives the same answer whatever order the finders arrive in', () => {
    const a = { x: 0, y: 0, moduleSize: 4 };
    const b = { x: size, y: 0, moduleSize: 4 };
    const c = { x: 0, y: size, moduleSize: 4 };
    for (const order of [[a, b, c], [c, a, b], [b, c, a], [c, b, a]]) {
      const oriented = orientFinders(order);
      expect(oriented.topLeft, JSON.stringify(order)).toEqual(a);
      expect(oriented.topRight).toEqual(b);
      expect(oriented.bottomLeft).toEqual(c);
    }
  });

  it('handles a code rotated a quarter turn', () => {
    // Top left at the top right of the frame, rotated ninety degrees.
    const topLeft = { x: size, y: 0, moduleSize: 4 };
    const topRight = { x: size, y: size, moduleSize: 4 };
    const bottomLeft = { x: 0, y: 0, moduleSize: 4 };
    const oriented = orientFinders([topRight, bottomLeft, topLeft]);
    expect(oriented.topLeft).toEqual(topLeft);
    expect(oriented.topRight).toEqual(topRight);
    expect(oriented.bottomLeft).toEqual(bottomLeft);
  });

  it('refuses with fewer than three', () => {
    expect(() => orientFinders([{ x: 0, y: 0, moduleSize: 4 }])).toThrow(ScanError);
  });
});

describe('estimateVersion', () => {
  it('reads version 1 from finder spacing', () => {
    // Version 1 is 21 modules; the finder centres are 14 modules apart.
    const module = 5;
    expect(estimateVersion(
      { x: 0, y: 0, moduleSize: module },
      { x: 14 * module, y: 0, moduleSize: module },
      { x: 0, y: 14 * module, moduleSize: module },
    )).toBe(1);
  });

  it('reads a larger version', () => {
    const module = 3;
    const spacing = (10 * 4 + 17 - 7) * module;
    expect(estimateVersion(
      { x: 0, y: 0, moduleSize: module },
      { x: spacing, y: 0, moduleSize: module },
      { x: 0, y: spacing, moduleSize: module },
    )).toBe(10);
  });

  it('clamps rather than returning something impossible', () => {
    const tiny = { x: 0, y: 0, moduleSize: 40 };
    expect(estimateVersion(tiny, { x: 1, y: 0, moduleSize: 40 }, { x: 0, y: 1, moduleSize: 40 })).toBe(1);
  });

  it('refuses when the module size is unmeasurable', () => {
    const bad = { x: 0, y: 0, moduleSize: 0 };
    expect(() => estimateVersion(bad, bad, bad)).toThrow(ScanError);
  });
});

describe('symbolCorners and sampleGrid', () => {
  it('places the corners three and a half modules out from the finder centres', () => {
    const module = 10;
    const size = 21;
    const corners = symbolCorners(
      { x: 35, y: 35, moduleSize: module },
      { x: 35 + 14 * module, y: 35, moduleSize: module },
      { x: 35, y: 35 + 14 * module, moduleSize: module },
      size,
    );
    expect(corners[0].x).toBeCloseTo(0, 5);
    expect(corners[0].y).toBeCloseTo(0, 5);
    expect(corners[2].x).toBeCloseTo(size * module, 5);
    expect(corners[2].y).toBeCloseTo(size * module, 5);
  });

  it('reads a matrix back exactly out of a clean rendering', () => {
    const code = encodeQr('SAMPLE GRID');
    const scale = 8;
    const quiet = 4;
    const image = matrixToImage(code.modules, scale, quiet);
    const binary = binarise(toLuma(image), image.width, image.height);
    const size = code.modules.length;
    const offset = quiet * scale;
    const corners: Point[] = [
      { x: offset, y: offset },
      { x: offset + size * scale, y: offset },
      { x: offset + size * scale, y: offset + size * scale },
      { x: offset, y: offset + size * scale },
    ];
    expect(sampleGrid(binary, corners, size)).toEqual(code.modules);
  });
});

describe('nearbyVersions', () => {
  it('tries the estimate first', () => {
    expect(nearbyVersions(10)[0]).toBe(10);
  });

  it('stays inside the legal range', () => {
    expect(nearbyVersions(1)).toEqual([1, 2, 3]);
    expect(nearbyVersions(40)).toEqual([40, 39, 38]);
  });

  it('never repeats a version', () => {
    const versions = nearbyVersions(20);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('scanImage', () => {
  it('reads a clean code', () => {
    const result = scanImage(picture('HELLO WORLD'));
    expect(result.text).toBe('HELLO WORLD');
    expect(result.inverted).toBe(false);
    expect(result.corners).toHaveLength(4);
  });

  it('reads a URL', () => {
    const url = 'https://alexmerced.app/tessera';
    expect(scanImage(picture(url)).text).toBe(url);
  });

  it('reads text outside ASCII', () => {
    expect(scanImage(picture('Café 日本 🎉')).text).toBe('Café 日本 🎉');
  });

  it('reads at every error correction level', () => {
    for (const ec of ['L', 'M', 'Q', 'H'] as EcLevel[]) {
      expect(scanImage(picture('LEVEL TEST', { ec })).text, ec).toBe('LEVEL TEST');
    }
  });

  it('reads a larger symbol', () => {
    const text = 'The quick brown fox jumps over the lazy dog, twice, for length. '.repeat(3);
    expect(scanImage(picture(text, { scale: 4 })).text).toBe(text);
  });

  it('reads a small rendering, down to three pixels a module', () => {
    expect(scanImage(picture('SMALL', { scale: 3 })).text).toBe('SMALL');
  });

  it('reads a light code on a dark background', () => {
    const image = picture('INVERTED');
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = 255 - image.data[index];
      image.data[index + 1] = 255 - image.data[index + 1];
      image.data[index + 2] = 255 - image.data[index + 2];
    }
    const result = scanImage(image);
    expect(result.text).toBe('INVERTED');
    expect(result.inverted).toBe(true);
  });

  it('reads through uneven lighting that a single cutoff would lose', () => {
    expect(scanImage(shade(picture('UNEVEN LIGHT', { scale: 8 }), 1, 0.35)).text).toBe('UNEVEN LIGHT');
  });

  it('reads a code photographed at an angle', () => {
    const flat = picture('PERSPECTIVE', { scale: 10 });
    const inset = flat.width * 0.06;
    const tilted = skew(flat, [
      { x: inset, y: inset * 0.5 },
      { x: flat.width - inset * 0.5, y: inset },
      { x: flat.width - inset, y: flat.height - inset * 0.6 },
      { x: inset * 0.6, y: flat.height - inset },
    ]);
    expect(scanImage(tilted).text).toBe('PERSPECTIVE');
  });

  it('reads a code with damaged modules, thanks to the error correction', () => {
    const code = encodeQr('DAMAGED BUT READABLE', { ec: 'H' });
    const modules = code.modules.map((row) => [...row]);
    // Scribble over a patch away from the finders.
    for (let y = 10; y < 16; y += 1) {
      for (let x = 10; x < 16; x += 1) modules[y][x] = (x + y) % 2 === 0;
    }
    expect(scanImage(matrixToImage(modules, 8)).text).toBe('DAMAGED BUT READABLE');
  });

  it('says there is no code rather than returning nonsense', () => {
    const blank = new ImageData(200, 200);
    blank.data.fill(255);
    for (let index = 3; index < blank.data.length; index += 4) blank.data[index] = 255;
    expect(() => scanImage(blank)).toThrow(ScanError);
  });

  it('says so for a picture of something that is not a code', () => {
    const stripes = new ImageData(200, 200);
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 200; x += 1) {
        const value = (x + y) % 16 < 8 ? 20 : 240;
        const at = (y * 200 + x) * 4;
        stripes.data[at] = value;
        stripes.data[at + 1] = value;
        stripes.data[at + 2] = value;
        stripes.data[at + 3] = 255;
      }
    }
    expect(() => scanImage(stripes)).toThrow(ScanError);
  });

  it('reports the corners it found, so they can be drawn over the picture', () => {
    const image = picture('CORNERS', { scale: 6 });
    const { corners } = scanImage(image);
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThan(-10);
      expect(corner.x).toBeLessThan(image.width + 10);
      expect(corner.y).toBeGreaterThan(-10);
      expect(corner.y).toBeLessThan(image.height + 10);
    }
  });
});
