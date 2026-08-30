import {
  errorResult, fileResult, readEnum, readNumber, requireString, textResult, type McpTool,
} from '../../lib/webmcp';
import { detectPage, finish, type Finish } from './detect';
import { orderCorners, scalePoints, targetSize, warp, type Point } from './geometry';
import { createPage } from './model';
import { toPdf } from './pdf';

const FINISHES = ['contrast', 'blackAndWhite', 'grayscale', 'colour'] as const;

/**
 * Foolscap's tools. Straightening a photographed page is a genuinely hard piece
 * of geometry that an agent cannot do in its head, and the result is the kind of
 * paperwork that should never be uploaded anywhere.
 */
export function foolscapTools(): McpTool[] {
  return [
    {
      name: 'foolscap_find_page',
      description:
        'Look for a document in a photograph and report where its corners are, without changing anything. Says plainly when it cannot find one, which is worth knowing before asking for a scan that would then crop the wrong thing.',
      inputSchema: {
        type: 'object',
        properties: { image: { type: 'string', description: 'A data: URI, blob: URL, or http URL.' } },
        required: ['image'],
      },
      execute: async (input) => {
        const image = await loadImage(requireString(input, 'image'));
        const detection = detectPage(image);
        return textResult({
          width: image.width,
          height: image.height,
          found: detection.confident,
          corners: detection.corners.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
          note: detection.confident
            ? 'The corners are in reading order: top left, top right, bottom right, bottom left.'
            : 'No clear page edge was found, so these are the corners of the whole photograph. Pass your own corners to foolscap_scan if you know where the page is.',
        });
      },
    },
    {
      name: 'foolscap_scan',
      description:
        'Straighten a photographed document and return it as a PDF or a JPEG. The perspective is corrected by homography, so a page shot at an angle comes out square rather than trapezoidal, and the lighting is flattened so one dim corner does not disappear. Corners are found automatically unless you give them.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string' },
          corners: {
            type: 'array',
            description: 'Optional. Four points as [{"x":120,"y":80}, ...] in pixels. Found automatically when omitted.',
            items: { type: 'object' },
          },
          finish: {
            type: 'string',
            enum: [...FINISHES],
            description: '"contrast" flattens the lighting and lifts the paper to white; "blackAndWhite" gives pure ink on pure paper; "colour" leaves it alone. "contrast" by default.',
          },
          as: { type: 'string', enum: ['pdf', 'jpeg'], description: 'PDF by default.' },
          pageSize: { type: 'string', enum: ['fit', 'letter', 'a4', 'legal'] },
          quality: { type: 'number', description: 'JPEG quality, 0.3 to 1. 0.82 by default.' },
        },
        required: ['image'],
      },
      execute: async (input) => {
        const image = await loadImage(requireString(input, 'image'));

        let corners: Point[];
        let detected = false;
        const given = input.corners;

        if (Array.isArray(given) && given.length === 4) {
          const parsed = given.map((entry) => {
            const point = (entry ?? {}) as Record<string, unknown>;
            const x = Number(point.x);
            const y = Number(point.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return { x, y };
          });
          if (parsed.some((point) => point === null)) {
            return errorResult('Each corner needs a numeric x and y, in pixels.');
          }
          corners = orderCorners(parsed as Point[]);
        } else {
          const detection = detectPage(image);
          corners = detection.corners;
          detected = detection.confident;
        }

        const size = targetSize(corners);
        const straightened = warp(image, corners, size.width, size.height);
        const mode = readEnum(input, 'finish', FINISHES, 'contrast') as Finish;
        const finished = finish(straightened, mode, 1);

        const quality = Math.max(0.3, Math.min(1, readNumber(input, 'quality', 0.82)));
        const jpeg = await toJpeg(finished, quality);

        if (readEnum(input, 'as', ['pdf', 'jpeg'] as const, 'pdf') === 'jpeg') {
          return fileResult('scan.jpg', jpeg, 'image/jpeg', {
            width: finished.width,
            height: finished.height,
            cornersFound: detected,
            finish: mode,
          });
        }

        const page = createPage(jpeg, finished.width, finished.height, mode);
        const pdf = await toPdf([page], readEnum(input, 'pageSize', ['fit', 'letter', 'a4', 'legal'] as const, 'fit'), 'Scan');

        return fileResult('scan.pdf', pdf, 'application/pdf', {
          width: finished.width,
          height: finished.height,
          cornersFound: detected,
          finish: mode,
          note: detected
            ? 'The page edges were found automatically.'
            : 'No clear page edge was found, so the whole photograph was used. Pass corners to crop it properly.',
        });
      },
    },
    {
      name: 'foolscap_scans_to_pdf',
      description:
        'Straighten several photographed pages and put them into one PDF, in the order given. Use it to turn a set of photographs of a contract into a single document.',
      inputSchema: {
        type: 'object',
        properties: {
          images: { type: 'array', items: { type: 'string' }, description: 'Data URIs or URLs, in page order.' },
          finish: { type: 'string', enum: [...FINISHES] },
          pageSize: { type: 'string', enum: ['fit', 'letter', 'a4', 'legal'] },
          title: { type: 'string' },
        },
        required: ['images'],
      },
      execute: async (input) => {
        const sources = Array.isArray(input.images) ? input.images.filter((entry): entry is string => typeof entry === 'string') : [];
        if (sources.length === 0) throw new Error('"images" must hold at least one photograph.');

        const mode = readEnum(input, 'finish', FINISHES, 'contrast') as Finish;
        const pages = [];
        const report: { page: number; cornersFound: boolean }[] = [];

        for (let index = 0; index < sources.length; index += 1) {
          const image = await loadImage(sources[index]);
          const detection = detectPage(image);
          const size = targetSize(detection.corners);
          const finished = finish(warp(image, detection.corners, size.width, size.height), mode, 1);
          const jpeg = await toJpeg(finished, 0.82);
          pages.push(createPage(jpeg, finished.width, finished.height, mode));
          report.push({ page: index + 1, cornersFound: detection.confident });
        }

        const title = typeof input.title === 'string' && input.title.trim() ? input.title : 'Scan';
        const pdf = await toPdf(pages, readEnum(input, 'pageSize', ['fit', 'letter', 'a4', 'legal'] as const, 'fit'), title);

        return fileResult(`${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'scan'}.pdf`, pdf, 'application/pdf', {
          pages: pages.length,
          detection: report,
        });
      },
    },
  ];
}

async function loadImage(source: string): Promise<ImageData> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`That image could not be fetched (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    // A phone photograph can be forty megapixels, which is far more than the
    // detection needs and slow enough to matter.
    const cap = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * cap));
    const height = Math.max(1, Math.round(bitmap.height * cap));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser would not give a drawing surface.');
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

async function toJpeg(image: ImageData, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give a drawing surface.');
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Kept for the page, which scales preview corners up to the full image. */
export { scalePoints };
