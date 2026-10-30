import { toAudioBuffer, fromAudioBuffer } from './audio';
import type { Samples } from './wav';

export type Effects = {
  enabled: boolean;
  highPassHz: number;
  lowPassHz: number;
  bassDb: number;
  midDb: number;
  trebleDb: number;
  compressorThresholdDb: number;
  compressorRatio: number;
  attackMs: number;
  releaseMs: number;
  gateThresholdDb: number;
  limiter: boolean;
  outputGainDb: number;
};

export const defaultEffects: Effects = {
  enabled: false, highPassHz: 0, lowPassHz: 0, bassDb: 0, midDb: 0, trebleDb: 0,
  compressorThresholdDb: 0, compressorRatio: 1, attackMs: 10, releaseMs: 150,
  gateThresholdDb: -90, limiter: false, outputGainDb: 0,
};

export const voiceEffects: Effects = {
  ...defaultEffects, enabled: true, highPassHz: 80, lowPassHz: 12000,
  bassDb: -2, midDb: 2, trebleDb: 1, compressorThresholdDb: -20,
  compressorRatio: 3, gateThresholdDb: -50, limiter: true,
};

export function reviveEffects(value: unknown): Effects {
  if (!value || typeof value !== 'object') return { ...defaultEffects };
  const data = value as Partial<Effects>;
  const number = (key: keyof Effects, min: number, max: number) => {
    const value = data[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaultEffects[key] as number;
  };
  return {
    enabled: data.enabled === true,
    highPassHz: number('highPassHz', 0, 2000),
    lowPassHz: number('lowPassHz', 0, 20000),
    bassDb: number('bassDb', -18, 18), midDb: number('midDb', -18, 18), trebleDb: number('trebleDb', -18, 18),
    compressorThresholdDb: number('compressorThresholdDb', -60, 0),
    compressorRatio: number('compressorRatio', 1, 20),
    attackMs: number('attackMs', 1, 100), releaseMs: number('releaseMs', 10, 1000),
    gateThresholdDb: number('gateThresholdDb', -90, 0), limiter: data.limiter === true,
    outputGainDb: number('outputGainDb', -24, 24),
  };
}

/** Gate with a 5 ms opening and 30 ms closing envelope to avoid hard clicks. */
export function gateSamples(samples: Samples, thresholdDb: number): Samples {
  if (thresholdDb <= -90) return samples;
  const threshold = 10 ** (thresholdDb / 20);
  const openStep = 1 / Math.max(1, Math.round(samples.sampleRate * 0.005));
  const closeStep = 1 / Math.max(1, Math.round(samples.sampleRate * 0.03));
  const channels = samples.channels.map(() => new Float32Array(samples.channels[0]?.length ?? 0));
  let envelope = 0;
  for (let index = 0; index < (samples.channels[0]?.length ?? 0); index += 1) {
    const loud = samples.channels.some((channel) => Math.abs(channel[index]) >= threshold);
    envelope = loud ? Math.min(1, envelope + openStep) : Math.max(0, envelope - closeStep);
    channels.forEach((channel, channelIndex) => { channel[index] = samples.channels[channelIndex][index] * envelope; });
  }
  return { sampleRate: samples.sampleRate, channels };
}

/** Processed output is generated on demand; stored recording bytes are untouched. */
export async function processEffects(samples: Samples, raw: Effects): Promise<Samples> {
  const effects = reviveEffects(raw);
  if (!effects.enabled || !samples.channels[0]?.length) return samples;
  if (typeof OfflineAudioContext === 'undefined') throw new Error('Audio effects are unavailable in this browser.');
  const gated = gateSamples(samples, effects.gateThresholdDb);
  const context = new OfflineAudioContext(gated.channels.length, gated.channels[0].length, gated.sampleRate);
  const source = context.createBufferSource();
  source.buffer = toAudioBuffer(gated, context);
  let previous: AudioNode = source;
  const filter = (type: BiquadFilterType, frequency: number, gain = 0) => {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.gain.value = gain;
    previous.connect(node); previous = node;
  };
  if (effects.highPassHz > 0) filter('highpass', effects.highPassHz);
  if (effects.lowPassHz > 0) filter('lowpass', effects.lowPassHz);
  if (effects.bassDb) filter('lowshelf', 180, effects.bassDb);
  if (effects.midDb) filter('peaking', 2200, effects.midDb);
  if (effects.trebleDb) filter('highshelf', 6000, effects.trebleDb);
  if (effects.compressorRatio > 1) {
    const node = context.createDynamicsCompressor();
    node.threshold.value = effects.compressorThresholdDb;
    node.ratio.value = effects.compressorRatio;
    node.attack.value = effects.attackMs / 1000;
    node.release.value = effects.releaseMs / 1000;
    previous.connect(node); previous = node;
  }
  if (effects.limiter) {
    const node = context.createDynamicsCompressor();
    node.threshold.value = -1;
    node.ratio.value = 20;
    node.attack.value = 0.001;
    node.release.value = 0.08;
    previous.connect(node); previous = node;
  }
  const output = context.createGain();
  output.gain.value = 10 ** (effects.outputGainDb / 20);
  previous.connect(output).connect(context.destination);
  source.start();
  const rendered = fromAudioBuffer(await context.startRendering());
  if (!effects.limiter) return rendered;
  let highest = 0;
  for (const channel of rendered.channels) for (const sample of channel) highest = Math.max(highest, Math.abs(sample));
  if (highest <= 0.99) return rendered;
  const factor = 0.99 / highest;
  return { ...rendered, channels: rendered.channels.map((channel) => channel.map((sample) => sample * factor)) };
}
