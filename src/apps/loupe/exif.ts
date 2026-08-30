/**
 * A small EXIF reader.
 *
 * Loupe strips metadata as a side effect of re-encoding through a canvas. That
 * is only reassuring if you can see what was there in the first place, which is
 * what this is for: read the tags, show them, then show them gone.
 */

export type ExifValue = string | number;
export type ExifTags = Record<string, ExifValue>;

/** The tags worth surfacing. Camera settings, timestamps, and location. */
const TAG_NAMES: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISO',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x920a: 'FocalLength',
  0x9286: 'UserComment',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa430: 'OwnerName',
  0xa431: 'SerialNumber',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
};

const GPS_TAG_NAMES: Record<number, string> = {
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0006: 'GPSAltitude',
  0x001d: 'GPSDateStamp',
};

const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;

/** These are the ones that identify a person or a place. */
export const SENSITIVE_TAGS = new Set([
  'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSDateStamp',
  'Artist', 'Copyright', 'OwnerName', 'SerialNumber', 'UserComment',
]);

type Reader = {
  view: DataView;
  little: boolean;
  base: number;
};

function readValue(reader: Reader, offset: number): ExifValue | null {
  const { view, little, base } = reader;
  const type = view.getUint16(offset + 2, little);
  const count = view.getUint32(offset + 4, little);

  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const size = sizes[type];
  if (!size) return null;

  const total = size * count;
  const valueOffset = total <= 4 ? offset + 8 : base + view.getUint32(offset + 8, little);
  if (valueOffset + total > view.byteLength) return null;

  switch (type) {
    case 1:
    case 7:
      return count === 1 ? view.getUint8(valueOffset) : `${count} bytes`;
    case 2: {
      let text = '';
      for (let i = 0; i < count - 1; i += 1) {
        const code = view.getUint8(valueOffset + i);
        if (code === 0) break;
        text += String.fromCharCode(code);
      }
      return text.trim();
    }
    case 3:
      return view.getUint16(valueOffset, little);
    case 4:
      return view.getUint32(valueOffset, little);
    case 5: {
      // A rational is a numerator over a denominator. GPS uses three of them.
      if (count === 3) {
        const parts: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const numerator = view.getUint32(valueOffset + i * 8, little);
          const denominator = view.getUint32(valueOffset + i * 8 + 4, little);
          parts.push(denominator ? numerator / denominator : 0);
        }
        return Math.round((parts[0] + parts[1] / 60 + parts[2] / 3600) * 1000000) / 1000000;
      }
      const numerator = view.getUint32(valueOffset, little);
      const denominator = view.getUint32(valueOffset + 4, little);
      return denominator ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
    }
    case 9:
      return view.getInt32(valueOffset, little);
    case 10: {
      const numerator = view.getInt32(valueOffset, little);
      const denominator = view.getInt32(valueOffset + 4, little);
      return denominator ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
    }
    default:
      return null;
  }
}

function readIfd(reader: Reader, offset: number, names: Record<number, string>, into: ExifTags): number[] {
  const { view, little } = reader;
  if (offset + 2 > view.byteLength) return [];

  const count = view.getUint16(offset, little);
  const pointers: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;

    const tag = view.getUint16(entry, little);
    if (tag === EXIF_IFD_POINTER || tag === GPS_IFD_POINTER) {
      pointers.push(tag);
      pointers.push(view.getUint32(entry + 8, little));
      continue;
    }

    const name = names[tag];
    if (!name) continue;
    const value = readValue(reader, entry);
    if (value !== null && value !== '') into[name] = value;
  }

  return pointers;
}

/** Reads the EXIF block out of a JPEG. Returns an empty object when there is none. */
export function readExif(bytes: Uint8Array): ExifTags {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};

  let offset = 2;
  while (offset < bytes.length - 4) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];

    // APP1 carrying the "Exif\0\0" identifier.
    if (marker === 0xe1 && bytes[offset + 4] === 0x45 && bytes[offset + 5] === 0x78) {
      const tiffStart = offset + 10;
      if (tiffStart + 8 > bytes.length) return {};

      const view = new DataView(bytes.buffer, bytes.byteOffset + tiffStart, Math.min(length, bytes.length - tiffStart));
      const endian = view.getUint16(0, false);
      if (endian !== 0x4949 && endian !== 0x4d4d) return {};

      const reader: Reader = { view, little: endian === 0x4949, base: 0 };
      if (view.getUint16(2, reader.little) !== 42) return {};

      const tags: ExifTags = {};
      const firstIfd = view.getUint32(4, reader.little);
      const pointers = readIfd(reader, firstIfd, TAG_NAMES, tags);

      for (let i = 0; i < pointers.length; i += 2) {
        const which = pointers[i];
        const at = pointers[i + 1];
        readIfd(reader, at, which === GPS_IFD_POINTER ? GPS_TAG_NAMES : TAG_NAMES, tags);
      }

      return tags;
    }

    if (marker === 0xda || marker === 0xd9) break; // start of scan, or end
    if (length <= 0) break;
    offset += 2 + length;
  }

  return {};
}

/** Turns the raw tags into rows a person can read. */
export function describeExif(tags: ExifTags): { label: string; value: string; sensitive: boolean }[] {
  const rows: { label: string; value: string; sensitive: boolean }[] = [];

  const push = (label: string, value: ExifValue | undefined, sensitive = false) => {
    if (value === undefined || value === '') return;
    rows.push({ label, value: String(value), sensitive });
  };

  push('Camera', [tags.Make, tags.Model].filter(Boolean).join(' ') || undefined);
  push('Lens', [tags.LensMake, tags.LensModel].filter(Boolean).join(' ') || undefined);
  push('Taken', tags.DateTimeOriginal ?? tags.DateTime);
  push('Software', tags.Software);
  if (tags.ExposureTime !== undefined) {
    const seconds = Number(tags.ExposureTime);
    push('Exposure', seconds && seconds < 1 ? `1/${Math.round(1 / seconds)} s` : `${seconds} s`);
  }
  if (tags.FNumber !== undefined) push('Aperture', `f/${tags.FNumber}`);
  push('ISO', tags.ISO);
  if (tags.FocalLength !== undefined) push('Focal length', `${tags.FocalLength} mm`);
  push('Orientation', tags.Orientation);

  if (tags.GPSLatitude !== undefined && tags.GPSLongitude !== undefined) {
    const latitude = Number(tags.GPSLatitude) * (tags.GPSLatitudeRef === 'S' ? -1 : 1);
    const longitude = Number(tags.GPSLongitude) * (tags.GPSLongitudeRef === 'W' ? -1 : 1);
    push('Location', `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`, true);
  }
  push('Altitude', tags.GPSAltitude !== undefined ? `${tags.GPSAltitude} m` : undefined, true);
  push('Artist', tags.Artist, true);
  push('Copyright', tags.Copyright, true);
  push('Owner', tags.OwnerName, true);
  push('Serial number', tags.SerialNumber, true);

  return rows;
}

export function hasSensitiveTags(tags: ExifTags): boolean {
  return Object.keys(tags).some((name) => SENSITIVE_TAGS.has(name));
}
