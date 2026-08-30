import { describe, expect, it } from 'vitest';
import {
  interestFromPointer, mergeInterest, motionCentre, motionGrid, motionSpread, sampleAt, smoothPath,
  type Interest, type PointerSample,
} from './attention';

/** A frame of one flat colour. */
function flat(width: number, height: number, value: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value; data[index + 1] = value; data[index + 2] = value; data[index + 3] = 255;
  }
  return data;
}

/** Paints a rectangle onto a copy of a frame. */
function paint(frame: Uint8ClampedArray, width: number, patch: Rect, value: number): Uint8ClampedArray {
  const data = frame.slice();
  for (let y = patch.y; y < patch.y + patch.height; y += 1) {
    for (let x = patch.x; x < patch.x + patch.width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = value; data[at + 1] = value; data[at + 2] = value;
    }
  }
  return data;
}

/** A flat frame with one rectangle painted a different shade. */
function withPatch(width: number, height: number, base: number, patch: Rect, value: number): Uint8ClampedArray {
  return paint(flat(width, height, base), width, patch, value);
}

type Rect = { x: number; y: number; width: number; height: number };

describe('motionGrid', () => {
  it('reports nothing when the frame did not change', () => {
    const frame = flat(64, 36, 120);
    const grid = motionGrid(frame, frame, 64, 36);
    expect(Math.max(...grid.cells)).toBe(0);
  });

  it('reports change only where it happened', () => {
    const before = flat(64, 36, 20);
    const after = withPatch(64, 36, 20, { x: 48, y: 4, width: 12, height: 8 }, 240);
    const grid = motionGrid(before, after, 64, 36, 8, 4);

    // The patch is in the top right, so that cell should be the loudest.
    const loudest = [...grid.cells].reduce((best, value, index) => (value > grid.cells[best] ? index : best), 0);
    const row = Math.floor(loudest / grid.columns);
    const column = loudest % grid.columns;
    expect(row).toBe(0);
    expect(column).toBeGreaterThanOrEqual(6);
  });

  it('scales with how much the brightness moved', () => {
    const before = flat(64, 36, 100);
    const small = motionGrid(before, flat(64, 36, 110), 64, 36);
    const large = motionGrid(before, flat(64, 36, 200), 64, 36);
    expect(Math.max(...large.cells)).toBeGreaterThan(Math.max(...small.cells) * 5);
  });

  it('returns the grid size it was asked for', () => {
    const frame = flat(64, 36, 0);
    const grid = motionGrid(frame, frame, 64, 36, 20, 12);
    expect(grid.columns).toBe(20);
    expect(grid.rows).toBe(12);
    expect(grid.cells).toHaveLength(240);
  });
});

describe('motionSpread', () => {
  it('is zero for a still frame and one for a full change', () => {
    const frame = flat(64, 36, 50);
    expect(motionSpread(motionGrid(frame, frame, 64, 36))).toBe(0);
    expect(motionSpread(motionGrid(frame, flat(64, 36, 200), 64, 36))).toBe(1);
  });
});

describe('motionCentre', () => {
  it('finds the middle of a small change', () => {
    const before = flat(128, 72, 20);
    // A patch in the lower left quarter.
    const after = withPatch(128, 72, 20, { x: 16, y: 48, width: 16, height: 12 }, 220);
    const centre = motionCentre(motionGrid(before, after, 128, 72))!;

    expect(centre).not.toBeNull();
    expect(centre.x).toBeGreaterThan(0.1);
    expect(centre.x).toBeLessThan(0.4);
    expect(centre.y).toBeGreaterThan(0.6);
    expect(centre.source).toBe('motion');
  });

  it('reports nothing when nothing moved', () => {
    const frame = flat(64, 36, 90);
    expect(motionCentre(motionGrid(frame, frame, 64, 36))).toBeNull();
  });

  it('reports nothing when everything moved, which is a scroll', () => {
    // There is no single place worth looking at, so no zoom is the right answer.
    const before = flat(128, 72, 40);
    const after = flat(128, 72, 200);
    expect(motionCentre(motionGrid(before, after, 128, 72))).toBeNull();
  });

  it('weights the centre towards the larger change when there are two', () => {
    const before = flat(128, 72, 20);
    // A small dim change on the left, a large bright one on the right.
    const twoPatches = paint(
      paint(before, 128, { x: 8, y: 32, width: 8, height: 8 }, 60),
      128, { x: 96, y: 32, width: 24, height: 16 }, 250,
    );
    const centre = motionCentre(motionGrid(before, twoPatches, 128, 72))!;
    expect(centre).not.toBeNull();
    expect(centre.x).toBeGreaterThan(0.6);
  });

  it('ignores a change too faint to be worth following', () => {
    const before = flat(128, 72, 100);
    const barely = paint(before, 128, { x: 60, y: 30, width: 8, height: 8 }, 101);
    expect(motionCentre(motionGrid(before, barely, 128, 72))).toBeNull();
  });
});

describe('smoothPath', () => {
  it('leaves a path of fewer than two points alone', () => {
    expect(smoothPath([])).toEqual([]);
    expect(smoothPath([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });

  it('returns as many points as it was given', () => {
    const points = Array.from({ length: 50 }, (_, index) => ({ x: index / 50, y: 0.5 }));
    expect(smoothPath(points)).toHaveLength(50);
  });

  it('takes the jitter out of a shaky line', () => {
    const jittery = Array.from({ length: 60 }, (_, index) => ({
      x: index / 60,
      y: 0.5 + (index % 2 === 0 ? 0.05 : -0.05),
    }));
    const smoothed = smoothPath(jittery);

    const wobble = (points: { y: number }[]) =>
      points.slice(1).reduce((sum, point, index) => sum + Math.abs(point.y - points[index].y), 0);

    expect(wobble(smoothed)).toBeLessThan(wobble(jittery) / 4);
  });

  it('stays on the path rather than trailing behind it', () => {
    // A steady diagonal. A one-pass filter would lag; two passes should not.
    const straight = Array.from({ length: 80 }, (_, index) => ({ x: index / 80, y: index / 80 }));
    const smoothed = smoothPath(straight);
    const middle = 40;
    expect(smoothed[middle].x).toBeCloseTo(straight[middle].x, 2);
    expect(smoothed[middle].y).toBeCloseTo(straight[middle].y, 2);
  });

  it('leaves a still path where it was', () => {
    const still = Array.from({ length: 30 }, () => ({ x: 0.3, y: 0.7 }));
    const smoothed = smoothPath(still);
    expect(smoothed[15].x).toBeCloseTo(0.3, 6);
    expect(smoothed[15].y).toBeCloseTo(0.7, 6);
  });
});

describe('sampleAt', () => {
  const samples: PointerSample[] = [
    { time: 0, x: 0, y: 0 },
    { time: 1, x: 1, y: 0.5 },
    { time: 3, x: 0, y: 1 },
  ];

  it('returns nothing for an empty track', () => {
    expect(sampleAt([], 1)).toBeNull();
  });

  it('clamps to the ends', () => {
    expect(sampleAt(samples, -5)).toEqual({ x: 0, y: 0 });
    expect(sampleAt(samples, 99)).toEqual({ x: 0, y: 1 });
  });

  it('lands exactly on a sample', () => {
    expect(sampleAt(samples, 1)).toEqual({ x: 1, y: 0.5 });
  });

  it('interpolates between two samples', () => {
    const middle = sampleAt(samples, 2)!;
    expect(middle.x).toBeCloseTo(0.5);
    expect(middle.y).toBeCloseTo(0.75);
  });

  it('finds the right pair in a long track', () => {
    const long: PointerSample[] = Array.from({ length: 1000 }, (_, index) => ({
      time: index / 100, x: index / 1000, y: 0,
    }));
    expect(sampleAt(long, 5)!.x).toBeCloseTo(0.5, 3);
  });
});

describe('interestFromPointer', () => {
  it('always includes every click', () => {
    const clicks = [{ time: 1, x: 0.2, y: 0.3 }, { time: 5, x: 0.8, y: 0.9 }];
    const found = interestFromPointer([], clicks);
    expect(found.filter((point) => point.source === 'click')).toHaveLength(2);
    expect(found.every((point) => point.weight === 1 || point.source !== 'click')).toBe(true);
  });

  it('notices where the pointer came to rest', () => {
    const pointer: PointerSample[] = [
      { time: 0, x: 0.1, y: 0.1 },
      // Sits still at the same place for a second.
      ...Array.from({ length: 20 }, (_, index) => ({ time: 0.05 * index, x: 0.5, y: 0.5 })),
      { time: 2, x: 0.9, y: 0.9 },
    ];
    const rests = interestFromPointer(pointer, []).filter((point) => point.source === 'pointer');
    expect(rests.length).toBeGreaterThan(0);
    expect(rests[0].x).toBeCloseTo(0.5, 1);
  });

  it('ignores a pointer that only passes through', () => {
    const sweeping: PointerSample[] = Array.from({ length: 40 }, (_, index) => ({
      time: index * 0.05, x: index / 40, y: 0.5,
    }));
    expect(interestFromPointer(sweeping, [])).toHaveLength(0);
  });

  it('returns moments in time order', () => {
    const found = interestFromPointer([], [
      { time: 5, x: 0.1, y: 0.1 },
      { time: 1, x: 0.2, y: 0.2 },
      { time: 3, x: 0.3, y: 0.3 },
    ]);
    expect(found.map((point) => point.time)).toEqual([1, 3, 5]);
  });
});

describe('mergeInterest', () => {
  const at = (time: number, x: number, y: number, source: Interest['source'] = 'motion', weight = 0.5): Interest =>
    ({ time, x, y, weight, source });

  it('joins moments close in time and place', () => {
    const merged = mergeInterest([at(1, 0.5, 0.5), at(1.2, 0.52, 0.51), at(1.4, 0.5, 0.5)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].time).toBe(1);
  });

  it('keeps moments far apart in time', () => {
    expect(mergeInterest([at(1, 0.5, 0.5), at(9, 0.5, 0.5)])).toHaveLength(2);
  });

  it('keeps moments far apart on screen', () => {
    expect(mergeInterest([at(1, 0.1, 0.1), at(1.2, 0.9, 0.9)])).toHaveLength(2);
  });

  it('keeps the earlier time, so the zoom arrives before the action', () => {
    expect(mergeInterest([at(2, 0.5, 0.5), at(2.3, 0.5, 0.5)])[0].time).toBe(2);
  });

  it('does not let motion demote a click', () => {
    const merged = mergeInterest([at(1, 0.5, 0.5, 'motion', 0.3), at(1.2, 0.5, 0.5, 'click', 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('click');
    expect(merged[0].weight).toBe(1);
  });

  it('pulls the position towards the stronger moment', () => {
    const merged = mergeInterest([at(1, 0.4, 0.5, 'motion', 0.2), at(1.2, 0.5, 0.5, 'click', 1)]);
    expect(merged[0].x).toBeGreaterThan(0.47);
  });

  it('handles an empty list', () => {
    expect(mergeInterest([])).toEqual([]);
  });
});
