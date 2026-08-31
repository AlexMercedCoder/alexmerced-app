import { describe, expect, it } from 'vitest';
import {
  addRedaction, MIN_REDACT, rectAt, redactionsAt, removePoint, removeRedaction, reviveRedactions,
  setPoint, sortRedactions, type RedactBlock,
} from './redact';

const block = (extra: Partial<RedactBlock> = {}): RedactBlock => ({
  id: 'r1', start: 1, end: 5, style: 'blur',
  points: [{ time: 1, x: 0.5, y: 0.5 }], width: 0.2, height: 0.1, ...extra,
});

describe('rectAt', () => {
  it('centres the box on its point', () => {
    expect(rectAt(block(), 2)).toEqual({ x: 0.4, y: 0.45, width: 0.2, height: 0.1 });
  });

  it('holds still with a single point', () => {
    const one = block();
    expect(rectAt(one, 1)).toEqual(rectAt(one, 5));
  });

  it('follows between two points', () => {
    const moving = block({ points: [{ time: 1, x: 0, y: 0 }, { time: 5, x: 1, y: 1 }] });
    // Halfway through in time is halfway across in space.
    const middle = rectAt(moving, 3);
    expect(middle.x + middle.width / 2).toBeCloseTo(0.5);
    expect(middle.y + middle.height / 2).toBeCloseTo(0.5);
  });

  it('holds at the first point before the first point', () => {
    const moving = block({ points: [{ time: 2, x: 0.2, y: 0.2 }, { time: 4, x: 0.8, y: 0.8 }] });
    const early = rectAt(moving, 0);
    expect(early.x + early.width / 2).toBeCloseTo(0.2);
  });

  it('holds at the last point after the last point', () => {
    const moving = block({ points: [{ time: 2, x: 0.2, y: 0.2 }, { time: 4, x: 0.8, y: 0.8 }] });
    const late = rectAt(moving, 99);
    expect(late.x + late.width / 2).toBeCloseTo(0.8);
  });

  it('walks three points in order', () => {
    const moving = block({
      end: 7,
      points: [{ time: 1, x: 0, y: 0.5 }, { time: 4, x: 1, y: 0.5 }, { time: 7, x: 0, y: 0.5 }],
    });
    expect(rectAt(moving, 2.5).x + 0.1).toBeCloseTo(0.5);
    expect(rectAt(moving, 5.5).x + 0.1).toBeCloseTo(0.5);
  });

  it('survives two points at the same moment rather than dividing by nothing', () => {
    const odd = block({ points: [{ time: 2, x: 0.1, y: 0.1 }, { time: 2, x: 0.9, y: 0.9 }] });
    const at = rectAt(odd, 2);
    expect(Number.isFinite(at.x)).toBe(true);
    expect(Number.isFinite(at.y)).toBe(true);
  });

  it('never reports a box of no size', () => {
    const tiny = rectAt(block({ width: 0, height: 0 }), 2);
    expect(tiny.width).toBeGreaterThan(0);
    expect(tiny.height).toBeGreaterThan(0);
  });

  it('falls back to the middle for a block with no points at all', () => {
    // Should be impossible after revival, but a box that covers nothing is the
    // one failure that matters here, so it is guarded anyway.
    const at = rectAt(block({ points: [] }), 2);
    expect(at.x + at.width / 2).toBeCloseTo(0.5);
  });
});

describe('redactionsAt', () => {
  it('finds one covering the moment', () => {
    expect(redactionsAt([block()], 3).map((b) => b.id)).toEqual(['r1']);
  });

  it('ignores one that has finished', () => {
    expect(redactionsAt([block()], 9)).toEqual([]);
  });

  it('allows two at once, because two things can need hiding', () => {
    const two = [block(), block({ id: 'r2', start: 2, end: 6 })];
    expect(redactionsAt(two, 3)).toHaveLength(2);
  });

  it('includes the exact boundaries, so a box is never off by a frame', () => {
    expect(redactionsAt([block()], 1)).toHaveLength(1);
    expect(redactionsAt([block()], 5)).toHaveLength(1);
  });
});

describe('addRedaction', () => {
  it('adds one at the moment given, aimed where asked', () => {
    const out = addRedaction([], 2, 10, 'new', { x: 0.7, y: 0.3 });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBeCloseTo(2);
    expect(out[0].points[0]).toMatchObject({ x: 0.7, y: 0.3 });
  });

  it('allows overlapping ones', () => {
    const first = addRedaction([], 2, 10, 'a');
    expect(addRedaction(first, 2.5, 10, 'b')).toHaveLength(2);
  });

  it('does not run past the end of the recording', () => {
    const out = addRedaction([], 9.9, 10, 'late');
    expect(out[0].end).toBeLessThanOrEqual(10);
    expect(out[0].end - out[0].start).toBeGreaterThanOrEqual(MIN_REDACT - 1e-9);
  });

  it('removes by id', () => {
    const two = addRedaction(addRedaction([], 1, 10, 'a'), 5, 10, 'b');
    expect(removeRedaction(two, 'a').map((b) => b.id)).toEqual(['b']);
  });
});

describe('setPoint and removePoint', () => {
  it('adds a following point', () => {
    const moved = setPoint(block(), 4, 0.9, 0.1);
    expect(moved.points).toHaveLength(2);
    expect(moved.points[1]).toMatchObject({ time: 4, x: 0.9, y: 0.1 });
  });

  it('replaces rather than stacks at the same moment', () => {
    const once = setPoint(block(), 3, 0.2, 0.2);
    const twice = setPoint(once, 3, 0.8, 0.8);
    expect(twice.points).toHaveLength(2);
    expect(twice.points.find((p) => Math.abs(p.time - 3) < 0.01)).toMatchObject({ x: 0.8 });
  });

  it('keeps the points in time order', () => {
    const out = setPoint(setPoint(block(), 4, 0.1, 0.1), 2, 0.9, 0.9);
    expect(out.points.map((p) => p.time)).toEqual([...out.points.map((p) => p.time)].sort((a, b) => a - b));
  });

  it('holds a point inside the block', () => {
    expect(setPoint(block(), 99, 0.5, 0.5).points.every((p) => p.time <= 5)).toBe(true);
  });

  it('clamps a point to the frame', () => {
    const out = setPoint(block(), 3, -1, 5);
    const added = out.points.find((p) => Math.abs(p.time - 3) < 0.01)!;
    expect(added.x).toBe(0);
    expect(added.y).toBe(1);
  });

  it('will not remove the last point, which would cover nothing', () => {
    expect(removePoint(block(), 1).points).toHaveLength(1);
  });

  it('removes the nearest point when there are several', () => {
    const two = setPoint(block(), 4, 0.9, 0.9);
    expect(removePoint(two, 4).points.map((p) => p.time)).toEqual([1]);
  });
});

describe('reviveRedactions', () => {
  const id = () => 'made-up';

  it('gives nothing back for nonsense', () => {
    expect(reviveRedactions(null, id)).toEqual([]);
    expect(reviveRedactions([{ start: 'x' }], id)).toEqual([]);
  });

  it('gives a stored block with no points one, rather than a box covering nothing', () => {
    const out = reviveRedactions([{ id: 'a', start: 1, end: 2, points: [] }], id);
    expect(out[0].points).toHaveLength(1);
  });

  it('repairs an unknown style', () => {
    expect(reviveRedactions([{ id: 'a', start: 1, end: 2, style: 'wat', points: [] }], id)[0].style).toBe('blur');
  });

  it('keeps a known style', () => {
    expect(reviveRedactions([{ id: 'a', start: 1, end: 2, style: 'solid', points: [] }], id)[0].style).toBe('solid');
  });

  it('repairs a size of zero', () => {
    const out = reviveRedactions([{ id: 'a', start: 1, end: 2, width: 0, height: 0, points: [] }], id);
    expect(out[0].width).toBeGreaterThan(0);
    expect(out[0].height).toBeGreaterThan(0);
  });
});

describe('sortRedactions', () => {
  it('drops an empty block and orders the rest', () => {
    const out = sortRedactions([block({ id: 'b', start: 5, end: 6 }), block({ id: 'z', start: 2, end: 2 }), block({ id: 'a', start: 1, end: 3 })]);
    expect(out.map((b) => b.id)).toEqual(['a', 'b']);
  });
});
