import { describe, expect, it } from 'vitest';
import { describeTidy, planTidy, tidyChangesAnything, type TidyInput } from './tidy';
import type { ZoomBlock } from './zooms';

const clock = (seconds: number) => `${seconds.toFixed(1)}s`;

const zoom = (id: string, start: number, end: number, pinned = false): ZoomBlock => ({
  id, start, end, scale: 1.8, x: 0.5, y: 0.5, pinned,
});

function input(over: Partial<TidyInput> = {}): TidyInput {
  return {
    silences: [],
    cuts: [],
    trim: { start: 0, end: 60 },
    zooms: [],
    suggested: [],
    ...over,
  };
}

describe('planTidy', () => {
  it('cuts the quiet stretches and says how much shorter it got', () => {
    const plan = planTidy(input({ silences: [{ start: 10, end: 13 }, { start: 20, end: 22 }] }));
    expect(plan.addedCuts).toBe(2);
    expect(plan.saved).toBeCloseTo(5);
  });

  it('ignores a silence outside the trim', () => {
    // Cutting from a stretch already being thrown away changes nothing, and
    // counting it would make the sentence afterwards a lie.
    const plan = planTidy(input({
      trim: { start: 10, end: 30 },
      silences: [{ start: 0, end: 5 }, { start: 40, end: 50 }],
    }));
    expect(plan.addedCuts).toBe(0);
    expect(plan.saved).toBe(0);
  });

  it('clips a silence that straddles the trim edge', () => {
    const plan = planTidy(input({
      trim: { start: 10, end: 30 },
      silences: [{ start: 8, end: 14 }],
    }));
    expect(plan.saved).toBeCloseTo(4);
  });

  it('ignores a gap too short to be worth a join', () => {
    expect(planTidy(input({ silences: [{ start: 5, end: 5.02 }] })).addedCuts).toBe(0);
  });

  it('counts what changed, not what was proposed', () => {
    // Two overlapping silences merge into one cut. Reporting two would be
    // counting the input.
    const plan = planTidy(input({ silences: [{ start: 10, end: 14 }, { start: 12, end: 16 }] }));
    expect(plan.addedCuts).toBe(1);
    expect(plan.saved).toBeCloseTo(6);
  });

  it('does not double count a silence that is already cut', () => {
    const plan = planTidy(input({
      cuts: [{ start: 10, end: 13 }],
      silences: [{ start: 10, end: 13 }],
    }));
    expect(plan.addedCuts).toBe(0);
    expect(plan.saved).toBe(0);
  });

  it('adds the suggested zooms', () => {
    const plan = planTidy(input({ suggested: [zoom('a', 2, 5), zoom('b', 20, 24)] }));
    expect(plan.addedZooms).toBe(2);
  });

  it('never moves a zoom somebody placed themselves', () => {
    // This is the rule that makes the button safe to press at any point, not
    // just on a recording nobody has touched.
    const held = zoom('mine', 2, 6, true);
    const plan = planTidy(input({ zooms: [held], suggested: [zoom('auto', 3, 7)] }));
    expect(plan.zooms).toEqual([held]);
    expect(plan.addedZooms).toBe(0);
  });

  it('keeps a suggestion that does not clash with a pinned one', () => {
    const held = zoom('mine', 2, 6, true);
    const plan = planTidy(input({ zooms: [held], suggested: [zoom('auto', 30, 34)] }));
    expect(plan.zooms.map((block) => block.id).sort()).toEqual(['auto', 'mine']);
    expect(plan.addedZooms).toBe(1);
  });

  it('does both halves in one plan, which is what makes it one undo', () => {
    const plan = planTidy(input({
      silences: [{ start: 10, end: 13 }],
      suggested: [zoom('auto', 2, 5)],
    }));
    expect(plan.addedCuts).toBe(1);
    expect(plan.addedZooms).toBe(1);
  });

  it('proposes nothing for a recording with nothing to find', () => {
    expect(tidyChangesAnything(planTidy(input()))).toBe(false);
  });
});

describe('describeTidy', () => {
  it('says both halves when it did both', () => {
    const plan = planTidy(input({
      silences: [{ start: 10, end: 13 }],
      suggested: [zoom('auto', 2, 5)],
    }));
    expect(describeTidy(plan, clock)).toBe('Cut 1 quiet gap, 3.0s shorter and added 1 zoom.');
  });

  it('says only the half it did', () => {
    const cutsOnly = planTidy(input({ silences: [{ start: 10, end: 14 }, { start: 20, end: 22 }] }));
    expect(describeTidy(cutsOnly, clock)).toBe('Cut 2 quiet gaps, 6.0s shorter.');
    const zoomsOnly = planTidy(input({ suggested: [zoom('a', 1, 3), zoom('b', 5, 7)] }));
    expect(describeTidy(zoomsOnly, clock)).toBe('Added 2 zooms.');
  });

  it('says plainly when there was nothing to do', () => {
    // Silence after a press reads as a broken button.
    expect(describeTidy(planTidy(input()), clock)).toMatch(/Nothing to tidy/);
  });
});
