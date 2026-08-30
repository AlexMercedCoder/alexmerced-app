/**
 * A PDF writer.
 *
 * PDF is a text-based object format: a header, a set of numbered objects, a
 * cross-reference table saying where each one starts, and a trailer. Writing
 * one from scratch is very tractable, and using the fourteen standard fonts
 * means nothing has to be embedded.
 *
 * Limitation, stated plainly: the standard fonts use WinAnsiEncoding, so text
 * is Latin-1. Characters outside it become a question mark rather than a wrong
 * glyph. Supporting CJK or emoji would require embedding and subsetting a font.
 */
import { encodeWinAnsi, measureText, wrapText, type StandardFont } from './fonts';

export type { StandardFont };
export { measureText, wrapText };

/** Page sizes in points, at 72 per inch. */
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
  tabloid: [792, 1224],
  /** 16 by 9 at 96 dpi, which is what a slide deck wants. */
  slide16x9: [960, 540],
  slide4x3: [960, 720],
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

export type Rgb = { r: number; g: number; b: number };

export function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

/** Parses #rrggbb into the 0..1 components PDF wants. */
export function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { r: 0, g: 0, b: 0 };
  const value = parseInt(match[1], 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

const number = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/**
 * Escapes a string for a PDF literal.
 *
 * Order matters: the control characters PDF understands have to be turned into
 * escape sequences before encoding, or WinAnsi would replace them with a
 * question mark on the way past.
 */
export function escapeString(text: string): string {
  let out = '';
  for (const character of text) {
    if (character === '\\') out += '\\\\';
    else if (character === '(') out += '\\(';
    else if (character === ')') out += '\\)';
    else if (character === '\n') out += '\\n';
    else if (character === '\r') out += '\\r';
    else if (character === '\t') out += '\\t';
    else out += encodeWinAnsi(character);
  }
  return out;
}

type ImageResource = {
  name: string;
  width: number;
  height: number;
  bytes: Uint8Array;
  /** Only JPEG can be passed through untouched. */
  filter: 'DCTDecode' | 'FlateDecode';
  colorSpace: 'DeviceRGB' | 'DeviceGray';
  bitsPerComponent: number;
};

/** One page: a content stream plus the resources it refers to. */
export class Page {
  readonly parts: string[] = [];
  readonly fonts = new Set<StandardFont>();
  readonly images: ImageResource[] = [];

  constructor(readonly width: number, readonly height: number) {}

  /** PDF's origin is bottom left; this converts from a top-left system. */
  private y(top: number): number {
    return this.height - top;
  }

  text(
    content: string,
    x: number,
    top: number,
    options: { font?: StandardFont; size?: number; color?: Rgb; align?: 'left' | 'center' | 'right'; width?: number } = {},
  ): this {
    const { font = 'Helvetica', size = 12, color = rgb(0, 0, 0), align = 'left', width } = options;
    if (!content) return this;
    this.fonts.add(font);

    let drawX = x;
    if (align !== 'left' && width !== undefined) {
      const measured = measureText(content, font, size);
      drawX = align === 'center' ? x + (width - measured) / 2 : x + width - measured;
    }

    this.parts.push(
      'BT',
      `${number(color.r)} ${number(color.g)} ${number(color.b)} rg`,
      `/${fontKey(font)} ${number(size)} Tf`,
      `1 0 0 1 ${number(drawX)} ${number(this.y(top) - size)} Tm`,
      `(${escapeString(content)}) Tj`,
      'ET',
    );
    return this;
  }

  /** Lays out wrapped text and returns the height it consumed. */
  paragraph(
    content: string,
    x: number,
    top: number,
    width: number,
    options: { font?: StandardFont; size?: number; color?: Rgb; lineHeight?: number; align?: 'left' | 'center' | 'right' } = {},
  ): number {
    const { font = 'Helvetica', size = 12, lineHeight = 1.45 } = options;
    const lines = wrapText(content, font, size, width);
    lines.forEach((line, index) => {
      this.text(line, x, top + index * size * lineHeight, { ...options, width, align: options.align });
    });
    return lines.length * size * lineHeight;
  }

  rect(x: number, top: number, width: number, height: number, options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number } = {}): this {
    const { fill, stroke, lineWidth = 1 } = options;
    if (!fill && !stroke) return this;

    if (fill) this.parts.push(`${number(fill.r)} ${number(fill.g)} ${number(fill.b)} rg`);
    if (stroke) {
      this.parts.push(`${number(stroke.r)} ${number(stroke.g)} ${number(stroke.b)} RG`, `${number(lineWidth)} w`);
    }
    this.parts.push(`${number(x)} ${number(this.y(top) - height)} ${number(width)} ${number(height)} re`);
    this.parts.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    return this;
  }

  line(x1: number, top1: number, x2: number, top2: number, options: { color?: Rgb; width?: number } = {}): this {
    const { color = rgb(0, 0, 0), width = 1 } = options;
    this.parts.push(
      `${number(color.r)} ${number(color.g)} ${number(color.b)} RG`,
      `${number(width)} w`,
      `${number(x1)} ${number(this.y(top1))} m`,
      `${number(x2)} ${number(this.y(top2))} l`,
      'S',
    );
    return this;
  }

  image(resource: ImageResource, x: number, top: number, width: number, height: number): this {
    this.images.push(resource);
    this.parts.push(
      'q',
      `${number(width)} 0 0 ${number(height)} ${number(x)} ${number(this.y(top) - height)} cm`,
      `/${resource.name} Do`,
      'Q',
    );
    return this;
  }

  get content(): string {
    return this.parts.join('\n');
  }
}

function fontKey(font: StandardFont): string {
  return `F_${font.replace(/-/g, '')}`;
}

/** Reads the dimensions out of a JPEG so it can be placed without decoding it. */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number; grayscale: boolean } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;

  while (offset < bytes.length - 9) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    // The SOFn markers carry the frame dimensions. SOF4, SOF8 and SOF12 do not exist.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
        grayscale: bytes[offset + 9] === 1,
      };
    }
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return null;
}

let imageCounter = 0;

export function jpegImage(bytes: Uint8Array): ImageResource {
  const size = readJpegSize(bytes);
  if (!size) throw new Error('That does not look like a JPEG.');
  imageCounter += 1;
  return {
    name: `Im${imageCounter}`,
    width: size.width,
    height: size.height,
    bytes,
    filter: 'DCTDecode',
    colorSpace: size.grayscale ? 'DeviceGray' : 'DeviceRGB',
    bitsPerComponent: 8,
  };
}

/** Raw RGB pixels, deflated with the browser's own compressor. */
export async function rawRgbImage(rgbBytes: Uint8Array, width: number, height: number): Promise<ImageResource> {
  imageCounter += 1;
  return {
    name: `Im${imageCounter}`,
    width,
    height,
    bytes: await deflate(rgbBytes),
    filter: 'FlateDecode',
    colorSpace: 'DeviceRGB',
    bitsPerComponent: 8,
  };
}

export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type DocumentInfo = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
};

/**
 * Assembles pages into a finished file.
 *
 * Objects are written in order and their byte offsets recorded, because the
 * cross-reference table at the end has to point at each one exactly.
 */
export class PdfDocument {
  readonly pages: Page[] = [];

  constructor(private info: DocumentInfo = {}) {}

  addPage(width: number, height: number): Page;
  addPage(size?: PageSizeName, orientation?: 'portrait' | 'landscape'): Page;
  addPage(a?: number | PageSizeName, b?: number | 'portrait' | 'landscape'): Page {
    let width: number;
    let height: number;

    if (typeof a === 'number' && typeof b === 'number') {
      width = a;
      height = b;
    } else {
      const [w, h] = PAGE_SIZES[(a as PageSizeName) ?? 'letter'];
      const landscape = b === 'landscape';
      width = landscape ? h : w;
      height = landscape ? w : h;
    }

    const page = new Page(width, height);
    this.pages.push(page);
    return page;
  }

  async build(): Promise<Uint8Array> {
    if (this.pages.length === 0) throw new Error('A PDF needs at least one page.');

    const chunks: (string | Uint8Array)[] = [];
    const offsets: number[] = [];
    let length = 0;

    const push = (value: string | Uint8Array) => {
      chunks.push(value);
      length += typeof value === 'string' ? byteLength(value) : value.length;
    };

    push('%PDF-1.7\n');
    // A binary comment marks the file as binary for tools that sniff content.
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const startObject = (id: number) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
    };
    const endObject = () => push('endobj\n');

    // Object 1 is the catalog, 2 the page tree. Pages and their content follow.
    const catalogId = 1;
    const pagesId = 2;
    let nextId = 3;

    const fontIds = new Map<StandardFont, number>();
    for (const page of this.pages) {
      for (const font of page.fonts) {
        if (!fontIds.has(font)) fontIds.set(font, nextId++);
      }
    }

    const imageIds = new Map<ImageResource, number>();
    for (const page of this.pages) {
      for (const image of page.images) {
        if (!imageIds.has(image)) imageIds.set(image, nextId++);
      }
    }

    const pageIds = this.pages.map(() => nextId++);
    const contentIds = this.pages.map(() => nextId++);
    const infoId = nextId++;

    startObject(catalogId);
    push(`<< /Type /Catalog /Pages ${pagesId} 0 R >>\n`);
    endObject();

    startObject(pagesId);
    push(`<< /Type /Pages /Count ${this.pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>\n`);
    endObject();

    for (const [font, id] of fontIds) {
      startObject(id);
      push(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>\n`);
      endObject();
    }

    for (const [image, id] of imageIds) {
      startObject(id);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} ` +
          `/Filter /${image.filter} /Length ${image.bytes.length} >>\nstream\n`,
      );
      push(image.bytes);
      push('\nendstream\n');
      endObject();
    }

    this.pages.forEach((page, index) => {
      const usedFonts = [...page.fonts].map((font) => `/${fontKey(font)} ${fontIds.get(font)} 0 R`);
      const usedImages = [...new Set(page.images)].map((image) => `/${image.name} ${imageIds.get(image)} 0 R`);

      const resources = [
        usedFonts.length ? `/Font << ${usedFonts.join(' ')} >>` : '',
        usedImages.length ? `/XObject << ${usedImages.join(' ')} >>` : '',
      ].filter(Boolean).join(' ');

      startObject(pageIds[index]);
      push(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${number(page.width)} ${number(page.height)}] ` +
          `/Resources << ${resources} >> /Contents ${contentIds[index]} 0 R >>\n`,
      );
      endObject();

      const content = page.content;
      startObject(contentIds[index]);
      push(`<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream\n`);
      endObject();
    });

    startObject(infoId);
    const entries = [
      this.info.title ? `/Title (${escapeString(this.info.title)})` : '',
      this.info.author ? `/Author (${escapeString(this.info.author)})` : '',
      this.info.subject ? `/Subject (${escapeString(this.info.subject)})` : '',
      this.info.keywords ? `/Keywords (${escapeString(this.info.keywords)})` : '',
      `/Producer (alexmerced.app)`,
      `/Creator (${escapeString(this.info.creator ?? 'alexmerced.app')})`,
    ].filter(Boolean);
    push(`<< ${entries.join(' ')} >>\n`);
    endObject();

    const xrefOffset = length;
    const count = nextId;
    push(`xref\n0 ${count}\n`);
    push('0000000000 65535 f \n');
    for (let id = 1; id < count; id += 1) {
      push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${count} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return concat(chunks);
  }

  async blob(): Promise<Blob> {
    const bytes = await this.build();
    return new Blob([bytes as BlobPart], { type: 'application/pdf' });
  }
}

function byteLength(text: string): number {
  // Content is written as Latin-1, so one character is one byte.
  return text.length;
}

function concat(chunks: (string | Uint8Array)[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += typeof chunk === 'string' ? chunk.length : chunk.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      for (let i = 0; i < chunk.length; i += 1) out[offset + i] = chunk.charCodeAt(i) & 0xff;
      offset += chunk.length;
    } else {
      out.set(chunk, offset);
      offset += chunk.length;
    }
  }
  return out;
}
