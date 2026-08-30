import { describe, expect, it } from 'vitest';
import {
  clampJob, concerns, defaultJob, estimateBytes, evenly, fitWithin, formatDuration, frameCount,
  gifDelay, outputDuration, outputName, suggestBitrate, type Job, type SourceInfo,
} from './model';

const SOURCE: SourceInfo = { name: 'holiday.mp4', duration: 30, width: 1920, height: 1080, hasAudio: true, bytes: 40_000_000 };

function job(overrides: Partial<Job> = {}): Job {
  return { ...defaultJob(SOURCE), ...overrides };
}

describe('evenly', () => {
  it('rounds to an even number, which is what codecs require', () => {
    expect(evenly(101)).toBe(102);
    expect(evenly(100)).toBe(100);
    expect(evenly(99)).toBe(100);
  });

  it('never goes below two', () => {
    expect(evenly(0)).toBe(2);
    expect(evenly(-5)).toBe(2);
  });
});

describe('fitWithin', () => {
  it('scales down to fit the box, keeping the shape', () => {
    expect(fitWithin(1920, 1080, 1280, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it('fits a portrait video on its height', () => {
    expect(fitWithin(1080, 1920, 1280, 1280)).toEqual({ width: 720, height: 1280 });
  });

  it('never scales up', () => {
    expect(fitWithin(320, 240, 1280, 1280)).toEqual({ width: 320, height: 240 });
  });

  it('always returns even dimensions', () => {
    const fitted = fitWithin(1001, 667, 500, 500);
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);
  });
});

describe('suggestBitrate', () => {
  it('scales with the pixel rate', () => {
    expect(suggestBitrate(1280, 720, 30)).toBeGreaterThan(suggestBitrate(640, 360, 30));
    expect(suggestBitrate(640, 360, 60)).toBeGreaterThan(suggestBitrate(640, 360, 30));
  });

  it('lands somewhere sensible for common sizes', () => {
    const hd = suggestBitrate(1280, 720, 30);
    expect(hd).toBeGreaterThan(1_000_000);
    expect(hd).toBeLessThan(4_000_000);
  });

  it('stays inside usable bounds', () => {
    expect(suggestBitrate(2, 2, 1)).toBeGreaterThanOrEqual(120_000);
    expect(suggestBitrate(7680, 4320, 120)).toBeLessThanOrEqual(20_000_000);
  });
});

describe('defaultJob', () => {
  it('covers the whole source', () => {
    const created = defaultJob(SOURCE);
    expect(created.start).toBe(0);
    expect(created.end).toBe(30);
  });

  it('caps a large video at a sensible size', () => {
    expect(defaultJob(SOURCE).width).toBe(1280);
  });

  it('keeps audio only when there is some', () => {
    expect(defaultJob(SOURCE).keepAudio).toBe(true);
    expect(defaultJob({ ...SOURCE, hasAudio: false }).keepAudio).toBe(false);
  });
});

describe('clampJob', () => {
  it('keeps the range inside the source', () => {
    const fixed = clampJob(job({ start: -5, end: 100 }), SOURCE);
    expect(fixed.start).toBe(0);
    expect(fixed.end).toBe(30);
  });

  it('never lets the end fall before the start', () => {
    const fixed = clampJob(job({ start: 20, end: 5 }), SOURCE);
    expect(fixed.end).toBeGreaterThanOrEqual(fixed.start);
  });

  it('forces even dimensions', () => {
    const fixed = clampJob(job({ width: 641, height: 361 }), SOURCE);
    expect(fixed.width % 2).toBe(0);
    expect(fixed.height % 2).toBe(0);
  });

  it('clamps a silly frame rate or speed', () => {
    expect(clampJob(job({ frameRate: 1000 }), SOURCE).frameRate).toBe(120);
    expect(clampJob(job({ frameRate: 0 }), SOURCE).frameRate).toBe(1);
    expect(clampJob(job({ speed: 0 }), SOURCE).speed).toBe(0.1);
    expect(clampJob(job({ speed: 99 }), SOURCE).speed).toBe(8);
  });

  it('replaces a value that is not a number', () => {
    expect(clampJob(job({ bitrate: NaN }), SOURCE).bitrate).toBe(50_000);
  });
});

describe('outputDuration and frameCount', () => {
  it('measures the trimmed range', () => {
    expect(outputDuration(job({ start: 5, end: 15 }))).toBe(10);
  });

  it('shortens with speed', () => {
    expect(outputDuration(job({ start: 0, end: 10, speed: 2 }))).toBe(5);
    expect(outputDuration(job({ start: 0, end: 10, speed: 0.5 }))).toBe(20);
  });

  it('counts frames from the duration and the rate', () => {
    expect(frameCount(job({ start: 0, end: 10, frameRate: 30 }))).toBe(300);
    expect(frameCount(job({ start: 0, end: 10, frameRate: 30, speed: 2 }))).toBe(150);
  });

  it('never reports zero frames', () => {
    expect(frameCount(job({ start: 5, end: 5 }))).toBe(1);
  });
});

describe('estimateBytes', () => {
  it('grows with duration and bitrate', () => {
    const short = estimateBytes(job({ start: 0, end: 5 }));
    const long = estimateBytes(job({ start: 0, end: 20 }));
    expect(long).toBeGreaterThan(short * 3);
  });

  it('adds something for audio', () => {
    const withAudio = estimateBytes(job({ keepAudio: true }));
    const without = estimateBytes(job({ keepAudio: false }));
    expect(withAudio).toBeGreaterThan(without);
  });

  it('estimates a GIF from its pixels, not its bitrate', () => {
    const small = estimateBytes(job({ format: 'gif', width: 320, height: 240 }));
    const large = estimateBytes(job({ format: 'gif', width: 640, height: 480 }));
    expect(large).toBeGreaterThan(small * 3);
  });

  it('estimates still frames as a pile of images', () => {
    expect(estimateBytes(job({ format: 'frames', start: 0, end: 1, frameRate: 10 }))).toBeGreaterThan(0);
  });
});

describe('concerns', () => {
  it('says nothing about a reasonable job', () => {
    expect(concerns(job({ start: 0, end: 10, width: 1280, height: 720 }), SOURCE)).toEqual([]);
  });

  it('warns about an empty range', () => {
    expect(concerns(job({ start: 5, end: 5 }), SOURCE).join(' ')).toMatch(/nothing to export/);
  });

  it('warns about a long GIF', () => {
    expect(concerns(job({ format: 'gif', start: 0, end: 25 }), SOURCE).join(' ')).toMatch(/very large/);
  });

  it('warns about a wide GIF', () => {
    expect(concerns(job({ format: 'gif', width: 1280, start: 0, end: 5 }), SOURCE).join(' ')).toMatch(/big quickly with width/);
  });

  it('warns that a high GIF frame rate is wasted', () => {
    expect(concerns(job({ format: 'gif', frameRate: 60, start: 0, end: 5, width: 400 }), SOURCE).join(' ')).toMatch(/hundredths of a second/);
  });

  it('warns before writing thousands of images', () => {
    expect(concerns(job({ format: 'frames', start: 0, end: 30, frameRate: 120 }), SOURCE).join(' ')).toMatch(/separate images/);
  });

  it('warns about scaling up', () => {
    expect(concerns(job({ width: 3840, height: 2160 }), SOURCE).join(' ')).toMatch(/cannot add detail/);
  });

  it('warns when there is no audio to keep', () => {
    expect(concerns(job({ keepAudio: true }), { ...SOURCE, hasAudio: false }).join(' ')).toMatch(/no audio track/);
  });

  it('warns that changing speed drops the audio', () => {
    expect(concerns(job({ speed: 2, keepAudio: true }), SOURCE).join(' ')).toMatch(/drops the audio/);
  });
});

describe('gifDelay', () => {
  it('converts a frame rate into hundredths of a second', () => {
    expect(gifDelay(10)).toBe(10);
    expect(gifDelay(25)).toBe(4);
    expect(gifDelay(50)).toBe(2);
  });

  it('never goes below the two hundredths most players honour', () => {
    expect(gifDelay(120)).toBe(2);
  });
});

describe('formatDuration', () => {
  it('reads as minutes, seconds and hundredths', () => {
    expect(formatDuration(0)).toBe('0:00.00');
    expect(formatDuration(65.5)).toBe('1:05.50');
  });

  it('shows zero for nonsense', () => {
    expect(formatDuration(NaN)).toBe('0:00.00');
    expect(formatDuration(-3)).toBe('0:00.00');
  });
});

describe('outputName', () => {
  it('keeps the source name and swaps the extension', () => {
    expect(outputName('Holiday Video.MP4', 'webm-vp9')).toBe('holiday-video.webm');
    expect(outputName('clip.mov', 'gif')).toBe('clip.gif');
    expect(outputName('clip.mov', 'frames')).toBe('clip.zip');
  });

  it('falls back when nothing usable is left', () => {
    expect(outputName('---.mp4', 'webm-vp9')).toBe('clip.webm');
  });
});
