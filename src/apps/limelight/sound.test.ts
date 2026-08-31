import { describe, expect, it } from 'vitest';
import {
  cleanVoice, defaultMusic, duckingEnvelope, gate, highPass, mixUnder, normalise,
} from './sound';

const RATE = 48000;

/** A sine at a frequency, for checking what a filter lets through. */
function sine(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Math.sin((2 * Math.PI * hz * index) / RATE) * amplitude;
  }
  return out;
}

const peakOf = (samples: Float32Array) => {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  return peak;
};

describe('normalise', () => {
  it('brings a quiet recording up', () => {
    const quiet = sine(200, 0.2, 0.05);
    expect(peakOf(normalise(quiet))).toBeGreaterThan(0.8);
  });

  it('brings a loud one down, leaving headroom', () => {
    const loud = sine(200, 0.2, 0.99);
    expect(peakOf(normalise(loud))).toBeLessThan(0.95);
  });

  it('leaves silence alone rather than dividing by nothing', () => {
    const silence = new Float32Array(1000);
    const out = normalise(silence);
    expect(out.every((value) => value === 0)).toBe(true);
  });

  it('does not bother for a change too small to hear', () => {
    const already = sine(200, 0.1, 0.89);
    expect(normalise(already)).toBe(already);
  });
});

describe('highPass', () => {
  it('takes out a low rumble', () => {
    // Two poles, so an octave and a half down should lose most of it. Six
    // decibels per octave left enough that levelling afterwards amplified it
    // straight back, which is what this threshold is guarding.
    const rumble = sine(30, 0.4, 0.5);
    expect(peakOf(highPass(rumble, RATE, 90))).toBeLessThan(peakOf(rumble) * 0.2);
  });

  it('leaves speech alone', () => {
    // Voice sits well above the cutoff, so it should come through nearly whole.
    const voice = sine(400, 0.4, 0.5);
    expect(peakOf(highPass(voice, RATE, 90))).toBeGreaterThan(peakOf(voice) * 0.85);
  });

  it('is off at zero', () => {
    const input = sine(30, 0.1);
    expect(highPass(input, RATE, 0)).toBe(input);
  });

  it('survives an empty buffer', () => {
    expect(highPass(new Float32Array(), RATE, 90)).toHaveLength(0);
  });
});

describe('gate', () => {
  it('pulls down a quiet stretch and keeps a loud one', () => {
    const loud = sine(300, 0.5, 0.8);
    const quiet = sine(300, 0.5, 0.01);
    const joined = new Float32Array([...loud, ...quiet]);
    const out = gate(joined, RATE, 0.15);

    const half = loud.length;
    // Measured away from the boundary, where the smoothing is still moving.
    const loudAfter = peakOf(out.subarray(1000, half - 1000));
    const quietAfter = peakOf(out.subarray(half + 8000));
    expect(loudAfter).toBeGreaterThan(0.5);
    expect(quietAfter).toBeLessThan(0.005);
  });

  it('does not chatter at a word boundary', () => {
    // A gate that snaps produces a step; the smoothing should keep successive
    // samples close together.
    const joined = new Float32Array([...sine(300, 0.2, 0.8), ...sine(300, 0.2, 0.005)]);
    const out = gate(joined, RATE, 0.15);
    let biggestJump = 0;
    for (let index = 1; index < out.length; index += 1) {
      biggestJump = Math.max(biggestJump, Math.abs(out[index] - out[index - 1]));
    }
    expect(biggestJump).toBeLessThan(0.2);
  });

  it('is off at zero', () => {
    const input = sine(300, 0.1);
    expect(gate(input, RATE, 0)).toBe(input);
  });

  it('leaves silence alone', () => {
    const silence = new Float32Array(1000);
    expect(gate(silence, RATE, 0.2)).toBe(silence);
  });
});

describe('cleanVoice', () => {
  it('does nothing when nothing is asked for', () => {
    const input = sine(300, 0.1);
    expect(cleanVoice(input, RATE, { normalise: false, highPass: 0, gate: 0 })).toBe(input);
  });

  it('normalises after filtering, not before', () => {
    // A quiet voice riding on a loud rumble: filtering first then normalising
    // should end up loud. Doing it the other way round would scale to the
    // rumble's peak and leave the voice quiet.
    const mixed = new Float32Array(RATE / 2);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = Math.sin((2 * Math.PI * 25 * index) / RATE) * 0.9
        + Math.sin((2 * Math.PI * 400 * index) / RATE) * 0.05;
    }
    const out = cleanVoice(mixed, RATE, { normalise: true, highPass: 120, gate: 0 });
    expect(peakOf(out)).toBeGreaterThan(0.7);
  });
});

describe('duckingEnvelope', () => {
  const loudness = new Float32Array([1, 1, 1, 0, 0, 0, 0, 0, 1, 1]);

  it('sits at the chosen level when nobody is speaking', () => {
    const out = duckingEnvelope(loudness, 100, { level: 0.2, duck: 0.8 });
    // Well into the quiet stretch, having had time to come back up.
    expect(out[70]).toBeGreaterThan(0.15);
  });

  it('drops while somebody is speaking', () => {
    const out = duckingEnvelope(loudness, 100, { level: 0.2, duck: 0.8 });
    expect(out[20]).toBeLessThan(0.1);
  });

  it('comes down faster than it goes back up', () => {
    const out = duckingEnvelope(loudness, 200, defaultMusic);
    const droppedBy = out[0] - out[8];
    const recoveredBy = out[70] - out[62];
    expect(droppedBy).toBeGreaterThan(recoveredBy);
  });

  it('holds the level when there is no voice at all', () => {
    const out = duckingEnvelope(new Float32Array(), 10, { level: 0.3, duck: 0.9 });
    // Float32Array, so exact equality against a double is not available.
    expect([...out].every((value) => Math.abs(value - 0.3) < 1e-6)).toBe(true);
  });
});

describe('mixUnder', () => {
  it('adds the bed at the envelope level', () => {
    const voice = new Float32Array([0, 0, 0, 0]);
    const music = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const out = mixUnder(voice, music, new Float32Array([0.2]));
    expect(out[0]).toBeCloseTo(0.1);
  });

  it('loops music shorter than the recording', () => {
    const voice = new Float32Array(6);
    const music = new Float32Array([1, -1]);
    const out = mixUnder(voice, music, new Float32Array([1]));
    expect([...out]).toEqual([1, -1, 1, -1, 1, -1]);
  });

  it('clamps rather than wrapping round when the sum is too big', () => {
    const voice = new Float32Array([0.9, -0.9]);
    const music = new Float32Array([0.9, -0.9]);
    const out = mixUnder(voice, music, new Float32Array([1]));
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(-1);
  });

  it('gives back the voice untouched when there is no music', () => {
    const voice = new Float32Array([0.4, 0.5]);
    expect(mixUnder(voice, new Float32Array(), new Float32Array([1]))).toBe(voice);
  });
});
