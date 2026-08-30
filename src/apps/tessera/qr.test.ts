import { describe, expect, it } from 'vitest';
import {
  MAX_VERSION,
  QrError,
  buildCodewords,
  capacityFor,
  chooseMode,
  chooseVersion,
  dataCodewords,
  encodeQr,
  isAlphanumeric,
  isNumeric,
  maskCondition,
  penaltyScore,
  reedSolomon,
  toSvg,
  type EcLevel,
} from './qr';

const LEVELS: EcLevel[] = ['L', 'M', 'Q', 'H'];

// --------------------------------------------------------------- helpers used only by the tests

/** GF(2^8) multiply, mirrored here so the tests do not trust the encoder's copy. */
function gfMul(a: number, b: number): number {
  let result = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i += 1) {
    if (y & 1) result ^= x;
    const high = x & 0x80;
    x = (x << 1) & 0xff;
    if (high) x ^= 0x1d;
    y >>= 1;
  }
  return result;
}

/** Evaluates the codeword polynomial at a field element, via Horner's method. */
function evaluateAt(codeword: number[], root: number): number {
  let accumulator = 0;
  for (const coefficient of codeword) accumulator = gfMul(accumulator, root) ^ coefficient;
  return accumulator;
}

describe('Reed-Solomon', () => {
  it('produces the requested number of error correction codewords', () => {
    expect(reedSolomon([1, 2, 3], 7)).toHaveLength(7);
    expect(reedSolomon([1, 2, 3], 30)).toHaveLength(30);
  });

  it('produces a codeword divisible by the generator, so every syndrome is zero', () => {
    // The definitive property of a Reed-Solomon codeword. If placement of the
    // remainder or the field arithmetic were wrong, these would be non-zero.
    for (const eccLength of [7, 10, 13, 17, 22, 28, 30]) {
      const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff);
      const codeword = [...data, ...reedSolomon(data, eccLength)];

      let root = 1;
      for (let i = 0; i < eccLength; i += 1) {
        expect(evaluateAt(codeword, root)).toBe(0);
        root = gfMul(root, 2);
      }
    }
  });

  it('is deterministic', () => {
    expect(reedSolomon([9, 9, 9], 10)).toEqual(reedSolomon([9, 9, 9], 10));
  });

  it('changes when the data changes', () => {
    expect(reedSolomon([1, 2, 3], 10)).not.toEqual(reedSolomon([1, 2, 4], 10));
  });
});

describe('mode selection', () => {
  it('recognises numeric strings', () => {
    expect(isNumeric('0123456789')).toBe(true);
    expect(isNumeric('12a')).toBe(false);
    expect(isNumeric('')).toBe(false);
  });

  it('recognises the alphanumeric character set', () => {
    expect(isAlphanumeric('HELLO WORLD')).toBe(true);
    expect(isAlphanumeric('HTTPS://ALEXMERCED.APP')).toBe(true);
    expect(isAlphanumeric('hello')).toBe(false);
  });

  it('picks the most compact mode available', () => {
    expect(chooseMode('12345')).toBe('numeric');
    expect(chooseMode('HELLO')).toBe('alphanumeric');
    expect(chooseMode('Hello')).toBe('byte');
    expect(chooseMode('héllo')).toBe('byte');
  });
});

/** The published total data codewords for every version and level. */
const PUBLISHED_DATA_CODEWORDS: Record<number, [number, number, number, number]> = {
  1: [19, 16, 13, 9], 2: [34, 28, 22, 16], 3: [55, 44, 34, 26], 4: [80, 64, 48, 36],
  5: [108, 86, 62, 46], 6: [136, 108, 76, 60], 7: [156, 124, 88, 66], 8: [194, 154, 110, 86],
  9: [232, 182, 132, 100], 10: [274, 216, 154, 122], 11: [324, 254, 180, 140], 12: [370, 290, 206, 158],
  13: [428, 334, 244, 180], 14: [461, 365, 261, 197], 15: [523, 415, 295, 223], 16: [589, 453, 325, 253],
  17: [647, 507, 367, 283], 18: [721, 563, 397, 313], 19: [795, 627, 445, 341], 20: [861, 669, 485, 385],
  21: [932, 714, 512, 406], 22: [1006, 782, 568, 442], 23: [1094, 860, 614, 464], 24: [1174, 914, 664, 514],
  25: [1276, 1000, 718, 538], 26: [1370, 1062, 754, 596], 27: [1468, 1128, 808, 628], 28: [1531, 1193, 871, 661],
  29: [1631, 1267, 911, 701], 30: [1735, 1373, 985, 745], 31: [1843, 1455, 1033, 793], 32: [1955, 1541, 1115, 845],
  33: [2071, 1631, 1171, 901], 34: [2191, 1725, 1231, 961], 35: [2306, 1812, 1286, 986], 36: [2434, 1914, 1354, 1054],
  37: [2566, 1992, 1426, 1096], 38: [2702, 2102, 1502, 1142], 39: [2812, 2216, 1582, 1222], 40: [2956, 2334, 1666, 1276],
};

/** Derived from the capacity, so the tests do not import the private tables. */
function eccCodewordsFor(version: number, ec: EcLevel): number {
  const totalModules = (() => {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const alignCount = Math.floor(version / 7) + 2;
      result -= (25 * alignCount - 10) * alignCount - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  })();
  return Math.floor(totalModules / 8) - dataCodewords(version, ec);
}

describe('capacity', () => {
  it('matches the published table for all 160 version and level combinations', () => {
    for (let version = 1; version <= MAX_VERSION; version += 1) {
      LEVELS.forEach((level, index) => {
        expect(`v${version}${level}=${dataCodewords(version, level)}`)
          .toBe(`v${version}${level}=${PUBLISHED_DATA_CODEWORDS[version][index]}`);
      });
    }
  });

  it('matches the published data capacities for version 1', () => {
    expect(dataCodewords(1, 'L')).toBe(19);
    expect(dataCodewords(1, 'M')).toBe(16);
    expect(dataCodewords(1, 'Q')).toBe(13);
    expect(dataCodewords(1, 'H')).toBe(9);
  });

  it('matches published capacities at the top end', () => {
    expect(dataCodewords(40, 'L')).toBe(2956);
    expect(dataCodewords(40, 'M')).toBe(2334);
    expect(dataCodewords(40, 'Q')).toBe(1666);
    expect(dataCodewords(40, 'H')).toBe(1276);
  });

  it('reports the published character capacities', () => {
    // Version 1 L: 41 numeric, 25 alphanumeric, 17 bytes.
    expect(capacityFor('numeric', 1, 'L')).toBe(41);
    expect(capacityFor('alphanumeric', 1, 'L')).toBe(25);
    expect(capacityFor('byte', 1, 'L')).toBe(17);
    // Version 40 L: 7089 numeric, 4296 alphanumeric, 2953 bytes.
    expect(capacityFor('numeric', 40, 'L')).toBe(7089);
    expect(capacityFor('alphanumeric', 40, 'L')).toBe(4296);
    expect(capacityFor('byte', 40, 'L')).toBe(2953);
  });

  it('grows monotonically with version at a fixed level', () => {
    for (const level of LEVELS) {
      for (let version = 2; version <= MAX_VERSION; version += 1) {
        expect(dataCodewords(version, level)).toBeGreaterThan(dataCodewords(version - 1, level));
      }
    }
  });

  it('shrinks as error correction rises', () => {
    for (let version = 1; version <= MAX_VERSION; version += 1) {
      expect(dataCodewords(version, 'L')).toBeGreaterThan(dataCodewords(version, 'M'));
      expect(dataCodewords(version, 'M')).toBeGreaterThan(dataCodewords(version, 'Q'));
      expect(dataCodewords(version, 'Q')).toBeGreaterThan(dataCodewords(version, 'H'));
    }
  });
});

describe('version selection', () => {
  it('uses the smallest version that fits', () => {
    expect(chooseVersion('HELLO WORLD', 'Q')).toBe(1);
    expect(chooseVersion('1', 'L')).toBe(1);
  });

  it('grows the version as the payload grows', () => {
    const short = chooseVersion('a'.repeat(10), 'M');
    const long = chooseVersion('a'.repeat(500), 'M');
    expect(long).toBeGreaterThan(short);
  });

  it('respects a requested minimum version', () => {
    expect(chooseVersion('hi', 'M', 10)).toBe(10);
  });

  it('refuses a payload no symbol can hold', () => {
    expect(() => chooseVersion('a'.repeat(4000), 'H')).toThrow(QrError);
    expect(() => chooseVersion('a'.repeat(4000), 'H')).toThrow(/more data than a QR code can hold/);
  });
});

describe('codeword assembly', () => {
  it('fills the symbol exactly, data plus error correction', () => {
    for (const level of LEVELS) {
      for (const version of [1, 2, 5, 10, 20, 40]) {
        // Short payload on purpose: the point is that padding fills the rest.
        const codewords = buildCodewords('am', level, version);
        const expected = dataCodewords(version, level) + eccCodewordsFor(version, level);
        expect(codewords.length).toBe(expected);
      }
    }
  });

  it('pads with the alternating bytes the specification names', () => {
    const codewords = buildCodewords('1', 'L', 1);
    expect(codewords.slice(0, dataCodewords(1, 'L'))).toContain(0xec);
    expect(codewords.slice(0, dataCodewords(1, 'L'))).toContain(0x11);
  });

  it('refuses a payload that does not fit the requested version', () => {
    expect(() => buildCodewords('a'.repeat(200), 'H', 1)).toThrow(/does not fit/);
  });
});

describe('masks', () => {
  it('implements all eight conditions', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      expect(typeof maskCondition(mask, 3, 4)).toBe('boolean');
    }
    expect(() => maskCondition(8, 0, 0)).toThrow(QrError);
  });

  it('matches the published formulae at a sample point', () => {
    expect(maskCondition(0, 2, 2)).toBe(true);
    expect(maskCondition(0, 2, 3)).toBe(false);
    expect(maskCondition(1, 4, 2)).toBe(true);
    expect(maskCondition(1, 4, 3)).toBe(false);
    expect(maskCondition(2, 3, 5)).toBe(true);
    expect(maskCondition(2, 4, 5)).toBe(false);
    expect(maskCondition(3, 1, 2)).toBe(true);
  });
});

describe('penalty scoring', () => {
  const size = 21;
  // A checkerboard has no long runs and no solid blocks, so it is the cleanest
  // baseline to measure each rule against. An empty grid is not: it is one
  // enormous run and already scores highly.
  const checkerboard = () =>
    Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => (x + y) % 2 === 0));

  it('charges for long runs', () => {
    const base = checkerboard();
    const withRun = checkerboard();
    for (let x = 0; x < 10; x += 1) withRun[0][x] = true;
    expect(penaltyScore(withRun, size)).toBeGreaterThan(penaltyScore(base, size));
  });

  it('charges for solid blocks', () => {
    const base = checkerboard();
    const block = checkerboard();
    block[5][5] = block[5][6] = block[6][5] = block[6][6] = true;
    expect(penaltyScore(block, size)).toBeGreaterThan(penaltyScore(base, size));
  });

  it('charges heavily for an all-one-colour symbol via the balance rule', () => {
    const size = 21;
    const allDark = Array.from({ length: size }, () => new Array<boolean>(size).fill(true));
    expect(penaltyScore(allDark, size)).toBeGreaterThan(500);
  });
});

// --------------------------------------------------------------- structural checks

function readModule(code: ReturnType<typeof encodeQr>, x: number, y: number): boolean {
  return code.modules[y][x];
}

describe('symbol structure', () => {
  it('produces the right size for each version', () => {
    expect(encodeQr('hi', { ec: 'L' }).size).toBe(21);
    for (const version of [1, 2, 7, 15, 40]) {
      const code = encodeQr('x'.repeat(4), { ec: 'L', minVersion: version });
      expect(code.size).toBe(version * 4 + 17);
      expect(code.modules).toHaveLength(code.size);
      expect(code.modules[0]).toHaveLength(code.size);
    }
  });

  it('places the three finder patterns', () => {
    const code = encodeQr('alexmerced.app', { ec: 'M' });
    const corners: [number, number][] = [[3, 3], [code.size - 4, 3], [3, code.size - 4]];
    for (const [cx, cy] of corners) {
      // Centre three by three is dark, the ring around it is light.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) expect(readModule(code, cx + dx, cy + dy)).toBe(true);
      }
      for (let d = -2; d <= 2; d += 1) {
        expect(readModule(code, cx + d, cy - 2)).toBe(false);
        expect(readModule(code, cx + d, cy + 2)).toBe(false);
      }
    }
  });

  it('places alternating timing patterns', () => {
    const code = encodeQr('alexmerced.app', { ec: 'M' });
    for (let i = 8; i < code.size - 8; i += 1) {
      expect(readModule(code, i, 6)).toBe(i % 2 === 0);
      expect(readModule(code, 6, i)).toBe(i % 2 === 0);
    }
  });

  it('always sets the dark module', () => {
    for (const version of [1, 5, 12, 30]) {
      const code = encodeQr('x', { ec: 'H', minVersion: version });
      expect(readModule(code, 8, code.size - 8)).toBe(true);
    }
  });

  it('leaves the separator ring around each finder light', () => {
    const code = encodeQr('alexmerced.app', { ec: 'Q' });
    for (let i = 0; i < 8; i += 1) {
      expect(readModule(code, i, 7)).toBe(false);
      expect(readModule(code, 7, i)).toBe(false);
    }
  });

  it('encodes at every error correction level and a spread of versions', () => {
    for (const level of LEVELS) {
      for (const version of [1, 4, 7, 14, 27, 40]) {
        const code = encodeQr('am.app', { ec: level, minVersion: version });
        expect(code.version).toBe(version);
        expect(code.ec).toBe(level);
        expect(code.mask).toBeGreaterThanOrEqual(0);
        expect(code.mask).toBeLessThan(8);
      }
    }
  });
});

// --------------------------------------------------------------- round trip

/**
 * Reads a finished symbol back: rebuilds the function-pattern map, walks the
 * zigzag, removes the mask, and returns the interleaved codewords. If the
 * placement, the mask, or the reservation map were wrong, this would not
 * reproduce what the encoder put in.
 */
function readCodewords(code: ReturnType<typeof encodeQr>): number[] {
  const size = code.size;
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const reserve = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved[y][x] = true;
  };

  // Finders, separators, and the format areas beside them.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as [number, number][]) {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) reserve(cx + dx, cy + dy);
  }
  // Timing patterns.
  for (let i = 0; i < size; i += 1) { reserve(6, i); reserve(i, 6); }
  // Format information.
  for (let i = 0; i <= 8; i += 1) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i += 1) { reserve(size - 1 - i, 8); reserve(8, size - 1 - i); }
  // Version information.
  if (code.version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      reserve(a, b);
      reserve(b, a);
    }
  }
  // Alignment patterns.
  const alignmentPositions = (): number[] => {
    if (code.version === 1) return [];
    const count = Math.floor(code.version / 7) + 2;
    const step = code.version === 32 ? 26 : Math.ceil((code.version * 4 + 4) / (count * 2 - 2)) * 2;
    const positions = [6];
    for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
    return positions;
  };
  const positions = alignmentPositions();
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) reserve(positions[i] + dx, positions[j] + dy);
    }
  }

  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y][x]) continue;
        const masked = code.modules[y][x];
        bits.push((masked !== maskCondition(code.mask, x, y)) ? 1 : 0);
      }
    }
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  return codewords;
}

describe('round trip through the matrix', () => {
  it('reads back exactly the codewords the encoder placed', () => {
    const cases: { text: string; ec: EcLevel; version: number }[] = [
      { text: 'HELLO WORLD', ec: 'Q', version: 1 },
      { text: '8675309', ec: 'L', version: 1 },
      { text: 'https://alexmerced.app', ec: 'M', version: 2 },
      { text: 'Tessera makes QR codes without a server.', ec: 'H', version: 5 },
      { text: 'x'.repeat(300), ec: 'M', version: 10 },
      { text: 'y'.repeat(900), ec: 'L', version: 20 },
    ];

    for (const { text, ec, version } of cases) {
      const code = encodeQr(text, { ec, minVersion: version });
      const expected = buildCodewords(text, ec, code.version);
      const actual = readCodewords(code);
      expect(actual.slice(0, expected.length)).toEqual(expected);
    }
  });

  it('reads back correctly under every mask', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const code = encodeQr('alexmerced.app', { ec: 'M', mask });
      expect(code.mask).toBe(mask);
      const expected = buildCodewords('alexmerced.app', 'M', code.version);
      expect(readCodewords(code).slice(0, expected.length)).toEqual(expected);
    }
  });

  it('reads back correctly across versions that use alignment and version blocks', () => {
    for (const version of [1, 2, 6, 7, 14, 25, 32, 40]) {
      // Short enough to fit version 1, so every version in the list is exercised.
      const text = 'am.app';
      const code = encodeQr(text, { ec: 'L', minVersion: version });
      expect(code.version).toBe(version);
      const expected = buildCodewords(text, 'L', code.version);
      expect(readCodewords(code).slice(0, expected.length)).toEqual(expected);
    }
  });
});

describe('rendering', () => {
  it('produces an SVG sized to the symbol plus its quiet zone', () => {
    const code = encodeQr('alexmerced.app', { ec: 'M' });
    const svg = toSvg(code, { scale: 4, quietZone: 4 });
    const total = code.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
    expect(svg).toContain(`width="${total * 4}"`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('honours the colours it is given', () => {
    const svg = toSvg(encodeQr('hi'), { dark: '#112233', light: '#ffeedd' });
    expect(svg).toContain('#112233');
    expect(svg).toContain('#ffeedd');
  });

  it('omits the background when asked for transparency', () => {
    const svg = toSvg(encodeQr('hi'), { transparent: true });
    expect(svg).not.toContain('<rect');
  });
});

describe('input handling', () => {
  it('refuses an empty payload', () => {
    expect(() => encodeQr('')).toThrow(/nothing to encode/);
  });

  it('refuses an unknown error correction level', () => {
    expect(() => encodeQr('hi', { ec: 'Z' as EcLevel })).toThrow(/not an error correction level/);
  });

  it('handles multi-byte characters', () => {
    const code = encodeQr('café ☕ 東京');
    expect(code.mode).toBe('byte');
    expect(code.size).toBeGreaterThan(20);
  });

  it('handles a newline-heavy payload such as a vCard', () => {
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nN:Merced;Alex\nEND:VCARD';
    const code = encodeQr(vcard, { ec: 'M' });
    const expected = buildCodewords(vcard, 'M', code.version);
    expect(readCodewords(code).slice(0, expected.length)).toEqual(expected);
  });
});
