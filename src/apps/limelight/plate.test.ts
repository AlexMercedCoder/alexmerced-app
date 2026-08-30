import { describe, expect, it } from 'vitest';
import {
  cornersBounds, defaultMotion, defaultTilt, hasTilt, plateMotion, reviveMotion, reviveTilt,
  tiltCorners, type Tilt,
} from './plate';

const RECT = { x: 100, y: 50, width: 800, height: 450 };
const tilt = (overrides: Partial<Tilt> = {}): Tilt => ({ ...defaultTilt, ...overrides });

describe('hasTilt', () => {
  it('knows a plate lying flat', () => {
    expect(hasTilt(defaultTilt)).toBe(false);
  });

  it('notices any of the three angles', () => {
    expect(hasTilt(tilt({ x: 5 }))).toBe(true);
    expect(hasTilt(tilt({ y: 5 }))).toBe(true);
    expect(hasTilt(tilt({ rotate: 5 }))).toBe(true);
  });

  it('ignores a rounding-error angle', () => {
    expect(hasTilt(tilt({ x: 0.001 }))).toBe(false);
  });
});

describe('tiltCorners', () => {
  it('gives back the plain rectangle when nothing is tilted', () => {
    expect(tiltCorners(RECT, defaultTilt)).toEqual([
      { x: 100, y: 50 }, { x: 900, y: 50 }, { x: 900, y: 500 }, { x: 100, y: 500 },
    ]);
  });

  it('keeps the plate where it was put', () => {
    // The centre of the four corners moves under perspective, because the near
    // edge grows more than the far edge shrinks. What has to stay put is the
    // box the plate occupies.
    for (const angle of [tilt({ x: 20 }), tilt({ y: -15 }), tilt({ rotate: 12 }), tilt({ x: 30, y: 20 })]) {
      const bounds = cornersBounds(tiltCorners(RECT, angle));
      expect(bounds.x + bounds.width / 2).toBeCloseTo(500, 6);
      expect(bounds.y + bounds.height / 2).toBeCloseTo(275, 6);
    }
  });

  it('makes the receding edge shorter than the near one', () => {
    // Leaning the top away should make the top edge the short one.
    const [topLeft, topRight, bottomRight, bottomLeft] = tiltCorners(RECT, tilt({ x: 25 }));
    const top = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
    const bottom = Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y);
    expect(top).toBeLessThan(bottom);
  });

  it('makes the other receding edge shorter for a sideways lean', () => {
    const [topLeft, topRight, bottomRight, bottomLeft] = tiltCorners(RECT, tilt({ y: 25 }));
    const left = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
    const right = Math.hypot(bottomRight.x - topRight.x, bottomRight.y - topRight.y);
    expect(right).toBeLessThan(left);
  });

  it('leans the other way for the opposite angle', () => {
    const positive = tiltCorners(RECT, tilt({ x: 25 }));
    const negative = tiltCorners(RECT, tilt({ x: -25 }));
    const width = (corners: { x: number }[], a: number, b: number) => Math.abs(corners[b].x - corners[a].x);
    expect(width(positive, 0, 1)).toBeLessThan(width(positive, 3, 2));
    expect(width(negative, 0, 1)).toBeGreaterThan(width(negative, 3, 2));
  });

  it('stays inside the space it was given', () => {
    for (const angle of [tilt({ x: 40 }), tilt({ y: -40 }), tilt({ x: 20, y: 20, rotate: 15 })]) {
      const bounds = cornersBounds(tiltCorners(RECT, angle));
      expect(bounds.width).toBeLessThanOrEqual(RECT.width + 1e-6);
      expect(bounds.height).toBeLessThanOrEqual(RECT.height + 1e-6);
    }
  });

  it('turns the plate rather than shrinking it', () => {
    // The longer side should still reach the edge of the space it was given.
    const bounds = cornersBounds(tiltCorners(RECT, tilt({ y: 20 })));
    expect(Math.max(bounds.width / RECT.width, bounds.height / RECT.height)).toBeCloseTo(1, 6);
  });

  it('rolls without changing the shape', () => {
    const flat = tiltCorners(RECT, defaultTilt);
    const rolled = tiltCorners(RECT, tilt({ rotate: 90 }));
    const side = (corners: { x: number; y: number }[], a: number, b: number) =>
      Math.hypot(corners[b].x - corners[a].x, corners[b].y - corners[a].y);
    // A quarter turn swaps which side is which, at whatever scale it was fitted.
    expect(side(rolled, 0, 1) / side(rolled, 1, 2)).toBeCloseTo(side(flat, 0, 1) / side(flat, 1, 2), 6);
  });

  it('converges less at a low depth than at a high one', () => {
    const converge = (depth: number) => {
      const [topLeft, topRight, bottomRight, bottomLeft] = tiltCorners(RECT, tilt({ x: 25, depth }));
      return Math.abs(bottomRight.x - bottomLeft.x) - Math.abs(topRight.x - topLeft.x);
    };
    expect(converge(0)).toBeGreaterThan(0);
    expect(converge(0)).toBeLessThan(converge(1));
  });
});

describe('reviveTilt', () => {
  it('reads back what was stored', () => {
    expect(reviveTilt({ x: 10, y: -5, rotate: 2, depth: 0.5 })).toEqual({ x: 10, y: -5, rotate: 2, depth: 0.5 });
  });

  it('falls back for anything unreadable', () => {
    for (const value of [null, undefined, 'tilt', 3]) expect(reviveTilt(value)).toEqual(defaultTilt);
  });

  it('caps an angle that would fold the plate over', () => {
    const stored = reviveTilt({ x: 400, y: -400, rotate: 400 });
    expect(stored.x).toBe(45);
    expect(stored.y).toBe(-45);
    expect(stored.rotate).toBe(30);
  });
});

describe('plateMotion', () => {
  const settings = { entrance: 'grow' as const, exit: 'fade' as const, seconds: 0.5 };

  it('leaves the plate alone in the middle', () => {
    expect(plateMotion(settings, 5, 0, 10)).toEqual({ opacity: 1, scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('starts an entrance small and see-through', () => {
    const at = plateMotion(settings, 0, 0, 10);
    expect(at.opacity).toBe(0);
    expect(at.scale).toBeLessThan(1);
  });

  it('has finished the entrance by the time it is over', () => {
    const at = plateMotion(settings, 0.5, 0, 10);
    expect(at.opacity).toBe(1);
    expect(at.scale).toBeCloseTo(1, 6);
  });

  it('fades out at the end', () => {
    expect(plateMotion(settings, 10, 0, 10).opacity).toBe(0);
    expect(plateMotion(settings, 9.75, 0, 10).opacity).toBeGreaterThan(0);
  });

  it('measures from the trim point, not from the recording', () => {
    // An export starting at four seconds has its entrance at four seconds.
    expect(plateMotion(settings, 4, 4, 10).opacity).toBe(0);
    expect(plateMotion(settings, 4.5, 4, 10).opacity).toBe(1);
  });

  it('does nothing outside the export, so scrubbing past the trim shows the plate', () => {
    expect(plateMotion(settings, 0, 4, 10)).toEqual({ opacity: 1, scale: 1, offsetX: 0, offsetY: 0 });
    expect(plateMotion(settings, 12, 4, 10)).toEqual({ opacity: 1, scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('does nothing when neither is set', () => {
    const still = { entrance: 'none' as const, exit: 'none' as const, seconds: 0.5 };
    expect(plateMotion(still, 0, 0, 10)).toEqual({ opacity: 1, scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('will not let the two animations eat the whole clip', () => {
    const greedy = { entrance: 'fade' as const, exit: 'fade' as const, seconds: 10 };
    // In a one second clip each gets half a second, so the middle is still shown.
    expect(plateMotion(greedy, 0.5, 0, 1).opacity).toBe(1);
  });

  it('does nothing for a clip with no length', () => {
    expect(plateMotion(settings, 0, 3, 3).opacity).toBe(1);
  });

  it('moves a rise upward into place', () => {
    const rising = { entrance: 'rise' as const, exit: 'none' as const, seconds: 0.5 };
    expect(plateMotion(rising, 0, 0, 10).offsetY).toBeGreaterThan(0);
    expect(plateMotion(rising, 0.5, 0, 10).offsetY).toBeCloseTo(0, 6);
  });

  it('slides in from the side', () => {
    const sliding = { entrance: 'slide' as const, exit: 'none' as const, seconds: 0.5 };
    expect(plateMotion(sliding, 0, 0, 10).offsetX).toBeLessThan(0);
  });
});

describe('reviveMotion', () => {
  it('reads back what was stored', () => {
    expect(reviveMotion({ entrance: 'rise', exit: 'grow', seconds: 1 }))
      .toEqual({ entrance: 'rise', exit: 'grow', seconds: 1 });
  });

  it('ignores a movement it does not know', () => {
    expect(reviveMotion({ entrance: 'cartwheel' }).entrance).toBe('none');
  });

  it('keeps the length within what is usable', () => {
    expect(reviveMotion({ seconds: 99 }).seconds).toBe(3);
    expect(reviveMotion({ seconds: -1 }).seconds).toBe(0.1);
  });

  it('falls back for anything unreadable', () => {
    for (const value of [null, undefined, 'motion']) expect(reviveMotion(value)).toEqual(defaultMotion);
  });
});
