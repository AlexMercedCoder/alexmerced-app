/**
 * Arithmetic in GF(2^8) with the QR primitive polynomial 0x11D, plus enough
 * Reed-Solomon to correct a damaged code rather than merely produce one.
 *
 * Encoding needs only multiplication. Decoding needs the whole apparatus:
 * syndromes to detect that something is wrong, Berlekamp-Massey to find where,
 * Chien search to locate it, and Forney to work out by how much.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  // The table is doubled so a product of two logs can be read without a modulo.
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
}

export function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF(2^8).');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export function inverse(a: number): number {
  if (a === 0) throw new Error('Zero has no inverse in GF(2^8).');
  return EXP[255 - LOG[a]];
}

/** The generator raised to a power, which is how syndromes are evaluated. */
export function power(exponent: number): number {
  return EXP[((exponent % 255) + 255) % 255];
}

// ------------------------------------------------------------------ polynomials
// Polynomials are held with the highest degree first, matching the codeword order.

export function polyMultiply(a: number[], b: number[]): number[] {
  const result = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j += 1) {
      result[i + j] ^= multiply(a[i], b[j]);
    }
  }
  return result;
}

export function polyAdd(a: number[], b: number[]): number[] {
  const length = Math.max(a.length, b.length);
  const result = new Array<number>(length).fill(0);
  for (let i = 0; i < a.length; i += 1) result[i + length - a.length] ^= a[i];
  for (let i = 0; i < b.length; i += 1) result[i + length - b.length] ^= b[i];
  return result;
}

/** Horner's method, evaluating the polynomial at x. */
export function polyEval(poly: number[], x: number): number {
  let result = 0;
  for (const coefficient of poly) result = multiply(result, x) ^ coefficient;
  return result;
}

export function trimLeadingZeros(poly: number[]): number[] {
  let start = 0;
  while (start < poly.length - 1 && poly[start] === 0) start += 1;
  return poly.slice(start);
}

export class CorrectionError extends Error {}

/**
 * Corrects a block in place and reports how many symbols were wrong.
 *
 * The block is data followed by its error correction codewords. Up to
 * ecLength / 2 errors can be fixed; past that the result is not recoverable and
 * this throws rather than returning plausible nonsense.
 */
export function correctBlock(block: number[], ecLength: number): number {
  const syndromes = new Array<number>(ecLength).fill(0);
  let anyError = false;

  for (let index = 0; index < ecLength; index += 1) {
    syndromes[index] = polyEval(block, power(index));
    if (syndromes[index] !== 0) anyError = true;
  }
  if (!anyError) return 0;

  const locator = berlekampMassey(syndromes, ecLength);
  const positions = chienSearch(locator, block.length);

  if (positions.length === 0 || positions.length !== locator.length - 1) {
    throw new CorrectionError('This code is damaged past what its error correction can repair.');
  }

  const magnitudes = forney(syndromes, locator, positions);

  for (let index = 0; index < positions.length; index += 1) {
    const at = block.length - 1 - positions[index];
    if (at < 0 || at >= block.length) {
      throw new CorrectionError('This code is damaged past what its error correction can repair.');
    }
    block[at] ^= magnitudes[index];
  }

  // Recomputing the syndromes is the only honest way to know the repair worked.
  for (let index = 0; index < ecLength; index += 1) {
    if (polyEval(block, power(index)) !== 0) {
      throw new CorrectionError('This code is damaged past what its error correction can repair.');
    }
  }

  return positions.length;
}

/** Finds the error locator polynomial from the syndromes. */
export function berlekampMassey(syndromes: number[], ecLength: number): number[] {
  let locator = [1];
  let previous = [1];
  let shift = 1;
  let lastDiscrepancy = 1;

  for (let index = 0; index < ecLength; index += 1) {
    let discrepancy = syndromes[index];
    for (let j = 1; j < locator.length; j += 1) {
      discrepancy ^= multiply(locator[locator.length - 1 - j], syndromes[index - j]);
    }

    if (discrepancy === 0) {
      shift += 1;
      continue;
    }

    const scaled = polyMultiply(previous, [divide(discrepancy, lastDiscrepancy)]);
    const shifted = [...scaled, ...new Array<number>(shift).fill(0)];
    const updated = polyAdd(locator, shifted);

    if (2 * (locator.length - 1) <= index) {
      previous = locator;
      lastDiscrepancy = discrepancy;
      shift = 1;
    } else {
      shift += 1;
    }
    locator = trimLeadingZeros(updated);
  }

  return locator;
}

/** Finds the roots of the locator, which are the error positions. */
export function chienSearch(locator: number[], length: number): number[] {
  const positions: number[] = [];
  for (let position = 0; position < length; position += 1) {
    // A root at alpha^-position means an error at that position.
    if (polyEval(locator, inverse(power(position))) === 0) positions.push(position);
  }
  return positions;
}

/** Works out how much each located symbol is wrong by. */
export function forney(syndromes: number[], locator: number[], positions: number[]): number[] {
  const syndromePoly = [...syndromes].reverse();
  const product = polyMultiply(syndromePoly, locator);
  // Everything above the correction capacity is discarded.
  const evaluator = trimLeadingZeros(product.slice(product.length - syndromes.length));

  // The formal derivative of a polynomial over GF(2) keeps only the odd terms.
  const derivative: number[] = [];
  const degree = locator.length - 1;
  for (let index = 0; index < degree; index += 1) {
    const power = degree - index;
    derivative.push(power % 2 === 1 ? locator[index] : 0);
  }
  const derivativePoly = trimLeadingZeros(derivative.length ? derivative : [0]);

  return positions.map((position) => {
    const x = power(position);
    const xInverse = inverse(x);
    const numerator = polyEval(evaluator, xInverse);
    const denominator = polyEval(derivativePoly, xInverse);
    if (denominator === 0) throw new CorrectionError('This code is damaged past what its error correction can repair.');
    return multiply(x, divide(numerator, denominator));
  });
}
