import { correctBlock, CorrectionError } from './gf';
import {
  ALPHANUMERIC, alignmentPositions, EC_FORMAT_BITS, EC_ORDER, ECC_CODEWORDS_PER_BLOCK,
  maskCondition, NUM_EC_BLOCKS, QrError, type EcLevel, type Mode,
} from './qr';

/**
 * Reading a QR code back out of a grid of modules.
 *
 * This is the encoder run backwards, and it has to be, because the only real
 * check on an encoder is independent code that reads its output and returns the
 * original text.
 */

export type Modules = boolean[][];

export type DecodeResult = {
  text: string;
  version: number;
  ec: EcLevel;
  mask: number;
  mode: Mode | 'mixed';
  /** How many codewords the error correction had to repair. */
  repaired: number;
};

export class DecodeError extends QrError {}

// --------------------------------------------------------------------- format

/** BCH(15,5) codes for the 32 possible format values, as the standard defines them. */
const FORMAT_CODES: number[] = (() => {
  const codes: number[] = [];
  for (let data = 0; data < 32; data += 1) {
    let value = data << 10;
    for (let bit = 14; bit >= 10; bit -= 1) {
      if ((value >>> bit) & 1) value ^= 0x537 << (bit - 10);
    }
    codes.push(((data << 10) | value) ^ 0x5412);
  }
  return codes;
})();

/** BCH(18,6) codes, carried by version 7 and up. */
const VERSION_CODES: number[] = (() => {
  const codes: number[] = [];
  for (let version = 0; version < 41; version += 1) {
    let value = version << 12;
    for (let bit = 17; bit >= 12; bit -= 1) {
      if ((value >>> bit) & 1) value ^= 0x1f25 << (bit - 12);
    }
    codes.push((version << 12) | value);
  }
  return codes;
})();

function popcount(value: number): number {
  let count = 0;
  let remaining = value;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

/**
 * Finds the closest valid format value. Fifteen bits carry five of information,
 * so up to three wrong bits can be corrected by looking for the nearest legal
 * code rather than by any cleverer means.
 */
export function correctFormat(raw: number): { ec: EcLevel; mask: number } | null {
  let best = -1;
  let bestDistance = 4;

  FORMAT_CODES.forEach((code, data) => {
    const distance = popcount(code ^ raw);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = data;
    }
  });

  if (best < 0) return null;
  const ecBits = (best >> 3) & 3;
  const ec = EC_ORDER.find((level) => EC_FORMAT_BITS[level] === ecBits);
  return ec ? { ec, mask: best & 7 } : null;
}

export function correctVersion(raw: number): number | null {
  let best = -1;
  let bestDistance = 4;
  VERSION_CODES.forEach((code, version) => {
    const distance = popcount(code ^ raw);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = version;
    }
  });
  return best >= 7 && best <= 40 ? best : null;
}

// --------------------------------------------------------------------- layout

/** True where a module is structure rather than payload. */
export function functionMask(version: number, size: number): boolean[][] {
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved[y][x] = true;
  };

  // Finder patterns with their separators, and the format bits beside them.
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as [number, number][]) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) mark(ox + dx, oy + dy);
    }
  }
  // The first copy of the format bits runs nine modules along row 8 and nine
  // down column 8. The second copy is only eight each way: eight along row 8 at
  // the right, and seven down column 8 at the bottom plus the always-dark
  // module above them. Reserving nine on those sides would swallow two payload
  // modules and put every codeword after them one place out.
  for (let index = 0; index < 9; index += 1) {
    mark(index, 8);
    mark(8, index);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(size - 1 - index, 8);
    mark(8, size - 1 - index);
  }

  // Timing patterns.
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const corner =
        (i === 0 && j === 0)
        || (i === 0 && j === positions.length - 1)
        || (i === positions.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(positions[i] + dx, positions[j] + dy);
      }
    }
  }

  // Version information blocks.
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const a = Math.floor(index / 3);
      const b = (index % 3) + size - 11;
      mark(a, b);
      mark(b, a);
    }
  }

  return reserved;
}

/**
 * Walks the payload modules in the order the standard lays them out: two-wide
 * columns from the right, alternating upward and downward, with the pairing
 * shifting left once past the vertical timing column.
 *
 * This mirrors the encoder step for step. Any disagreement between the two
 * would put every codeword in the wrong place, so they are written the same way
 * on purpose rather than derived independently.
 */
export function payloadPositions(version: number, size: number): [number, number][] {
  const reserved = functionMask(version, size);
  const positions: [number, number][] = [];

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        // The direction depends on the column's position, not on a running flag.
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!reserved[y][x]) positions.push([x, y]);
      }
    }
  }

  return positions;
}

// --------------------------------------------------------------------- reading

function readFormat(modules: Modules, size: number): { ec: EcLevel; mask: number } {
  // The format bits are written twice. Either copy alone can be corrected, so
  // the first that reads cleanly is used.
  let primary = 0;
  for (let index = 0; index <= 5; index += 1) primary = (primary << 1) | Number(modules[8][index]);
  primary = (primary << 1) | Number(modules[8][7]);
  primary = (primary << 1) | Number(modules[8][8]);
  primary = (primary << 1) | Number(modules[7][8]);
  for (let index = 5; index >= 0; index -= 1) primary = (primary << 1) | Number(modules[index][8]);

  const first = correctFormat(primary);
  if (first) return first;

  let secondary = 0;
  for (let index = 0; index < 7; index += 1) secondary = (secondary << 1) | Number(modules[size - 1 - index][8]);
  for (let index = 7; index >= 0; index -= 1) secondary = (secondary << 1) | Number(modules[8][size - 8 + index]);

  const second = correctFormat(secondary);
  if (second) return second;

  throw new DecodeError('The format information in this code is unreadable.');
}

function readVersion(modules: Modules, size: number): number {
  const bySize = (size - 17) / 4;
  if (bySize < 7) return bySize;

  let raw = 0;
  for (let index = 17; index >= 0; index -= 1) {
    const a = Math.floor(index / 3);
    const b = (index % 3) + size - 11;
    raw = (raw << 1) | Number(modules[b][a]);
  }
  // The size is the more reliable signal; the block is only a cross-check.
  return correctVersion(raw) ?? bySize;
}

/** Lifts the payload codewords out of the grid, undoing the mask on the way. */
export function readCodewords(modules: Modules, version: number, mask: number): number[] {
  const size = version * 4 + 17;
  const positions = payloadPositions(version, size);
  const codewords: number[] = [];

  let current = 0;
  let bits = 0;
  for (const [x, y] of positions) {
    const value = modules[y][x] !== maskCondition(mask, x, y);
    current = (current << 1) | Number(value);
    bits += 1;
    if (bits === 8) {
      codewords.push(current);
      current = 0;
      bits = 0;
    }
  }
  // Any remainder bits at the end are padding and carry nothing.
  return codewords;
}

/**
 * Undoes the interleaving. The encoder writes one codeword from each block in
 * turn, so the blocks have to be rebuilt before any of them can be corrected.
 */
export function deinterleave(codewords: number[], version: number, ec: EcLevel): number[][] {
  const blockCount = NUM_EC_BLOCKS[ec][version];
  const ecPerBlock = ECC_CODEWORDS_PER_BLOCK[ec][version];
  const totalEc = ecPerBlock * blockCount;
  const totalData = codewords.length - totalEc;

  if (totalData <= 0) throw new DecodeError('This code does not hold enough data to read.');

  const shortLength = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;

  const blocks: number[][] = Array.from({ length: blockCount }, (_, index) =>
    new Array<number>(shortLength + (index >= blockCount - longCount ? 1 : 0)));

  // Data codewords, one per block per round. The longer blocks take their extra
  // codeword only after every short block has been filled.
  let at = 0;
  for (let position = 0; position < shortLength; position += 1) {
    for (let block = 0; block < blockCount; block += 1) blocks[block][position] = codewords[at++];
  }
  for (let block = blockCount - longCount; block < blockCount; block += 1) {
    blocks[block][shortLength] = codewords[at++];
  }

  // Error correction codewords, again one per block per round.
  const parity: number[][] = Array.from({ length: blockCount }, () => new Array<number>(ecPerBlock));
  for (let position = 0; position < ecPerBlock; position += 1) {
    for (let block = 0; block < blockCount; block += 1) parity[block][position] = codewords[at++];
  }

  return blocks.map((data, index) => [...data, ...parity[index]]);
}

// --------------------------------------------------------------------- bitstream

class BitReader {
  private position = 0;

  constructor(private readonly bytes: number[]) {}

  get remaining(): number {
    return this.bytes.length * 8 - this.position;
  }

  read(count: number): number {
    if (count > this.remaining) throw new DecodeError('This code ended part way through a character.');
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[(this.position + index) >> 3];
      const bit = 7 - ((this.position + index) & 7);
      value = (value << 1) | ((byte >> bit) & 1);
    }
    this.position += count;
    return value;
  }
}

function countBits(mode: Mode, version: number): number {
  const tier = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === 'numeric') return [10, 12, 14][tier];
  if (mode === 'alphanumeric') return [9, 11, 13][tier];
  return [8, 16, 16][tier];
}

/** A placeholder standing in for a run of raw bytes, resolved once all are read. */
const BYTE_RUN = /^ BYTES:(\d+):(\d+)$/;

/** Turns the corrected data codewords back into text. */
export function readBitstream(bytes: number[], version: number): { text: string; mode: Mode | 'mixed' } {
  const reader = new BitReader(bytes);
  const parts: string[] = [];
  const modes = new Set<Mode>();
  const raw: number[] = [];

  while (reader.remaining >= 4) {
    const indicator = reader.read(4);
    // The terminator, or padding that reads as one.
    if (indicator === 0) break;

    if (indicator === 7) {
      // ECI. The assignment number is variable length, flagged by its top bits.
      // Byte segments are decoded as UTF-8 regardless, so the value is skipped.
      const first = reader.read(8);
      if ((first & 0x80) !== 0) reader.read((first & 0xc0) === 0x80 ? 8 : 16);
      continue;
    }

    const mode: Mode | null =
      indicator === 1 ? 'numeric'
      : indicator === 2 ? 'alphanumeric'
      : indicator === 4 ? 'byte'
      : null;

    if (mode === null) {
      if (indicator === 8) throw new DecodeError('This code uses Kanji mode, which this app cannot read.');
      if (indicator === 3 || indicator === 5) throw new DecodeError('This code is one of a linked set, which this app cannot join up.');
      throw new DecodeError(`This code uses an encoding this app does not know (mode ${indicator}).`);
    }

    modes.add(mode);
    const count = reader.read(countBits(mode, version));

    if (mode === 'numeric') {
      let text = '';
      let left = count;
      while (left >= 3) {
        text += String(reader.read(10)).padStart(3, '0');
        left -= 3;
      }
      if (left === 2) text += String(reader.read(7)).padStart(2, '0');
      else if (left === 1) text += String(reader.read(4));
      parts.push(text);
    } else if (mode === 'alphanumeric') {
      let text = '';
      let left = count;
      while (left >= 2) {
        const pair = reader.read(11);
        text += ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45];
        left -= 2;
      }
      if (left === 1) text += ALPHANUMERIC[reader.read(6)];
      parts.push(text);
    } else {
      // Byte runs are gathered and decoded together at the end, because one
      // character can be split across two segments.
      const start = raw.length;
      for (let index = 0; index < count; index += 1) raw.push(reader.read(8));
      parts.push(` BYTES:${start}:${raw.length}`);
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const text = parts
    .map((part) => {
      const match = BYTE_RUN.exec(part);
      if (!match) return part;
      return decoder.decode(new Uint8Array(raw.slice(Number(match[1]), Number(match[2]))));
    })
    .join('');

  return { text, mode: modes.size === 1 ? [...modes][0] : 'mixed' };
}

// --------------------------------------------------------------------- entry point

/** Reads a QR code from a grid of modules, where true is dark. */
export function decodeMatrix(modules: Modules): DecodeResult {
  const size = modules.length;
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0) {
    throw new DecodeError(`A QR symbol cannot be ${size} modules across.`);
  }
  if (modules.some((row) => row.length !== size)) {
    throw new DecodeError('This grid is not square.');
  }

  const version = readVersion(modules, size);
  const { ec, mask } = readFormat(modules, size);

  const codewords = readCodewords(modules, version, mask);
  const blocks = deinterleave(codewords, version, ec);
  const ecPerBlock = ECC_CODEWORDS_PER_BLOCK[ec][version];

  let repaired = 0;
  const data: number[] = [];

  for (const block of blocks) {
    const working = [...block];
    try {
      repaired += correctBlock(working, ecPerBlock);
    } catch (error) {
      if (error instanceof CorrectionError) {
        throw new DecodeError('This code is too damaged to read. Try a clearer photograph.');
      }
      throw error;
    }
    data.push(...working.slice(0, working.length - ecPerBlock));
  }

  const { text, mode } = readBitstream(data, version);
  return { text, version, ec, mask, mode, repaired };
}
