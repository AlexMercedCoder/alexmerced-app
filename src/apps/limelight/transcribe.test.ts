import { describe, expect, it } from 'vitest';
import { cuesFrom, forWhisper, overallRatio, WHISPER_MODELS, WHISPER_RATE } from './transcribe';

/**
 * A stand-in for AudioBuffer, which does not exist under the test runner.
 *
 * Only the four members the resampler touches, because the alternative is
 * pulling in a whole Web Audio implementation to test arithmetic.
 */
function buffer(channels: number[][], sampleRate: number): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (index: number) => Float32Array.from(channels[index]),
  } as unknown as AudioBuffer;
}

describe('forWhisper', () => {
  it('passes mono at the right rate straight through', () => {
    // Compared loosely because the data is Float32Array and the expectation
    // is written in doubles.
    const input = [0.1, 0.2, 0.3, 0.4];
    const out = forWhisper(buffer([input], WHISPER_RATE));
    expect(out).toHaveLength(4);
    for (const [index, value] of input.entries()) expect(out[index]).toBeCloseTo(value, 5);
  });

  it('mixes stereo down to mono', () => {
    const out = forWhisper(buffer([[1, 1], [0, 0]], WHISPER_RATE));
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.5);
  });

  it('resamples down to sixteen kilohertz', () => {
    // Half a second at 48k is 24000 samples, and 8000 at 16k.
    const input = new Array(24000).fill(0).map((_, index) => Math.sin(index / 50));
    const out = forWhisper(buffer([input], 48000));
    expect(out.length).toBe(8000);
  });

  it('keeps the shape of the signal through the resample', () => {
    // A slow ramp should still be a slow ramp, and still start and end near
    // where it did.
    const input = new Array(4800).fill(0).map((_, index) => index / 4800);
    const out = forWhisper(buffer([input], 48000));
    expect(out[0]).toBeCloseTo(0, 2);
    expect(out[out.length - 1]).toBeCloseTo(1, 1);
    for (let index = 1; index < out.length; index += 1) {
      expect(out[index]).toBeGreaterThanOrEqual(out[index - 1] - 1e-6);
    }
  });

  it('survives a single sample without reading past the end', () => {
    expect(() => forWhisper(buffer([[0.5]], 48000))).not.toThrow();
  });
});

describe('cuesFrom', () => {
  it('turns chunks into cues', () => {
    const out = cuesFrom([
      { text: ' Hello there', timestamp: [0, 1.5] },
      { text: ' second bit', timestamp: [1.5, 3] },
    ], 10);
    expect(out).toEqual([
      { start: 0, end: 1.5, text: 'Hello there' },
      { start: 1.5, end: 3, text: 'second bit' },
    ]);
  });

  it('closes a final chunk that has no end, which Whisper often leaves open', () => {
    const out = cuesFrom([{ text: 'Trailing', timestamp: [8, null] }], 12);
    expect(out[0]).toEqual({ start: 8, end: 12, text: 'Trailing' });
  });

  it('uses the next chunk to close one with no end in the middle', () => {
    const out = cuesFrom([
      { text: 'First', timestamp: [0, null] },
      { text: 'Second', timestamp: [4, 6] },
    ], 10);
    expect(out[0].end).toBe(4);
  });

  it('drops a chunk with no words', () => {
    expect(cuesFrom([{ text: '   ', timestamp: [0, 1] }], 5)).toEqual([]);
  });

  it('drops one with no start, since it cannot be placed', () => {
    expect(cuesFrom([{ text: 'Lost', timestamp: [null, 2] }], 5)).toEqual([]);
  });

  it('drops one that ends before it starts rather than showing forever', () => {
    expect(cuesFrom([{ text: 'Backwards', timestamp: [5, 2] }], 10)).toEqual([]);
  });

  it('holds a cue inside the recording', () => {
    expect(cuesFrom([{ text: 'Overrun', timestamp: [1, 99] }], 10)[0].end).toBe(10);
  });

  it('gives nothing back for nothing', () => {
    expect(cuesFrom(undefined, 10)).toEqual([]);
    expect(cuesFrom([], 10)).toEqual([]);
  });
});

describe('WHISPER_MODELS', () => {
  it('offers a size for each appetite, smallest first', () => {
    expect(WHISPER_MODELS.map((entry) => entry.id)).toEqual(['tiny', 'base', 'small']);
  });

  it('says how big each one is, since that is what a person is choosing', () => {
    for (const entry of WHISPER_MODELS) expect(entry.note).toMatch(/MB/);
  });

  it('names an English model for each, matching the pipeline task', () => {
    for (const entry of WHISPER_MODELS) expect(entry.model).toMatch(/whisper-.+\.en$/);
  });
});

describe('overallRatio', () => {
  const floor = 40_000_000;

  it('is the share of all bytes, not of one file', () => {
    const files = [{ loaded: 10_000_000, total: 20_000_000 }, { loaded: 10_000_000, total: 20_000_000 }];
    expect(overallRatio(files, floor)).toBeCloseTo(0.5, 3);
  });

  it('does not read as finished when only a small file is done', () => {
    // This was the bug: a completed tokenizer reported 100%, and the bar then
    // fell by ninety points when the encoder was announced.
    const files = [{ loaded: 500_000, total: 500_000 }];
    expect(overallRatio(files, floor)).toBeLessThan(0.05);
  });

  it('only ever climbs as the real files are discovered', () => {
    const seen: number[] = [];
    const files = [{ loaded: 500_000, total: 500_000 }];
    seen.push(overallRatio(files, floor)!);
    files.push({ loaded: 0, total: 39_500_000 });
    seen.push(overallRatio(files, floor)!);
    for (const at of [10_000_000, 20_000_000, 39_500_000]) {
      files[1].loaded = at;
      seen.push(overallRatio(files, floor)!);
    }
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]);
    }
    expect(seen[seen.length - 1]).toBeCloseTo(1, 2);
  });

  it('uses the real total once it exceeds the estimate', () => {
    const files = [{ loaded: 50_000_000, total: 100_000_000 }];
    expect(overallRatio(files, floor)).toBeCloseTo(0.5, 3);
  });

  it('never reports more than finished', () => {
    expect(overallRatio([{ loaded: 999, total: 1 }], 1)).toBe(1);
  });

  it('gives nothing back when there is nothing to measure', () => {
    expect(overallRatio([], 0)).toBeNull();
  });
});
