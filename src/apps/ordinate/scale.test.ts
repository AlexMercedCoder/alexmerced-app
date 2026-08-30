import { describe, expect, it } from 'vitest';
import {
  extent, formatTick, includeZero, labelStride, linearScale, niceStep, niceTicks,
  pieSlices, smoothPath, straightPath,
} from './scale';

describe('linearScale', () => {
  it('maps the domain ends onto the range ends', () => {
    const scale = linearScale([0, 100], [0, 400]);
    expect(scale(0)).toBe(0);
    expect(scale(50)).toBe(200);
    expect(scale(100)).toBe(400);
  });

  it('works with an inverted range, which is how y axes are drawn', () => {
    const scale = linearScale([0, 10], [300, 0]);
    expect(scale(0)).toBe(300);
    expect(scale(10)).toBe(0);
  });

  it('parks a zero-width domain in the middle rather than dividing by zero', () => {
    const scale = linearScale([5, 5], [0, 200]);
    expect(scale(5)).toBe(100);
    expect(Number.isNaN(scale(5))).toBe(false);
  });
});

describe('niceStep', () => {
  it('snaps to one, two, five, or ten times a power of ten', () => {
    expect(niceStep(0.9)).toBe(1);
    expect(niceStep(1.7)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(23)).toBe(50);
    expect(niceStep(0.03)).toBeCloseTo(0.05);
  });

  it('refuses to return zero or a negative step', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-4)).toBe(1);
    expect(niceStep(NaN)).toBe(1);
  });
});

describe('niceTicks', () => {
  it('widens the domain out to round numbers', () => {
    const ticks = niceTicks(3, 97, 5);
    expect(ticks.domain).toEqual([0, 100]);
    expect(ticks.values).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('handles a domain that does not start at zero', () => {
    const ticks = niceTicks(1200, 1800, 4);
    expect(ticks.domain[0]).toBeLessThanOrEqual(1200);
    expect(ticks.domain[1]).toBeGreaterThanOrEqual(1800);
    expect(ticks.values[0]).toBe(ticks.domain[0]);
    expect(ticks.values.at(-1)).toBe(ticks.domain[1]);
  });

  it('gives a flat series room on both sides', () => {
    const ticks = niceTicks(42, 42);
    expect(ticks.domain[0]).toBeLessThan(42);
    expect(ticks.domain[1]).toBeGreaterThan(42);
  });

  it('gives a flat series at zero a usable domain', () => {
    const ticks = niceTicks(0, 0);
    expect(ticks.domain[1]).toBeGreaterThan(ticks.domain[0]);
  });

  it('avoids floating point fuzz in fractional ticks', () => {
    const ticks = niceTicks(0, 1, 10);
    expect(ticks.values).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('handles negative ranges', () => {
    const ticks = niceTicks(-45, -5, 4);
    expect(ticks.domain[0]).toBeLessThanOrEqual(-45);
    expect(ticks.domain[1]).toBeGreaterThanOrEqual(-5);
    expect(ticks.values).toContain(-40);
  });

  it('spans zero when the data does', () => {
    const ticks = niceTicks(-20, 30, 5);
    expect(ticks.values).toContain(0);
  });

  it('falls back rather than producing NaN ticks', () => {
    expect(niceTicks(NaN, 5).values).toEqual([0, 1]);
  });
});

describe('extent and includeZero', () => {
  it('finds the range, skipping values that are not finite', () => {
    expect(extent([3, NaN, 9, Infinity, 1])).toEqual([1, 9]);
  });

  it('returns a usable pair when there is nothing finite at all', () => {
    expect(extent([NaN, Infinity])).toEqual([0, 1]);
  });

  it('pulls a bar chart baseline down to zero', () => {
    expect(includeZero(20, 80)).toEqual([0, 80]);
    expect(includeZero(-30, -5)).toEqual([-30, 0]);
    expect(includeZero(-10, 10)).toEqual([-10, 10]);
  });
});

describe('formatTick', () => {
  it('abbreviates large numbers', () => {
    expect(formatTick(1200, 200)).toBe('1.2k');
    expect(formatTick(3_400_000, 1_000_000)).toBe('3.4M');
    expect(formatTick(2_000_000_000, 1e9)).toBe('2B');
  });

  it('keeps small numbers exact', () => {
    expect(formatTick(0, 1)).toBe('0');
    expect(formatTick(0.25, 0.05)).toBe('0.25');
    expect(formatTick(-40, 20)).toBe('-40');
  });

  it('does not abbreviate when the step is finer than the unit', () => {
    expect(formatTick(1001, 1)).toBe('1001');
  });
});

describe('labelStride', () => {
  it('keeps every label when they all fit', () => {
    expect(labelStride(5, 600, 4)).toBe(1);
  });

  it('thins labels out when there is no room', () => {
    expect(labelStride(200, 600, 8)).toBeGreaterThan(1);
  });

  it('never returns a stride of zero', () => {
    expect(labelStride(50, 1, 40)).toBeGreaterThanOrEqual(1);
    expect(labelStride(0, 100, 4)).toBe(1);
  });
});

describe('paths', () => {
  it('draws a straight path through every point', () => {
    expect(straightPath([[0, 0], [10, 20]])).toBe('M0 0 L10 20');
  });

  it('returns nothing for no points', () => {
    expect(smoothPath([])).toBe('');
    expect(straightPath([])).toBe('');
  });

  it('falls back to straight segments below three points', () => {
    expect(smoothPath([[0, 0], [10, 10]])).toBe('M0 0 L10 10');
  });

  it('emits one cubic segment per gap once smoothing applies', () => {
    const path = smoothPath([[0, 0], [10, 10], [20, 0], [30, 10]]);
    expect(path.match(/C/g)).toHaveLength(3);
    expect(path.startsWith('M0 0')).toBe(true);
    expect(path.endsWith('30 10')).toBe(true);
  });
});

describe('pieSlices', () => {
  it('returns one slice per value', () => {
    expect(pieSlices([1, 2, 3], 100)).toHaveLength(3);
  });

  it('reports the fraction each slice takes', () => {
    const slices = pieSlices([25, 75], 100);
    expect(slices[0].fraction).toBeCloseTo(0.25);
    expect(slices[1].fraction).toBeCloseTo(0.75);
  });

  it('starts at twelve o\'clock', () => {
    const slices = pieSlices([1, 1, 1, 1], 100);
    // The first quarter is centred at 45 degrees past the top.
    expect(slices[0].midAngle).toBeCloseTo(-Math.PI / 4);
  });

  it('sets the large-arc flag once a slice passes a half turn', () => {
    const slices = pieSlices([70, 30], 100);
    expect(slices[0].path).toContain(' 1 1 ');
    expect(slices[1].path).not.toContain(' 1 1 ');
  });

  it('draws a full circle rather than nothing when one value is everything', () => {
    const slices = pieSlices([5], 100);
    expect(slices[0].path).toContain('A');
    expect(slices[0].path.split('A').length).toBeGreaterThan(2);
  });

  it('cuts a hole for a doughnut', () => {
    const [slice] = pieSlices([1, 1], 100, 60);
    expect(slice.path).toContain('60');
    expect(slice.path).not.toContain('M0 0');
  });

  it('ignores negative values instead of drawing them backwards', () => {
    const slices = pieSlices([10, -5, 10], 100);
    expect(slices[1].fraction).toBe(0);
    expect(slices[0].fraction).toBeCloseTo(0.5);
  });

  it('returns nothing when there is nothing to show', () => {
    expect(pieSlices([0, 0], 100)).toEqual([]);
    expect(pieSlices([], 100)).toEqual([]);
  });
});
