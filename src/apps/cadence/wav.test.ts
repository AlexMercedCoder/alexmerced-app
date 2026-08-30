import { describe, expect, it } from 'vitest';
import { decodeWav, duration, encodeWav, frameCount, looksLikeWav, WavError, type Samples } from './wav';

function tone(frames: number, channelCount = 1, sampleRate = 48000): Samples {
  const channels = Array.from({ length: channelCount }, (_, channel) =>
    Float32Array.from({ length: frames }, (_, frame) =>
      Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * (channel === 0 ? 0.8 : 0.4)));
  return { sampleRate, channels };
}

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header', () => {
    const bytes = encodeWav(tone(100));
    expect(looksLikeWav(bytes)).toBe(true);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
  });

  it('declares a length that matches the file', () => {
    const bytes = encodeWav(tone(100, 2));
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  });

  it('sizes the file correctly for each bit depth', () => {
    expect(encodeWav(tone(1000, 2), 16).length).toBe(44 + 1000 * 2 * 2);
    expect(encodeWav(tone(1000, 2), 24).length).toBe(44 + 1000 * 2 * 3);
    // Float needs the two extra fmt bytes and a fact chunk.
    expect(encodeWav(tone(1000, 2), 32).length).toBe(44 + 2 + 12 + 1000 * 2 * 4);
  });

  it('marks float files with format 3 and integer files with format 1', () => {
    const read = (bytes: Uint8Array) => new DataView(bytes.buffer).getUint16(20, true);
    expect(read(encodeWav(tone(10), 16))).toBe(1);
    expect(read(encodeWav(tone(10), 32))).toBe(3);
  });

  it('clamps rather than wrapping when a sample goes past full scale', () => {
    const hot: Samples = { sampleRate: 48000, channels: [Float32Array.from([2, -2])] };
    const decoded = decodeWav(encodeWav(hot, 16));
    expect(decoded.channels[0][0]).toBeCloseTo(1, 3);
    expect(decoded.channels[0][1]).toBeCloseTo(-1, 3);
  });

  it('writes an empty file rather than throwing when there is no audio', () => {
    const bytes = encodeWav({ sampleRate: 48000, channels: [new Float32Array(0)] });
    expect(decodeWav(bytes).channels[0]).toHaveLength(0);
  });
});

describe('round trip', () => {
  it('preserves 16 bit mono to within a bit', () => {
    const original = tone(2000);
    const decoded = decodeWav(encodeWav(original, 16));
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channels).toHaveLength(1);
    for (let index = 0; index < 2000; index += 1) {
      expect(decoded.channels[0][index]).toBeCloseTo(original.channels[0][index], 3);
    }
  });

  it('preserves stereo channel separation', () => {
    const original = tone(500, 2);
    const decoded = decodeWav(encodeWav(original, 16));
    expect(decoded.channels).toHaveLength(2);
    // The second channel was written at half the amplitude of the first.
    const peak = (data: Float32Array) => Math.max(...Array.from(data, Math.abs));
    expect(peak(decoded.channels[1])).toBeLessThan(peak(decoded.channels[0]));
  });

  it('is more accurate at 24 bit than at 16', () => {
    const original = tone(1000);
    const error = (depth: 16 | 24) => {
      const decoded = decodeWav(encodeWav(original, depth));
      let worst = 0;
      for (let index = 0; index < 1000; index += 1) {
        worst = Math.max(worst, Math.abs(decoded.channels[0][index] - original.channels[0][index]));
      }
      return worst;
    };
    expect(error(24)).toBeLessThan(error(16));
  });

  it('is exact at 32 bit float', () => {
    const original = tone(300);
    const decoded = decodeWav(encodeWav(original, 32));
    expect(Array.from(decoded.channels[0])).toEqual(Array.from(original.channels[0]));
  });

  it('preserves an unusual sample rate', () => {
    const decoded = decodeWav(encodeWav(tone(100, 1, 22050), 16));
    expect(decoded.sampleRate).toBe(22050);
  });

  it('handles three channels', () => {
    const decoded = decodeWav(encodeWav(tone(50, 3), 16));
    expect(decoded.channels).toHaveLength(3);
  });
});

describe('decodeWav', () => {
  it('walks past an unknown chunk to find the data', () => {
    const original = encodeWav(tone(100), 16);
    // Splice a LIST chunk in between fmt and data, which is where real encoders put one.
    const list = new Uint8Array(8 + 10);
    list.set([0x4c, 0x49, 0x53, 0x54]); // LIST
    new DataView(list.buffer).setUint32(4, 10, true);

    const patched = new Uint8Array(original.length + list.length);
    patched.set(original.subarray(0, 36));
    patched.set(list, 36);
    patched.set(original.subarray(36), 36 + list.length);
    new DataView(patched.buffer).setUint32(4, patched.length - 8, true);

    expect(decodeWav(patched).channels[0]).toHaveLength(100);
  });

  it('skips the pad byte after an odd length chunk', () => {
    const original = encodeWav(tone(64), 16);
    const odd = new Uint8Array(8 + 5 + 1);
    odd.set([0x6e, 0x6f, 0x74, 0x65]); // note
    new DataView(odd.buffer).setUint32(4, 5, true);

    const patched = new Uint8Array(original.length + odd.length);
    patched.set(original.subarray(0, 36));
    patched.set(odd, 36);
    patched.set(original.subarray(36), 36 + odd.length);

    expect(decodeWav(patched).channels[0]).toHaveLength(64);
  });

  it('falls back to the remaining bytes when the data chunk declares zero', () => {
    const bytes = encodeWav(tone(100), 16);
    new DataView(bytes.buffer).setUint32(40, 0, true);
    expect(decodeWav(bytes).channels[0]).toHaveLength(100);
  });

  it('reads eight bit unsigned PCM, where silence is 128', () => {
    const bytes = new Uint8Array(44 + 4);
    bytes.set(new TextEncoder().encode('RIFF'));
    bytes.set(new TextEncoder().encode('WAVE'), 8);
    bytes.set(new TextEncoder().encode('fmt '), 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    bytes.set(new TextEncoder().encode('data'), 36);
    view.setUint32(40, 4, true);
    bytes.set([128, 255, 0, 128], 44);

    const decoded = decodeWav(bytes);
    expect(decoded.channels[0][0]).toBeCloseTo(0, 5);
    expect(decoded.channels[0][1]).toBeCloseTo(0.99, 1);
    expect(decoded.channels[0][2]).toBeCloseTo(-1, 5);
  });

  it('reads a WAVE_FORMAT_EXTENSIBLE header by looking at the sub-format', () => {
    const bytes = encodeWav(tone(50), 16);
    // Rewrite fmt as extensible: tag 0xfffe, size 40, sub-format tag 1.
    const view = new DataView(bytes.buffer);
    const extended = new Uint8Array(bytes.length + 24);
    extended.set(bytes.subarray(0, 16));
    new DataView(extended.buffer).setUint32(16, 40, true);
    extended.set(bytes.subarray(20, 36), 20);
    new DataView(extended.buffer).setUint16(20, 0xfffe, true);
    new DataView(extended.buffer).setUint16(44, 1, true);
    extended.set(bytes.subarray(36), 60);
    expect(decodeWav(extended).channels[0]).toHaveLength(50);
    expect(view.getUint16(20, true)).toBe(1);
  });

  it('rejects a file that is not a WAV', () => {
    expect(() => decodeWav(new TextEncoder().encode('this is not audio at all'))).toThrow(WavError);
  });

  it('rejects a file that is too short', () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/too short/);
  });

  it('names the compression rather than returning noise', () => {
    const bytes = encodeWav(tone(10), 16);
    new DataView(bytes.buffer).setUint16(20, 85, true); // MPEG layer 3
    expect(() => decodeWav(bytes)).toThrow(/format 85/);
  });

  it('reports a missing data chunk plainly', () => {
    const bytes = encodeWav(tone(10), 16).slice(0, 36);
    new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
    expect(() => decodeWav(bytes)).toThrow(/no audio data/);
  });
});

describe('frameCount and duration', () => {
  it('measures in frames and seconds', () => {
    const samples = tone(48000, 2);
    expect(frameCount(samples)).toBe(48000);
    expect(duration(samples)).toBe(1);
  });

  it('returns zero for nothing', () => {
    expect(frameCount({ sampleRate: 48000, channels: [] })).toBe(0);
    expect(duration({ sampleRate: 0, channels: [] })).toBe(0);
  });
});

describe('looksLikeWav', () => {
  it('recognises a WAV and nothing else', () => {
    expect(looksLikeWav(encodeWav(tone(10)))).toBe(true);
    expect(looksLikeWav(new Uint8Array([0xff, 0xfb, 0x90]))).toBe(false);
    expect(looksLikeWav(new Uint8Array(2))).toBe(false);
  });
});
