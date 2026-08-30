import { describe, expect, it } from 'vitest';
import { reedSolomon } from './qr';
import {
  berlekampMassey, chienSearch, correctBlock, CorrectionError, divide, inverse, multiply,
  polyAdd, polyEval, polyMultiply, power, trimLeadingZeros,
} from './gf';

describe('field arithmetic', () => {
  it('has zero as an annihilator', () => {
    expect(multiply(0, 7)).toBe(0);
    expect(multiply(7, 0)).toBe(0);
  });

  it('has one as an identity', () => {
    for (const value of [1, 2, 57, 128, 255]) expect(multiply(value, 1)).toBe(value);
  });

  it('is commutative', () => {
    expect(multiply(87, 131)).toBe(multiply(131, 87));
  });

  it('is associative', () => {
    expect(multiply(multiply(3, 5), 7)).toBe(multiply(3, multiply(5, 7)));
  });

  it('reduces by 0x11D rather than by the AES polynomial', () => {
    // Doubling past 0x80 reduces by the field polynomial, giving 0x1D here.
    // With the AES field 0x11B it would be 0x1B, so this pins down which field.
    expect(multiply(0x80, 0x02)).toBe(0x1d);
  });

  it('agrees with a plain shift and reduce, across the whole field', () => {
    // The log tables are fast but opaque. This is the slow, obvious version,
    // and it is the only real proof the tables were built correctly.
    const longhand = (a: number, b: number): number => {
      let result = 0;
      let x = a;
      let y = b;
      while (y > 0) {
        if (y & 1) result ^= x;
        y >>= 1;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      return result & 0xff;
    };
    for (let a = 0; a < 256; a += 1) {
      for (let b = 0; b < 256; b += 1) {
        if (multiply(a, b) !== longhand(a, b)) {
          throw new Error(`multiply(${a}, ${b}) disagreed with the longhand version`);
        }
      }
    }
    expect(multiply(0x57, 0x83)).toBe(longhand(0x57, 0x83));
  });

  it('divides as the inverse of multiplying', () => {
    for (let a = 1; a < 256; a += 37) {
      for (let b = 1; b < 256; b += 41) {
        expect(divide(multiply(a, b), b)).toBe(a);
      }
    }
  });

  it('refuses to divide by zero', () => {
    expect(() => divide(5, 0)).toThrow(/Division by zero/);
    expect(() => inverse(0)).toThrow(/no inverse/);
  });

  it('gives every non-zero value an inverse', () => {
    for (let value = 1; value < 256; value += 1) {
      expect(multiply(value, inverse(value))).toBe(1);
    }
  });

  it('wraps powers of the generator every 255 steps', () => {
    expect(power(0)).toBe(1);
    expect(power(1)).toBe(2);
    expect(power(255)).toBe(1);
    expect(power(-1)).toBe(power(254));
  });
});

describe('polynomials', () => {
  it('multiplies by a constant', () => {
    expect(polyMultiply([1, 2, 3], [1])).toEqual([1, 2, 3]);
  });

  it('multiplies x by x to give x squared', () => {
    expect(polyMultiply([1, 0], [1, 0])).toEqual([1, 0, 0]);
  });

  it('adds by exclusive or, aligned at the low end', () => {
    expect(polyAdd([1, 2], [3])).toEqual([1, 1]);
    expect(polyAdd([5], [5])).toEqual([0]);
  });

  it('evaluates by Horner', () => {
    // x^2 + 1 at x = 2 is 4 xor 1
    expect(polyEval([1, 0, 1], 2)).toBe(multiply(2, 2) ^ 1);
  });

  it('evaluates a constant as itself', () => {
    expect(polyEval([9], 200)).toBe(9);
  });

  it('trims leading zeros but never to nothing', () => {
    expect(trimLeadingZeros([0, 0, 3, 4])).toEqual([3, 4]);
    expect(trimLeadingZeros([0, 0, 0])).toEqual([0]);
  });
});

describe('correctBlock', () => {
  /** A block is the data followed by the codewords the encoder produced for it. */
  function block(data: number[], ecLength: number): number[] {
    return [...data, ...reedSolomon(data, ecLength)];
  }

  const DATA = [0x40, 0x54, 0x86, 0x56, 0xc6, 0xc6, 0xf2, 0xc2, 0x07, 0x76, 0xf7, 0x26, 0xc6, 0x42, 0x12, 0x03];

  it('reports no errors in an untouched block', () => {
    expect(correctBlock(block(DATA, 10), 10)).toBe(0);
  });

  it('agrees with the encoder, which is the only real check on the tables', () => {
    const clean = block(DATA, 10);
    expect(clean).toHaveLength(DATA.length + 10);
    expect(correctBlock([...clean], 10)).toBe(0);
  });

  it('repairs a single corrupted data byte', () => {
    const damaged = block(DATA, 10);
    damaged[3] ^= 0xff;
    expect(correctBlock(damaged, 10)).toBe(1);
    expect(damaged.slice(0, DATA.length)).toEqual(DATA);
  });

  it('repairs a corrupted parity byte', () => {
    const clean = block(DATA, 10);
    const damaged = [...clean];
    damaged[damaged.length - 1] ^= 0x5a;
    expect(correctBlock(damaged, 10)).toBe(1);
    expect(damaged).toEqual(clean);
  });

  it('repairs the first and last bytes, where an off by one would show', () => {
    for (const at of [0, 25]) {
      const clean = block(DATA, 10);
      const damaged = [...clean];
      damaged[at] ^= 0x93;
      expect(correctBlock(damaged, 10), `position ${at}`).toBe(1);
      expect(damaged, `position ${at}`).toEqual(clean);
    }
  });

  it('repairs up to half the parity length', () => {
    const clean = block(DATA, 10);
    const damaged = [...clean];
    for (const at of [1, 6, 11, 17, 22]) damaged[at] ^= 0x37;
    expect(correctBlock(damaged, 10)).toBe(5);
    expect(damaged).toEqual(clean);
  });

  it('refuses rather than guessing once the damage exceeds the capacity', () => {
    const damaged = block(DATA, 10);
    for (const at of [0, 2, 4, 6, 8, 10, 12, 14]) damaged[at] ^= 0xa5;
    expect(() => correctBlock(damaged, 10)).toThrow(CorrectionError);
  });

  it('works at every parity length QR uses', () => {
    for (const ecLength of [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30]) {
      const clean = block(DATA, ecLength);
      const damaged = [...clean];
      const fixable = Math.floor(ecLength / 2);
      for (let index = 0; index < fixable; index += 1) damaged[index * 2] ^= 0x6b;
      expect(correctBlock(damaged, ecLength), `ec ${ecLength}`).toBe(fixable);
      expect(damaged, `ec ${ecLength}`).toEqual(clean);
    }
  });

  it('handles a block that is all zeros', () => {
    const zeros = block(new Array(16).fill(0), 10);
    expect(correctBlock(zeros, 10)).toBe(0);
  });

  it('finds the locator degree matching the error count', () => {
    const damaged = block(DATA, 10);
    damaged[5] ^= 0x11;
    damaged[9] ^= 0x22;
    const syndromes = Array.from({ length: 10 }, (_, index) => polyEval(damaged, power(index)));
    const locator = berlekampMassey(syndromes, 10);
    expect(locator.length - 1).toBe(2);
    expect(chienSearch(locator, damaged.length)).toHaveLength(2);
  });
});
