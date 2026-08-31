import { describe, expect, it } from 'vitest';
import {
  addShape, boundsOf, MIN_SHAPE, removeShape, reviveShapes, shapesAt, SHAPE_COLOURS, sortShapes,
  updateShape, type Shape,
} from './shapes';

const shape = (extra: Partial<Shape> = {}): Shape => ({
  id: 's1', start: 1, end: 5, kind: 'box',
  x: 0.2, y: 0.3, width: 0.4, height: 0.2,
  colour: '#e0a458', thickness: 0.006, fade: 0, ...extra,
});

describe('boundsOf', () => {
  it('is the rectangle as drawn', () => {
    expect(boundsOf(shape())).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.2 });
  });

  it('normalises one dragged right to left', () => {
    // Negative offsets are how people actually drag, so they mean something.
    const out = boundsOf(shape({ x: 0.6, y: 0.5, width: -0.4, height: -0.2 }));
    expect(out.x).toBeCloseTo(0.2);
    expect(out.y).toBeCloseTo(0.3);
    expect(out.width).toBeCloseTo(0.4);
    expect(out.height).toBeCloseTo(0.2);
  });
});

describe('shapesAt', () => {
  it('finds one covering the moment', () => {
    expect(shapesAt([shape()], 3).map((entry) => entry.shape.id)).toEqual(['s1']);
  });

  it('finds nothing outside it', () => {
    expect(shapesAt([shape()], 9)).toEqual([]);
  });

  it('is fully opaque with no fade', () => {
    expect(shapesAt([shape()], 3)[0].opacity).toBe(1);
  });

  it('fades in and out', () => {
    const fading = shape({ fade: 1 });
    expect(shapesAt([fading], 1.5)[0].opacity).toBeCloseTo(0.5);
    expect(shapesAt([fading], 3)[0].opacity).toBe(1);
    expect(shapesAt([fading], 4.5)[0].opacity).toBeCloseTo(0.5);
  });

  it('shares the fade on a shape too short for two of them', () => {
    // Otherwise the two ends fight and it never reaches full strength.
    const brief = shape({ start: 1, end: 1.4, fade: 2 });
    const middle = shapesAt([brief], 1.2)[0].opacity;
    expect(middle).toBeCloseTo(1);
  });

  it('never reports a negative opacity', () => {
    expect(shapesAt([shape({ fade: 1 })], 1)[0].opacity).toBeGreaterThanOrEqual(0);
  });

  it('returns several at once, since shapes may overlap', () => {
    expect(shapesAt([shape(), shape({ id: 's2', start: 2, end: 6 })], 3)).toHaveLength(2);
  });
});

describe('addShape', () => {
  it('adds one of the kind asked for', () => {
    const out = addShape([], 2, 10, 'arrow', 'new');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('arrow');
  });

  it('does not run past the end of the recording', () => {
    const out = addShape([], 9.9, 10, 'box', 'late');
    expect(out[0].end).toBeLessThanOrEqual(10);
    expect(out[0].end - out[0].start).toBeGreaterThanOrEqual(MIN_SHAPE - 1e-9);
  });

  it('allows overlapping shapes', () => {
    expect(addShape(addShape([], 2, 10, 'box', 'a'), 2.5, 10, 'arrow', 'b')).toHaveLength(2);
  });

  it('gives it a colour from the palette', () => {
    expect(SHAPE_COLOURS).toContain(addShape([], 1, 10, 'box', 'a')[0].colour);
  });
});

describe('updateShape and removeShape', () => {
  it('changes only the one named', () => {
    const two = [shape(), shape({ id: 's2' })];
    const out = updateShape(two, 's2', { colour: '#7fb0dd' });
    expect(out.find((entry) => entry.id === 's1')!.colour).toBe('#e0a458');
    expect(out.find((entry) => entry.id === 's2')!.colour).toBe('#7fb0dd');
  });

  it('removes by id', () => {
    expect(removeShape([shape(), shape({ id: 's2' })], 's1').map((s) => s.id)).toEqual(['s2']);
  });
});

describe('sortShapes', () => {
  it('drops an empty shape and orders the rest', () => {
    const out = sortShapes([shape({ id: 'b', start: 5, end: 6 }), shape({ id: 'z', start: 2, end: 2 }), shape({ id: 'a', start: 1, end: 3 })]);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('reviveShapes', () => {
  const id = () => 'made-up';

  it('gives nothing back for nonsense', () => {
    expect(reviveShapes(null, id)).toEqual([]);
    expect(reviveShapes([{ start: 'x', end: 2 }], id)).toEqual([]);
  });

  it('repairs an unknown kind', () => {
    expect(reviveShapes([{ id: 'a', start: 1, end: 2, kind: 'wat' }], id)[0].kind).toBe('box');
  });

  it('rejects a colour that is not a hex value', () => {
    // Anything else would go straight into a canvas fillStyle.
    expect(reviveShapes([{ id: 'a', start: 1, end: 2, colour: 'red; drop table' }], id)[0].colour)
      .toBe(SHAPE_COLOURS[0]);
  });

  it('keeps a real hex colour', () => {
    expect(reviveShapes([{ id: 'a', start: 1, end: 2, colour: '#7FB0DD' }], id)[0].colour).toBe('#7FB0DD');
  });

  it('holds thickness to something drawable', () => {
    expect(reviveShapes([{ id: 'a', start: 1, end: 2, thickness: 99 }], id)[0].thickness).toBeLessThanOrEqual(0.05);
  });

  it('gives one with no id a new one', () => {
    expect(reviveShapes([{ start: 1, end: 2 }], id)[0].id).toBe('made-up');
  });
});
