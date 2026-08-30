import { jpegImage, PAGE_SIZES, PdfDocument, readJpegSize } from '../../lib/pdf/write';
import type { Page, PageSize } from './model';

const SIZES: Record<Exclude<PageSize, 'fit'>, readonly [number, number]> = {
  letter: PAGE_SIZES.letter,
  a4: PAGE_SIZES.a4,
  legal: PAGE_SIZES.legal,
};

/**
 * Lays scanned pages into a PDF. On a fixed page size the image is fitted
 * inside a margin and centred, keeping its aspect ratio, so a portrait scan on
 * a landscape sheet does not get squashed.
 */
export async function toPdf(pages: Page[], size: PageSize, title = 'Scan'): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('There are no pages to put in a PDF.');

  const doc = new PdfDocument({ title, creator: 'Foolscap on alexmerced.app' });

  for (const page of pages) {
    const measured = readJpegSize(page.bytes);
    const width = measured?.width ?? page.width;
    const height = measured?.height ?? page.height;
    const image = jpegImage(page.bytes);

    if (size === 'fit') {
      // 72 points per inch at a nominal 150 dpi, so a scan comes out close to
      // the physical size of the page it was taken from.
      const scale = 72 / 150;
      const target = doc.addPage(Math.max(72, width * scale), Math.max(72, height * scale));
      target.image(image, 0, 0, target.width, target.height);
      continue;
    }

    const [sheetWidth, sheetHeight] = SIZES[size];
    // A landscape scan gets a landscape sheet, which is what people expect.
    const landscape = width > height;
    const target = doc.addPage(landscape ? sheetHeight : sheetWidth, landscape ? sheetWidth : sheetHeight);

    const margin = 18;
    const available = { width: target.width - margin * 2, height: target.height - margin * 2 };
    const scale = Math.min(available.width / width, available.height / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;

    target.image(image, (target.width - drawWidth) / 2, (target.height - drawHeight) / 2, drawWidth, drawHeight);
  }

  return doc.build();
}
