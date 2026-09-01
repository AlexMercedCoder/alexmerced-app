import { describe, expect, it } from 'vitest';
import {
  acrossClips, clipLength, isSingle, joins, layout, reelDuration, reviveClips,
  shiftAfter, singleClip, sourceOf, splice, splitAt, without, type Clip,
} from './reel';

let counter = 0;
const makeId = () => `made-${(counter += 1)}`;
const clip = (id: string, source: string, from: number, to: number): Clip =>
  ({ id, source, in: from, out: to });

const reel = (): Clip[] => [
  clip('a', 'take-1', 0, 10),
  clip('b', 'take-2', 2, 6),
];

describe('layout', () => {
  it('lays clips end to end with no gaps', () => {
    expect(layout(reel())).toEqual([
      { id: 'a', source: 'take-1', in: 0, out: 10, at: 0, length: 10 },
      { id: 'b', source: 'take-2', in: 2, out: 6, at: 10, length: 4 },
    ]);
  });

  it('measures a clip by its window, not by its recording', () => {
    // The second clip is four seconds of a recording that may be an hour long.
    expect(clipLength(clip('b', 'take-2', 2, 6))).toBe(4);
    expect(reelDuration(reel())).toBe(14);
  });

  it('drops a clip with nothing in it rather than laying an empty one', () => {
    const out = layout([clip('a', 's', 0, 5), clip('empty', 's', 3, 3), clip('c', 's', 0, 2)]);
    expect(out.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(out[1].at).toBe(5);
  });

  it('has nothing to lay out for an empty reel', () => {
    expect(layout([])).toEqual([]);
    expect(reelDuration([])).toBe(0);
  });
});

describe('sourceOf', () => {
  const placed = layout(reel());

  it('finds the recording and the moment inside it', () => {
    expect(sourceOf(placed, 3)).toEqual({ source: 'take-1', time: 3, clip: 'a' });
  });

  it('offsets into the second clip by its own window', () => {
    // Eleven seconds in is one second into a clip that starts two seconds into
    // its recording, so it is three seconds into that recording.
    expect(sourceOf(placed, 11)).toEqual({ source: 'take-2', time: 3, clip: 'b' });
  });

  it('puts a boundary moment on the clip that is starting', () => {
    expect(sourceOf(placed, 10)).toEqual({ source: 'take-2', time: 2, clip: 'b' });
  });

  it('clamps past the end rather than leaving a hole in the video', () => {
    // A rounding error on the last frame of an export must not return nothing.
    expect(sourceOf(placed, 99)).toEqual({ source: 'take-2', time: 6, clip: 'b' });
  });

  it('clamps a negative moment to the beginning', () => {
    expect(sourceOf(placed, -5)).toEqual({ source: 'take-1', time: 0, clip: 'a' });
  });

  it('has nothing to find on an empty reel', () => {
    expect(sourceOf([], 3)).toBeNull();
  });
});

describe('joins', () => {
  it('reports where one clip gives way to the next', () => {
    expect(joins(layout(reel()))).toEqual([10]);
  });

  it('reports nothing for one clip, since there is no join to draw', () => {
    expect(joins(layout([singleClip('take-1', 10)]))).toEqual([]);
  });
});

describe('splitAt', () => {
  it('turns one clip into two windows onto the same recording', () => {
    const out = splitAt([singleClip('take-1', 10)], 4, makeId);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: 'take-1', in: 0, out: 4 });
    expect(out[1]).toMatchObject({ source: 'take-1', in: 4, out: 10 });
  });

  it('leaves the total length alone', () => {
    expect(reelDuration(splitAt(reel(), 7, makeId))).toBe(reelDuration(reel()));
  });

  it('does not split on a boundary, which would add an empty clip', () => {
    expect(splitAt(reel(), 10, makeId)).toEqual(reel());
    expect(splitAt(reel(), 0, makeId)).toEqual(reel());
    expect(splitAt(reel(), 14, makeId)).toEqual(reel());
  });

  it('splits inside the second clip using its own window', () => {
    const out = splitAt(reel(), 12, makeId);
    expect(out[1]).toMatchObject({ source: 'take-2', in: 2, out: 4 });
    expect(out[2]).toMatchObject({ source: 'take-2', in: 4, out: 6 });
  });
});

describe('without', () => {
  it('takes a stretch out of the middle of one clip, keeping both ends', () => {
    const out = without([singleClip('take-1', 10)], { start: 4, end: 7 }, makeId);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ in: 0, out: 4 });
    expect(out[1]).toMatchObject({ in: 7, out: 10 });
    expect(reelDuration(out)).toBe(7);
  });

  it('drops a clip that sits wholly inside the stretch', () => {
    const out = without(reel(), { start: 0, end: 14 }, makeId);
    expect(out).toEqual([]);
  });

  it('trims a clip that overlaps one edge', () => {
    const out = without(reel(), { start: 8, end: 12 }, makeId);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'a', in: 0, out: 8 });
    expect(out[1]).toMatchObject({ source: 'take-2', in: 4, out: 6 });
  });

  it('leaves everything alone for a stretch of no length', () => {
    expect(without(reel(), { start: 5, end: 5 }, makeId)).toEqual(reel());
  });

  it('copes with the ends being given the wrong way round', () => {
    expect(reelDuration(without(reel(), { start: 12, end: 8 }, makeId))).toBe(10);
  });
});

describe('splice', () => {
  const fresh = clip('new', 'take-3', 0, 6);

  it('drops a recording in where the old one was', () => {
    const out = splice([singleClip('take-1', 10, 'a')], { start: 4, end: 7 }, fresh, makeId);
    expect(out.clips.map((entry) => entry.source)).toEqual(['take-1', 'take-3', 'take-1']);
    expect(out.at).toBe(4);
  });

  it('reports how much longer everything after it has become', () => {
    // Six seconds replacing three, so everything after moves three later.
    const out = splice([singleClip('take-1', 10)], { start: 4, end: 7 }, fresh, makeId);
    expect(out.shift).toBe(3);
    expect(reelDuration(out.clips)).toBe(13);
  });

  it('reports a negative shift when the retake is shorter', () => {
    const short = clip('new', 'take-3', 0, 1);
    const out = splice([singleClip('take-1', 10)], { start: 4, end: 7 }, short, makeId);
    expect(out.shift).toBe(-2);
    expect(reelDuration(out.clips)).toBe(8);
  });

  it('appends when the stretch is at the very end', () => {
    const out = splice([singleClip('take-1', 10)], { start: 10, end: 10 }, fresh, makeId);
    expect(out.clips.map((entry) => entry.source)).toEqual(['take-1', 'take-3']);
    expect(out.shift).toBe(6);
  });

  it('puts it in front when the stretch is at the very beginning', () => {
    const out = splice([singleClip('take-1', 10)], { start: 0, end: 0 }, fresh, makeId);
    expect(out.clips.map((entry) => entry.source)).toEqual(['take-3', 'take-1']);
  });

  it('replaces the whole reel when the stretch covers it', () => {
    const out = splice(reel(), { start: 0, end: 14 }, fresh, makeId);
    expect(out.clips).toEqual([fresh]);
    expect(out.shift).toBe(-8);
  });

  it('lines the new material up where the old material started', () => {
    const out = splice(reel(), { start: 3, end: 5 }, fresh, makeId);
    const placed = layout(out.clips);
    expect(placed.find((entry) => entry.source === 'take-3')?.at).toBe(3);
  });
});

describe('shiftAfter', () => {
  const blocks = [
    { id: 'before', start: 1, end: 2 },
    { id: 'straddling', start: 3, end: 8 },
    { id: 'after', start: 9, end: 11 },
  ];

  it('moves what sits after the splice', () => {
    const out = shiftAfter(blocks, 5, 3);
    expect(out[2]).toMatchObject({ start: 12, end: 14 });
  });

  it('leaves what sits before it alone', () => {
    expect(shiftAfter(blocks, 5, 3)[0]).toMatchObject({ start: 1, end: 2 });
  });

  it('leaves a block that straddles the splice where it started', () => {
    // Stretching it would be a guess about a passage that no longer exists.
    expect(shiftAfter(blocks, 5, 3)[1]).toMatchObject({ start: 3, end: 8 });
  });

  it('never moves a block back past zero', () => {
    expect(shiftAfter([{ start: 1, end: 2 }], 0, -10)[0]).toEqual({ start: 0, end: 0 });
  });

  it('does nothing at all for a shift of nothing', () => {
    expect(shiftAfter(blocks, 5, 0)).toBe(blocks);
  });
});

describe('the single recording case', () => {
  it('is what a project starts as', () => {
    expect(singleClip('take-1', 12.5)).toEqual({ id: 'clip-1', source: 'take-1', in: 0, out: 12.5 });
    expect(isSingle([singleClip('take-1', 12.5)])).toBe(true);
    expect(isSingle(reel())).toBe(false);
  });

  it('treats an empty reel as single, since there is nothing to join', () => {
    expect(isSingle([])).toBe(true);
  });

  it('never gives a recording a negative length', () => {
    expect(singleClip('take-1', -4).out).toBe(0);
  });
});

describe('reviveClips', () => {
  it('reads back what was stored', () => {
    expect(reviveClips([{ id: 'a', source: 's', in: 0, out: 4 }], makeId))
      .toEqual([{ id: 'a', source: 's', in: 0, out: 4 }]);
  });

  it('drops anything malformed rather than putting it on the reel', () => {
    expect(reviveClips([
      { id: 'a', source: 's', in: 0, out: 4 },
      { source: 's', in: 'x', out: 4 },
      { in: 0, out: 4 },
      null,
      'nonsense',
    ], makeId)).toHaveLength(1);
  });

  it('drops a clip with no length, which would be a join with nothing in it', () => {
    expect(reviveClips([{ id: 'a', source: 's', in: 4, out: 4 }], makeId)).toEqual([]);
  });

  it('gives an id to a clip that lost one', () => {
    expect(reviveClips([{ source: 's', in: 0, out: 4 }], makeId)[0].id).toMatch(/^made-/);
  });

  it('reads nothing from something that is not a list', () => {
    expect(reviveClips(null, makeId)).toEqual([]);
    expect(reviveClips({ clips: [] }, makeId)).toEqual([]);
  });
});

describe('inserting without replacing anything', () => {
  it('splits the clip at that moment rather than appending to the end', () => {
    // This is the bug the empty-span guard in `without` first hid: with nothing
    // removed there is no boundary to insert at, and the new material silently
    // went to the end of the reel instead of into the middle.
    const out = splice(
      [singleClip('take-1', 10, 'a')], { start: 4, end: 4 },
      clip('new', 'take-3', 0, 2), makeId,
    );
    expect(out.clips.map((entry) => entry.source)).toEqual(['take-1', 'take-3', 'take-1']);
    expect(out.at).toBe(4);
    expect(out.shift).toBe(2);
    expect(layout(out.clips).find((entry) => entry.source === 'take-3')?.at).toBe(4);
  });

  it('leaves the reel length as the sum of what is on it', () => {
    const out = splice(reel(), { start: 6, end: 6 }, clip('new', 'take-3', 0, 3), makeId);
    expect(reelDuration(out.clips)).toBe(17);
  });
});

describe('acrossClips', () => {
  const placed = layout(reel());

  it('rewrites a segment in the recording it sits in', () => {
    expect(acrossClips(placed, [{ start: 2, end: 5, speed: 1 }]))
      .toEqual([{ start: 2, end: 5, speed: 1, source: 'take-1' }]);
  });

  it('splits a segment that runs across a join', () => {
    // The sound has to come from two recordings for this one stretch, and each
    // in its own seconds.
    expect(acrossClips(placed, [{ start: 8, end: 12, speed: 1 }])).toEqual([
      { start: 8, end: 10, speed: 1, source: 'take-1' },
      { start: 2, end: 4, speed: 1, source: 'take-2' },
    ]);
  });

  it('carries the speed onto every piece it was split into', () => {
    const out = acrossClips(placed, [{ start: 8, end: 12, speed: 2 }]);
    expect(out.every((piece) => piece.speed === 2)).toBe(true);
  });

  it('keeps the pieces in the order they play', () => {
    const out = acrossClips(placed, [{ start: 11, end: 13, speed: 1 }, { start: 1, end: 2, speed: 1 }]);
    expect(out.map((piece) => piece.source)).toEqual(['take-2', 'take-1']);
  });

  it('drops a segment that lands on no clip at all', () => {
    expect(acrossClips(placed, [{ start: 20, end: 25, speed: 1 }])).toEqual([]);
  });

  it('keeps the total length the segments asked for', () => {
    const segments = [{ start: 0, end: 14, speed: 1 }];
    const total = acrossClips(placed, segments)
      .reduce((sum, piece) => sum + (piece.end - piece.start), 0);
    expect(total).toBe(14);
  });

  it('has nothing to rewrite without clips', () => {
    expect(acrossClips([], [{ start: 0, end: 5, speed: 1 }])).toEqual([]);
  });
});
