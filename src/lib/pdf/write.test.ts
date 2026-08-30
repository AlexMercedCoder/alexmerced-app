import { describe, expect, it } from 'vitest';
import { charWidth, measureText, toWinAnsi, wrapText } from './fonts';
import { PAGE_SIZES, PdfDocument, escapeString, hexToRgb, readJpegSize, rgb } from './write';

const decode = (bytes: Uint8Array) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
};

describe('font metrics', () => {
  it('knows the space width for each family', () => {
    expect(charWidth('Helvetica', 32)).toBe(278);
    expect(charWidth('Times-Roman', 32)).toBe(250);
    expect(charWidth('Courier', 32)).toBe(600);
  });

  it('treats Courier as fixed width', () => {
    const widths = new Set([...'abcdefgWM.'].map((c) => charWidth('Courier', c.charCodeAt(0))));
    expect(widths.size).toBe(1);
  });

  it('gives proportional fonts different widths per glyph', () => {
    expect(charWidth('Helvetica', 'i'.charCodeAt(0))).toBeLessThan(charWidth('Helvetica', 'W'.charCodeAt(0)));
  });

  it('measures a string in points', () => {
    // Courier at 12pt is exactly 0.6 em per character.
    expect(measureText('abcde', 'Courier', 12)).toBeCloseTo(5 * 7.2, 6);
  });

  it('measures bold wider than regular for the same text', () => {
    expect(measureText('Hamburgefonstiv', 'Helvetica-Bold', 12))
      .toBeGreaterThan(measureText('Hamburgefonstiv', 'Helvetica', 12));
  });

  it('scales linearly with size', () => {
    expect(measureText('test', 'Helvetica', 24)).toBeCloseTo(measureText('test', 'Helvetica', 12) * 2, 6);
  });
});

describe('WinAnsi encoding', () => {
  it('passes ASCII through', () => {
    expect(toWinAnsi('A')).toBe(65);
    expect(toWinAnsi(' ')).toBe(32);
  });

  it('maps the WinAnsi specials', () => {
    expect(toWinAnsi('’')).toBe(146); // right single quote
    expect(toWinAnsi('—')).toBe(151); // em dash
    expect(toWinAnsi('€')).toBe(128); // euro
  });

  it('keeps Latin-1 accented characters', () => {
    expect(toWinAnsi('é')).toBe(233);
    expect(toWinAnsi('ü')).toBe(252);
  });

  it('falls back to a question mark outside the encoding', () => {
    expect(toWinAnsi('東')).toBe(63);
    expect(toWinAnsi('🙂')).toBe(63);
  });
});

describe('wrapText', () => {
  it('wraps at the measure', () => {
    const lines = wrapText('one two three four five six seven', 'Helvetica', 12, 80);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, 'Helvetica', 12)).toBeLessThanOrEqual(80);
  });

  it('keeps a short string on one line', () => {
    expect(wrapText('short', 'Helvetica', 12, 500)).toEqual(['short']);
  });

  it('honours explicit newlines', () => {
    expect(wrapText('a\nb\nc', 'Helvetica', 12, 500)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a word that cannot fit rather than overflowing', () => {
    const lines = wrapText('supercalifragilistic', 'Helvetica', 12, 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, 'Helvetica', 12)).toBeLessThanOrEqual(30);
  });

  it('preserves blank lines between paragraphs', () => {
    expect(wrapText('a\n\nb', 'Helvetica', 12, 500)).toEqual(['a', '', 'b']);
  });
});

describe('escapeString', () => {
  it('escapes the delimiters that would end a string early', () => {
    expect(escapeString('a(b)c')).toBe('a\\(b\\)c');
    expect(escapeString('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes newlines', () => {
    expect(escapeString('a\nb')).toBe('a\\nb');
  });
});

describe('hexToRgb', () => {
  it('parses six digit hex', () => {
    expect(hexToRgb('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgb('000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('parses a mid tone', () => {
    const color = hexToRgb('#3366cc');
    expect(color.r).toBeCloseTo(0.2, 2);
    expect(color.g).toBeCloseTo(0.4, 2);
    expect(color.b).toBeCloseTo(0.8, 2);
  });

  it('falls back to black on nonsense', () => {
    expect(hexToRgb('nope')).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('readJpegSize', () => {
  it('rejects something that is not a JPEG', () => {
    expect(readJpegSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('reads dimensions from a minimal SOF0 frame', () => {
    // SOI, then an SOF0 segment declaring 40 high by 64 wide, 3 components.
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x28, 0x00, 0x40, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(readJpegSize(bytes)).toEqual({ width: 64, height: 40, grayscale: false });
  });

  it('reports a single component frame as grayscale', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01,
      0x01, 0x11, 0x00,
    ]);
    expect(readJpegSize(bytes)?.grayscale).toBe(true);
  });

  it('skips over other segments to find the frame', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      // An APP0 segment of length 6 that must be stepped over.
      0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(readJpegSize(bytes)).toEqual({ width: 200, height: 100, grayscale: false });
  });
});

describe('PdfDocument', () => {
  it('refuses to build with no pages', async () => {
    await expect(new PdfDocument().build()).rejects.toThrow(/at least one page/);
  });

  it('writes a well formed file', async () => {
    const doc = new PdfDocument({ title: 'Test', author: 'Alex Merced' });
    doc.addPage('letter').text('Hello', 72, 72);
    const text = decode(await doc.build());

    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page');
    expect(text).toContain('xref');
    expect(text).toContain('trailer');
    expect(text).toContain('startxref');
  });

  it('records the page size it was given', async () => {
    const doc = new PdfDocument();
    doc.addPage('a4');
    const text = decode(await doc.build());
    expect(text).toContain(`/MediaBox [0 0 ${PAGE_SIZES.a4[0]} ${PAGE_SIZES.a4[1]}]`);
  });

  it('swaps the axes for landscape', async () => {
    const doc = new PdfDocument();
    doc.addPage('letter', 'landscape');
    expect(decode(await doc.build())).toContain('/MediaBox [0 0 792 612]');
  });

  it('accepts an explicit size', async () => {
    const doc = new PdfDocument();
    doc.addPage(300, 200);
    expect(decode(await doc.build())).toContain('/MediaBox [0 0 300 200]');
  });

  it('counts its pages in the page tree', async () => {
    const doc = new PdfDocument();
    doc.addPage('letter');
    doc.addPage('letter');
    doc.addPage('letter');
    expect(decode(await doc.build())).toContain('/Count 3');
  });

  it('declares only the fonts a page actually uses', async () => {
    const doc = new PdfDocument();
    doc.addPage('letter').text('Regular', 10, 10).text('Bold', 10, 30, { font: 'Helvetica-Bold' });
    const text = decode(await doc.build());
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
    expect(text).not.toContain('/BaseFont /Courier');
  });

  it('places text with the origin at the top left', async () => {
    const doc = new PdfDocument();
    // A letter page is 792 tall, so 72 from the top is 720 from the bottom,
    // less the font size for the baseline.
    doc.addPage('letter').text('x', 0, 72, { size: 12 });
    expect(decode(await doc.build())).toContain('1 0 0 1 0 708 Tm');
  });

  it('writes a cross-reference entry for every object', async () => {
    const doc = new PdfDocument();
    doc.addPage('letter').text('a', 10, 10);
    const text = decode(await doc.build());
    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const entries = text.slice(text.indexOf('xref')).match(/^\d{10} \d{5} [nf] $/gm) ?? [];
    expect(entries).toHaveLength(size);
  });

  it('points startxref at the actual xref position', async () => {
    const doc = new PdfDocument();
    doc.addPage('letter').text('a', 10, 10);
    const text = decode(await doc.build());
    const declared = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(declared, declared + 4)).toBe('xref');
  });

  it('records each object at the offset the table claims', async () => {
    const doc = new PdfDocument({ title: 'Offsets' });
    doc.addPage('letter').text('one', 10, 10).rect(0, 0, 10, 10, { fill: rgb(1, 0, 0) });
    doc.addPage('a4').text('two', 10, 10, { font: 'Times-Bold' });
    const text = decode(await doc.build());

    const table = text.slice(text.indexOf('xref\n0 '));
    const rows = table.match(/^(\d{10}) \d{5} n $/gm) ?? [];
    expect(rows.length).toBeGreaterThan(4);

    rows.forEach((row, index) => {
      const offset = Number(row.slice(0, 10));
      // Object ids start at 1 and are written in order.
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('draws shapes and lines into the content stream', async () => {
    const doc = new PdfDocument();
    doc.addPage('letter')
      .rect(10, 10, 100, 50, { fill: rgb(0, 0, 1) })
      .line(0, 0, 100, 100, { color: rgb(1, 0, 0), width: 2 });
    const text = decode(await doc.build());
    expect(text).toContain(' re');
    expect(text).toContain(' m');
    expect(text).toContain(' l');
    expect(text).toContain('0 0 1 rg');
  });

  it('lays out a paragraph and reports the height used', async () => {
    const doc = new PdfDocument();
    const page = doc.addPage('letter');
    const height = page.paragraph('word '.repeat(60), 72, 72, 400, { size: 10, lineHeight: 1.5 });
    expect(height).toBeGreaterThan(10 * 1.5);
    expect(page.parts.filter((part) => part === 'BT').length).toBeGreaterThan(1);
  });

  it('centres and right aligns within a given width', async () => {
    const doc = new PdfDocument();
    const page = doc.addPage(200, 200);
    page.text('ab', 0, 10, { size: 10, align: 'center', width: 200 });
    page.text('ab', 0, 30, { size: 10, align: 'right', width: 200 });
    const stream = page.content;
    const positions = [...stream.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm/g)].map((m) => Number(m[1]));
    expect(positions[0]).toBeGreaterThan(0);
    expect(positions[1]).toBeGreaterThan(positions[0]);
  });

  it('carries document metadata', async () => {
    const doc = new PdfDocument({ title: 'A title', author: 'Someone' });
    doc.addPage('letter');
    const text = decode(await doc.build());
    expect(text).toContain('/Title (A title)');
    expect(text).toContain('/Author (Someone)');
    expect(text).toContain('/Producer (alexmerced.app)');
  });

  it('escapes metadata that contains delimiters', async () => {
    const doc = new PdfDocument({ title: 'Bad (title)' });
    doc.addPage('letter');
    expect(decode(await doc.build())).toContain('/Title (Bad \\(title\\))');
  });
});
