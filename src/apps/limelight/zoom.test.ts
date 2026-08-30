import { describe, expect, it } from 'vitest';
import type { Interest } from './attention';
import { buildZoomTrack, defaultZoom, ease, viewRect, zoomAt, type ZoomSettings } from './zoom';

const at = (time: number, x = 0.5, y = 0.5): Interest => ({ time, x, y, weight: 1, source: 'click' });
const settings = (overrides: Partial<ZoomSettings> = {}): ZoomSettings => ({ ...defaultZoom, ...overrides });

describe('ease', () => {
  it('starts and ends at rest', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBe(0.5);
  });

  it('clamps outside the range', () => {
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
  });

  it('accelerates then decelerates rather than moving at a constant rate', () => {
    expect(ease(0.25)).toBeLessThan(0.25);
    expect(ease(0.75)).toBeGreaterThan(0.75);
  });
});

describe('buildZoomTrack', () => {
  it('stays wide when zooming is off', () => {
    const track = buildZoomTrack([at(2)], 10, settings({ enabled: false }));
    expect(track).toEqual([{ time: 0, scale: 1, x: 0.5, y: 0.5 }]);
  });

  it('stays wide when there is nothing worth looking at', () => {
    expect(buildZoomTrack([], 10, settings()).every((frame) => frame.scale === 1)).toBe(true);
  });

  it('starts wide', () => {
    const track = buildZoomTrack([at(3)], 10, settings());
    expect(track[0]).toEqual({ time: 0, scale: 1, x: 0.5, y: 0.5 });
  });

  it('pulls in on the moment and back out afterwards', () => {
    const track = buildZoomTrack([at(4, 0.8, 0.2)], 12, settings({ scale: 2 }));
    const zoomed = track.filter((frame) => frame.scale > 1);
    expect(zoomed.length).toBeGreaterThan(0);
    expect(zoomed[0].x).toBeCloseTo(0.8);
    expect(zoomed[0].y).toBeCloseTo(0.2);
    expect(track[track.length - 1].scale).toBe(1);
  });

  it('arrives before the moment, not after it', () => {
    const track = buildZoomTrack([at(5)], 12, settings({ leadSeconds: 0.4, scale: 2 }));
    const arrival = track.find((frame) => frame.scale === 2)!;
    expect(arrival.time).toBeLessThanOrEqual(5);
    expect(arrival.time).toBeCloseTo(4.6, 5);
  });

  it('never moves backwards in time', () => {
    const points = [at(1, 0.2, 0.2), at(1.1, 0.9, 0.9), at(1.15, 0.1, 0.8), at(6, 0.5, 0.5)];
    const track = buildZoomTrack(points, 12, settings());
    for (let index = 1; index < track.length; index += 1) {
      expect(track[index].time).toBeGreaterThanOrEqual(track[index - 1].time);
    }
  });

  it('slides across instead of pulling out when the next moment comes soon', () => {
    // Two clicks a second apart, with a hold longer than that.
    const track = buildZoomTrack([at(3, 0.2, 0.2), at(4, 0.8, 0.8)], 10, settings({ holdSeconds: 2, scale: 2 }));
    // The camera should never return to a scale of 1 between them.
    const between = track.filter((frame) => frame.time > 3 && frame.time < 4.5);
    expect(between.every((frame) => frame.scale > 1)).toBe(true);
  });

  it('does pull out when there is room before the next moment', () => {
    const track = buildZoomTrack([at(2), at(12)], 20, settings({ holdSeconds: 1, moveSeconds: 0.5 }));
    const between = track.filter((frame) => frame.time > 3 && frame.time < 11);
    expect(between.some((frame) => frame.scale === 1)).toBe(true);
  });

  it('ends wide at the end of the recording', () => {
    const track = buildZoomTrack([at(9.5)], 10, settings());
    const last = track[track.length - 1];
    expect(last.time).toBeGreaterThanOrEqual(10);
    expect(last.scale).toBe(1);
  });

  it('never zooms out past the whole frame', () => {
    const track = buildZoomTrack([at(3)], 10, settings({ scale: 0.5 }));
    expect(track.every((frame) => frame.scale >= 1)).toBe(true);
  });

  it('handles a moment at time zero', () => {
    const track = buildZoomTrack([at(0)], 10, settings());
    expect(track.every((frame) => frame.time >= 0)).toBe(true);
  });

  it('handles a recording of no length', () => {
    expect(buildZoomTrack([at(0)], 0, settings())).toHaveLength(1);
  });
});

describe('zoomAt', () => {
  const track = buildZoomTrack([at(5, 0.8, 0.3)], 12, settings({ scale: 2, moveSeconds: 1, leadSeconds: 0 }));

  it('returns a wide view before anything happens', () => {
    expect(zoomAt(track, 0).scale).toBe(1);
  });

  it('returns the full zoom at the moment itself', () => {
    expect(zoomAt(track, 5).scale).toBeCloseTo(2, 5);
    expect(zoomAt(track, 5).x).toBeCloseTo(0.8, 5);
  });

  it('is part way through during the move', () => {
    const halfway = zoomAt(track, 4.5);
    expect(halfway.scale).toBeGreaterThan(1);
    expect(halfway.scale).toBeLessThan(2);
  });

  it('never jumps: consecutive samples stay close together', () => {
    let previous = zoomAt(track, 0);
    for (let time = 0.05; time <= 12; time += 0.05) {
      const current = zoomAt(track, time);
      expect(Math.abs(current.scale - previous.scale)).toBeLessThan(0.25);
      expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThan(0.12);
      previous = current;
    }
  });

  it('clamps past the ends', () => {
    expect(zoomAt(track, -5).scale).toBe(1);
    expect(zoomAt(track, 999).scale).toBe(1);
  });

  it('copes with an empty track', () => {
    expect(zoomAt([], 3)).toEqual({ time: 3, scale: 1, x: 0.5, y: 0.5 });
  });
});

describe('viewRect', () => {
  it('gives the whole frame at a scale of one', () => {
    expect(viewRect({ time: 0, scale: 1, x: 0.5, y: 0.5 }, 1920, 1080))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('takes a smaller window as the scale rises', () => {
    const rect = viewRect({ time: 0, scale: 2, x: 0.5, y: 0.5 }, 1920, 1080);
    expect(rect.width).toBe(960);
    expect(rect.height).toBe(540);
    expect(rect.x).toBe(480);
    expect(rect.y).toBe(270);
  });

  it('never runs off the left or top edge', () => {
    const rect = viewRect({ time: 0, scale: 4, x: 0, y: 0 }, 1920, 1080);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it('never runs off the right or bottom edge', () => {
    const rect = viewRect({ time: 0, scale: 4, x: 1, y: 1 }, 1920, 1080);
    expect(rect.x + rect.width).toBeCloseTo(1920, 5);
    expect(rect.y + rect.height).toBeCloseTo(1080, 5);
  });

  it('stays inside the frame at every position and scale', () => {
    for (const scale of [1, 1.5, 2, 3, 5]) {
      for (let x = 0; x <= 1; x += 0.1) {
        for (let y = 0; y <= 1; y += 0.25) {
          const rect = viewRect({ time: 0, scale, x, y }, 1920, 1080);
          expect(rect.x, `${scale} ${x} ${y}`).toBeGreaterThanOrEqual(-1e-9);
          expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
          expect(rect.x + rect.width).toBeLessThanOrEqual(1920 + 1e-9);
          expect(rect.y + rect.height).toBeLessThanOrEqual(1080 + 1e-9);
        }
      }
    }
  });

  it('refuses to zoom out below the frame', () => {
    const rect = viewRect({ time: 0, scale: 0.25, x: 0.5, y: 0.5 }, 800, 600);
    expect(rect.width).toBe(800);
    expect(rect.height).toBe(600);
  });
});
