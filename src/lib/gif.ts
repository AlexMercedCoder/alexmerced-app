/**
 * A GIF89a encoder.
 *
 * Two problems have to be solved. A GIF holds at most 256 colours per frame, so
 * millions of them have to be reduced to a palette without the result looking
 * like a poster. And the pixels are packed with LZW, a compressor from 1984
 * whose codes grow in width as the dictionary fills.
 */

// --------------------------------------------------------------------- palette

export type Rgb = [number, number, number];

type Box = {
  colours: Uint32Array;
  counts: Uint32Array;
  length: number;
};

/**
 * Median cut. Colours are put in one box, the box is split along whichever
 * channel varies most, and the process repeats until there are enough boxes.
 * Each box then contributes its average colour.
 *
 * Splitting by variance rather than by count is what stops a large flat
 * background from swallowing the whole palette.
 */
export function quantise(pixels: Uint8ClampedArray, maxColours = 256): Rgb[] {
  const histogram = new Map<number, number>();

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    // Five bits a channel is enough to build a palette from, and keeps the
    // histogram small enough to sort quickly on a large frame.
    const key = ((pixels[index] >> 3) << 10) | ((pixels[index + 1] >> 3) << 5) | (pixels[index + 2] >> 3);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  if (histogram.size === 0) return [[0, 0, 0]];
  if (histogram.size <= maxColours) {
    return [...histogram.keys()].map(expand);
  }

  const colours = new Uint32Array(histogram.size);
  const counts = new Uint32Array(histogram.size);
  let at = 0;
  for (const [key, count] of histogram) {
    colours[at] = key;
    counts[at] = count;
    at += 1;
  }

  let boxes: Box[] = [{ colours, counts, length: colours.length }];

  while (boxes.length < maxColours) {
    // Split the box with the widest spread, since that is where the visible
    // error is. A box holding one colour cannot be split at all.
    let target = -1;
    let widest = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      const spread = Math.max(...channelRanges(box));
      if (spread > widest) { widest = spread; target = index; }
    });
    if (target === -1) break;

    const [left, right] = split(boxes[target]);
    if (left.length === 0 || right.length === 0) break;
    boxes = [...boxes.slice(0, target), left, right, ...boxes.slice(target + 1)];
  }

  return boxes.map(averageOf);
}

function expand(key: number): Rgb {
  // Five bits back to eight, replicating the high bits so white stays white.
  const r = (key >> 10) & 31;
  const g = (key >> 5) & 31;
  const b = key & 31;
  return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)];
}

function channelRanges(box: Box): [number, number, number] {
  let rLow = 255; let rHigh = 0;
  let gLow = 255; let gHigh = 0;
  let bLow = 255; let bHigh = 0;
  for (let index = 0; index < box.length; index += 1) {
    const [r, g, b] = expand(box.colours[index]);
    if (r < rLow) rLow = r;
    if (r > rHigh) rHigh = r;
    if (g < gLow) gLow = g;
    if (g > gHigh) gHigh = g;
    if (b < bLow) bLow = b;
    if (b > bHigh) bHigh = b;
  }
  return [rHigh - rLow, gHigh - gLow, bHigh - bLow];
}

function split(box: Box): [Box, Box] {
  const ranges = channelRanges(box);
  const channel = ranges.indexOf(Math.max(...ranges));
  const shift = channel === 0 ? 10 : channel === 1 ? 5 : 0;

  const order = Array.from({ length: box.length }, (_, index) => index)
    .sort((a, b) => ((box.colours[a] >> shift) & 31) - ((box.colours[b] >> shift) & 31));

  // Cut where half the pixels lie, not half the colours, so a box holding one
  // very common colour and many rare ones splits somewhere useful.
  let total = 0;
  for (let index = 0; index < box.length; index += 1) total += box.counts[index];

  let running = 0;
  let cut = 0;
  for (; cut < order.length - 1; cut += 1) {
    running += box.counts[order[cut]];
    if (running * 2 >= total) break;
  }
  cut += 1;

  const build = (indices: number[]): Box => ({
    colours: Uint32Array.from(indices.map((index) => box.colours[index])),
    counts: Uint32Array.from(indices.map((index) => box.counts[index])),
    length: indices.length,
  });

  return [build(order.slice(0, cut)), build(order.slice(cut))];
}

function averageOf(box: Box): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let index = 0; index < box.length; index += 1) {
    const [cr, cg, cb] = expand(box.colours[index]);
    const count = box.counts[index];
    r += cr * count;
    g += cg * count;
    b += cb * count;
    weight += count;
  }
  if (weight === 0) return [0, 0, 0];
  return [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)];
}

/** Nearest palette entry by squared distance. */
export function nearestColour(palette: Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index += 1) {
    const [pr, pg, pb] = palette[index];
    const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
      if (distance === 0) break;
    }
  }
  return best;
}

/**
 * Maps pixels onto a palette, optionally spreading the error into neighbouring
 * pixels so a gradient becomes a fine stipple rather than visible bands.
 */
export function mapToPalette(
  pixels: Uint8ClampedArray, width: number, height: number, palette: Rgb[], dither: boolean,
): Uint8Array {
  const indexed = new Uint8Array(width * height);
  if (!dither) {
    for (let index = 0; index < indexed.length; index += 1) {
      const at = index * 4;
      indexed[index] = nearestColour(palette, pixels[at], pixels[at + 1], pixels[at + 2]);
    }
    return indexed;
  }

  // Floyd-Steinberg, on a working copy so the source is not modified.
  const working = Float32Array.from(pixels);
  const push = (x: number, y: number, channel: number, error: number, factor: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    working[(y * width + x) * 4 + channel] += error * factor;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const r = clamp(working[at]);
      const g = clamp(working[at + 1]);
      const b = clamp(working[at + 2]);

      const chosen = nearestColour(palette, r, g, b);
      indexed[y * width + x] = chosen;

      const errors = [r - palette[chosen][0], g - palette[chosen][1], b - palette[chosen][2]];
      for (let channel = 0; channel < 3; channel += 1) {
        push(x + 1, y, channel, errors[channel], 7 / 16);
        push(x - 1, y + 1, channel, errors[channel], 3 / 16);
        push(x, y + 1, channel, errors[channel], 5 / 16);
        push(x + 1, y + 1, channel, errors[channel], 1 / 16);
      }
    }
  }
  return indexed;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// --------------------------------------------------------------------- LZW

class BitWriter {
  private readonly bytes: number[] = [];
  private accumulator = 0;
  private bits = 0;

  write(code: number, width: number): void {
    this.accumulator |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) {
      this.bytes.push(this.accumulator & 0xff);
      this.accumulator >>= 8;
      this.bits -= 8;
    }
  }

  finish(): Uint8Array {
    if (this.bits > 0) this.bytes.push(this.accumulator & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

/**
 * The variant GIF uses: codes start one bit wider than the colour depth, grow
 * as the dictionary fills, and the dictionary is cleared and rebuilt when it
 * reaches twelve bits.
 */
export function lzwEncode(indexed: Uint8Array, minimumCodeSize: number): Uint8Array {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;

  const writer = new BitWriter();
  let dictionary = new Map<string, number>();
  let next = endCode + 1;
  let width = minimumCodeSize + 1;

  const reset = () => {
    dictionary = new Map();
    next = endCode + 1;
    width = minimumCodeSize + 1;
  };

  writer.write(clearCode, width);
  reset();

  if (indexed.length === 0) {
    writer.write(endCode, width);
    return writer.finish();
  }

  let previous = String(indexed[0]);

  for (let index = 1; index < indexed.length; index += 1) {
    const current = indexed[index];
    const combined = `${previous},${current}`;

    if (dictionary.has(combined)) {
      previous = combined;
      continue;
    }

    writer.write(codeFor(previous, dictionary, clearCode), width);
    dictionary.set(combined, next);
    next += 1;

    if (next > 1 << width) {
      if (width < 12) {
        width += 1;
      } else {
        writer.write(clearCode, width);
        reset();
      }
    }
    previous = String(current);
  }

  writer.write(codeFor(previous, dictionary, clearCode), width);
  writer.write(endCode, width);
  return writer.finish();
}

function codeFor(sequence: string, dictionary: Map<string, number>, clearCode: number): number {
  const known = dictionary.get(sequence);
  if (known !== undefined) return known;
  // A single index is its own code, below the clear code.
  const value = Number(sequence);
  if (!Number.isNaN(value) && value < clearCode) return value;
  throw new Error('The LZW dictionary lost track of a sequence.');
}

/** GIF stores compressed data in sub-blocks of at most 255 bytes. */
export function toSubBlocks(bytes: Uint8Array): Uint8Array {
  const parts: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const chunk = bytes.subarray(offset, offset + 255);
    parts.push(chunk.length, ...chunk);
  }
  parts.push(0);
  return Uint8Array.from(parts);
}

// --------------------------------------------------------------------- file

export type GifFrame = {
  /** RGBA pixels, as they come out of a canvas. */
  pixels: Uint8ClampedArray;
  /** Hundredths of a second this frame is shown for. */
  delay: number;
};

export type GifOptions = {
  width: number;
  height: number;
  /** How many times to loop. Zero means forever. */
  loop?: number;
  colours?: number;
  dither?: boolean;
};

/** Rounds a palette size up to a power of two, which is what the format needs. */
export function paletteBits(count: number): number {
  let bits = 1;
  while (1 << bits < count) bits += 1;
  return Math.min(8, Math.max(1, bits));
}

export function encodeGif(frames: GifFrame[], options: GifOptions): Uint8Array {
  if (frames.length === 0) throw new Error('A GIF needs at least one frame.');
  const { width, height } = options;
  if (width < 1 || height < 1) throw new Error('A GIF needs a positive size.');

  const parts: Uint8Array[] = [];
  const push = (...bytes: number[]) => parts.push(Uint8Array.from(bytes));

  // Header and logical screen descriptor. No global palette: each frame brings
  // its own, which is what keeps colours right across a changing scene.
  parts.push(new TextEncoder().encode('GIF89a'));
  push(width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x00, 0x00);

  // The Netscape extension is how a GIF says it should loop.
  if (frames.length > 1) {
    const loop = options.loop ?? 0;
    parts.push(new Uint8Array([0x21, 0xff, 0x0b]));
    parts.push(new TextEncoder().encode('NETSCAPE2.0'));
    push(0x03, 0x01, loop & 0xff, loop >> 8, 0x00);
  }

  const maxColours = Math.max(2, Math.min(256, options.colours ?? 256));

  for (const frame of frames) {
    const palette = quantise(frame.pixels, maxColours);
    const bits = paletteBits(palette.length);
    const size = 1 << bits;
    const indexed = mapToPalette(frame.pixels, width, height, palette, options.dither ?? false);

    // Graphic control extension, carrying the delay.
    const delay = Math.max(0, Math.round(frame.delay));
    push(0x21, 0xf9, 0x04, 0x04, delay & 0xff, delay >> 8, 0x00, 0x00);

    // Image descriptor, flagged as carrying a local colour table.
    push(0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x80 | (bits - 1));

    const table = new Uint8Array(size * 3);
    palette.forEach((colour, index) => table.set(colour, index * 3));
    parts.push(table);

    // The minimum code size has a floor of two, whatever the palette holds.
    const minimumCodeSize = Math.max(2, bits);
    push(minimumCodeSize);
    parts.push(toSubBlocks(lzwEncode(indexed, minimumCodeSize)));
  }

  push(0x3b);

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Decodes the LZW stream back to indices. Used by the tests to prove it round trips. */
export function lzwDecode(bytes: Uint8Array, minimumCodeSize: number): Uint8Array {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;

  let dictionary: number[][] = [];
  const reset = () => {
    dictionary = Array.from({ length: clearCode + 2 }, (_, index) => (index < clearCode ? [index] : []));
  };
  reset();

  let width = minimumCodeSize + 1;
  let bitPosition = 0;
  const output: number[] = [];
  let previous: number[] | null = null;

  const read = (): number | null => {
    if (bitPosition + width > bytes.length * 8) return null;
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      const position = bitPosition + index;
      const bit = (bytes[position >> 3] >> (position & 7)) & 1;
      value |= bit << index;
    }
    bitPosition += width;
    return value;
  };

  for (;;) {
    const code = read();
    if (code === null || code === endCode) break;

    if (code === clearCode) {
      reset();
      width = minimumCodeSize + 1;
      previous = null;
      continue;
    }

    let entry: number[];
    if (code < dictionary.length) {
      entry = dictionary[code];
    } else if (previous) {
      // The one case where a code refers to the entry being built right now.
      entry = [...previous, previous[0]];
    } else {
      break;
    }

    output.push(...entry);

    if (previous) {
      dictionary.push([...previous, entry[0]]);
      if (dictionary.length === 1 << width && width < 12) width += 1;
    }
    previous = entry;
  }

  return Uint8Array.from(output);
}

/** Reads sub-blocks back into one run of bytes. */
export function fromSubBlocks(bytes: Uint8Array, start = 0): { data: Uint8Array; end: number } {
  const parts: number[] = [];
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset];
    if (size === 0) { offset += 1; break; }
    for (let index = 0; index < size; index += 1) parts.push(bytes[offset + 1 + index]);
    offset += size + 1;
  }
  return { data: Uint8Array.from(parts), end: offset };
}
