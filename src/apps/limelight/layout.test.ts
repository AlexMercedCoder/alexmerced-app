import { describe, expect, it } from 'vitest';
import {
  cameraCrop, cameraRect, contentRect, cornerRadius, cropRect, cropToAspect, defaultComposition,
  evenSize, isFullCrop, MIN_CROP, normaliseCrop, reviveCrop, ripple,
  type Composition,
} from './layout';

const make = (overrides: Partial<Composition> = {}): Composition => ({
  ...defaultComposition,
  ...overrides,
  camera: { ...defaultComposition.camera, ...(overrides.camera ?? {}) },
});

describe('contentRect', () => {
  it('centres the recording inside the padding', () => {
    const rect = contentRect(make({ width: 1000, height: 1000, padding: 0.1 }), 800, 800);
    expect(rect.x).toBeCloseTo(100);
    expect(rect.y).toBeCloseTo(100);
    expect(rect.width).toBeCloseTo(800);
    expect(rect.height).toBeCloseTo(800);
  });

  it('keeps the shape of the recording rather than stretching it', () => {
    // A 16:10 capture on a 16:9 output keeps its own ratio.
    const rect = contentRect(make({ width: 1920, height: 1080, padding: 0 }), 1600, 1000);
    expect(rect.width / rect.height).toBeCloseTo(1.6, 5);
  });

  it('leaves bars of background where the shapes differ', () => {
    const composition = make({ width: 1920, height: 1080, padding: 0 });
    const rect = contentRect(composition, 1000, 1000);
    expect(rect.width).toBeCloseTo(1080);
    expect(rect.x).toBeCloseTo(420);
    expect(rect.y).toBeCloseTo(0);
  });

  it('fills the frame with no padding at all', () => {
    const rect = contentRect(make({ width: 1920, height: 1080, padding: 0 }), 1920, 1080);
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('caps the padding rather than shrinking the picture to nothing', () => {
    const rect = contentRect(make({ width: 1000, height: 1000, padding: 5 }), 1000, 1000);
    expect(rect.width).toBeGreaterThan(400);
  });

  it('handles a source with no size', () => {
    const rect = contentRect(make({ width: 800, height: 600 }), 0, 0);
    expect(rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('scales a vertical output correctly', () => {
    const rect = contentRect(make({ width: 1080, height: 1920, padding: 0.05 }), 1920, 1080);
    expect(rect.width).toBeLessThanOrEqual(1080 - 1080 * 0.1);
    expect(rect.width / rect.height).toBeCloseTo(1920 / 1080, 3);
  });
});

describe('cornerRadius', () => {
  it('scales with the shorter edge of the recording', () => {
    const content = { x: 0, y: 0, width: 1000, height: 500 };
    expect(cornerRadius(make({ radius: 0.02 }), content)).toBeCloseTo(10);
  });

  it('never rounds away more than half the picture', () => {
    const content = { x: 0, y: 0, width: 100, height: 100 };
    expect(cornerRadius(make({ radius: 5 }), content)).toBeLessThanOrEqual(50);
  });

  it('is zero when asked for square corners', () => {
    expect(cornerRadius(make({ radius: 0 }), { x: 0, y: 0, width: 800, height: 600 })).toBe(0);
  });
});

describe('cameraRect', () => {
  it('returns nothing when the camera is off', () => {
    expect(cameraRect(make({ camera: { enabled: false } as never }))).toBeNull();
  });

  it('sits in each corner with its margin', () => {
    const base = { width: 1000, height: 1000 };
    const size = 0.2 * 1000;
    const margin = 0.05 * 1000;

    const corners = {
      topLeft: { x: margin, y: margin },
      topRight: { x: 1000 - size - margin, y: margin },
      bottomLeft: { x: margin, y: 1000 - size - margin },
      bottomRight: { x: 1000 - size - margin, y: 1000 - size - margin },
    } as const;

    for (const [corner, expected] of Object.entries(corners)) {
      const rect = cameraRect(make({
        ...base,
        camera: { enabled: true, corner: corner as never, size: 0.2, round: true, margin: 0.05 },
      }))!;
      expect(rect.x, corner).toBeCloseTo(expected.x);
      expect(rect.y, corner).toBeCloseTo(expected.y);
      expect(rect.width, corner).toBeCloseTo(size);
    }
  });

  it('measures against the shorter edge, so a vertical output does not get a giant bubble', () => {
    const rect = cameraRect(make({
      width: 1080, height: 1920,
      camera: { enabled: true, corner: 'bottomRight', size: 0.25, round: true, margin: 0.03 },
    }))!;
    expect(rect.width).toBeCloseTo(0.25 * 1080);
  });

  it('stays inside the frame even when asked for a huge bubble', () => {
    const composition = make({
      width: 1000, height: 1000,
      camera: { enabled: true, corner: 'bottomRight', size: 9, round: true, margin: 0 },
    });
    const rect = cameraRect(composition)!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1000);
  });
});

describe('cameraCrop', () => {
  it('takes a square out of a wide frame', () => {
    const crop = cameraCrop(1280, 720);
    expect(crop.width).toBe(720);
    expect(crop.height).toBe(720);
    expect(crop.x).toBe(280);
  });

  it('takes the whole thing when it is already square', () => {
    expect(cameraCrop(500, 500)).toEqual({ x: 0, y: 0, width: 500, height: 500 });
  });

  it('sits a little above centre on a tall frame, where a face is', () => {
    const crop = cameraCrop(480, 640);
    expect(crop.y).toBeLessThan((640 - 480) / 2);
    expect(crop.y).toBeGreaterThanOrEqual(0);
  });

  it('never starts off the top of the frame', () => {
    expect(cameraCrop(400, 401).y).toBeGreaterThanOrEqual(0);
  });
});

describe('evenSize', () => {
  it('rounds both dimensions to even numbers', () => {
    expect(evenSize(1919, 1081)).toEqual({ width: 1920, height: 1082 });
  });

  it('never returns less than two', () => {
    expect(evenSize(0, -4)).toEqual({ width: 2, height: 2 });
  });
});

describe('ripple', () => {
  it('is nothing before it starts or after it ends', () => {
    expect(ripple(-0.1)).toBeNull();
    expect(ripple(2)).toBeNull();
  });

  it('starts small and opaque and ends wide and clear', () => {
    const early = ripple(0.02)!;
    const late = ripple(0.55)!;
    expect(early.radius).toBeLessThan(late.radius);
    expect(early.opacity).toBeGreaterThan(late.opacity);
  });

  it('expands quickly then slows, which reads as an impact', () => {
    const first = ripple(0.15)!.radius;
    const second = ripple(0.3)!.radius - first;
    expect(first).toBeGreaterThan(second);
  });

  it('reaches full width and no opacity at the end', () => {
    const end = ripple(0.6)!;
    expect(end.radius).toBeCloseTo(1, 5);
    expect(end.opacity).toBeCloseTo(0, 5);
  });
});

describe('normaliseCrop', () => {
  it('leaves a sensible crop alone', () => {
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
    expect(normaliseCrop(crop)).toEqual(crop);
  });

  it('refuses to let a crop collapse to nothing', () => {
    const crop = normaliseCrop({ x: 0.5, y: 0.5, width: 0, height: -1 });
    expect(crop.width).toBe(MIN_CROP);
    expect(crop.height).toBe(MIN_CROP);
  });

  it('pushes a crop that hangs off the right edge back inside', () => {
    const crop = normaliseCrop({ x: 0.8, y: 0, width: 0.5, height: 1 });
    expect(crop.x).toBeCloseTo(0.5, 6);
    expect(crop.x + crop.width).toBeCloseTo(1, 6);
  });

  it('caps a crop larger than the source', () => {
    expect(normaliseCrop({ x: -1, y: -1, width: 3, height: 3 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe('isFullCrop', () => {
  it('recognises the whole picture', () => {
    expect(isFullCrop({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
  });

  it('recognises anything less', () => {
    expect(isFullCrop({ x: 0, y: 0, width: 0.9, height: 1 })).toBe(false);
    expect(isFullCrop({ x: 0.05, y: 0, width: 0.95, height: 1 })).toBe(false);
  });
});

describe('reviveCrop', () => {
  it('reads a stored crop back', () => {
    expect(reviveCrop({ x: 0.25, y: 0.1, width: 0.5, height: 0.5 }))
      .toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.5 });
  });

  it('falls back to the whole picture for anything unreadable', () => {
    for (const value of [null, undefined, 'crop', 42, {}]) {
      expect(reviveCrop(value)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    }
  });

  it('repairs a partly broken crop rather than discarding it', () => {
    expect(reviveCrop({ x: 0.2, y: 'no', width: 0.5 }))
      .toEqual({ x: 0.2, y: 0, width: 0.5, height: 1 });
  });
});

describe('cropRect', () => {
  it('turns fractions into source pixels', () => {
    expect(cropRect({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 1920, 1080))
      .toEqual({ x: 480, y: 540, width: 960, height: 270 });
  });

  it('treats a missing crop as the whole picture', () => {
    expect(cropRect(null, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it('never reports a zero size, whatever it is given', () => {
    const rect = cropRect({ x: 0, y: 0, width: 0, height: 0 }, 0, 0);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });
});

describe('cropToAspect', () => {
  const full = { x: 0, y: 0, width: 1, height: 1 };

  it('takes a tall slice for a square picture out of a wide recording', () => {
    const crop = cropToAspect(full, 1, 1920, 1080);
    // A square of a 16:9 source is 9/16 of its width and all of its height.
    expect(crop.height).toBeCloseTo(1, 6);
    expect(crop.width).toBeCloseTo(1080 / 1920, 6);
  });

  it('leaves a matching shape untouched', () => {
    const crop = cropToAspect(full, 16 / 9, 1920, 1080);
    expect(crop).toEqual(full);
  });

  it('produces the aspect it was asked for, in output pixels', () => {
    const crop = cropToAspect({ x: 0.1, y: 0.1, width: 0.6, height: 0.6 }, 9 / 16, 1920, 1080);
    const pixels = cropRect(crop, 1920, 1080);
    expect(pixels.width / pixels.height).toBeCloseTo(9 / 16, 4);
  });

  it('keeps the middle where it was', () => {
    const before = { x: 0.5, y: 0.2, width: 0.4, height: 0.4 };
    const after = cropToAspect(before, 4 / 3, 1920, 1080);
    expect(after.x + after.width / 2).toBeCloseTo(0.7, 6);
    expect(after.y + after.height / 2).toBeCloseTo(0.4, 6);
  });

  it('stays inside the source when the middle is near an edge', () => {
    const after = cropToAspect({ x: 0.9, y: 0, width: 0.1, height: 1 }, 1, 1920, 1080);
    expect(after.x).toBeGreaterThanOrEqual(0);
    expect(after.x + after.width).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('ignores a ratio that makes no sense', () => {
    const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(cropToAspect(crop, 0, 1920, 1080)).toEqual(crop);
    expect(cropToAspect(crop, Number.NaN, 1920, 1080)).toEqual(crop);
  });
});
