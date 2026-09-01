import { describe, expect, it } from 'vitest';
import { applyDrag, type Block } from './blockTrack';

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
