/**
 * A QR Code encoder, written from scratch so Tessera has no dependencies and
 * works with the network switched off.
 *
 * Implements ISO/IEC 18004: numeric, alphanumeric, and byte modes, versions 1
 * through 40, all four error correction levels, Reed-Solomon error correction
 * over GF(2^8), and the eight data masks scored by the four penalty rules.
 *
 * The numeric tables below are constants from the specification.
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';
export type Mode = 'numeric' | 'alphanumeric' | 'byte';

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrError';
  }
}

const EC_ORDER: EcLevel[] = ['L', 'M', 'Q', 'H'];
/** Format-info encoding order differs from the L, M, Q, H reading order. */
const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const ECC_CODEWORDS_PER_BLOCK: Record<EcLevel, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const NUM_EC_BLOCKS: Record<EcLevel, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

// --------------------------------------------------------------------- capacity

/** Total data modules in a symbol, before subtracting error correction. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function dataCodewords(version: number, ec: EcLevel): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ec][version] * NUM_EC_BLOCKS[ec][version]
  );
}

function charCountBits(mode: Mode, version: number): number {
  const tier = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === 'numeric') return [10, 12, 14][tier];
  if (mode === 'alphanumeric') return [9, 11, 13][tier];
  return [8, 16, 16][tier];
}

const MODE_INDICATOR: Record<Mode, number> = { numeric: 1, alphanumeric: 2, byte: 4 };

// --------------------------------------------------------------------- modes

export function isNumeric(text: string): boolean {
  return text.length > 0 && /^[0-9]+$/.test(text);
}

export function isAlphanumeric(text: string): boolean {
  return text.length > 0 && [...text].every((char) => ALPHANUMERIC.includes(char));
}

/** The most compact mode that can carry the whole string. */
export function chooseMode(text: string): Mode {
  if (isNumeric(text)) return 'numeric';
  if (isAlphanumeric(text)) return 'alphanumeric';
  return 'byte';
}

function utf8Bytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    if (length < 0 || length > 31 || value >>> length !== 0) {
      throw new QrError('Internal encoder error: value does not fit the requested bit length.');
    }
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }
}

function encodeSegment(text: string, mode: Mode, version: number): BitBuffer {
  const buffer = new BitBuffer();
  buffer.append(MODE_INDICATOR[mode], 4);

  if (mode === 'numeric') {
    buffer.append(text.length, charCountBits(mode, version));
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      buffer.append(Number(chunk), chunk.length * 3 + 1);
    }
    return buffer;
  }

  if (mode === 'alphanumeric') {
    buffer.append(text.length, charCountBits(mode, version));
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) {
        buffer.append(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
      } else {
        buffer.append(ALPHANUMERIC.indexOf(text[i]), 6);
      }
    }
    return buffer;
  }

  const bytes = utf8Bytes(text);
  buffer.append(bytes.length, charCountBits(mode, version));
  for (const byte of bytes) buffer.append(byte, 8);
  return buffer;
}

/** Bits the payload needs at a given version, before padding. */
function segmentBitLength(text: string, mode: Mode, version: number): number {
  const count = charCountBits(mode, version);
  if (mode === 'numeric') {
    const groups = Math.floor(text.length / 3);
    const remainder = text.length % 3;
    return 4 + count + groups * 10 + (remainder === 0 ? 0 : remainder === 1 ? 4 : 7);
  }
  if (mode === 'alphanumeric') {
    return 4 + count + Math.floor(text.length / 2) * 11 + (text.length % 2) * 6;
  }
  return 4 + count + utf8Bytes(text).length * 8;
}

/** The smallest version that fits, at or above minVersion. */
export function chooseVersion(text: string, ec: EcLevel, minVersion = MIN_VERSION): number {
  const mode = chooseMode(text);
  for (let version = Math.max(MIN_VERSION, minVersion); version <= MAX_VERSION; version += 1) {
    if (segmentBitLength(text, mode, version) <= dataCodewords(version, ec) * 8) return version;
  }
  throw new QrError(
    'That is more data than a QR code can hold. Shorten the text, or lower the error correction level.',
  );
}

/** How many characters would still fit at this version and level. */
export function capacityFor(mode: Mode, version: number, ec: EcLevel): number {
  const available = dataCodewords(version, ec) * 8 - 4 - charCountBits(mode, version);
  if (available <= 0) return 0;
  if (mode === 'numeric') {
    const groups = Math.floor(available / 10);
    const spare = available % 10;
    return groups * 3 + (spare >= 7 ? 2 : spare >= 4 ? 1 : 0);
  }
  if (mode === 'alphanumeric') {
    const pairs = Math.floor(available / 11);
    return pairs * 2 + (available % 11 >= 6 ? 1 : 0);
  }
  return Math.floor(available / 8);
}

// --------------------------------------------------------------------- Reed-Solomon

/** Multiplication in GF(2^8) with the QR primitive polynomial 0x11D. */
function gfMultiply(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xff;
}

function generatorPolynomial(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function reedSolomon(data: number[], eccLength: number): number[] {
  const generator = generatorPolynomial(eccLength);
  const result = new Array<number>(eccLength).fill(0);

  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < eccLength; i += 1) result[i] ^= gfMultiply(generator[i], factor);
  }
  return result;
}

// --------------------------------------------------------------------- codewords

export function buildCodewords(text: string, ec: EcLevel, version: number): number[] {
  const mode = chooseMode(text);
  const capacityBits = dataCodewords(version, ec) * 8;
  const buffer = encodeSegment(text, mode, version);

  if (buffer.length > capacityBits) {
    throw new QrError('That payload does not fit the chosen version. Try a larger size.');
  }

  const bits = [...buffer.bits];
  // Terminator, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    bytes.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }

  // Alternating pad bytes defined by the specification.
  for (let pad = 0xec; bytes.length < capacityBits / 8; pad ^= 0xec ^ 0x11) bytes.push(pad);

  return interleave(bytes, ec, version);
}

/** Splits into blocks, adds error correction, and interleaves as the spec requires. */
function interleave(data: number[], ec: EcLevel, version: number): number[] {
  const blockCount = NUM_EC_BLOCKS[ec][version];
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ec][version];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockLength = Math.floor(totalCodewords / blockCount) - eccPerBlock;
  const shortBlockCount = blockCount - (totalCodewords % blockCount);

  const blocks: { data: number[]; ecc: number[] }[] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const length = shortBlockLength + (i < shortBlockCount ? 0 : 1);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: chunk, ecc: reedSolomon(chunk, eccPerBlock) });
  }

  const result: number[] = [];
  const longest = shortBlockLength + 1;
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return result;
}

// --------------------------------------------------------------------- matrix

export type Matrix = boolean[][];

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

class Symbol {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number, readonly ec: EcLevel) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean, reserve = true): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark;
    if (reserve) this.reserved[y][x] = true;
  }

  drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }

    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPositions(this.version);
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = 0; j < positions.length; j += 1) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
        if (!corner) this.drawAlignment(positions[i], positions[j]);
      }
    }

    // Reserve the format information areas; the values are written later.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  drawFormatBits(mask: number): void {
    const data = (EC_FORMAT_BITS[this.ec] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;

    const bitAt = (index: number) => ((bits >>> index) & 1) === 1;

    for (let i = 0; i <= 5; i += 1) this.set(8, i, bitAt(i));
    this.set(8, 7, bitAt(6));
    this.set(8, 8, bitAt(7));
    this.set(7, 8, bitAt(8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bitAt(i));

    for (let i = 0; i < 8; i += 1) this.set(this.size - 1 - i, 8, bitAt(i));
    for (let i = 8; i < 15; i += 1) this.set(8, this.size - 15 + i, bitAt(i));

    // The dark module, always set, always at this position.
    this.set(8, this.size - 8, true);
  }

  drawVersionBits(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;

    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit);
      this.set(b, a, bit);
    }
  }

  /** Places codewords in the zigzag pattern the spec defines, skipping column 6. */
  drawCodewords(codewords: number[]): void {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let column = 0; column < 2; column += 1) {
          const x = right - column;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (this.reserved[y][x]) continue;
          if (index < codewords.length * 8) {
            this.modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
            index += 1;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.reserved[y][x]) continue;
        if (maskCondition(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty(): number {
    return penaltyScore(this.modules, this.size);
  }
}

export function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new QrError(`Mask ${mask} does not exist.`);
  }
}

/** The four penalty rules from the specification, used to pick the best mask. */
export function penaltyScore(modules: boolean[][], size: number): number {
  let score = 0;

  const runPenalty = (run: number) => (run >= 5 ? run - 2 : 0);

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let y = 0; y < size; y += 1) {
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (modules[y][x] === modules[y][x - 1]) run += 1;
      else { score += runPenalty(run); run = 1; }
    }
    score += runPenalty(run);
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (modules[y][x] === modules[y - 1][x]) run += 1;
      else { score += runPenalty(run); run = 1; }
    }
    score += runPenalty(run);
  }

  // Rule 2: every two by two block of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = modules[y][x];
      if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like pattern, in either orientation, in rows and columns.
  const pattern = [true, false, true, true, true, false, true];
  const hasPatternAt = (get: (index: number) => boolean, start: number, limit: number): boolean => {
    if (start + 7 > limit) return false;
    for (let i = 0; i < 7; i += 1) if (get(start + i) !== pattern[i]) return false;
    const leadingClear = (() => {
      for (let i = start - 4; i < start; i += 1) {
        if (i < 0) continue;
        if (get(i)) return false;
      }
      return start - 4 < 0 ? true : true;
    })();
    const trailingClear = (() => {
      for (let i = start + 7; i < start + 11; i += 1) {
        if (i >= limit) continue;
        if (get(i)) return false;
      }
      return true;
    })();
    return leadingClear || trailingClear;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x <= size - 7; x += 1) {
      if (hasPatternAt((index) => modules[y][index], x, size)) score += 40;
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y <= size - 7; y += 1) {
      if (hasPatternAt((index) => modules[index][x], y, size)) score += 40;
    }
  }

  // Rule 4: how far the proportion of dark modules strays from half.
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
  const total = size * size;
  const deviation = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total);
  score += deviation * 10;

  return score;
}

export type QrOptions = {
  ec?: EcLevel;
  /** Forces a version. The encoder still refuses payloads that do not fit. */
  minVersion?: number;
  /** Fixes the mask instead of scoring all eight. Mostly useful for tests. */
  mask?: number;
};

export type QrCode = {
  modules: Matrix;
  size: number;
  version: number;
  ec: EcLevel;
  mask: number;
  mode: Mode;
};

export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  if (typeof text !== 'string' || text.length === 0) {
    throw new QrError('There is nothing to encode yet.');
  }

  const ec = options.ec ?? 'M';
  if (!EC_ORDER.includes(ec)) throw new QrError(`"${ec}" is not an error correction level.`);

  const version = chooseVersion(text, ec, options.minVersion ?? MIN_VERSION);
  const codewords = buildCodewords(text, ec, version);

  let best: Symbol | null = null;
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  const masks = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];

  for (const mask of masks) {
    const symbol = new Symbol(version, ec);
    symbol.drawFunctionPatterns();
    symbol.drawCodewords(codewords);
    symbol.applyMask(mask);
    symbol.drawFormatBits(mask);

    const score = symbol.penalty();
    if (score < bestScore) {
      bestScore = score;
      best = symbol;
      bestMask = mask;
    }
  }

  if (!best) throw new QrError('The encoder produced no symbol.');

  return {
    modules: best.modules,
    size: best.size,
    version,
    ec,
    mask: bestMask,
    mode: chooseMode(text),
  };
}

// --------------------------------------------------------------------- rendering

export type RenderOptions = {
  /** Pixels per module. */
  scale?: number;
  /** Light modules of margin around the symbol. Four is the specified minimum. */
  quietZone?: number;
  dark?: string;
  light?: string;
  /** Leaves the background transparent instead of filling it. */
  transparent?: boolean;
};

export function toSvg(code: QrCode, options: RenderOptions = {}): string {
  const { scale = 8, quietZone = 4, dark = '#000000', light = '#ffffff', transparent = false } = options;
  const total = code.size + quietZone * 2;
  const dimension = total * scale;

  const path: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= code.size; x += 1) {
      const on = x < code.size && code.modules[y][x];
      if (on && runStart === -1) runStart = x;
      if (!on && runStart !== -1) {
        path.push(`M${runStart + quietZone} ${y + quietZone}h${x - runStart}v1h-${x - runStart}z`);
        runStart = -1;
      }
    }
  }

  const background = transparent ? '' : `<rect width="${total}" height="${total}" fill="${light}"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">`,
    background,
    `<path d="${path.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('');
}

export function drawToCanvas(code: QrCode, canvas: HTMLCanvasElement, options: RenderOptions = {}): void {
  const { scale = 8, quietZone = 4, dark = '#000000', light = '#ffffff', transparent = false } = options;
  const total = code.size + quietZone * 2;

  canvas.width = total * scale;
  canvas.height = total * scale;

  const context = canvas.getContext('2d');
  if (!context) throw new QrError('This browser would not give us a canvas to draw on.');

  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!transparent) {
    context.fillStyle = light;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.fillStyle = dark;
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (code.modules[y][x]) {
        context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
      }
    }
  }
}
