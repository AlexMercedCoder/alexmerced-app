/**
 * A RIFF/WAVE reader and writer.
 *
 * The browser will decode a WAV for you, but it will not write one, and the
 * decoder is asynchronous and tied to an AudioContext. Having both directions
 * here means the export path is exact, testable, and works in a worker.
 */

export type Samples = {
  sampleRate: number;
  /** One Float32Array per channel, each the same length, nominally -1 to 1. */
  channels: Float32Array[];
};

export type BitDepth = 16 | 24 | 32;

export function frameCount(samples: Samples): number {
  return samples.channels[0]?.length ?? 0;
}

export function duration(samples: Samples): number {
  return samples.sampleRate > 0 ? frameCount(samples) / samples.sampleRate : 0;
}

/** Clamps to the representable range so an over-driven sample wraps to the rail, not around it. */
function clamp(value: number): number {
  return value > 1 ? 1 : value < -1 ? -1 : value;
}

export function encodeWav(samples: Samples, bitDepth: BitDepth = 16): Uint8Array {
  const channelCount = Math.max(1, samples.channels.length);
  const frames = frameCount(samples);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frames * blockAlign;

  // 32-bit is written as IEEE float, which needs the extended fmt chunk and a
  // fact chunk. 16 and 24 bit are plain integer PCM.
  const isFloat = bitDepth === 32;
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;

  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  const ascii = (text: string) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
    offset += text.length;
  };
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const u16 = (value: number) => { view.setUint16(offset, value, true); offset += 2; };

  ascii('RIFF');
  u32(headerSize + dataSize - 8);
  ascii('WAVE');

  ascii('fmt ');
  u32(fmtSize);
  u16(isFloat ? 3 : 1);
  u16(channelCount);
  u32(samples.sampleRate);
  u32(samples.sampleRate * blockAlign);
  u16(blockAlign);
  u16(bitDepth);
  if (isFloat) u16(0);

  if (isFloat) {
    ascii('fact');
    u32(4);
    u32(frames);
  }

  ascii('data');
  u32(dataSize);

  const channels = samples.channels.length ? samples.channels : [new Float32Array(0)];
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = clamp(channels[channel][frame] ?? 0);
      if (bitDepth === 16) {
        // Asymmetric scaling: -1 maps to -32768 and +1 to 32767, so full scale
        // in both directions stays inside the type.
        view.setInt16(offset, Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), true);
        offset += 2;
      } else if (bitDepth === 24) {
        const scaled = Math.round(value < 0 ? value * 0x800000 : value * 0x7fffff);
        view.setUint8(offset, scaled & 0xff);
        view.setUint8(offset + 1, (scaled >> 8) & 0xff);
        view.setUint8(offset + 2, (scaled >> 16) & 0xff);
        offset += 3;
      } else {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
    }
  }

  return bytes;
}

export class WavError extends Error {}

/**
 * Reads a WAV. Chunks are walked rather than assumed to sit at fixed offsets,
 * because plenty of encoders drop a LIST or fact chunk in before the data.
 */
export function decodeWav(input: Uint8Array): Samples {
  if (input.length < 12) throw new WavError('This file is too short to be a WAV.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const tag = (offset: number) => String.fromCharCode(input[offset], input[offset + 1], input[offset + 2], input[offset + 3]);

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new WavError('This is not a WAV file.');

  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= input.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE hides the real format in a sub-chunk GUID whose
      // first two bytes are the format tag.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataStart = body;
      // A streamed file can declare a size of zero, so fall back to what is left.
      dataLength = size === 0 || body + size > input.length ? input.length - body : size;
    }

    // Chunks are word aligned, so an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
    if (size === 0 && id !== 'data') break;
  }

  if (dataStart < 0) throw new WavError('This WAV has no audio data in it.');
  if (channelCount < 1 || sampleRate < 1) throw new WavError('This WAV has an unreadable format chunk.');
  if (format !== 1 && format !== 3) throw new WavError(`This WAV uses a compressed format this app cannot read (format ${format}).`);
  if (![8, 16, 24, 32].includes(bitDepth)) throw new WavError(`This WAV is ${bitDepth} bit, which this app cannot read.`);

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const frames = Math.floor(dataLength / blockAlign);

  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const at = dataStart + frame * blockAlign + channel * bytesPerSample;
      let value: number;
      if (format === 3) {
        value = bitDepth === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
      } else if (bitDepth === 8) {
        // Eight-bit PCM is unsigned, centred on 128.
        value = (view.getUint8(at) - 128) / 128;
      } else if (bitDepth === 16) {
        value = view.getInt16(at, true) / 0x8000;
      } else if (bitDepth === 24) {
        const raw = input[at] | (input[at + 1] << 8) | (input[at + 2] << 16);
        value = (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x800000;
      } else {
        value = view.getInt32(at, true) / 0x80000000;
      }
      channels[channel][frame] = value;
    }
  }

  return { sampleRate, channels };
}

/** True if the bytes start with a RIFF/WAVE header, so the caller can skip the browser decoder. */
export function looksLikeWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}
