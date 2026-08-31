import { describe, expect, it } from 'vitest';
import {
  findSilences, keptDuration, keptSpans, loudnessFrom, mergeSpans, peaksFrom, sourceTimeAt,
  type Span,
} from './waveform';

/** A run of samples at a fixed amplitude, for building predictable signals. */
function tone(amplitude: number, length: number): number[] {
  return Array.from({ length }, (_, index) => (index % 2 === 0 ? amplitude : -amplitude));
}

describe('peaksFrom', () => {
  it('reduces to the number of columns asked for', () => {
    expect(peaksFrom(new Float32Array(1000), 50)).toHaveLength(50);
  });

  it('keeps the extremes of each column', () => {
    const samples = new Float32Array([1, -1, 0.5, -0.5]);
    const peaks = peaksFrom(samples, 2);
    expect(peaks[0]).toEqual({ min: -1, max: 1 });
    expect(peaks[1]).toEqual({ min: -0.5, max: 0.5 });
  });

  it('gives every column a sample even when there are fewer samples than columns', () => {
    // Otherwise a short recording draws gaps in the middle of its own waveform.
    const peaks = peaksFrom(new Float32Array([1, -1]), 8);
    expect(peaks).toHaveLength(8);
    expect(peaks.every((peak) => peak.max >= peak.min)).toBe(true);
  });

  it('survives having no samples at all', () => {
    expect(peaksFrom(new Float32Array(), 4)).toEqual([
      { min: 0, max: 0 }, { min: 0, max: 0 }, { min: 0, max: 0 }, { min: 0, max: 0 },
    ]);
  });
});

describe('loudnessFrom', () => {
  it('reads quiet as quiet and loud as loud', () => {
    const samples = new Float32Array([...tone(0.01, 100), ...tone(0.9, 100)]);
    const loudness = loudnessFrom(samples, 2);
    expect(loudness[0]).toBeLessThan(0.05);
    expect(loudness[1]).toBeGreaterThan(0.8);
  });

  it('does not let one click make a quiet stretch look loud', () => {
    // Root mean square rather than peak, which is the whole reason for it.
    const quiet = tone(0.005, 999);
    const withClick = new Float32Array([...quiet, 1]);
    expect(loudnessFrom(withClick, 1)[0]).toBeLessThan(0.1);
  });
});

describe('findSilences', () => {
  const loud = 1;
  const quiet = 0.001;

  it('finds a quiet stretch between two loud ones', () => {
    // 10 seconds over 10 columns: loud, quiet for 4, loud.
    const loudness = new Float32Array([loud, loud, quiet, quiet, quiet, quiet, loud, loud, loud, loud]);
    const spans = findSilences(loudness, 10, { threshold: 0.06, minSeconds: 0.5, padSeconds: 0 });
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBeCloseTo(2);
    expect(spans[0].end).toBeCloseTo(6);
  });

  it('ignores a gap too short to be worth cutting', () => {
    const loudness = new Float32Array([loud, quiet, loud, loud, loud, loud, loud, loud, loud, loud]);
    expect(findSilences(loudness, 10, { threshold: 0.06, minSeconds: 2, padSeconds: 0 })).toEqual([]);
  });

  it('leaves padding at each end so speech is not clipped', () => {
    const loudness = new Float32Array([loud, loud, quiet, quiet, quiet, quiet, loud, loud, loud, loud]);
    const spans = findSilences(loudness, 10, { threshold: 0.06, minSeconds: 0.5, padSeconds: 0.25 });
    expect(spans[0].start).toBeCloseTo(2.25);
    expect(spans[0].end).toBeCloseTo(5.75);
  });

  it('drops a span that padding shrinks below the minimum', () => {
    const loudness = new Float32Array([loud, quiet, quiet, loud, loud, loud, loud, loud, loud, loud]);
    // Two columns is 2 seconds; 0.9 of padding at each end leaves 0.2.
    expect(findSilences(loudness, 10, { threshold: 0.06, minSeconds: 0.5, padSeconds: 0.9 })).toEqual([]);
  });

  it('treats a recording with no sound as nothing to cut, not as one long cut', () => {
    // Cutting all of it would leave an empty video, which is never the intent.
    expect(findSilences(new Float32Array(50), 10)).toEqual([]);
  });

  it('closes a silence that runs to the very end', () => {
    const loudness = new Float32Array([loud, loud, quiet, quiet, quiet, quiet, quiet, quiet, quiet, quiet]);
    const spans = findSilences(loudness, 10, { threshold: 0.06, minSeconds: 0.5, padSeconds: 0 });
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBeCloseTo(10);
  });

  it('scales the threshold to the recording rather than an absolute level', () => {
    // The same shape recorded quietly should find the same silence.
    const shape = [1, 1, 0.001, 0.001, 0.001, 0.001, 1, 1, 1, 1];
    const loudRec = findSilences(new Float32Array(shape), 10, { threshold: 0.06, minSeconds: 0.5, padSeconds: 0 });
    const quietRec = findSilences(new Float32Array(shape.map((v) => v * 0.02)), 10, { threshold: 0.06, minSeconds: 0.5, padSeconds: 0 });
    expect(quietRec).toEqual(loudRec);
  });
});

describe('mergeSpans', () => {
  it('joins overlapping cuts into one', () => {
    expect(mergeSpans([{ start: 1, end: 4 }, { start: 3, end: 6 }])).toEqual([{ start: 1, end: 6 }]);
  });

  it('joins cuts that merely touch', () => {
    expect(mergeSpans([{ start: 1, end: 3 }, { start: 3, end: 5 }])).toEqual([{ start: 1, end: 5 }]);
  });

  it('leaves separate cuts alone and sorts them', () => {
    expect(mergeSpans([{ start: 6, end: 8 }, { start: 1, end: 2 }])).toEqual([
      { start: 1, end: 2 }, { start: 6, end: 8 },
    ]);
  });

  it('drops an empty span', () => {
    expect(mergeSpans([{ start: 2, end: 2 }])).toEqual([]);
  });
});

describe('keptSpans and keptDuration', () => {
  it('returns the whole range when nothing is cut', () => {
    expect(keptSpans([], 0, 10)).toEqual([{ start: 0, end: 10 }]);
    expect(keptDuration([], 0, 10)).toBeCloseTo(10);
  });

  it('leaves the pieces either side of a cut', () => {
    expect(keptSpans([{ start: 3, end: 5 }], 0, 10)).toEqual([
      { start: 0, end: 3 }, { start: 5, end: 10 },
    ]);
    expect(keptDuration([{ start: 3, end: 5 }], 0, 10)).toBeCloseTo(8);
  });

  it('ignores cuts outside the trimmed range', () => {
    expect(keptSpans([{ start: 20, end: 25 }], 0, 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it('clips a cut that hangs over the edge of the range', () => {
    expect(keptSpans([{ start: -5, end: 3 }], 0, 10)).toEqual([{ start: 3, end: 10 }]);
  });

  it('counts overlapping cuts once', () => {
    expect(keptDuration([{ start: 2, end: 6 }, { start: 4, end: 8 }], 0, 10)).toBeCloseTo(4);
  });

  it('can cut everything', () => {
    expect(keptSpans([{ start: 0, end: 10 }], 0, 10)).toEqual([]);
    expect(keptDuration([{ start: 0, end: 10 }], 0, 10)).toBe(0);
  });
});

describe('sourceTimeAt', () => {
  const cuts: Span[] = [{ start: 3, end: 5 }];

  it('is the identity before any cut', () => {
    expect(sourceTimeAt(cuts, 0, 10, 1)).toBeCloseTo(1);
  });

  it('skips over the cut', () => {
    // Edited second 3 is source second 5, the moment the cut ends.
    expect(sourceTimeAt(cuts, 0, 10, 3)).toBeCloseTo(5);
    expect(sourceTimeAt(cuts, 0, 10, 4)).toBeCloseTo(6);
  });

  it('clamps past the end rather than running off', () => {
    // A rounding error on the final frame must not ask for a time that is not
    // in the recording.
    expect(sourceTimeAt(cuts, 0, 10, 999)).toBeCloseTo(10);
  });

  it('accounts for the trim start', () => {
    expect(sourceTimeAt([], 2, 10, 0)).toBeCloseTo(2);
    expect(sourceTimeAt([], 2, 10, 3)).toBeCloseTo(5);
  });

  it('gives back the start when everything has been cut', () => {
    expect(sourceTimeAt([{ start: 0, end: 10 }], 0, 10, 1)).toBeCloseTo(0);
  });

  it('walks the whole edited length without leaving the kept pieces', () => {
    const many: Span[] = [{ start: 1, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 8.5 }];
    const total = keptDuration(many, 0, 10);
    for (let edited = 0; edited < total; edited += 0.1) {
      const source = sourceTimeAt(many, 0, 10, edited);
      const inACut = many.some((cut) => source > cut.start + 1e-9 && source < cut.end - 1e-9);
      expect(inACut).toBe(false);
    }
  });
});
