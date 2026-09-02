import { describe, expect, it } from 'vitest';
import { alignToZero, canEncodeAudio, joinAcross, OPUS_RATE, resampleTo48k } from './opus';
import type { WebmSample } from './webm';

/** A stand-in AudioBuffer, since neither Node nor jsdom has Web Audio. */
function fakeBuffer(sampleRate: number, seconds: number, channels = 1, fill = (i: number, c: number) => Math.sin(i / 10) * (c === 0 ? 1 : 0.5)): AudioBuffer {
  const length = Math.round(sampleRate * seconds);
  const data = Array.from({ length: channels }, (_, channel) =>
    Float32Array.from({ length }, (_, index) => fill(index, channel)));
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channels,
    getChannelData: (channel: number) => data[channel],
  } as unknown as AudioBuffer;
}

describe('resampleTo48k', () => {
  it('leaves a 48 kHz source alone but for the window', () => {
    const buffer = fakeBuffer(OPUS_RATE, 1);
    const planes = resampleTo48k(buffer, 0, 1, 1);
    expect(planes[0]).toHaveLength(OPUS_RATE);
    expect(planes[0][100]).toBeCloseTo(buffer.getChannelData(0)[100], 6);
  });

  it('stretches a lower rate up to 48 kHz, keeping the duration', () => {
    const planes = resampleTo48k(fakeBuffer(16000, 2), 0, 2, 1);
    expect(planes[0]).toHaveLength(OPUS_RATE * 2);
  });

  it('takes only the window asked for', () => {
    const planes = resampleTo48k(fakeBuffer(OPUS_RATE, 10), 2, 5, 1);
    expect(planes[0]).toHaveLength(OPUS_RATE * 3);
  });

  it('starts the window at the right sample', () => {
    // A ramp, so the value at a position identifies it exactly.
    const buffer = fakeBuffer(OPUS_RATE, 4, 1, (index) => index / OPUS_RATE);
    const planes = resampleTo48k(buffer, 1, 2, 1);
    expect(planes[0][0]).toBeCloseTo(1, 4);
    expect(planes[0].at(-1)).toBeCloseTo(2, 3);
  });

  it('returns one plane per channel asked for', () => {
    expect(resampleTo48k(fakeBuffer(OPUS_RATE, 1, 2), 0, 1, 2)).toHaveLength(2);
  });

  it('duplicates a mono source when stereo is asked for', () => {
    const planes = resampleTo48k(fakeBuffer(OPUS_RATE, 1, 1), 0, 1, 2);
    expect(planes[1][50]).toBe(planes[0][50]);
  });

  it('returns empty planes for a window of no length', () => {
    expect(resampleTo48k(fakeBuffer(OPUS_RATE, 5), 3, 3, 1)[0]).toHaveLength(0);
  });

  it('does not run off the end when the window reaches it', () => {
    const planes = resampleTo48k(fakeBuffer(44100, 1), 0.9, 1, 1);
    expect(planes[0].every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('alignToZero', () => {
  const at = (timestamp: number): WebmSample =>
    ({ track: 2, timestamp, data: new Uint8Array(1), keyframe: true });

  it('shifts a track that starts late back to zero', () => {
    const shifted = alignToZero([at(2_000_000), at(2_020_000), at(2_040_000)]);
    expect(shifted.map((sample) => sample.timestamp)).toEqual([0, 20_000, 40_000]);
  });

  it('leaves a track that already starts at zero alone', () => {
    const samples = [at(0), at(20_000)];
    expect(alignToZero(samples)).toBe(samples);
  });

  it('keeps the spacing exactly, which is what stops drift', () => {
    const shifted = alignToZero([at(5_000_000), at(5_020_000)]);
    expect(shifted[1].timestamp - shifted[0].timestamp).toBe(20_000);
  });

  it('handles nothing at all', () => {
    expect(alignToZero([])).toEqual([]);
  });
});

describe('canEncodeAudio', () => {
  it('reports false where WebCodecs is absent, rather than throwing', () => {
    expect(typeof canEncodeAudio()).toBe('boolean');
  });
});

describe('joinAcross', () => {
  const ones = fakeBuffer(OPUS_RATE, 4, 1, () => 1);
  const halves = fakeBuffer(OPUS_RATE, 4, 1, () => 0.5);

  it('takes each piece from the recording it belongs to', () => {
    const planes = joinAcross(
      [{ start: 0, end: 1, source: 'a' }, { start: 0, end: 1, source: 'b' }],
      new Map([['a', ones], ['b', halves]]), null, 1,
    );
    expect(planes[0]).toHaveLength(OPUS_RATE * 2);
    expect(planes[0][10]).toBeCloseTo(1);
    expect(planes[0][OPUS_RATE + 10]).toBeCloseTo(0.5);
  });

  it('falls back to the first recording for a piece that names nothing', () => {
    const planes = joinAcross([{ start: 0, end: 1 }], new Map(), ones, 1);
    expect(planes[0][10]).toBeCloseTo(1);
  });

  it('fills silence for a clip whose recording has no sound', () => {
    // Dropping it instead would pull everything after it earlier, and the sound
    // would drift further from the picture at every join.
    const planes = joinAcross(
      [{ start: 0, end: 1, source: 'a' }, { start: 0, end: 2, source: 'silent' }, { start: 0, end: 1, source: 'a' }],
      new Map([['a', ones]]), null, 1,
    );
    expect(planes[0]).toHaveLength(OPUS_RATE * 4);
    expect(planes[0][OPUS_RATE + 10]).toBe(0);
    expect(planes[0][OPUS_RATE * 3 + 10]).toBeCloseTo(1);
  });

  it('makes the silence shorter when that clip runs fast', () => {
    const planes = joinAcross(
      [{ start: 0, end: 2, speed: 2, source: 'silent' }], new Map(), null, 1,
    );
    expect(planes[0]).toHaveLength(OPUS_RATE);
  });

  it('keeps both channels the same length', () => {
    const planes = joinAcross(
      [{ start: 0, end: 1, source: 'a' }, { start: 0, end: 1, source: 'gone' }],
      new Map([['a', fakeBuffer(OPUS_RATE, 4, 2)]]), null, 2,
    );
    expect(planes).toHaveLength(2);
    expect(planes[0].length).toBe(planes[1].length);
  });

  it('produces nothing at all when there are no pieces', () => {
    expect(joinAcross([], new Map(), ones, 1)[0]).toHaveLength(0);
  });

  it('applies clip volume and mute before joining', () => {
    const planes = joinAcross([
      { start: 0, end: 1, source: 'a', gain: 0.5 },
      { start: 0, end: 1, source: 'a', muted: true },
    ], new Map([['a', ones]]), null, 1);
    expect(planes[0][100]).toBeCloseTo(0.5);
    expect(planes[0][OPUS_RATE + 100]).toBe(0);
  });

  it('fades at the beginning and end of a clip', () => {
    const planes = joinAcross([{
      start: 0, end: 2, source: 'a', fadeIn: 1, fadeOut: 1, clipFrom: 0, clipLength: 2,
    }], new Map([['a', ones]]), null, 1);
    expect(planes[0][0]).toBe(0);
    expect(planes[0][OPUS_RATE]).toBeCloseTo(1, 3);
    expect(planes[0].at(-1)).toBeCloseTo(0, 3);
  });
});
