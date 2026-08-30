import { describe, expect, it } from 'vitest';
import { decodeMatrix, DecodeError, correctFormat, correctVersion, deinterleave, functionMask, payloadPositions } from './decode';
import { encodeQr, type EcLevel } from './qr';

const LEVELS: EcLevel[] = ['L', 'M', 'Q', 'H'];

/** Encodes, then reads the result back. The encoder is the only oracle available. */
function roundTrip(text: string, ec: EcLevel = 'M', minVersion = 1) {
  const code = encodeQr(text, { ec, minVersion });
  return { code, result: decodeMatrix(code.modules) };
}

describe('round trip', () => {
  it('reads back a short alphanumeric payload', () => {
    const { code, result } = roundTrip('HELLO WORLD');
    expect(result.text).toBe('HELLO WORLD');
    expect(result.mode).toBe('alphanumeric');
    expect(result.version).toBe(code.version);
    expect(result.ec).toBe('M');
    expect(result.repaired).toBe(0);
  });

  it('reads back a numeric payload', () => {
    expect(roundTrip('01234567').result.text).toBe('01234567');
  });

  it('reads back numeric payloads of every remainder length', () => {
    for (const digits of ['1', '12', '123', '1234', '12345']) {
      expect(roundTrip(digits).result.text, digits).toBe(digits);
    }
  });

  it('reads back alphanumeric payloads of both parities', () => {
    expect(roundTrip('ABC').result.text).toBe('ABC');
    expect(roundTrip('ABCD').result.text).toBe('ABCD');
  });

  it('reads back a URL', () => {
    const url = 'https://alexmerced.app/tessera?x=1&y=2';
    expect(roundTrip(url).result.text).toBe(url);
  });

  it('reads back text with characters outside ASCII', () => {
    const text = 'Café, naïve, £40, 日本';
    expect(roundTrip(text).result.text).toBe(text);
  });

  it('reads back an emoji, which is four bytes of UTF-8', () => {
    expect(roundTrip('ok 🎉 done').result.text).toBe('ok 🎉 done');
  });

  it('reads back one character', () => {
    expect(roundTrip('A').result.text).toBe('A');
  });

  it('works at every error correction level', () => {
    for (const ec of LEVELS) {
      const { result } = roundTrip('LEVEL CHECK 123', ec);
      expect(result.text, ec).toBe('LEVEL CHECK 123');
      expect(result.ec, ec).toBe(ec);
    }
  });

  it('works across the version range, including the multi-block sizes', () => {
    for (const version of [1, 2, 6, 7, 10, 14, 20, 27, 33, 40]) {
      const { code, result } = roundTrip('The quick brown fox jumps over the lazy dog. ', 'M', version);
      expect(result.version, `version ${version}`).toBe(code.version);
      expect(result.text, `version ${version}`).toBe('The quick brown fox jumps over the lazy dog. ');
    }
  });

  it('reads back a payload large enough to need many blocks', () => {
    const long = 'A'.repeat(1200);
    const { result } = roundTrip(long, 'Q');
    expect(result.text).toBe(long);
    expect(result.version).toBeGreaterThan(20);
  });

  it('reads back the largest payload the smallest symbol holds', () => {
    // Version 1 at level L holds 25 alphanumeric characters.
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXY';
    const { code, result } = roundTrip(text, 'L', 1);
    expect(code.version).toBe(1);
    expect(result.text).toBe(text);
  });

  it('reports the mask the encoder chose', () => {
    const { code, result } = roundTrip('MASK CHECK');
    expect(result.mask).toBe(code.mask);
    expect(result.mask).toBeGreaterThanOrEqual(0);
    expect(result.mask).toBeLessThanOrEqual(7);
  });
});

describe('error correction in practice', () => {
  /** Flips a run of modules in the payload area, standing in for a smudge. */
  function damage(modules: boolean[][], count: number): boolean[][] {
    const size = modules.length;
    const copy = modules.map((row) => [...row]);
    const reserved = functionMask((size - 17) / 4, size);
    let flipped = 0;
    for (let y = 9; y < size - 9 && flipped < count; y += 1) {
      for (let x = 9; x < size - 9 && flipped < count; x += 1) {
        if (reserved[y][x]) continue;
        copy[y][x] = !copy[y][x];
        flipped += 1;
      }
    }
    return copy;
  }

  it('reads through damage and says how much it repaired', () => {
    const code = encodeQr('RECOVERY TEST 12345', { ec: 'H' });
    const result = decodeMatrix(damage(code.modules, 24));
    expect(result.text).toBe('RECOVERY TEST 12345');
    expect(result.repaired).toBeGreaterThan(0);
  });

  it('reads a level H code through damage that would defeat level L', () => {
    const text = 'HIGH LEVEL RECOVERY';
    const high = encodeQr(text, { ec: 'H', minVersion: 4 });
    expect(decodeMatrix(damage(high.modules, 40)).text).toBe(text);
  });

  it('refuses rather than returning nonsense once the damage is too great', () => {
    const code = encodeQr('SHORT', { ec: 'L' });
    const size = code.modules.length;
    const wrecked = code.modules.map((row) => [...row]);
    // Overwrite the entire payload with a fixed pattern, leaving the finders
    // and format bits intact so it still looks like a code worth reading.
    for (const [x, y] of payloadPositions(code.version, size)) {
      wrecked[y][x] = (x * 7 + y * 13) % 3 === 0;
    }
    expect(() => decodeMatrix(wrecked)).toThrow(DecodeError);
  });

  it('recovers from a damaged format block, which is stored twice', () => {
    const code = encodeQr('FORMAT', { ec: 'Q' });
    const copy = code.modules.map((row) => [...row]);
    // Flip two bits of the first format copy. Three or fewer are correctable.
    copy[8][0] = !copy[8][0];
    copy[8][1] = !copy[8][1];
    expect(decodeMatrix(copy).text).toBe('FORMAT');
  });
});

describe('rejecting what is not a QR code', () => {
  it('rejects a grid of an impossible size', () => {
    const grid = Array.from({ length: 20 }, () => new Array(20).fill(false));
    expect(() => decodeMatrix(grid)).toThrow(/cannot be 20 modules/);
  });

  it('rejects a grid that is not square', () => {
    const grid = Array.from({ length: 21 }, (_, index) => new Array(index === 0 ? 20 : 21).fill(false));
    expect(() => decodeMatrix(grid)).toThrow(/not square/);
  });

  it('rejects an empty grid', () => {
    const grid = Array.from({ length: 21 }, () => new Array(21).fill(false));
    expect(() => decodeMatrix(grid)).toThrow(DecodeError);
  });
});

describe('format and version blocks', () => {
  it('reads back every combination of level and mask', () => {
    for (const ec of LEVELS) {
      for (let mask = 0; mask < 8; mask += 1) {
        const code = encodeQr('X', { ec, mask });
        const result = decodeMatrix(code.modules);
        expect(result.ec, `${ec}/${mask}`).toBe(ec);
        expect(result.mask, `${ec}/${mask}`).toBe(mask);
      }
    }
  });

  it('corrects a format word with up to three wrong bits', () => {
    for (const ec of LEVELS) {
      for (let mask = 0; mask < 8; mask += 1) {
        const clean = encodeQr('X', { ec, mask });
        // Read the first format copy straight out of the finished symbol.
        const modules = clean.modules;
        let word = 0;
        for (let index = 0; index <= 5; index += 1) word = (word << 1) | Number(modules[8][index]);
        word = (word << 1) | Number(modules[8][7]);
        word = (word << 1) | Number(modules[8][8]);
        word = (word << 1) | Number(modules[7][8]);
        for (let index = 5; index >= 0; index -= 1) word = (word << 1) | Number(modules[index][8]);

        expect(correctFormat(word), `${ec}/${mask} clean`).toEqual({ ec, mask });
        for (const flips of [[0], [3, 9], [1, 7, 13]]) {
          let damaged = word;
          for (const bit of flips) damaged ^= 1 << bit;
          expect(correctFormat(damaged), `${ec}/${mask} with ${flips.length} bits flipped`).toEqual({ ec, mask });
        }
      }
    }
  });

  it('rejects a format word too far from any legal one', () => {
    // The code has a minimum distance of seven, so plenty of words sit four or
    // more away from every legal one and cannot be recovered.
    let unrecoverable = 0;
    for (let value = 0; value < 32768; value += 1) {
      if (correctFormat(value) === null) unrecoverable += 1;
    }
    expect(unrecoverable).toBeGreaterThan(0);
  });

  it('reads a version block for a large symbol', () => {
    const code = encodeQr('VERSION BLOCK', { minVersion: 7 });
    expect(decodeMatrix(code.modules).version).toBe(code.version);
  });

  it('rejects a version word that decodes below seven', () => {
    expect(correctVersion(0)).toBeNull();
  });
});

describe('layout', () => {
  it('reserves the finder patterns and timing lines', () => {
    const reserved = functionMask(1, 21);
    expect(reserved[0][0]).toBe(true);
    expect(reserved[6][10]).toBe(true);
    expect(reserved[10][6]).toBe(true);
    expect(reserved[10][10]).toBe(false);
  });

  it('reserves the alignment pattern from version 2 up', () => {
    const reserved = functionMask(2, 25);
    expect(reserved[18][18]).toBe(true);
    expect(reserved[16][16]).toBe(true);
    expect(reserved[15][15]).toBe(false);
  });

  it('finds exactly as many payload modules as the symbol holds', () => {
    // Version 1 holds 26 codewords and has no remainder bits.
    expect(payloadPositions(1, 21)).toHaveLength(26 * 8);
    // Version 7 holds 196, and also has no remainder bits.
    expect(payloadPositions(7, 45)).toHaveLength(196 * 8);
    // Version 2 holds 44 codewords and leaves seven bits over.
    expect(payloadPositions(2, 25)).toHaveLength(44 * 8 + 7);
    // Version 14 holds 581 and leaves three over.
    expect(payloadPositions(14, 73)).toHaveLength(581 * 8 + 3);
  });

  it('visits every payload module exactly once', () => {
    for (const [version, size] of [[1, 21], [5, 37], [10, 57]] as [number, number][]) {
      const positions = payloadPositions(version, size);
      const seen = new Set(positions.map(([x, y]) => `${x},${y}`));
      expect(seen.size, `version ${version}`).toBe(positions.length);
    }
  });
});

describe('deinterleave', () => {
  it('splits a single block symbol straight through', () => {
    const codewords = Array.from({ length: 26 }, (_, index) => index);
    const blocks = deinterleave(codewords, 1, 'M');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(codewords);
  });

  it('rebuilds blocks of unequal length in the right order', () => {
    // Version 5 at level Q: four blocks, two of 11 data and two of 12.
    const total = 134;
    const codewords = Array.from({ length: total }, (_, index) => index);
    const blocks = deinterleave(codewords, 5, 'Q');
    expect(blocks).toHaveLength(4);
    // Sixty-two data codewords over four blocks is 15, 15, 16, 16, and each
    // carries eighteen error correction codewords.
    expect(blocks.map((block) => block.length)).toEqual([33, 33, 34, 34]);
  });

  it('refuses a codeword run too short to hold any data', () => {
    expect(() => deinterleave([1, 2, 3], 1, 'H')).toThrow(DecodeError);
  });
});
