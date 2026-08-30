import { assemble, PdfFile, PdfReadError, type PageSelection } from '../../lib/pdf/parse';
import { jpegImage, PAGE_SIZES, PdfDocument, readJpegSize } from '../../lib/pdf/write';
import {
  errorResult, fileResult, readNumber, readString, readStringArray, requireString, textResult,
  type McpTool,
} from '../../lib/webmcp';
import { parsePageRange, rotateBy } from './model';

/**
 * Quire's tools. Handling PDFs is something an agent is regularly asked to do
 * and has no way to do on its own, so these take files in as data URIs and hand
 * finished ones back the same way.
 */
export function quireTools(): McpTool[] {
  return [
    {
      name: 'quire_describe_pdf',
      description:
        'Read a PDF and report how many pages it has, the size and rotation of each, and the file size. Call this before merging or extracting so the page numbers you use are right.',
      inputSchema: {
        type: 'object',
        properties: { pdf: { type: 'string', description: 'A data: URI, blob: URL, or http URL for the PDF.' } },
        required: ['pdf'],
      },
      execute: async (input) => {
        const bytes = await fetchBytes(requireString(input, 'pdf'));
        const file = await open(bytes);
        return textResult({
          bytes: bytes.length,
          pages: file.pages.length,
          sizes: file.pages.map((page) => ({
            page: page.index + 1,
            widthPoints: Math.round(page.width),
            heightPoints: Math.round(page.height),
            inches: `${(page.width / 72).toFixed(2)} by ${(page.height / 72).toFixed(2)}`,
            rotation: page.rotation,
          })),
        });
      },
    },
    {
      name: 'quire_merge_pdfs',
      description:
        'Join several PDFs into one, in the order given. Optionally take only some pages from each, using ranges like "1-3,7,12-". Returns the finished PDF as a data URI.',
      inputSchema: {
        type: 'object',
        properties: {
          pdfs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Data URIs or URLs, in the order they should appear.',
          },
          ranges: {
            type: 'array',
            items: { type: 'string' },
            description: 'One range per PDF, matching by position. Blank or missing means every page. For example ["1-3", "", "5"].',
          },
        },
        required: ['pdfs'],
      },
      execute: async (input) => {
        const sources = readStringArray(input, 'pdfs');
        if (sources.length === 0) throw new Error('"pdfs" must hold at least one PDF.');
        const ranges = readStringArray(input, 'ranges');

        const selection: PageSelection[] = [];
        const summary: { pdf: number; pages: number }[] = [];

        for (let index = 0; index < sources.length; index += 1) {
          const file = await open(await fetchBytes(sources[index]));
          const range = ranges[index]?.trim();
          const wanted = range ? parsePageRange(range, file.pages.length) : file.pages.map((page) => page.index);
          if (wanted.length === 0) {
            return errorResult(`The range "${range}" picks no pages out of PDF ${index + 1}, which has ${file.pages.length}.`);
          }
          for (const page of wanted) selection.push({ file, pageIndex: page });
          summary.push({ pdf: index + 1, pages: wanted.length });
        }

        const merged = await assemble(selection);
        return fileResult('merged.pdf', merged, 'application/pdf', {
          pages: selection.length,
          from: summary,
        });
      },
    },
    {
      name: 'quire_extract_pages',
      description:
        'Take some pages out of a PDF and return them as a new one. Ranges look like "1-3,7,12-", counting from one. Use it to split a document or pull out a single page.',
      inputSchema: {
        type: 'object',
        properties: {
          pdf: { type: 'string' },
          range: { type: 'string', description: 'For example "1-3,7" or "5-".' },
        },
        required: ['pdf', 'range'],
      },
      execute: async (input) => {
        const file = await open(await fetchBytes(requireString(input, 'pdf')));
        const range = requireString(input, 'range');
        const wanted = parsePageRange(range, file.pages.length);
        if (wanted.length === 0) {
          return errorResult(`"${range}" picks no pages. This PDF has ${file.pages.length}.`);
        }
        const bytes = await assemble(wanted.map((pageIndex) => ({ file, pageIndex })));
        return fileResult('extract.pdf', bytes, 'application/pdf', {
          pages: wanted.length,
          taken: wanted.map((page) => page + 1),
        });
      },
    },
    {
      name: 'quire_rotate_pages',
      description:
        'Turn some or all of a PDF’s pages by a quarter, a half, or three quarters, and return the result. Use it to fix a document that was scanned sideways.',
      inputSchema: {
        type: 'object',
        properties: {
          pdf: { type: 'string' },
          degrees: { type: 'number', description: '90, 180, or 270. Added to whatever rotation the page already has.' },
          range: { type: 'string', description: 'Which pages. Every page when omitted.' },
        },
        required: ['pdf', 'degrees'],
      },
      execute: async (input) => {
        const file = await open(await fetchBytes(requireString(input, 'pdf')));
        const degrees = Math.round(readNumber(input, 'degrees', 90));
        if (![90, 180, 270, -90, -180, -270].includes(degrees)) {
          return errorResult('A PDF page can only be turned by 90, 180, or 270 degrees.');
        }

        const range = readString(input, 'range');
        const wanted = new Set(range ? parsePageRange(range, file.pages.length) : file.pages.map((page) => page.index));

        const bytes = await assemble(file.pages.map((page) => ({
          file,
          pageIndex: page.index,
          rotate: wanted.has(page.index) ? rotateBy(page.rotation, degrees) : page.rotation,
        })));

        return fileResult('rotated.pdf', bytes, 'application/pdf', { turned: [...wanted].map((page) => page + 1) });
      },
    },
    {
      name: 'quire_images_to_pdf',
      description:
        'Turn a set of JPEG images into a PDF, one image per page. Useful for making a single document out of photographs of receipts or pages.',
      inputSchema: {
        type: 'object',
        properties: {
          images: { type: 'array', items: { type: 'string' }, description: 'JPEG data URIs or URLs, in order.' },
          pageSize: {
            type: 'string',
            enum: ['fit', 'letter', 'a4', 'legal'],
            description: '"fit" makes each page the size of its image. The others centre it on a sheet.',
          },
        },
        required: ['images'],
      },
      execute: async (input) => {
        const sources = readStringArray(input, 'images');
        if (sources.length === 0) throw new Error('"images" must hold at least one image.');

        const size = readString(input, 'pageSize', 'fit');
        const doc = new PdfDocument({ title: 'Images', creator: 'Quire on alexmerced.app' });
        let skipped = 0;

        for (const source of sources) {
          const bytes = await fetchBytes(source);
          const measured = readJpegSize(bytes);
          if (!measured) {
            // Only JPEG can go into a PDF without being re-encoded, and
            // re-encoding here would need a canvas the tool does not have.
            skipped += 1;
            continue;
          }

          const image = jpegImage(bytes);
          if (size === 'fit') {
            const scale = 72 / 150;
            const page = doc.addPage(Math.max(72, measured.width * scale), Math.max(72, measured.height * scale));
            page.image(image, 0, 0, page.width, page.height);
            continue;
          }

          const [sheetWidth, sheetHeight] = PAGE_SIZES[size as 'letter' | 'a4' | 'legal'];
          const landscape = measured.width > measured.height;
          const page = doc.addPage(landscape ? sheetHeight : sheetWidth, landscape ? sheetWidth : sheetHeight);
          const margin = 18;
          const fit = Math.min(
            (page.width - margin * 2) / measured.width,
            (page.height - margin * 2) / measured.height,
          );
          const drawWidth = measured.width * fit;
          const drawHeight = measured.height * fit;
          page.image(image, (page.width - drawWidth) / 2, (page.height - drawHeight) / 2, drawWidth, drawHeight);
        }

        if (doc.pages.length === 0) {
          return errorResult('None of those were JPEGs. Only JPEG can be placed in a PDF without re-encoding.');
        }

        const bytes = await doc.build();
        return fileResult('images.pdf', bytes, 'application/pdf', {
          pages: doc.pages.length,
          skippedNotJpeg: skipped || undefined,
        });
      },
    },
  ];
}

async function open(bytes: Uint8Array): Promise<PdfFile> {
  try {
    return await PdfFile.open(bytes);
  } catch (error) {
    throw new Error(error instanceof PdfReadError ? error.message : 'That file could not be read as a PDF.');
  }
}

/** Fetch handles data URIs, blob URLs and http URLs alike. */
export async function fetchBytes(source: string): Promise<Uint8Array> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`That file could not be fetched (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}
