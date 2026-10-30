/** Capture preferences are requests. The track's settings report what the browser applied. */
export type RecordingPreset = 'voice' | 'podcast' | 'music' | 'raw' | 'custom';
export type RecordingSettings = {
  preset: RecordingPreset;
  source: 'microphone' | 'system';
  deviceId: string;
  sampleRate: 44100 | 48000 | 96000;
  channels: 1 | 2;
  gainDb: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  countdown: 0 | 3 | 5 | 10;
  silenceStop: boolean;
  silenceThresholdDb: number;
  silenceDurationSeconds: number;
};

export const presetSettings: Record<Exclude<RecordingPreset, 'custom'>, Pick<RecordingSettings, 'sampleRate' | 'channels' | 'gainDb' | 'noiseSuppression' | 'echoCancellation' | 'autoGainControl'>> = {
  voice: { sampleRate: 48000, channels: 1, gainDb: 0, noiseSuppression: true, echoCancellation: false, autoGainControl: false },
  podcast: { sampleRate: 48000, channels: 1, gainDb: 0, noiseSuppression: true, echoCancellation: true, autoGainControl: false },
  music: { sampleRate: 48000, channels: 2, gainDb: 0, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
  raw: { sampleRate: 48000, channels: 1, gainDb: 0, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
};

export const defaultRecordingSettings: RecordingSettings = {
  preset: 'raw', source: 'microphone', deviceId: '', countdown: 0, silenceStop: false, silenceThresholdDb: -45, silenceDurationSeconds: 5, ...presetSettings.raw,
};

export function reviveRecordingSettings(value: unknown): RecordingSettings {
  if (!value || typeof value !== 'object') return { ...defaultRecordingSettings };
  const data = value as Partial<RecordingSettings>;
  const rates = [44100, 48000, 96000];
  const counts = [0, 3, 5, 10];
  return {
    preset: ['voice', 'podcast', 'music', 'raw', 'custom'].includes(data.preset ?? '') ? data.preset! : 'custom',
    source: data.source === 'system' ? 'system' : 'microphone',
    deviceId: typeof data.deviceId === 'string' ? data.deviceId : '',
    sampleRate: rates.includes(data.sampleRate ?? 0) ? data.sampleRate! : 48000,
    channels: data.channels === 2 ? 2 : 1,
    gainDb: typeof data.gainDb === 'number' && Number.isFinite(data.gainDb) ? Math.max(-24, Math.min(24, data.gainDb)) : 0,
    noiseSuppression: data.noiseSuppression === true,
    echoCancellation: data.echoCancellation === true,
    autoGainControl: data.autoGainControl === true,
    countdown: counts.includes(data.countdown ?? -1) ? data.countdown! : 0,
    silenceStop: data.silenceStop === true,
    silenceThresholdDb: typeof data.silenceThresholdDb === 'number' && Number.isFinite(data.silenceThresholdDb) ? Math.max(-80, Math.min(-10, data.silenceThresholdDb)) : -45,
    silenceDurationSeconds: typeof data.silenceDurationSeconds === 'number' && Number.isFinite(data.silenceDurationSeconds) ? Math.max(2, Math.min(30, data.silenceDurationSeconds)) : 5,
  };
}

export function captureConstraints(settings: RecordingSettings, supported: MediaTrackSupportedConstraints = {}): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {};
  if (settings.deviceId) audio.deviceId = { ideal: settings.deviceId };
  if (supported.sampleRate) audio.sampleRate = { ideal: settings.sampleRate };
  if (supported.channelCount) audio.channelCount = { ideal: settings.channels };
  if (supported.noiseSuppression) audio.noiseSuppression = settings.noiseSuppression;
  if (supported.echoCancellation) audio.echoCancellation = settings.echoCancellation;
  if (supported.autoGainControl) audio.autoGainControl = settings.autoGainControl;
  return { audio };
}

export type Level = { rms: number; peak: number; db: number; clipping: boolean };
export function measureLevel(samples: Float32Array, gain = 1): Level {
  if (!samples.length) return { rms: 0, peak: 0, db: -Infinity, clipping: false };
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    const value = Math.abs(sample * gain);
    sum += value * value;
    if (value > peak) peak = value;
  }
  const rms = Math.sqrt(sum / samples.length);
  return { rms, peak, db: rms > 0 ? 20 * Math.log10(rms) : -Infinity, clipping: peak >= 0.98 };
}

/** Stop only after speech has occurred and silence has lasted long enough. */
export class SilenceStopDetector {
  private heardSpeech = false;
  private quietSince: number | null = null;

  reset(): void { this.heardSpeech = false; this.quietSince = null; }

  update(db: number, nowMs: number, thresholdDb: number, durationSeconds: number): { quietSeconds: number; shouldStop: boolean } {
    if (db > thresholdDb + 3) {
      this.heardSpeech = true;
      this.quietSince = null;
    } else if (this.heardSpeech && db < thresholdDb && this.quietSince === null) {
      this.quietSince = nowMs;
    }
    const quietSeconds = this.quietSince === null ? 0 : Math.max(0, (nowMs - this.quietSince) / 1000);
    return { quietSeconds, shouldStop: this.heardSpeech && quietSeconds >= durationSeconds };
  }
}

export function appliedSettings(track: MediaStreamTrack): string {
  const applied = track.getSettings?.() ?? {};
  const parts = [track.label || 'Audio input'];
  if (applied.sampleRate) parts.push(`${applied.sampleRate.toLocaleString()} Hz`);
  if (applied.channelCount) parts.push(`${applied.channelCount} channel${applied.channelCount === 1 ? '' : 's'}`);
  for (const [key, label] of [
    ['noiseSuppression', 'Noise suppression'],
    ['echoCancellation', 'Echo cancellation'],
    ['autoGainControl', 'Automatic gain control'],
  ] as const) {
    if (typeof applied[key] === 'boolean') parts.push(`${label}: ${applied[key] ? 'on' : 'off'}`);
  }
  return parts.join(' · ');
}
