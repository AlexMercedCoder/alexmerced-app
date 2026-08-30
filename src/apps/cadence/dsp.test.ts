import { describe, expect, it } from 'vitest';
import {
  changeSpeed, cut, decibelsToGain, fadeCurve, fadeIn, fadeOut, findBounds, formatTime, gain,
  gainToDecibels, join, normalisePeak, normaliseRms, peak, resample, reverse, rms, silence,
  toMono, toStereo, trim, trimSilence, waveformPeaks,
} from './dsp';
import { frameCount, type Samples } from './wav';

const RATE = 1000;

function ramp(length: number, channelCount = 1): Samples {
  return {
    sampleRate: RATE,
    channels: Array.from({ length: channelCount }, (_, channel) =>
      Float32Array.from({ length }, (_, index) => (index / length) * (channel === 0 ? 1 : 0.5))),
  };
}

function constant(length: number, value: number, channelCount = 1): Samples {
  return {
    sampleRate: RATE,
    channels: Array.from({ length: channelCount }, () => new Float32Array(length).fill(value)),
  };
}

describe('trim and cut', () => {
  it('keeps only the requested window', () => {
    const result = trim(ramp(1000), 0.2, 0.5);
    expect(frameCount(result)).toBe(300);
    expect(result.channels[0][0]).toBeCloseTo(0.2);
  });

  it('clamps a window that runs off the end', () => {
    expect(frameCount(trim(ramp(100), -5, 500))).toBe(100);
  });

  it('returns nothing for a backwards window rather than throwing', () => {
    expect(frameCount(trim(ramp(100), 0.08, 0.02))).toBe(0);
  });

  it('removes the middle and joins what is left', () => {
    const result = cut(ramp(1000), 0.2, 0.5);
    expect(frameCount(result)).toBe(700);
    // Frame 200 in the result is what was frame 500 in the source.
    expect(result.channels[0][200]).toBeCloseTo(0.5);
  });

  it('cuts across every channel by the same amount', () => {
    const result = cut(ramp(100, 2), 0.01, 0.05);
    expect(result.channels[0].length).toBe(result.channels[1].length);
  });
});

describe('gain and levels', () => {
  it('scales every sample', () => {
    expect(gain(constant(10, 0.5), 2).channels[0][0]).toBeCloseTo(1);
  });

  it('converts between decibels and a factor both ways', () => {
    expect(decibelsToGain(0)).toBeCloseTo(1);
    expect(decibelsToGain(6)).toBeCloseTo(1.995, 2);
    expect(decibelsToGain(-6)).toBeCloseTo(0.501, 2);
    expect(gainToDecibels(2)).toBeCloseTo(6.02, 1);
    expect(gainToDecibels(0)).toBe(-Infinity);
  });

  it('finds the peak across every channel', () => {
    const samples: Samples = { sampleRate: RATE, channels: [Float32Array.from([0.2, -0.9]), Float32Array.from([0.4, 0.1])] };
    expect(peak(samples)).toBeCloseTo(0.9);
  });

  it('measures RMS, which for a constant signal is the value itself', () => {
    expect(rms(constant(100, 0.5))).toBeCloseTo(0.5);
    expect(rms(constant(100, 0))).toBe(0);
  });

  it('returns zero RMS for an empty buffer instead of NaN', () => {
    expect(rms({ sampleRate: RATE, channels: [] })).toBe(0);
  });
});

describe('normalising', () => {
  it('lifts the peak to the target', () => {
    const result = normalisePeak(constant(100, 0.1), -1);
    expect(peak(result)).toBeCloseTo(decibelsToGain(-1), 4);
  });

  it('pulls a hot recording down as well as up', () => {
    expect(peak(normalisePeak(constant(100, 0.99), -6))).toBeCloseTo(decibelsToGain(-6), 4);
  });

  it('leaves silence alone rather than dividing by zero', () => {
    const quiet = constant(100, 0);
    expect(peak(normalisePeak(quiet))).toBe(0);
    expect(peak(normaliseRms(quiet))).toBe(0);
  });

  it('matches average level when normalising by RMS', () => {
    const result = normaliseRms(constant(100, 0.02), -20);
    expect(rms(result)).toBeCloseTo(decibelsToGain(-20), 3);
  });

  it('never lets an RMS normalise push the peaks past full scale', () => {
    // A signal with a very low average but occasional full-scale spikes.
    const spiky = new Float32Array(1000).fill(0.001);
    spiky[10] = 1;
    spiky[500] = -1;
    expect(peak(normaliseRms({ sampleRate: RATE, channels: [spiky] }, -6))).toBeLessThanOrEqual(1.0001);
  });
});

describe('fades', () => {
  it('runs a linear curve straight from zero to one', () => {
    expect(fadeCurve(0, 'linear')).toBe(0);
    expect(fadeCurve(0.5, 'linear')).toBe(0.5);
    expect(fadeCurve(1, 'linear')).toBe(1);
  });

  it('keeps an equal power curve above the linear one in the middle', () => {
    expect(fadeCurve(0.5, 'equalPower')).toBeGreaterThan(0.5);
    expect(fadeCurve(0, 'equalPower')).toBeCloseTo(0);
    expect(fadeCurve(1, 'equalPower')).toBeCloseTo(1);
  });

  it('keeps an exponential curve below the linear one in the middle', () => {
    expect(fadeCurve(0.5, 'exponential')).toBeLessThan(0.5);
  });

  it('clamps a position outside zero to one', () => {
    expect(fadeCurve(-1, 'linear')).toBe(0);
    expect(fadeCurve(2, 'linear')).toBe(1);
  });

  it('starts a fade in at silence and reaches full level', () => {
    const result = fadeIn(constant(1000, 1), 0.5, 'linear');
    expect(result.channels[0][0]).toBeCloseTo(0);
    expect(result.channels[0][250]).toBeCloseTo(0.5, 2);
    expect(result.channels[0][500]).toBeCloseTo(1);
    expect(result.channels[0][999]).toBeCloseTo(1);
  });

  it('ends a fade out at silence', () => {
    const result = fadeOut(constant(1000, 1), 0.5, 'linear');
    expect(result.channels[0][999]).toBeCloseTo(0);
    expect(result.channels[0][0]).toBeCloseTo(1);
  });

  it('does nothing for a fade of no length', () => {
    const original = constant(100, 1);
    expect(fadeIn(original, 0)).toBe(original);
    expect(fadeOut(original, -1)).toBe(original);
  });

  it('clamps a fade longer than the clip to the clip', () => {
    const result = fadeIn(constant(100, 1), 10, 'linear');
    expect(result.channels[0][0]).toBeCloseTo(0);
    expect(result.channels[0][99]).toBeLessThan(1);
  });

  it('fades every channel', () => {
    const result = fadeIn(constant(100, 1, 2), 0.05, 'linear');
    expect(result.channels[1][0]).toBeCloseTo(0);
  });

  it('leaves the source untouched', () => {
    const original = constant(100, 1);
    fadeIn(original, 0.05);
    expect(original.channels[0][0]).toBe(1);
  });
});

describe('reverse, mono, and stereo', () => {
  it('reverses each channel', () => {
    const result = reverse(ramp(100));
    expect(result.channels[0][0]).toBeCloseTo(0.99);
    expect(result.channels[0][99]).toBeCloseTo(0);
  });

  it('averages channels down to one', () => {
    const stereo: Samples = { sampleRate: RATE, channels: [Float32Array.from([1, 1]), Float32Array.from([0, 0.5])] };
    const mono = toMono(stereo);
    expect(mono.channels).toHaveLength(1);
    expect(mono.channels[0][0]).toBeCloseTo(0.5);
    expect(mono.channels[0][1]).toBeCloseTo(0.75);
  });

  it('leaves a mono clip alone', () => {
    const mono = constant(10, 0.5);
    expect(toMono(mono)).toBe(mono);
  });

  it('copies a mono clip into both sides of a stereo one', () => {
    const stereo = toStereo(constant(10, 0.5));
    expect(stereo.channels).toHaveLength(2);
    expect(stereo.channels[1][0]).toBe(0.5);
  });

  it('drops extra channels when forcing stereo', () => {
    expect(toStereo(constant(10, 1, 5)).channels).toHaveLength(2);
  });
});

describe('resample and speed', () => {
  it('halves the frame count when halving the rate', () => {
    const result = resample(ramp(1000), 500);
    expect(result.sampleRate).toBe(500);
    expect(frameCount(result)).toBe(500);
  });

  it('holds the duration steady across a rate change', () => {
    const before = frameCount(ramp(1000)) / RATE;
    const result = resample(ramp(1000), 3000);
    expect(frameCount(result) / result.sampleRate).toBeCloseTo(before, 3);
  });

  it('preserves a constant signal exactly', () => {
    const result = resample(constant(1000, 0.5), 1500);
    expect(result.channels[0][10]).toBeCloseTo(0.5, 5);
    expect(result.channels[0].at(-1)).toBeCloseTo(0.5, 5);
  });

  it('does nothing when the rate already matches', () => {
    const original = ramp(100);
    expect(resample(original, RATE)).toBe(original);
  });

  it('handles an empty clip', () => {
    expect(frameCount(resample({ sampleRate: RATE, channels: [new Float32Array(0)] }, 2000))).toBe(0);
  });

  it('makes a clip shorter when sped up and keeps the sample rate', () => {
    const result = changeSpeed(ramp(1000), 2);
    expect(result.sampleRate).toBe(RATE);
    expect(frameCount(result)).toBe(500);
  });

  it('makes a clip longer when slowed down', () => {
    expect(frameCount(changeSpeed(ramp(1000), 0.5))).toBe(2000);
  });

  it('ignores a speed of one or an impossible speed', () => {
    const original = ramp(100);
    expect(changeSpeed(original, 1)).toBe(original);
    expect(changeSpeed(original, 0)).toBe(original);
    expect(changeSpeed(original, -2)).toBe(original);
  });
});

describe('join', () => {
  it('lays clips end to end', () => {
    const result = join([constant(100, 0.5), constant(200, -0.5)]);
    expect(frameCount(result)).toBe(300);
    expect(result.channels[0][50]).toBeCloseTo(0.5);
    expect(result.channels[0][250]).toBeCloseTo(-0.5);
  });

  it('overlaps by the crossfade length', () => {
    const result = join([constant(100, 1), constant(100, 1)], 0.05);
    expect(frameCount(result)).toBe(150);
  });

  it('holds the level steady through an equal power crossfade', () => {
    const result = join([constant(1000, 1), constant(1000, 1)], 0.2);
    // Halfway through the join both sides contribute sin and cos of the same
    // angle, so the sum stays close to one rather than dipping.
    expect(result.channels[0][900]).toBeGreaterThan(0.98);
    expect(result.channels[0][900]).toBeLessThan(1.02);
  });

  it('brings everything up to the highest sample rate', () => {
    const slow: Samples = { sampleRate: 8000, channels: [new Float32Array(8000).fill(0.5)] };
    const fast: Samples = { sampleRate: 48000, channels: [new Float32Array(48000).fill(0.5)] };
    const result = join([slow, fast]);
    expect(result.sampleRate).toBe(48000);
    // One second each, so two seconds at the higher rate.
    expect(frameCount(result)).toBeCloseTo(96000, -2);
  });

  it('widens a mono clip to match a stereo one', () => {
    const result = join([constant(100, 0.5, 1), constant(100, 0.5, 2)]);
    expect(result.channels).toHaveLength(2);
    expect(result.channels[1][50]).toBeCloseTo(0.5);
  });

  it('skips empty clips', () => {
    const result = join([constant(0, 0), constant(100, 1), constant(0, 0)]);
    expect(frameCount(result)).toBe(100);
  });

  it('returns an empty clip when there is nothing to join', () => {
    expect(frameCount(join([]))).toBe(0);
    expect(frameCount(join([constant(0, 0)]))).toBe(0);
  });

  it('returns a single clip unchanged', () => {
    const only = constant(100, 1);
    expect(join([only])).toBe(only);
  });
});

describe('silence detection', () => {
  function withSilence(): Samples {
    const data = new Float32Array(1000);
    for (let index = 300; index < 700; index += 1) data[index] = 0.8;
    return { sampleRate: RATE, channels: [data] };
  }

  it('finds where the sound starts and stops', () => {
    const bounds = findBounds(withSilence(), -50, 0);
    expect(bounds.start).toBeCloseTo(0.3, 3);
    expect(bounds.end).toBeCloseTo(0.7, 3);
  });

  it('leaves the padding it was asked for', () => {
    const bounds = findBounds(withSilence(), -50, 0.05);
    expect(bounds.start).toBeCloseTo(0.25, 3);
    expect(bounds.end).toBeCloseTo(0.75, 3);
  });

  it('never pads past the ends of the clip', () => {
    const bounds = findBounds(constant(100, 1), -50, 10);
    expect(bounds.start).toBe(0);
    expect(bounds.end).toBeCloseTo(0.1, 3);
  });

  it('reports nothing for a clip that is silent throughout', () => {
    expect(findBounds(constant(1000, 0))).toEqual({ start: 0, end: 0 });
    expect(frameCount(trimSilence(constant(1000, 0)))).toBe(0);
  });

  it('trims to the detected bounds', () => {
    expect(frameCount(trimSilence(withSilence(), -50, 0))).toBe(400);
  });

  it('respects the threshold, so quiet noise below it is still cut', () => {
    const data = new Float32Array(1000).fill(0.0005);
    for (let index = 400; index < 600; index += 1) data[index] = 0.5;
    const bounds = findBounds({ sampleRate: RATE, channels: [data] }, -50, 0);
    expect(bounds.start).toBeCloseTo(0.4, 3);
  });

  it('handles an empty clip', () => {
    expect(findBounds({ sampleRate: RATE, channels: [new Float32Array(0)] })).toEqual({ start: 0, end: 0 });
  });
});

describe('waveformPeaks', () => {
  it('returns one min and max per column', () => {
    const peaks = waveformPeaks(ramp(1000), 100);
    expect(peaks.min).toHaveLength(100);
    expect(peaks.max).toHaveLength(100);
  });

  it('tracks a rising signal', () => {
    const peaks = waveformPeaks(ramp(1000), 10);
    expect(peaks.max[0]).toBeLessThan(peaks.max[9]);
  });

  it('spans both directions of a symmetric signal', () => {
    const wave = Float32Array.from({ length: 1000 }, (_, index) => Math.sin(index / 5));
    const peaks = waveformPeaks({ sampleRate: RATE, channels: [wave] }, 20);
    expect(peaks.min[5]).toBeLessThan(-0.9);
    expect(peaks.max[5]).toBeGreaterThan(0.9);
  });

  it('returns flat zeroes for an empty clip', () => {
    const peaks = waveformPeaks({ sampleRate: RATE, channels: [new Float32Array(0)] }, 10);
    expect(Array.from(peaks.max)).toEqual(new Array(10).fill(0));
  });

  it('handles more columns than there are frames', () => {
    const peaks = waveformPeaks(constant(5, 1), 50);
    expect(peaks.max).toHaveLength(50);
    expect(peaks.max.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('never returns fewer than one column', () => {
    expect(waveformPeaks(ramp(100), 0).max).toHaveLength(1);
  });
});

describe('silence generator', () => {
  it('makes the requested length of nothing', () => {
    const quiet = silence(1000, 2, 2);
    expect(frameCount(quiet)).toBe(2000);
    expect(quiet.channels).toHaveLength(2);
    expect(peak(quiet)).toBe(0);
  });
});

describe('formatTime', () => {
  it('reads as minutes, seconds, and hundredths', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(9.5)).toBe('0:09.50');
    expect(formatTime(75.25)).toBe('1:15.25');
    expect(formatTime(3600)).toBe('60:00.00');
  });

  it('shows zero rather than nonsense for bad input', () => {
    expect(formatTime(-4)).toBe('0:00.00');
    expect(formatTime(NaN)).toBe('0:00.00');
  });
});
