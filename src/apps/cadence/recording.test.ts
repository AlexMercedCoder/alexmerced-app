import { describe, expect, it } from 'vitest';
import { appliedSettings, captureConstraints, defaultRecordingSettings, measureLevel, reviveRecordingSettings, SilenceStopDetector } from './recording';

describe('recording settings', () => {
  it('clamps invalid stored values and preserves independent processing toggles', () => {
    const value = reviveRecordingSettings({ gainDb: 100, sampleRate: 123, channels: 2, noiseSuppression: true, echoCancellation: false });
    expect(value.gainDb).toBe(24);
    expect(value.sampleRate).toBe(48000);
    expect(value.channels).toBe(2);
    expect(value.noiseSuppression).toBe(true);
    expect(value.echoCancellation).toBe(false);
  });

  it('requests only supported constraints and uses a soft device preference', () => {
    const settings = { ...defaultRecordingSettings, deviceId: 'mic-2', sampleRate: 96000 as const, channels: 2 as const };
    expect(captureConstraints(settings, { sampleRate: true, channelCount: true, echoCancellation: true })).toEqual({
      audio: { deviceId: { ideal: 'mic-2' }, sampleRate: { ideal: 96000 }, channelCount: { ideal: 2 }, echoCancellation: false },
    });
  });

  it('displays applied track settings rather than requested ones', () => {
    const track = { label: 'USB Microphone', getSettings: () => ({ sampleRate: 44100, channelCount: 1, echoCancellation: true }) } as unknown as MediaStreamTrack;
    expect(appliedSettings(track)).toContain('44,100 Hz');
    expect(appliedSettings(track)).toContain('Echo cancellation: on');
  });
});

describe('input levels', () => {
  it('reports silence, decibels and clipping after software gain', () => {
    expect(measureLevel(new Float32Array(4)).db).toBe(-Infinity);
    expect(measureLevel(Float32Array.from([0.5, -0.5])).db).toBeCloseTo(-6.02, 1);
    expect(measureLevel(Float32Array.from([0.5, -0.5]), 2).clipping).toBe(true);
  });
});

describe('silence stop', () => {
  it('waits for speech, requires sustained silence, and resets after new speech', () => {
    const detector = new SilenceStopDetector();
    expect(detector.update(-80, 0, -45, 5).shouldStop).toBe(false);
    detector.update(-20, 1000, -45, 5);
    expect(detector.update(-60, 2000, -45, 5).shouldStop).toBe(false);
    detector.update(-20, 5000, -45, 5);
    expect(detector.update(-60, 6000, -45, 5).shouldStop).toBe(false);
    expect(detector.update(-60, 11000, -45, 5).shouldStop).toBe(true);
  });
});
