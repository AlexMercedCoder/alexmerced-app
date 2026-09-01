import { describe, expect, it } from 'vitest';
import { applyDrag, type Block, keyEdit } from './blockTrack';

const blocks = (): Block[] => [
  { id: 'a', start: 1, end: 3 },
  { id: 'b', start: 5, end: 8 },
];

describe('applyDrag', () => {
  it('moves a block, keeping its length', () => {
    const out = applyDrag(blocks(), 'a', 'move', 2, { start: 1, end: 3 });
    expect(out[0]).toEqual({ id: 'a', start: 3, end: 5 });
  });

  it('moves it backwards too', () => {
    const out = applyDrag(blocks(), 'b', 'move', -2, { start: 5, end: 8 });
    expect(out[1]).toEqual({ id: 'b', start: 3, end: 6 });
  });

  it('drags the start without touching the end', () => {
    const out = applyDrag(blocks(), 'a', 'start', 0.5, { start: 1, end: 3 });
    expect(out[0]).toEqual({ id: 'a', start: 1.5, end: 3 });
  });

  it('drags the end without touching the start', () => {
    const out = applyDrag(blocks(), 'a', 'end', 1, { start: 1, end: 3 });
    expect(out[0]).toEqual({ id: 'a', start: 1, end: 4 });
  });

  it('leaves every other block alone', () => {
    const out = applyDrag(blocks(), 'a', 'move', 10, { start: 1, end: 3 });
    expect(out[1]).toEqual({ id: 'b', start: 5, end: 8 });
  });

  it('measures from where the drag began, not from where the block is now', () => {
    // This is what makes a drag track the pointer instead of accelerating: the
    // shift is always applied to the original position.
    const first = applyDrag(blocks(), 'a', 'move', 1, { start: 1, end: 3 });
    const second = applyDrag(first, 'a', 'move', 2, { start: 1, end: 3 });
    expect(second[0]).toEqual({ id: 'a', start: 3, end: 5 });
  });

  it('keeps any extra the block carries', () => {
    const rich = [{ id: 'a', start: 1, end: 3, scale: 2.4, pinned: true }];
    const out = applyDrag(rich, 'a', 'move', 1, { start: 1, end: 3 });
    expect(out[0]).toMatchObject({ scale: 2.4, pinned: true, start: 2, end: 4 });
  });

  it('does nothing for an id it does not have', () => {
    expect(applyDrag(blocks(), 'ghost', 'move', 5, { start: 0, end: 1 })).toEqual(blocks());
  });

  it('allows a zero shift without disturbing anything', () => {
    expect(applyDrag(blocks(), 'a', 'move', 0, { start: 1, end: 3 })[0])
      .toEqual({ id: 'a', start: 1, end: 3 });
  });
});

describe('keyEdit', () => {
  const step = { small: 0.1, large: 1 };
  const none = {};

  it('moves the whole block with left and right', () => {
    expect(keyEdit('ArrowRight', none, step)).toEqual({ edge: 'move', shift: 0.1 });
    expect(keyEdit('ArrowLeft', none, step)).toEqual({ edge: 'move', shift: -0.1 });
  });

  it('changes how long it is with up and down', () => {
    expect(keyEdit('ArrowUp', none, step)).toEqual({ edge: 'end', shift: 0.1 });
    expect(keyEdit('ArrowDown', none, step)).toEqual({ edge: 'end', shift: -0.1 });
  });

  it('moves the start edge instead when Alt is held', () => {
    expect(keyEdit('ArrowRight', { alt: true }, step)).toEqual({ edge: 'start', shift: 0.1 });
    expect(keyEdit('ArrowLeft', { alt: true }, step)).toEqual({ edge: 'start', shift: -0.1 });
  });

  it('leaves up and down on the end even with Alt, since a block has two ends', () => {
    // Alt already means the start. Applying it to up and down as well would
    // give two ways to say the same thing and no way to say the other.
    expect(keyEdit('ArrowUp', { alt: true }, step)).toEqual({ edge: 'end', shift: 0.1 });
  });

  it('takes the larger step with Shift', () => {
    expect(keyEdit('ArrowRight', { shift: true }, step)).toEqual({ edge: 'move', shift: 1 });
    expect(keyEdit('ArrowDown', { shift: true }, step)).toEqual({ edge: 'end', shift: -1 });
    expect(keyEdit('ArrowLeft', { shift: true, alt: true }, step)).toEqual({ edge: 'start', shift: -1 });
  });

  it('means nothing for any other key', () => {
    for (const key of ['Delete', 'Enter', ' ', 'a', 'Home', 'Tab']) {
      expect(keyEdit(key, none, step)).toBeNull();
    }
  });

  it('composes with applyDrag into the move a person expects', () => {
    const start = [{ id: 'a', start: 2, end: 4 }];
    const edit = keyEdit('ArrowRight', { shift: true }, step)!;
    const out = applyDrag(start, 'a', edit.edge, edit.shift, { start: 2, end: 4 });
    expect(out[0]).toEqual({ id: 'a', start: 3, end: 5 });
  });

  it('lengthens without moving the start', () => {
    const edit = keyEdit('ArrowUp', none, step)!;
    const out = applyDrag([{ id: 'a', start: 2, end: 4 }], 'a', edit.edge, edit.shift, { start: 2, end: 4 });
    expect(out[0].start).toBe(2);
    expect(out[0].end).toBeCloseTo(4.1);
  });
});
