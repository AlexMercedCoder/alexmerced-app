import {
  errorResult, fileResult, readEnum, readNumber, readString, requireString, textResult,
  type McpTool,
} from '../../lib/webmcp';
import { describeExif, hasSensitiveTags, readExif } from './exif';
import { extensionFor, formatBytes, savings, targetSize, type OutputFormat } from './model';

/**
 * Loupe's tools. The one an agent most needs is the check nobody thinks to do:
 * what a photograph is quietly carrying before it gets posted anywhere.
 */
export function loupeTools(): McpTool[] {
  return [
    {
      name: 'loupe_read_exif',
      description:
        'Read the EXIF metadata out of a JPEG and say what it reveals: the camera, the date and time, and above all whether it carries GPS coordinates. Use this before anyone posts a photograph publicly. Give a data URI, a blob URL, or an http URL.',
      inputSchema: {
        type: 'object',
        properties: { image: { type: 'string', description: 'A data: URI, blob: URL, or http URL for the image.' } },
        required: ['image'],
      },
      execute: async (input) => {
        const source = requireString(input, 'image');
        const response = await fetch(source);
        if (!response.ok) throw new Error(`That image could not be fetched (${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());

        const tags = readExif(bytes);
        const described = describeExif(tags);

        return textResult({
          bytes: bytes.length,
          size: formatBytes(bytes.length),
          hasMetadata: described.length > 0,
          carriesSensitiveData: hasSensitiveTags(tags),
          warning: hasSensitiveTags(tags)
            ? 'This image carries location or identifying data. Re-encoding it, which Loupe does on the page, strips all of it.'
            : null,
          tags: described.map((entry) => ({ label: entry.label, value: entry.value, sensitive: entry.sensitive })),
        });
      },
    },
    {
      name: 'loupe_convert_image',
      description:
        'Resize, convert and compress an image, and get it back. Handles JPEG, PNG and WebP in either direction, and re-encoding strips every piece of EXIF along with it, which is the only reliable way to remove a location from a photograph. Returns the new image as a data URI with the size saved.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'A data: URI, blob: URL, or http URL.' },
          mode: {
            type: 'string',
            enum: ['none', 'fit', 'exact', 'scale'],
            description: '"fit" keeps the shape inside a box, "exact" forces both, "scale" is a percentage.',
          },
          width: { type: 'number', description: 'Pixels for fit and exact, or the percentage for scale.' },
          height: { type: 'number', description: 'Only for "exact".' },
          format: { type: 'string', enum: ['keep', 'jpeg', 'png', 'webp'] },
          quality: { type: 'number', description: '0 to 1, for JPEG and WebP. 0.85 by default.' },
          background: { type: 'string', description: 'Hex colour behind a transparent image when going to JPEG. White by default.' },
        },
        required: ['image'],
      },
      execute: async (input) => {
        const source = requireString(input, 'image');
        const response = await fetch(source);
        if (!response.ok) return errorResult(`That image could not be fetched (${response.status}).`);
        const original = new Uint8Array(await response.arrayBuffer());

        const bitmap = await createImageBitmap(new Blob([original as unknown as BlobPart]));
        try {
          const mode = readEnum(input, 'mode', ['none', 'fit', 'exact', 'scale'] as const, 'none');
          const value = readNumber(input, 'width', bitmap.width);
          const target = targetSize({ width: bitmap.width, height: bitmap.height }, {
            mode,
            width: value,
            height: readNumber(input, 'height', value),
            percent: value,
            format: 'keep',
            quality: 0.85,
            rotate: 0,
            flipHorizontal: false,
            flipVertical: false,
            background: '#ffffff',
            suffix: '',
          });

          const canvas = new OffscreenCanvas(target.width, target.height);
          const context = canvas.getContext('2d');
          if (!context) return errorResult('This browser would not give a drawing surface.');

          const wanted = readEnum(input, 'format', ['keep', 'jpeg', 'png', 'webp'] as const, 'keep');
          const sourceType = response.headers.get('content-type') ?? (source.startsWith('data:') ? source.slice(5, source.indexOf(';')) : '');
          const format = wanted === 'keep'
            ? (sourceType.includes('png') ? 'png' : sourceType.includes('webp') ? 'webp' : 'jpeg')
            : wanted;

          // JPEG has no transparency, so anything see-through has to land on
          // something rather than turning black.
          if (format === 'jpeg') {
            context.fillStyle = readString(input, 'background', '#ffffff') || '#ffffff';
            context.fillRect(0, 0, target.width, target.height);
          }
          context.drawImage(bitmap, 0, 0, target.width, target.height);

          const quality = Math.max(0.1, Math.min(1, readNumber(input, 'quality', 0.85)));
          const blob = await canvas.convertToBlob({ type: `image/${format}`, quality });
          const bytes = new Uint8Array(await blob.arrayBuffer());

          return fileResult(`image.${extensionFor(format as OutputFormat)}`, bytes, `image/${format}`, {
            from: { width: bitmap.width, height: bitmap.height, bytes: original.length },
            to: { width: target.width, height: target.height, bytes: bytes.length },
            saved: `${savings(original.length, bytes.length)}%`,
            metadataStripped: true,
          });
        } finally {
          bitmap.close();
        }
      },
    },
    {
      name: 'loupe_plan_resize',
      description:
        'Work out what an image would become at a given size, without touching it. Give the current dimensions and the constraint, and get back the result with the aspect ratio kept.',
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'The image as it is now.' },
          height: { type: 'number' },
          mode: {
            type: 'string',
            enum: ['fit', 'exact', 'scale', 'none'],
            description: '"fit" keeps the shape inside a box, "exact" forces both dimensions, "scale" is a percentage.',
          },
          value: { type: 'number', description: 'Pixels for fit and exact, a percentage for scale.' },
          heightValue: { type: 'number', description: 'Only for "exact", when the height differs from the width.' },
        },
        required: ['width', 'height', 'mode', 'value'],
      },
      execute: (input) => {
        const width = Math.max(1, Math.round(readNumber(input, 'width', 0)));
        const height = Math.max(1, Math.round(readNumber(input, 'height', 0)));
        const mode = readEnum(input, 'mode', ['fit', 'exact', 'scale', 'none'] as const, 'fit');
        const value = readNumber(input, 'value', 0);

        const result = targetSize({ width, height }, {
          mode,
          // targetSize reads whichever of these the mode calls for.
          width: value,
          height: readNumber(input, 'heightValue', value),
          percent: value,
          format: 'keep',
          quality: 0.85,
          rotate: 0,
          flipHorizontal: false,
          flipVertical: false,
          background: '#ffffff',
          suffix: '',
        });

        return textResult({
          from: { width, height, pixels: width * height },
          to: { width: result.width, height: result.height, pixels: result.width * result.height },
          scale: Number((result.width / width).toFixed(3)),
          note: result.width > width ? 'This is larger than the original, which cannot add detail.' : null,
        });
      },
    },
  ];
}
