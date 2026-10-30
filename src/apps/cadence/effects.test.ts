import { describe, expect, it } from 'vitest';
import { defaultEffects, gateSamples, reviveEffects } from './effects';

describe('effects', () => {
  it('defaults to a dry recording and clamps unsafe parameters', () => {
    expect(reviveEffects(null)).toEqual(defaultEffects);
    const value = reviveEffects({ enabled: true, highPassHz: 999999, compressorRatio: -1 });
    expect(value.highPassHz).toBe(2000);
    expect(value.compressorRatio).toBe(1);
  });

  it('gates quiet audio without changing source samples', () => {
    const samples = { sampleRate: 1000, channels: [Float32Array.from([0.001, 0.001, 0.5, 0.5, 0.001])] };
    const processed = gateSamples(samples, -40);
    expect(processed.channels[0][0]).toBe(0);
    expect(processed.channels[0][3]).toBeGreaterThan(0);
    expect(samples.channels[0][0]).toBe(0.0010000000474974513);
  });
});
