import { describe, expect, it } from 'vitest';
import { createZip, crc32, safeEntryName, uniqueNames } from './zip';

const encode = (text: string) => new TextEncoder().encode(text);
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('crc32', () => {
  it('matches the known checksum for a standard input', () => {
    // The CRC-32 of "123456789" is a widely published check value.
    expect(crc32(encode('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('differs when a single byte changes', () => {
    expect(crc32(encode('hello'))).not.toBe(crc32(encode('hellp')));
  });
});

describe('safeEntryName', () => {
  it('strips path traversal', () => {
    expect(safeEntryName('../../etc/passwd')).toBe('etc/passwd');
    expect(safeEntryName('./a/./b')).toBe('a/b');
  });

  it('normalises backslashes', () => {
    expect(safeEntryName('a\\b\\c.txt')).toBe('a/b/c.txt');
  });

  it('never returns an empty name', () => {
    expect(safeEntryName('../..')).toBe('file');
    expect(safeEntryName('')).toBe('file');
  });
});

describe('uniqueNames', () => {
  it('leaves distinct names alone', () => {
    const entries = uniqueNames([
      { name: 'a.png', bytes: new Uint8Array() },
      { name: 'b.png', bytes: new Uint8Array() },
    ]);
    expect(entries.map((e) => e.name)).toEqual(['a.png', 'b.png']);
  });

  it('disambiguates duplicates before the extension', () => {
    const entries = uniqueNames([
      { name: 'photo.jpg', bytes: new Uint8Array() },
      { name: 'photo.jpg', bytes: new Uint8Array() },
      { name: 'photo.jpg', bytes: new Uint8Array() },
    ]);
    expect(entries.map((e) => e.name)).toEqual(['photo.jpg', 'photo-2.jpg', 'photo-3.jpg']);
  });

  it('handles names with no extension', () => {
    const entries = uniqueNames([
      { name: 'README', bytes: new Uint8Array() },
      { name: 'README', bytes: new Uint8Array() },
    ]);
    expect(entries.map((e) => e.name)).toEqual(['README', 'README-2']);
  });
});

describe('createZip', () => {
  const at = new Date('2026-06-15T12:30:20Z');

  it('starts with a local file header and ends with the central directory record', () => {
    const zip = createZip([{ name: 'a.txt', bytes: encode('hello') }], at);
    expect(view(zip).getUint32(0, true)).toBe(0x04034b50);
    expect(view(zip).getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });

  it('records the entry count in both places', () => {
    const zip = createZip(
      [
        { name: 'a.txt', bytes: encode('one') },
        { name: 'b.txt', bytes: encode('two') },
        { name: 'c.txt', bytes: encode('three') },
      ],
      at,
    );
    const end = view(zip);
    expect(end.getUint16(zip.length - 22 + 8, true)).toBe(3);
    expect(end.getUint16(zip.length - 22 + 10, true)).toBe(3);
  });

  it('stores the real size and checksum, uncompressed', () => {
    const payload = encode('some file contents');
    const zip = createZip([{ name: 'a.txt', bytes: payload }], at);
    const header = view(zip);
    expect(header.getUint16(8, true)).toBe(0); // method 0 is stored
    expect(header.getUint32(14, true)).toBe(crc32(payload));
    expect(header.getUint32(18, true)).toBe(payload.length);
    expect(header.getUint32(22, true)).toBe(payload.length);
  });

  it('writes the file contents immediately after the header', () => {
    const payload = encode('findme');
    const zip = createZip([{ name: 'a.txt', bytes: payload }], at);
    const nameLength = view(zip).getUint16(26, true);
    const start = 30 + nameLength;
    expect(new TextDecoder().decode(zip.slice(start, start + payload.length))).toBe('findme');
  });

  it('points each central directory entry at its local header', () => {
    const zip = createZip(
      [
        { name: 'first.txt', bytes: encode('1111') },
        { name: 'second.txt', bytes: encode('22222222') },
      ],
      at,
    );
    const end = view(zip);
    const centralOffset = end.getUint32(zip.length - 22 + 16, true);

    let cursor = centralOffset;
    for (let i = 0; i < 2; i += 1) {
      const central = view(zip);
      expect(central.getUint32(cursor, true)).toBe(0x02014b50);
      const localOffset = central.getUint32(cursor + 42, true);
      expect(central.getUint32(localOffset, true)).toBe(0x04034b50);
      cursor += 46 + central.getUint16(cursor + 28, true);
    }
  });

  it('marks names as UTF-8', () => {
    const zip = createZip([{ name: 'café.txt', bytes: encode('x') }], at);
    expect(view(zip).getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it('produces an empty but valid archive', () => {
    const zip = createZip([], at);
    expect(zip.length).toBe(22);
    expect(view(zip).getUint32(0, true)).toBe(0x06054b50);
  });
});
