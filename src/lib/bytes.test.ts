import { describe, expect, it } from 'vitest';
import { base64Size, formatBytes, fromBase64, toBase64 } from './bytes';

describe('base64', () => {
  it('round trips a short payload', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('round trips an empty payload', () => {
    expect(toBase64(new Uint8Array())).toBe('');
    expect(fromBase64('')).toEqual(new Uint8Array());
  });

  it('matches the standard alphabet', () => {
    expect(toBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });

  it('round trips a payload far past the argument limit', () => {
    // Half a megabyte: enough to break a naive spread-based implementation.
    const bytes = new Uint8Array(512 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const restored = fromBase64(toBase64(bytes));
    expect(restored.length).toBe(bytes.length);
    expect(restored[0]).toBe(0);
    expect(restored[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });

  it('handles a length that is not a multiple of three', () => {
    for (const length of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(length).fill(7);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });
});

describe('base64Size', () => {
  it('reports the encoded length including padding', () => {
    expect(base64Size(3)).toBe(4);
    expect(base64Size(1)).toBe(4);
    expect(base64Size(0)).toBe(0);
    expect(base64Size(1000)).toBe(toBase64(new Uint8Array(1000)).length);
  });
});

describe('formatBytes', () => {
  it('reads the way a file manager would', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(15 * 1024)).toBe('15 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });
});
