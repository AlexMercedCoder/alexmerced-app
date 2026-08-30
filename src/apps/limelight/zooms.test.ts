import { describe, expect, it } from 'vitest';
import type { Interest } from './attention';
import { defaultZoom, zoomAt, type ZoomSettings } from './zoom';
import {
  addBlock, blocksFromInterest, constrain, duplicateBlock, mergeBlocks, MIN_BLOCK, overlaps,
  removeBlock, reviveBlocks, sortBlocks, splitBlock, trackFromBlocks, type ZoomBlock,
} from './zooms';

const settings = (overrides: Partial<ZoomSettings> = {}): ZoomSettings => ({ ...defaultZoom, ...overrides });
const at = (time: number, x = 0.5, y = 0.5): Interest => ({ time, x, y, weight: 1, source: 'click' });

function block(start: number, end: number, overrides: Partial<ZoomBlock> = {}): ZoomBlock {
  return { id: `b${start}`, start, end, scale: 1.8, x: 0.5, y: 0.5, pinned: false, ...overrides };
}

describe('blocksFromInterest', () => {
  it('makes one block per moment', () => {
    const blocks = blocksFromInterest([at(2), at(8)], 20, settings({ holdSeconds: 1.5, leadSeconds: 0 }));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].start).toBeCloseTo(2);
    expect(blocks[0].end).toBeCloseTo(3.5);
  });

  it('arrives before the moment by the lead time', () => {
    const [first] = blocksFromInterest([at(5)], 20, settings({ leadSeconds: 0.4 }));
    expect(first.start).toBeCloseTo(4.6);
  });

  it('extends a block rather than stacking a second on top of it', () => {
    // Two moments half a second apart, with a hold of two seconds.
    const blocks = blocksFromInterest([at(3), at(3.5)], 20, settings({ holdSeconds: 2, leadSeconds: 0 }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].end).toBeCloseTo(5.5);
  });

  it('produces nothing when zooming is off', () => {
    expect(blocksFromInterest([at(2)], 20, settings({ enabled: false }))).toEqual([]);
  });

  it('never runs past the end of the recording', () => {
    const [first] = blocksFromInterest([at(9.8)], 10, settings({ holdSeconds: 3, leadSeconds: 0 }));
    expect(first.end).toBeLessThanOrEqual(10);
  });

  it('pulls a block near the end backwards rather than dropping it', () => {
    // A click on the last thing that happens still deserves a zoom.
    const [first] = blocksFromInterest([at(9.9)], 10, settings({ holdSeconds: 3, leadSeconds: 0 }));
    expect(first).toBeDefined();
    expect(first.end - first.start).toBeGreaterThanOrEqual(MIN_BLOCK - 1e-9);
    expect(first.end).toBeLessThanOrEqual(10);
  });

  it('drops a moment with genuinely nowhere to go', () => {
    // The block before it runs to the very end, leaving no room at all.
    const blocks = blocksFromInterest([at(0), at(9.99)], 10, settings({ holdSeconds: 10, leadSeconds: 0 }));
    expect(blocks).toHaveLength(1);
  });

  it('marks nothing as pinned, since a person has not touched it', () => {
    expect(blocksFromInterest([at(2)], 20, settings()).every((entry) => !entry.pinned)).toBe(true);
  });
});

describe('mergeBlocks', () => {
  it('keeps a pinned block through a fresh analysis', () => {
    const kept = block(2, 4, { id: 'mine', pinned: true, scale: 3 });
    const merged = mergeBlocks([kept], [block(10, 12)]);
    expect(merged.find((entry) => entry.id === 'mine')).toEqual(kept);
    expect(merged).toHaveLength(2);
  });

  it('drops a new block that would land on a pinned one', () => {
    const merged = mergeBlocks([block(2, 6, { id: 'mine', pinned: true })], [block(3, 5, { id: 'fresh' })]);
    expect(merged.map((entry) => entry.id)).toEqual(['mine']);
  });

  it('throws away unpinned blocks, which is what re-analysing means', () => {
    const merged = mergeBlocks([block(1, 2, { id: 'old' })], [block(5, 6, { id: 'new' })]);
    expect(merged.map((entry) => entry.id)).toEqual(['new']);
  });

  it('returns them in time order', () => {
    const merged = mergeBlocks([block(8, 9, { id: 'late', pinned: true })], [block(1, 2, { id: 'early' })]);
    expect(merged.map((entry) => entry.id)).toEqual(['early', 'late']);
  });
});

describe('overlaps', () => {
  it('is true when they share any time at all', () => {
    expect(overlaps({ start: 1, end: 3 }, { start: 2, end: 4 })).toBe(true);
  });

  it('is false when they merely touch', () => {
    expect(overlaps({ start: 1, end: 3 }, { start: 3, end: 5 })).toBe(false);
  });
});

describe('constrain', () => {
  it('keeps a block inside the recording', () => {
    const blocks = constrain([block(-2, 25, { id: 'x' })], 'x', 20);
    expect(blocks[0].start).toBe(0);
    expect(blocks[0].end).toBe(20);
  });

  it('stops a block running into the one before it', () => {
    const blocks = constrain([block(1, 5, { id: 'a' }), block(3, 8, { id: 'b' })], 'b', 20);
    expect(blocks.find((entry) => entry.id === 'b')!.start).toBeGreaterThanOrEqual(5);
  });

  it('stops a block running into the one after it', () => {
    const blocks = constrain([block(1, 9, { id: 'a' }), block(6, 10, { id: 'b' })], 'a', 20);
    expect(blocks.find((entry) => entry.id === 'a')!.end).toBeLessThanOrEqual(6);
  });

  it('gives a squeezed block the minimum length where there is room', () => {
    const blocks = constrain([block(1, 2, { id: 'a' }), block(1.9, 1.95, { id: 'b' })], 'b', 20);
    const b = blocks.find((entry) => entry.id === 'b')!;
    expect(b.end - b.start).toBeCloseTo(MIN_BLOCK, 5);
  });

  it('drops a block with nowhere left to go', () => {
    const blocks = constrain(
      [block(1, 2, { id: 'a' }), block(2, 2.1, { id: 'b' }), block(2.1, 3, { id: 'c' })],
      'b', 20,
    );
    expect(blocks.map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  it('clamps the scale and the position', () => {
    const blocks = constrain([block(1, 3, { id: 'x', scale: 99, x: -1, y: 5 })], 'x', 20);
    expect(blocks[0].scale).toBe(4);
    expect(blocks[0].x).toBe(0);
    expect(blocks[0].y).toBe(1);
  });

  it('never lets the scale drop below the whole frame', () => {
    expect(constrain([block(1, 3, { id: 'x', scale: 0.2 })], 'x', 20)[0].scale).toBe(1);
  });
});

describe('addBlock', () => {
  it('adds one in an empty stretch', () => {
    const blocks = addBlock([], 5, 20, settings({ holdSeconds: 2 }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBeCloseTo(5);
    expect(blocks[0].end).toBeCloseTo(7);
  });

  it('marks it pinned, because a person put it there', () => {
    expect(addBlock([], 5, 20, settings())[0].pinned).toBe(true);
  });

  it('refuses to add one inside an existing block', () => {
    const existing = [block(4, 8)];
    expect(addBlock(existing, 6, 20, settings())).toHaveLength(1);
  });

  it('fits it into the gap available', () => {
    const blocks = addBlock([block(0, 5), block(6, 10)], 5.2, 20, settings({ holdSeconds: 4 }));
    const added = blocks.find((entry) => entry.pinned)!;
    expect(added.start).toBeGreaterThanOrEqual(5);
    expect(added.end).toBeLessThanOrEqual(6);
  });

  it('refuses when the gap is too small to hold one', () => {
    expect(addBlock([block(0, 5), block(5.1, 10)], 5.05, 20, settings())).toHaveLength(2);
  });

  it('does not run past the end of the recording', () => {
    const blocks = addBlock([], 9.5, 10, settings({ holdSeconds: 5 }));
    expect(blocks[0].end).toBeLessThanOrEqual(10);
  });
});

describe('removeBlock', () => {
  it('removes only the one named', () => {
    expect(removeBlock([block(1, 2, { id: 'a' }), block(3, 4, { id: 'b' })], 'a').map((e) => e.id)).toEqual(['b']);
  });
});

describe('trackFromBlocks', () => {
  it('stays wide when there are no blocks', () => {
    expect(trackFromBlocks([], 10, settings())).toEqual([{ time: 0, scale: 1, x: 0.5, y: 0.5 }]);
  });

  it('pulls in for a block and back out after it', () => {
    const track = trackFromBlocks([block(4, 6, { scale: 2, x: 0.8, y: 0.2 })], 12, settings({ moveSeconds: 0.5 }));
    expect(zoomAt(track, 1).scale).toBe(1);
    expect(zoomAt(track, 5).scale).toBeCloseTo(2, 5);
    expect(zoomAt(track, 5).x).toBeCloseTo(0.8, 5);
    expect(zoomAt(track, 11).scale).toBe(1);
  });

  it('holds the whole way through a block', () => {
    const track = trackFromBlocks([block(3, 8, { scale: 2 })], 12, settings());
    for (const time of [3.1, 5, 7.9]) expect(zoomAt(track, time).scale, String(time)).toBeCloseTo(2, 3);
  });

  it('never runs backwards in time', () => {
    const track = trackFromBlocks(
      [block(1, 2), block(2.05, 3), block(3.02, 4.5)], 10, settings({ moveSeconds: 0.6 }),
    );
    for (let index = 1; index < track.length; index += 1) {
      expect(track[index].time).toBeGreaterThanOrEqual(track[index - 1].time);
    }
  });

  it('slides straight across when two blocks nearly touch', () => {
    const track = trackFromBlocks(
      [block(2, 4, { scale: 2, x: 0.2 }), block(4.1, 6, { scale: 2, x: 0.8 })],
      12, settings({ moveSeconds: 0.6 }),
    );
    // It should not return to the whole frame in the gap between them.
    expect(zoomAt(track, 4.05).scale).toBeGreaterThan(1.5);
  });

  it('does go wide when there is room between blocks', () => {
    const track = trackFromBlocks([block(1, 2), block(8, 9)], 12, settings({ moveSeconds: 0.4 }));
    expect(zoomAt(track, 5).scale).toBe(1);
  });

  it('moves smoothly, with no jumps between samples', () => {
    const track = trackFromBlocks(
      [block(2, 4, { scale: 2.5, x: 0.9, y: 0.1 }), block(7, 9, { scale: 2, x: 0.1, y: 0.9 })],
      12, settings({ moveSeconds: 0.5 }),
    );
    let previous = zoomAt(track, 0);
    for (let time = 0.05; time <= 12; time += 0.05) {
      const current = zoomAt(track, time);
      expect(Math.abs(current.scale - previous.scale)).toBeLessThan(0.3);
      expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThan(0.15);
      previous = current;
    }
  });

  it('ignores a block of no length', () => {
    expect(trackFromBlocks([block(3, 3)], 10, settings())).toHaveLength(1);
  });
});

describe('reviveBlocks', () => {
  it('rejects anything that is not a list', () => {
    expect(reviveBlocks(null)).toEqual([]);
    expect(reviveBlocks('nope')).toEqual([]);
  });

  it('drops entries with no times or a backwards range', () => {
    expect(reviveBlocks([{ start: 1 }, { start: 3, end: 2 }, null, 'x'])).toEqual([]);
  });

  it('clamps what it keeps', () => {
    const [revived] = reviveBlocks([{ start: -1, end: 5, scale: 99, x: 2, y: -3 }]);
    expect(revived.start).toBe(0);
    expect(revived.scale).toBe(4);
    expect(revived.x).toBe(1);
    expect(revived.y).toBe(0);
  });

  it('round trips a real block', () => {
    const original = block(2, 5, { id: 'keep', scale: 2.2, x: 0.3, y: 0.7, pinned: true });
    expect(reviveBlocks(JSON.parse(JSON.stringify([original])))).toEqual([original]);
  });
});

describe('sortBlocks', () => {
  it('orders by start, then by end', () => {
    const sorted = sortBlocks([block(5, 6), block(1, 9), block(1, 3)]);
    expect(sorted.map((entry) => [entry.start, entry.end])).toEqual([[1, 3], [1, 9], [5, 6]]);
  });
});

describe('splitBlock', () => {
  const one = (): ZoomBlock[] => [
    { id: 'a', start: 1, end: 5, scale: 2, x: 0.5, y: 0.5, pinned: false },
  ];

  it('makes two out of one', () => {
    const after = splitBlock(one(), 'a', 3);
    expect(after).toHaveLength(2);
    expect(after[0].end).toBe(3);
    expect(after[1].start).toBe(3);
  });

  it('leaves no gap and no overlap at the cut', () => {
    const after = splitBlock(one(), 'a', 2.5);
    expect(after[0].end).toBe(after[1].start);
  });

  it('carries the settings into both halves', () => {
    const after = splitBlock(one(), 'a', 3);
    for (const half of after) {
      expect(half.scale).toBe(2);
      expect(half.pinned).toBe(true);
    }
  });

  it('gives the new half its own identity', () => {
    const after = splitBlock(one(), 'a', 3);
    expect(after[0].id).not.toBe(after[1].id);
  });

  it('refuses a cut that would leave a sliver', () => {
    expect(splitBlock(one(), 'a', 1.1)).toHaveLength(1);
    expect(splitBlock(one(), 'a', 4.95)).toHaveLength(1);
  });

  it('refuses a cut outside the block', () => {
    expect(splitBlock(one(), 'a', 9)).toHaveLength(1);
  });

  it('does nothing for a block that is not there', () => {
    expect(splitBlock(one(), 'missing', 3)).toEqual(one());
  });
});

describe('duplicateBlock', () => {
  it('puts the copy in the space after the original', () => {
    const blocks: ZoomBlock[] = [{ id: 'a', start: 1, end: 2, scale: 2, x: 0.5, y: 0.5, pinned: true }];
    const after = duplicateBlock(blocks, 'a', 10);
    expect(after).toHaveLength(2);
    const copy = after.find((entry) => entry.id !== 'a')!;
    expect(copy.start).toBe(2);
    expect(copy.end - copy.start).toBe(1);
  });

  it('never overlaps what is already there', () => {
    const blocks: ZoomBlock[] = [
      { id: 'a', start: 0, end: 2, scale: 2, x: 0.5, y: 0.5, pinned: true },
      { id: 'b', start: 2, end: 4, scale: 2, x: 0.5, y: 0.5, pinned: true },
    ];
    const after = duplicateBlock(blocks, 'a', 10);
    const copy = after.find((entry) => entry.id !== 'a' && entry.id !== 'b')!;
    expect(copy.start).toBeGreaterThanOrEqual(4);
  });

  it('looks backwards when there is no room ahead', () => {
    const blocks: ZoomBlock[] = [
      { id: 'a', start: 4, end: 6, scale: 2, x: 0.5, y: 0.5, pinned: true },
    ];
    // Room from 0 to 4, and only one second left at the end.
    const after = duplicateBlock(blocks, 'a', 7);
    const copy = after.find((entry) => entry.id !== 'a')!;
    expect(copy.start).toBe(0);
    expect(copy.end).toBe(2);
  });

  it('gives up when there is nowhere at all', () => {
    const blocks: ZoomBlock[] = [{ id: 'a', start: 0, end: 5, scale: 2, x: 0.5, y: 0.5, pinned: true }];
    expect(duplicateBlock(blocks, 'a', 5)).toHaveLength(1);
  });

  it('copies the settings, not the identity', () => {
    const blocks: ZoomBlock[] = [{ id: 'a', start: 0, end: 1, scale: 2.7, x: 0.2, y: 0.3, pinned: true }];
    const copy = duplicateBlock(blocks, 'a', 10).find((entry) => entry.id !== 'a')!;
    expect(copy.scale).toBe(2.7);
    expect(copy.x).toBe(0.2);
    expect(copy.id).not.toBe('a');
  });

  it('does nothing for a block that is not there', () => {
    expect(duplicateBlock([], 'missing', 10)).toEqual([]);
  });
});
