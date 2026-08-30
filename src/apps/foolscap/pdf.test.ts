import { describe, expect, it } from 'vitest';
import { createPage, type Page } from './model';
import { toPdf } from './pdf';

/** A minimal JPEG carrying a real SOF0 marker declaring 64 by 48. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x11,
    0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint16(25, height, false);
  view.setUint16(27, width, false);
  return bytes;
}

function page(width: number, height: number): Page {
  return createPage(jpeg(width, height), width, height, 'contrast');
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

describe('toPdf', () => {
  it('writes a valid PDF', async () => {
    const bytes = await toPdf([page(640, 480)], 'fit');
    expect(text(bytes.slice(0, 8))).toBe('%PDF-1.7');
    expect(text(bytes.slice(-7))).toContain('%%EOF');
  });

  it('makes one page per scan', async () => {
    const bytes = await toPdf([page(600, 800), page(600, 800), page(600, 800)], 'letter');
    expect(/\/Count (\d+)/.exec(text(bytes))?.[1]).toBe('3');
  });

  it('sizes a fitted page from the image', async () => {
    const bytes = await toPdf([page(1500, 2100)], 'fit');
    // 150 dpi means 1500 pixels is 10 inches, which is 720 points.
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text(bytes));
    expect(Number(box![1])).toBeCloseTo(720, 0);
    expect(Number(box![2])).toBeCloseTo(1008, 0);
  });

  it('uses the sheet dimensions for a fixed size', async () => {
    const bytes = await toPdf([page(600, 800)], 'letter');
    expect(text(bytes)).toContain('/MediaBox [0 0 612 792]');
  });

  it('turns the sheet on its side for a landscape scan', async () => {
    const bytes = await toPdf([page(800, 600)], 'letter');
    expect(text(bytes)).toContain('/MediaBox [0 0 792 612]');
  });

  it('takes the true size from the JPEG rather than the stored numbers', async () => {
    // The stored width and height are wrong; the JPEG header is right.
    const wrong: Page = { ...createPage(jpeg(1500, 2100), 10, 10, 'contrast') };
    const bytes = await toPdf([wrong], 'fit');
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text(bytes));
    expect(Number(box![1])).toBeCloseTo(720, 0);
  });

  it('embeds the image without re-encoding it', async () => {
    const scan = page(600, 800);
    const bytes = await toPdf([scan], 'letter');
    expect(text(bytes)).toContain('/DCTDecode');
    // The original JPEG bytes appear in the file verbatim.
    expect(text(bytes)).toContain(text(scan.bytes.subarray(0, 12)));
  });

  it('refuses to write a PDF with no pages', async () => {
    await expect(toPdf([], 'letter')).rejects.toThrow(/no pages/);
  });

  it('carries the title into the document info', async () => {
    const bytes = await toPdf([page(600, 800)], 'a4', 'Lease agreement');
    expect(text(bytes)).toContain('Lease agreement');
  });

  it('never produces a page smaller than an inch', async () => {
    const bytes = await toPdf([page(4, 4)], 'fit');
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text(bytes));
    expect(Number(box![1])).toBeGreaterThanOrEqual(72);
  });
});
