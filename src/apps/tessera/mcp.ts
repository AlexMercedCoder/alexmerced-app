import {
  errorResult, fileResult, readEnum, readNumber, readString, requireString, textResult, type McpTool,
} from '../../lib/webmcp';
import { PAYLOADS, payloadByKind, type PayloadKind } from './payloads';
import { encodeQr, toSvg, type EcLevel } from './qr';
import { decodeMatrix } from './decode';
import { scanImage } from './scan';
import { describePayload } from './reader';

const LEVELS = ['L', 'M', 'Q', 'H'] as const;

/**
 * Tessera's tools. Both directions are offered, because an agent asked to
 * "check what this QR code says" should not have to guess from a picture, and
 * one asked to make a Wi-Fi code should not have to remember the format.
 */
export function tesseraTools(): McpTool[] {
  return [
    {
      name: 'tessera_generate_qr',
      description:
        'Make a QR code and return it as SVG markup and as a PNG data URI. Encoded to ISO/IEC 18004 in the browser. Pass "text" for a plain payload, or use "kind" with "fields" to have the payload built correctly for you: url, text, wifi, vcard, email, sms, tel, geo, or event.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The exact payload. Use this or kind and fields, not both.' },
          kind: { type: 'string', enum: PAYLOADS.map((entry) => entry.kind), description: 'Build a structured payload instead.' },
          fields: { type: 'object', description: 'Values for the chosen kind, for example {"ssid":"Cafe","password":"...","encryption":"WPA"}.' },
          ec: { type: 'string', enum: [...LEVELS], description: 'Error correction. L is smallest, H survives the most damage. M by default.' },
          scale: { type: 'number', description: 'Pixels per module for the PNG, 1 to 40. Eight by default.' },
          quiet: { type: 'number', description: 'Quiet zone in modules. Four by default, which is what the standard asks for.' },
          dark: { type: 'string', description: 'Module colour, as a hex value.' },
          light: { type: 'string', description: 'Background colour, as a hex value.' },
        },
      },
      execute: async (input) => {
        let payload = readString(input, 'text');

        if (!payload) {
          const kind = readString(input, 'kind') as PayloadKind;
          const spec = payloadByKind.get(kind);
          if (!spec) {
            return errorResult('Pass either "text", or a "kind" with "fields".', {
              kinds: PAYLOADS.map((entry) => ({
                kind: entry.kind,
                label: entry.label,
                fields: entry.fields.map((field) => ({ name: field.name, label: field.label, required: field.required === true })),
              })),
            });
          }
          const raw = input.fields;
          const values: Record<string, string> = {};
          if (raw && typeof raw === 'object') {
            for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
              values[key] = typeof value === 'string' ? value : String(value ?? '');
            }
          }
          try {
            payload = spec.build(values);
          } catch (error) {
            return errorResult(error instanceof Error ? error.message : 'Those fields were not enough.', {
              required: spec.fields.filter((field) => field.required).map((field) => field.name),
            });
          }
        }

        const ec = readEnum(input, 'ec', LEVELS, 'M') as EcLevel;
        const scale = Math.max(1, Math.min(40, Math.round(readNumber(input, 'scale', 8))));
        const quiet = Math.max(0, Math.min(16, Math.round(readNumber(input, 'quiet', 4))));
        const dark = readString(input, 'dark', '#000000');
        const light = readString(input, 'light', '#ffffff');

        try {
          const code = encodeQr(payload, { ec });
          const svg = toSvg(code, { scale, quietZone: quiet, dark, light });
          const png = await svgToPng(svg, (code.modules.length + quiet * 2) * scale);

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  payload,
                  version: code.version,
                  modules: code.modules.length,
                  ec,
                  mask: code.mask,
                  svg,
                  pngDataUri: png,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'That payload could not be encoded.');
        }
      },
    },
    {
      name: 'tessera_read_qr',
      description:
        'Read a QR code out of an image and say what it contains. Give a data URI or an http URL for the picture. Corrects perspective, handles light-on-dark, and repairs damaged modules with the code’s own error correction. It also classifies the payload and says whether it is safe to follow: Wi-Fi joins, payment requests, two factor secrets and unusual URL schemes are described rather than presented as links.',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'A data: URI, a blob: URL, or an http URL for the image.' },
        },
        required: ['image'],
      },
      execute: async (input) => {
        const source = requireString(input, 'image');
        try {
          const imageData = await loadImageData(source);
          const result = scanImage(imageData);
          const reading = describePayload(result.text);
          return textResult({
            text: result.text,
            contains: reading.kind,
            safeLink: reading.link,
            caution: reading.caution,
            version: result.version,
            ec: result.ec,
            mask: result.mask,
            encoding: result.mode,
            repairedCodewords: result.repaired,
            lightOnDark: result.inverted,
          });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'No QR code was found in that image.');
        }
      },
    },
    {
      name: 'tessera_decode_matrix',
      description:
        'Read a QR code from a grid of modules rather than an image. Give rows of characters where a dark module is any of #, 1, X or a filled block, and anything else is light. Useful when the modules are already known and there is no picture to work from.',
      inputSchema: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: { type: 'string' },
            description: 'One string per row, all the same length, and as many rows as columns.',
          },
        },
        required: ['rows'],
      },
      execute: (input) => {
        const raw = input.rows;
        const rows = (Array.isArray(raw) ? raw : String(raw ?? '').split('\n'))
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trimEnd())
          .filter(Boolean);

        if (rows.length === 0) throw new Error('"rows" must hold the grid, one string per row.');

        const modules = rows.map((row) => [...row].map((character) => '#1Xx█▓*'.includes(character)));
        try {
          const result = decodeMatrix(modules);
          const reading = describePayload(result.text);
          return textResult({ ...result, contains: reading.kind, caution: reading.caution });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : 'That grid is not a readable QR code.', {
            size: `${rows.length} rows, ${rows[0]?.length ?? 0} columns`,
          });
        }
      },
    },
  ];
}

/** Rasterises SVG through an image and a canvas, which is the only path available here. */
async function svgToPng(svg: string, size: number): Promise<string> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The code could not be rasterised.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No drawing surface.');
    context.drawImage(image, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImageData(source: string): Promise<ImageData> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`That image could not be fetched (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No drawing surface.');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
