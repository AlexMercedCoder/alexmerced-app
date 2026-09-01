import { describe, expect, it } from 'vitest';
import { planStrip } from './filmstrip';

describe('planStrip', () => {
  it('fills the width with thumbnails of the recording shape', () => {
    const plan = planStrip(1600, 100, 60, 16 / 9);
    // 100 tall at 16:9 is 178 wide, so nine of them cover 1600.
    expect(plan.slot).toBe(178);
    expect(plan.times.length).toBe(9);
    expect(plan.height).toBe(100);
  });

  it('runs past the right edge rather than stopping short of it', () => {
    // Stopping short leaves a grey gap exactly where the end of the recording
    // is, which is the part being trimmed.
    const plan = planStrip(1000, 100, 60, 1);
    expect(plan.times.length * plan.slot).toBeGreaterThanOrEqual(1000);
  });

  it('shows the middle of each slice, not its start', () => {
    // The first frame of a screen recording is a desktop before anything has
    // happened, and it is the thumbnail people look at first.
    const plan = planStrip(400, 100, 60, 1);
    expect(plan.times[0]).toBeGreaterThan(0);
    expect(plan.times[0]).toBeCloseTo(60 * (0.5 / plan.times.length));
  });

  it('keeps every time inside the recording', () => {
    const plan = planStrip(1200, 80, 12.5, 16 / 9);
    for (const time of plan.times) {
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThanOrEqual(12.5);
    }
  });

  it('spaces them evenly', () => {
    const plan = planStrip(900, 90, 90, 1);
    const gaps = plan.times.slice(1).map((time, index) => time - plan.times[index]);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]);
  });

  it('gives a tall thin recording narrow slots, and so more of them', () => {
    const wide = planStrip(1000, 100, 60, 16 / 9);
    const tall = planStrip(1000, 100, 60, 9 / 16);
    expect(tall.slot).toBeLessThan(wide.slot);
    expect(tall.times.length).toBeGreaterThan(wide.times.length);
  });

  it('never asks for a slot too narrow to see', () => {
    const plan = planStrip(1000, 4, 60, 0.01);
    expect(plan.slot).toBeGreaterThanOrEqual(8);
  });

  it('plans nothing at all for a recording with no length', () => {
    // Before a recording loads, and for a still image, there is nothing to show
    // and a divide by zero waiting to happen.
    expect(planStrip(1000, 100, 0, 16 / 9).times).toEqual([]);
    expect(planStrip(0, 100, 60, 16 / 9).times).toEqual([]);
    expect(planStrip(1000, 0, 60, 16 / 9).times).toEqual([]);
    expect(planStrip(1000, 100, 60, 0).times).toEqual([]);
  });

  it('always plans at least one thumbnail for a bar narrower than a slot', () => {
    const plan = planStrip(20, 100, 60, 16 / 9);
    expect(plan.times.length).toBe(1);
  });
});
