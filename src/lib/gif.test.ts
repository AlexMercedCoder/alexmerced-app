import { describe, expect, it } from 'vitest';
import {
  encodeGif, fromSubBlocks, lzwDecode, lzwEncode, mapToPalette, nearestColour, paletteBits,
  quantise, toSubBlocks, type GifFrame, type Rgb,
} from './gif';

/** Builds RGBA pixels from a function of position. */
function pixels(width: number, height: number, colour: (x: number, y: number) => Rgb): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y);
      const at = (y * width + x) * 4;
      data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
    }
  }
  return data;
}

describe('quantise', () => {
  it('returns every colour when there are few enough', () => {
    const flat = pixels(4, 4, (x) => (x < 2 ? [255, 0, 0] : [0, 0, 255]));
    const palette = quantise(flat, 256);
    expect(palette).toHaveLength(2);
  });

  it('never returns more than asked for', () => {
    const noisy = pixels(64, 64, (x, y) => [(x * 4) % 256, (y * 4) % 256, ((x + y) * 3) % 256]);
    expect(quantise(noisy, 16).length).toBeLessThanOrEqual(16);
    expect(quantise(noisy, 256).length).toBeLessThanOrEqual(256);
  });

  it('returns at least one colour for an empty or transparent image', () => {
    expect(quantise(new Uint8ClampedArray(0))).toHaveLength(1);
    expect(quantise(new Uint8ClampedArray(16))).toHaveLength(1);
  });

  it('keeps a rare colour rather than losing it to a large flat area', () => {
    // Mostly white, with a small red square.
    const data = pixels(32, 32, (x, y) => (x < 4 && y < 4 ? [220, 20, 20] : [250, 250, 250]));
    const palette = quantise(data, 8);
    const hasRed = palette.some(([r, g, b]) => r > 150 && g < 90 && b < 90);
    expect(hasRed).toBe(true);
  });

  it('spreads a palette across a gradient rather than clustering at one end', () => {
    const gradient = pixels(64, 8, (x) => [x * 4, x * 4, x * 4]);
    const palette = quantise(gradient, 8);
    const levels = palette.map(([r]) => r).sort((a, b) => a - b);
    expect(levels[0]).toBeLessThan(60);
    expect(levels[levels.length - 1]).toBeGreaterThan(190);
  });

  it('preserves pure white and pure black closely', () => {
    const data = pixels(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const palette = quantise(data, 4);
    expect(palette.some(([r, g, b]) => r < 10 && g < 10 && b < 10)).toBe(true);
    expect(palette.some(([r, g, b]) => r > 245 && g > 245 && b > 245)).toBe(true);
  });
});

describe('nearestColour', () => {
  const palette: Rgb[] = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [255, 255, 255]];

  it('finds an exact match', () => {
    expect(nearestColour(palette, 255, 0, 0)).toBe(1);
    expect(nearestColour(palette, 0, 0, 0)).toBe(0);
  });

  it('finds the closest when there is no exact match', () => {
    expect(nearestColour(palette, 240, 20, 20)).toBe(1);
    expect(nearestColour(palette, 200, 200, 200)).toBe(3);
  });
});

describe('mapToPalette', () => {
  const palette: Rgb[] = [[0, 0, 0], [255, 255, 255]];

  it('maps each pixel to an index', () => {
    const data = pixels(4, 1, (x) => (x < 2 ? [10, 10, 10] : [240, 240, 240]));
    expect(Array.from(mapToPalette(data, 4, 1, palette, false))).toEqual([0, 0, 1, 1]);
  });

  it('produces one index per pixel', () => {
    const data = pixels(8, 6, () => [128, 128, 128]);
    expect(mapToPalette(data, 8, 6, palette, false)).toHaveLength(48);
  });

  it('dithering turns a flat mid grey into a mixture, not one solid value', () => {
    const data = pixels(16, 16, () => [128, 128, 128]);
    const plain = mapToPalette(data, 16, 16, palette, false);
    const dithered = mapToPalette(data, 16, 16, palette, true);
    expect(new Set(plain).size).toBe(1);
    expect(new Set(dithered).size).toBe(2);
  });

  it('dithering leaves the source pixels untouched', () => {
    const data = pixels(8, 8, () => [128, 128, 128]);
    const before = Array.from(data);
    mapToPalette(data, 8, 8, palette, true);
    expect(Array.from(data)).toEqual(before);
  });

  it('keeps a dithered average close to the original brightness', () => {
    const data = pixels(32, 32, () => [128, 128, 128]);
    const dithered = mapToPalette(data, 32, 32, palette, true);
    const white = dithered.reduce((sum, value) => sum + value, 0) / dithered.length;
    expect(white).toBeGreaterThan(0.35);
    expect(white).toBeLessThan(0.65);
  });
});

describe('LZW', () => {
  it('round trips a short run', () => {
    const input = Uint8Array.from([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    expect(Array.from(lzwDecode(lzwEncode(input, 2), 2))).toEqual(Array.from(input));
  });

  it('round trips a long repetitive run, which is what it exists for', () => {
    const input = new Uint8Array(5000);
    for (let index = 0; index < input.length; index += 1) input[index] = index % 7;
    expect(Array.from(lzwDecode(lzwEncode(input, 3), 3))).toEqual(Array.from(input));
  });

  it('round trips data long enough to fill and clear the dictionary', () => {
    // Pseudo-random indices, which push the dictionary past twelve bits.
    const input = new Uint8Array(60_000);
    let seed = 7;
    for (let index = 0; index < input.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      input[index] = seed % 256;
    }
    expect(Array.from(lzwDecode(lzwEncode(input, 8), 8))).toEqual(Array.from(input));
  });

  it('round trips a single index', () => {
    expect(Array.from(lzwDecode(lzwEncode(Uint8Array.from([5]), 3), 3))).toEqual([5]);
  });

  it('round trips nothing at all', () => {
    expect(lzwDecode(lzwEncode(new Uint8Array(0), 2), 2)).toHaveLength(0);
  });

  it('compresses a repetitive run well below its original size', () => {
    const input = new Uint8Array(4000).fill(3);
    expect(lzwEncode(input, 2).length).toBeLessThan(input.length / 8);
  });

  it('handles every index in an eight bit palette', () => {
    const input = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(Array.from(lzwDecode(lzwEncode(input, 8), 8))).toEqual(Array.from(input));
  });
});

describe('sub-blocks', () => {
  it('splits at 255 bytes and terminates with a zero', () => {
    const blocked = toSubBlocks(new Uint8Array(600).fill(9));
    expect(blocked[0]).toBe(255);
    expect(blocked[256]).toBe(255);
    expect(blocked[blocked.length - 1]).toBe(0);
  });

  it('round trips', () => {
    for (const size of [0, 1, 254, 255, 256, 1000]) {
      const data = Uint8Array.from({ length: size }, (_, index) => index % 251);
      expect(Array.from(fromSubBlocks(toSubBlocks(data)).data), String(size)).toEqual(Array.from(data));
    }
  });
});

describe('paletteBits', () => {
  it('rounds up to a power of two', () => {
    expect(paletteBits(2)).toBe(1);
    expect(paletteBits(3)).toBe(2);
    expect(paletteBits(4)).toBe(2);
    expect(paletteBits(5)).toBe(3);
    expect(paletteBits(256)).toBe(8);
  });

  it('never goes outside what the format allows', () => {
    expect(paletteBits(1)).toBe(1);
    expect(paletteBits(1000)).toBe(8);
  });
});

describe('encodeGif', () => {
  const frame = (colour: Rgb): GifFrame => ({ pixels: pixels(8, 8, () => colour), delay: 10 });

  it('starts with the GIF89a signature and ends with the trailer', () => {
    const gif = encodeGif([frame([255, 0, 0])], { width: 8, height: 8 });
    expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
  });

  it('writes the size into the screen descriptor', () => {
    const gif = encodeGif([{ pixels: pixels(320, 240, () => [1, 2, 3]), delay: 5 }], { width: 320, height: 240 });
    expect(gif[6] | (gif[7] << 8)).toBe(320);
    expect(gif[8] | (gif[9] << 8)).toBe(240);
  });

  it('adds the loop extension only when there is more than one frame', () => {
    const one = encodeGif([frame([0, 0, 0])], { width: 8, height: 8 });
    const many = encodeGif([frame([0, 0, 0]), frame([255, 255, 255])], { width: 8, height: 8 });
    const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
    expect(text(one)).not.toContain('NETSCAPE2.0');
    expect(text(many)).toContain('NETSCAPE2.0');
  });

  it('writes one image descriptor per frame', () => {
    const gif = encodeGif([frame([1, 0, 0]), frame([0, 1, 0]), frame([0, 0, 1])], { width: 8, height: 8 });
    // Count graphic control extensions, which are one per frame.
    let count = 0;
    for (let index = 0; index < gif.length - 2; index += 1) {
      if (gif[index] === 0x21 && gif[index + 1] === 0xf9 && gif[index + 2] === 0x04) count += 1;
    }
    expect(count).toBe(3);
  });

  it('carries the delay for each frame', () => {
    const gif = encodeGif([{ pixels: pixels(4, 4, () => [9, 9, 9]), delay: 33 }], { width: 4, height: 4 });
    for (let index = 0; index < gif.length - 6; index += 1) {
      if (gif[index] === 0x21 && gif[index + 1] === 0xf9) {
        expect(gif[index + 4] | (gif[index + 5] << 8)).toBe(33);
        return;
      }
    }
    throw new Error('No graphic control extension was written');
  });

  it('reads back the pixels it was given', () => {
    // Encode a two colour checkerboard, then decode the LZW stream and confirm
    // every pixel lands on the right palette entry.
    const width = 16;
    const height = 16;
    const source = pixels(width, height, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));
    const gif = encodeGif([{ pixels: source, delay: 10 }], { width, height, colours: 4 });

    // Find the image descriptor, then step past the local colour table.
    const start = gif.indexOf(0x2c);
    const bits = (gif[start + 9] & 0x07) + 1;
    const tableStart = start + 10;
    const tableSize = (1 << bits) * 3;
    const palette: Rgb[] = [];
    for (let index = 0; index < 1 << bits; index += 1) {
      const at = tableStart + index * 3;
      palette.push([gif[at], gif[at + 1], gif[at + 2]]);
    }

    const minimumCodeSize = gif[tableStart + tableSize];
    const { data } = fromSubBlocks(gif, tableStart + tableSize + 1);
    const indices = lzwDecode(data, minimumCodeSize);

    expect(indices).toHaveLength(width * height);
    for (let index = 0; index < indices.length; index += 1) {
      const x = index % width;
      const y = Math.floor(index / width);
      const expected = (x + y) % 2 === 0 ? 255 : 0;
      expect(palette[indices[index]][0], `pixel ${x},${y}`).toBeCloseTo(expected, -1);
    }
  });

  it('refuses to write nothing', () => {
    expect(() => encodeGif([], { width: 8, height: 8 })).toThrow(/at least one frame/);
  });

  it('refuses an impossible size', () => {
    expect(() => encodeGif([frame([0, 0, 0])], { width: 0, height: 8 })).toThrow(/positive size/);
  });

  it('handles a photographic frame without blowing up', () => {
    const photo = pixels(120, 90, (x, y) => [
      (Math.sin(x / 9) * 90 + 140) | 0,
      (Math.cos(y / 7) * 80 + 130) | 0,
      ((x * y) % 200) + 30,
    ]);
    const gif = encodeGif([{ pixels: photo, delay: 8 }], { width: 120, height: 90, dither: true });
    expect(gif.length).toBeGreaterThan(1000);
    expect(gif[gif.length - 1]).toBe(0x3b);
  });
});
