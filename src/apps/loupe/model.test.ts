import { describe, expect, it } from 'vitest';
import { describeExif, hasSensitiveTags, readExif, SENSITIVE_TAGS } from './exif';
import {
  FORMATS, defaultRecipe, extensionFor, formatBytes, isLossy, outputName,
  resolveFormat, reviveRecipe, savings, targetSize, type Recipe,
} from './model';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({ ...defaultRecipe, ...over });

describe('targetSize', () => {
  const source = { width: 4000, height: 3000 };

  it('leaves the size alone in none mode', () => {
    expect(targetSize(source, recipe({ mode: 'none' }))).toEqual(source);
  });

  it('fits inside the box, keeping the ratio', () => {
    const size = targetSize(source, recipe({ mode: 'fit', width: 1000, height: 1000 }));
    expect(size).toEqual({ width: 1000, height: 750 });
  });

  it('fits against the limiting dimension', () => {
    expect(targetSize({ width: 1000, height: 4000 }, recipe({ mode: 'fit', width: 800, height: 800 })))
      .toEqual({ width: 200, height: 800 });
  });

  it('never enlarges in fit mode', () => {
    expect(targetSize({ width: 400, height: 300 }, recipe({ mode: 'fit', width: 4000, height: 4000 })))
      .toEqual({ width: 400, height: 300 });
  });

  it('takes the exact size when told to', () => {
    expect(targetSize(source, recipe({ mode: 'exact', width: 123, height: 456 })))
      .toEqual({ width: 123, height: 456 });
  });

  it('scales by percentage', () => {
    expect(targetSize(source, recipe({ mode: 'scale', percent: 25 }))).toEqual({ width: 1000, height: 750 });
  });

  it('can enlarge in scale mode', () => {
    expect(targetSize({ width: 100, height: 100 }, recipe({ mode: 'scale', percent: 200 })))
      .toEqual({ width: 200, height: 200 });
  });

  it('swaps the axes for a quarter turn', () => {
    expect(targetSize(source, recipe({ mode: 'none', rotate: 90 }))).toEqual({ width: 3000, height: 4000 });
    expect(targetSize(source, recipe({ mode: 'none', rotate: 180 }))).toEqual({ width: 4000, height: 3000 });
  });

  it('fits against the rotated dimensions', () => {
    const size = targetSize({ width: 4000, height: 2000 }, recipe({ mode: 'fit', rotate: 90, width: 1000, height: 1000 }));
    expect(size).toEqual({ width: 500, height: 1000 });
  });

  it('never returns a zero dimension', () => {
    const size = targetSize({ width: 10, height: 10 }, recipe({ mode: 'scale', percent: 1 }));
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe('formats', () => {
  it('knows which formats lose data', () => {
    expect(isLossy('image/jpeg')).toBe(true);
    expect(isLossy('image/webp')).toBe(true);
    expect(isLossy('image/png')).toBe(false);
  });

  it('maps to file extensions', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/webp')).toBe('webp');
  });

  it('keeps the source format when asked', () => {
    expect(resolveFormat(recipe({ format: 'keep' }), 'image/jpeg')).toBe('image/jpeg');
  });

  it('falls back to PNG for a format it cannot write', () => {
    expect(resolveFormat(recipe({ format: 'keep' }), 'image/heic')).toBe('image/png');
  });

  it('honours an explicit format', () => {
    expect(resolveFormat(recipe({ format: 'image/webp' }), 'image/jpeg')).toBe('image/webp');
  });

  it('offers three formats every browser can write', () => {
    expect(FORMATS).toHaveLength(3);
  });
});

describe('outputName', () => {
  it('swaps the extension', () => {
    expect(outputName('holiday.jpg', 'image/png', '')).toBe('holiday.png');
  });

  it('adds a suffix before the extension', () => {
    expect(outputName('holiday.jpg', 'image/jpeg', '-small')).toBe('holiday-small.jpg');
  });

  it('handles a name with no extension', () => {
    expect(outputName('holiday', 'image/webp', '')).toBe('holiday.webp');
  });

  it('strips characters that are illegal in a filename', () => {
    expect(outputName('a/b:c*d.png', 'image/png', '')).toBe('a-b-c-d.png');
  });

  it('never produces an empty name', () => {
    expect(outputName('.png', 'image/png', '')).toBe('.png.png');
    expect(outputName('///', 'image/png', '')).toBe('image.png');
  });
});

describe('formatBytes and savings', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('reports the percentage saved', () => {
    expect(savings(1000, 250)).toBe(75);
    expect(savings(1000, 1000)).toBe(0);
  });

  it('reports a negative when the output grew', () => {
    expect(savings(100, 150)).toBe(-50);
  });

  it('does not divide by zero', () => {
    expect(savings(0, 100)).toBe(0);
  });
});

describe('reviveRecipe', () => {
  it('falls back to defaults for nonsense', () => {
    expect(reviveRecipe({ mode: 'sideways', format: 'image/gif', quality: 9 })).toMatchObject({
      mode: defaultRecipe.mode,
      format: 'keep',
      quality: 1,
    });
  });

  it('clamps dimensions into a sane range', () => {
    expect(reviveRecipe({ width: -5 }).width).toBe(1);
    expect(reviveRecipe({ width: 999999 }).width).toBe(20000);
  });

  it('keeps only quarter turns', () => {
    expect(reviveRecipe({ rotate: 45 as 90 }).rotate).toBe(0);
    expect(reviveRecipe({ rotate: 270 }).rotate).toBe(270);
  });

  it('strips illegal characters from the suffix', () => {
    expect(reviveRecipe({ suffix: '-a/b:c' }).suffix).toBe('-abc');
  });

  it('rejects a background that is not a hex colour', () => {
    expect(reviveRecipe({ background: 'white' }).background).toBe(defaultRecipe.background);
    expect(reviveRecipe({ background: '#123456' }).background).toBe('#123456');
  });
});

// --------------------------------------------------------------- EXIF

/** Builds a JPEG carrying an EXIF block, so the reader can be tested for real. */
function jpegWithExif(
  entries: { tag: number; type: number; count: number; value: number[] }[],
  gps: { tag: number; type: number; count: number; value: number[] }[] = [],
): Uint8Array {
  const little = true;
  // TIFF header, then IFD0, then optionally a GPS IFD.
  const ifdSize = 2 + entries.length * 12 + 4;
  const gpsOffset = 8 + ifdSize + (gps.length ? 12 : 0);
  const total = 8 + ifdSize + (gps.length ? 12 + 2 + gps.length * 12 + 4 : 0) + 256;

  const tiff = new Uint8Array(total);
  const view = new DataView(tiff.buffer);

  view.setUint16(0, 0x4949, false); // little endian marker
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little); // first IFD at offset 8

  const entryCount = entries.length + (gps.length ? 1 : 0);
  view.setUint16(8, entryCount, little);

  let cursor = 10;
  for (const entry of entries) {
    view.setUint16(cursor, entry.tag, little);
    view.setUint16(cursor + 2, entry.type, little);
    view.setUint32(cursor + 4, entry.count, little);
    for (let i = 0; i < Math.min(4, entry.value.length); i += 1) {
      view.setUint8(cursor + 8 + i, entry.value[i]);
    }
    cursor += 12;
  }

  if (gps.length) {
    view.setUint16(cursor, 0x8825, little);
    view.setUint16(cursor + 2, 4, little);
    view.setUint32(cursor + 4, 1, little);
    view.setUint32(cursor + 8, gpsOffset, little);
    cursor += 12;

    view.setUint16(gpsOffset, gps.length, little);
    let gpsCursor = gpsOffset + 2;
    for (const entry of gps) {
      view.setUint16(gpsCursor, entry.tag, little);
      view.setUint16(gpsCursor + 2, entry.type, little);
      view.setUint32(gpsCursor + 4, entry.count, little);
      for (let i = 0; i < Math.min(4, entry.value.length); i += 1) {
        view.setUint8(gpsCursor + 8 + i, entry.value[i]);
      }
      gpsCursor += 12;
    }
  }

  const header = [0xff, 0xd8, 0xff, 0xe1];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([...header, (length >> 8) & 0xff, length & 0xff, ...payload, 0xff, 0xd9]);
}

describe('readExif', () => {
  it('returns nothing for something that is not a JPEG', () => {
    expect(readExif(new Uint8Array([1, 2, 3]))).toEqual({});
  });

  it('returns nothing for a JPEG with no EXIF block', () => {
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({});
  });

  it('reads a short string tag', () => {
    // Make = "AB"
    const tags = readExif(jpegWithExif([{ tag: 0x010f, type: 2, count: 3, value: [0x41, 0x42, 0x00, 0x00] }]));
    expect(tags.Make).toBe('AB');
  });

  it('reads a short numeric tag', () => {
    const tags = readExif(jpegWithExif([{ tag: 0x0112, type: 3, count: 1, value: [6, 0, 0, 0] }]));
    expect(tags.Orientation).toBe(6);
  });

  it('reads a long numeric tag', () => {
    const tags = readExif(jpegWithExif([{ tag: 0x8827, type: 4, count: 1, value: [200, 0, 0, 0] }]));
    expect(tags.ISO).toBe(200);
  });

  it('follows the GPS pointer into its own directory', () => {
    const tags = readExif(jpegWithExif(
      [{ tag: 0x010f, type: 2, count: 2, value: [0x41, 0x00, 0, 0] }],
      [{ tag: 0x0001, type: 2, count: 2, value: [0x4e, 0x00, 0, 0] }],
    ));
    expect(tags.GPSLatitudeRef).toBe('N');
  });

  it('ignores tags it does not know about', () => {
    const tags = readExif(jpegWithExif([{ tag: 0x9999, type: 3, count: 1, value: [1, 0, 0, 0] }]));
    expect(Object.keys(tags)).toHaveLength(0);
  });

  it('does not crash on a truncated block', () => {
    const full = jpegWithExif([{ tag: 0x010f, type: 2, count: 2, value: [0x41, 0x00, 0, 0] }]);
    expect(() => readExif(full.slice(0, 20))).not.toThrow();
  });
});

describe('describeExif', () => {
  it('combines make and model into one camera line', () => {
    const rows = describeExif({ Make: 'Canon', Model: 'EOS R5' });
    expect(rows.find((row) => row.label === 'Camera')?.value).toBe('Canon EOS R5');
  });

  it('renders a fast exposure as a fraction', () => {
    expect(describeExif({ ExposureTime: 0.008 }).find((r) => r.label === 'Exposure')?.value).toBe('1/125 s');
  });

  it('renders a long exposure in seconds', () => {
    expect(describeExif({ ExposureTime: 2 }).find((r) => r.label === 'Exposure')?.value).toBe('2 s');
  });

  it('formats the aperture', () => {
    expect(describeExif({ FNumber: 2.8 }).find((r) => r.label === 'Aperture')?.value).toBe('f/2.8');
  });

  it('combines coordinates and marks them sensitive', () => {
    const rows = describeExif({ GPSLatitude: 40.7128, GPSLatitudeRef: 'N', GPSLongitude: 74.006, GPSLongitudeRef: 'W' });
    const location = rows.find((row) => row.label === 'Location');
    expect(location?.value).toBe('40.712800, -74.006000');
    expect(location?.sensitive).toBe(true);
  });

  it('applies the southern and eastern hemispheres', () => {
    const rows = describeExif({ GPSLatitude: 33.86, GPSLatitudeRef: 'S', GPSLongitude: 151.2, GPSLongitudeRef: 'E' });
    expect(rows.find((row) => row.label === 'Location')?.value).toBe('-33.860000, 151.200000');
  });

  it('leaves out tags that are not present', () => {
    expect(describeExif({})).toEqual([]);
  });

  it('marks identifying tags as sensitive', () => {
    const rows = describeExif({ Artist: 'Someone', Model: 'Camera' });
    expect(rows.find((r) => r.label === 'Artist')?.sensitive).toBe(true);
    expect(rows.find((r) => r.label === 'Camera')?.sensitive).toBe(false);
  });
});

describe('hasSensitiveTags', () => {
  it('notices location', () => {
    expect(hasSensitiveTags({ GPSLatitude: 1 })).toBe(true);
  });

  it('notices a serial number', () => {
    expect(hasSensitiveTags({ SerialNumber: 'x' })).toBe(true);
  });

  it('is false for camera settings alone', () => {
    expect(hasSensitiveTags({ Make: 'Canon', ISO: 400 })).toBe(false);
  });

  it('lists the tags it considers identifying', () => {
    expect(SENSITIVE_TAGS.has('GPSLatitude')).toBe(true);
    expect(SENSITIVE_TAGS.has('ISO')).toBe(false);
  });
});
