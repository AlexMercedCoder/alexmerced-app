import { describe, expect, it } from 'vitest';
import {
  addSpeed, clampSpeed, editedAt, editedDuration, MAX_SPEED, MIN_SPEED, removeSpeed, reviveSpeeds,
  segmentsOf, sortSpeeds, sourceAt, speedAt, type SpeedRegion,
} from './timeline';

const whole = { start: 0, end: 10 };
const region = (id: string, start: number, end: number, speed: number): SpeedRegion =>
  ({ id, start, end, speed });

describe('clampSpeed', () => {
  it('keeps a sensible speed', () => {
    expect(clampSpeed(2)).toBe(2);
  });

  it('refuses zero, negative and nonsense, which would divide by nothing', () => {
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(-2)).toBe(1);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('holds to the range', () => {
    expect(clampSpeed(100)).toBe(MAX_SPEED);
    expect(clampSpeed(0.01)).toBe(MIN_SPEED);
  });
});

describe('sortSpeeds', () => {
  it('puts them in order', () => {
    const out = sortSpeeds([region('b', 5, 7, 2), region('a', 1, 3, 2)]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('trims an overlap back rather than refusing it', () => {
    const out = sortSpeeds([region('a', 1, 5, 2), region('b', 3, 8, 3)]);
    expect(out[0]).toMatchObject({ start: 1, end: 5 });
    expect(out[1]).toMatchObject({ start: 5, end: 8 });
  });

  it('drops one that an overlap leaves too short to grab', () => {
    const out = sortSpeeds([region('a', 1, 5, 2), region('b', 4.9, 5.1, 3)]);
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  it('drops an empty region', () => {
    expect(sortSpeeds([region('a', 3, 3, 2)])).toEqual([]);
  });
});

describe('segmentsOf', () => {
  it('is one whole piece when nothing is edited', () => {
    expect(segmentsOf(whole, [], [])).toEqual([{ start: 0, end: 10, speed: 1 }]);
  });

  it('splits around a speed region', () => {
    expect(segmentsOf(whole, [], [region('a', 4, 6, 2)])).toEqual([
      { start: 0, end: 4, speed: 1 },
      { start: 4, end: 6, speed: 2 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it('splits around a cut', () => {
    expect(segmentsOf(whole, [{ start: 3, end: 5 }], [])).toEqual([
      { start: 0, end: 3, speed: 1 },
      { start: 5, end: 10, speed: 1 },
    ]);
  });

  it('lets a cut win over a speed region on the same stretch', () => {
    // Those seconds are not in the finished video, so there is nothing to hurry.
    const out = segmentsOf(whole, [{ start: 4, end: 6 }], [region('a', 4, 6, 4)]);
    expect(out).toEqual([
      { start: 0, end: 4, speed: 1 },
      { start: 6, end: 10, speed: 1 },
    ]);
  });

  it('keeps the part of a speed region a cut did not take', () => {
    const out = segmentsOf(whole, [{ start: 5, end: 6 }], [region('a', 4, 8, 2)]);
    expect(out).toEqual([
      { start: 0, end: 4, speed: 1 },
      { start: 4, end: 5, speed: 2 },
      { start: 6, end: 8, speed: 2 },
      { start: 8, end: 10, speed: 1 },
    ]);
  });

  it('respects the trim', () => {
    expect(segmentsOf({ start: 2, end: 8 }, [], [])).toEqual([{ start: 2, end: 8, speed: 1 }]);
  });

  it('handles several speed regions at once', () => {
    const out = segmentsOf(whole, [], [region('a', 1, 2, 2), region('b', 5, 7, 4)]);
    expect(out.map((s) => [s.start, s.end, s.speed])).toEqual([
      [0, 1, 1], [1, 2, 2], [2, 5, 1], [5, 7, 4], [7, 10, 1],
    ]);
  });
});

describe('editedDuration', () => {
  it('is the plain length when nothing is edited', () => {
    expect(editedDuration(segmentsOf(whole, [], []))).toBeCloseTo(10);
  });

  it('shortens by what was cut', () => {
    expect(editedDuration(segmentsOf(whole, [{ start: 3, end: 5 }], []))).toBeCloseTo(8);
  });

  it('shortens by the speed', () => {
    // Four seconds at double speed is two seconds of finished video.
    expect(editedDuration(segmentsOf(whole, [], [region('a', 2, 6, 2)]))).toBeCloseTo(8);
  });

  it('lengthens for slow motion', () => {
    expect(editedDuration(segmentsOf(whole, [], [region('a', 2, 4, 0.5)]))).toBeCloseTo(12);
  });

  it('counts cuts and speeds together', () => {
    const segments = segmentsOf(whole, [{ start: 0, end: 2 }], [region('a', 4, 8, 4)]);
    // 2 to 4 plain, 4 to 8 at 4x, 8 to 10 plain: 2 + 1 + 2.
    expect(editedDuration(segments)).toBeCloseTo(5);
  });
});

describe('sourceAt', () => {
  it('is the identity with no edits', () => {
    const segments = segmentsOf(whole, [], []);
    expect(sourceAt(segments, 3)).toBeCloseTo(3);
  });

  it('runs through a fast region at its speed', () => {
    const segments = segmentsOf(whole, [], [region('a', 2, 6, 2)]);
    expect(sourceAt(segments, 2)).toBeCloseTo(2);
    // One second into a double speed region is two seconds of recording.
    expect(sourceAt(segments, 3)).toBeCloseTo(4);
    expect(sourceAt(segments, 4)).toBeCloseTo(6);
  });

  it('skips a cut', () => {
    const segments = segmentsOf(whole, [{ start: 3, end: 5 }], []);
    expect(sourceAt(segments, 3)).toBeCloseTo(5);
  });

  it('clamps past the end', () => {
    expect(sourceAt(segmentsOf(whole, [], []), 999)).toBeCloseTo(10);
  });

  it('gives back nothing sensible for an empty timeline rather than throwing', () => {
    expect(sourceAt([], 5)).toBe(0);
  });

  it('never lands inside a cut, walking the whole edited length', () => {
    const cuts = [{ start: 1, end: 2 }, { start: 4, end: 6 }];
    const segments = segmentsOf(whole, cuts, [region('a', 7, 9, 3)]);
    const total = editedDuration(segments);
    for (let edited = 0; edited < total; edited += 0.05) {
      const source = sourceAt(segments, edited);
      const inside = cuts.some((cut) => source > cut.start + 1e-9 && source < cut.end - 1e-9);
      expect(inside).toBe(false);
    }
  });

  it('round trips against editedAt', () => {
    const segments = segmentsOf(whole, [{ start: 2, end: 3 }], [region('a', 5, 8, 2)]);
    const total = editedDuration(segments);
    for (let edited = 0; edited <= total - 0.01; edited += 0.1) {
      expect(editedAt(segments, sourceAt(segments, edited))).toBeCloseTo(edited, 5);
    }
  });
});

describe('editedAt', () => {
  it('maps a moment before any edit straight through', () => {
    expect(editedAt(segmentsOf(whole, [], []), 4)).toBeCloseTo(4);
  });

  it('reports where playback resumes for a moment inside a cut', () => {
    const segments = segmentsOf(whole, [{ start: 3, end: 5 }], []);
    expect(editedAt(segments, 4)).toBeCloseTo(3);
  });

  it('accounts for a fast region before it', () => {
    const segments = segmentsOf(whole, [], [region('a', 0, 4, 4)]);
    expect(editedAt(segments, 4)).toBeCloseTo(1);
    expect(editedAt(segments, 6)).toBeCloseTo(3);
  });
});

describe('speedAt', () => {
  it('is one outside any region', () => {
    expect(speedAt(segmentsOf(whole, [], [region('a', 2, 4, 3)]), 5)).toBe(1);
  });

  it('is the region speed inside it', () => {
    expect(speedAt(segmentsOf(whole, [], [region('a', 2, 4, 3)]), 3)).toBe(3);
  });
});

describe('addSpeed and removeSpeed', () => {
  it('adds one at a moment', () => {
    const out = addSpeed([], 3, 10, 2, 'a');
    expect(out).toHaveLength(1);
    expect(out[0].start).toBeCloseTo(3);
    expect(out[0].speed).toBe(2);
  });

  it('refuses to add inside an existing region', () => {
    expect(addSpeed([region('a', 2, 6, 2)], 4, 10, 3, 'b')).toHaveLength(1);
  });

  it('fits into the gap available', () => {
    const out = addSpeed([region('a', 0, 4, 2), region('b', 5, 10, 2)], 4.1, 10, 3, 'c', 5);
    const added = out.find((r) => r.id === 'c')!;
    expect(added.end).toBeLessThanOrEqual(5);
  });

  it('gives up when the gap is too small', () => {
    expect(addSpeed([region('a', 0, 4, 2), region('b', 4.1, 10, 2)], 4.05, 10, 3, 'c')).toHaveLength(2);
  });

  it('removes by id', () => {
    expect(removeSpeed([region('a', 1, 2, 2), region('b', 3, 4, 2)], 'a').map((r) => r.id)).toEqual(['b']);
  });
});

describe('reviveSpeeds', () => {
  const id = () => 'made-up';

  it('gives nothing back for nonsense', () => {
    expect(reviveSpeeds(null, id)).toEqual([]);
    expect(reviveSpeeds('speeds', id)).toEqual([]);
  });

  it('drops entries without real times', () => {
    expect(reviveSpeeds([{ start: 'x', end: 2, speed: 2 }], id)).toEqual([]);
  });

  it('repairs a stored speed that is out of range', () => {
    expect(reviveSpeeds([{ id: 'a', start: 1, end: 2, speed: 999 }], id)[0].speed).toBe(MAX_SPEED);
  });

  it('gives an entry with no id a new one', () => {
    expect(reviveSpeeds([{ start: 1, end: 2, speed: 2 }], id)[0].id).toBe('made-up');
  });
});
