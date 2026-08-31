/**
 * Making the voice listenable, and putting something under it.
 *
 * A screen recording is usually somebody talking into whatever microphone they
 * had, in a room with a fridge in it. Three things fix most of that, and none
 * of them needs a model or a library: level it so quiet passages come up, roll
 * off the rumble below speech, and pull down the gaps so the room is not as
 * loud as the words.
 *
 * Music is the same arithmetic in reverse. A bed under narration has to get out
 * of the way when somebody speaks, and the loudness track that already drives
 * silence detection is exactly the envelope that says when.
 */

export type VoiceSettings = {
  /** Bring the whole thing to a target level. */
  normalise: boolean;
  /** Roll off everything below this, in hertz. 0 is off. */
  highPass: number;
  /** Pull down anything quieter than this fraction of the peak. 0 is off. */
  gate: number;
};

export const defaultVoice: VoiceSettings = { normalise: false, highPass: 0, gate: 0 };

/** How loud the result should be, as a peak. Short of 1 to leave headroom. */
const TARGET_PEAK = 0.89;

/** One pole of high pass, six decibels per octave. */
function onePole(samples: Float32Array, alpha: number): Float32Array {
  const out = new Float32Array(samples.length);
  let previousIn = samples[0] ?? 0;
  let previousOut = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];
    previousOut = alpha * (previousOut + current - previousIn);
    previousIn = current;
    out[index] = previousOut;
  }
  return out;
}

/**
 * A two pole high pass, twelve decibels per octave.
 *
 * One pole was not enough. Desk rumble and air conditioning sit two octaves
 * below speech, and at six decibels per octave enough of it survives that
 * levelling afterwards simply amplifies it again: measured on a deliberately
 * rumble-heavy signal, the quiet passages came back almost as loud as the
 * words. Two poles is still gentle enough near the cutoff not to hollow out a
 * voice, and takes four times as much off an octave down.
 */
export function highPass(samples: Float32Array, rate: number, cutoff: number): Float32Array {
  if (cutoff <= 0 || samples.length === 0) return samples;
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / rate;
  const alpha = rc / (rc + dt);
  return onePole(onePole(samples, alpha), alpha);
}

/**
 * Scales everything so the loudest moment sits just under full.
 *
 * Peak rather than perceived loudness: a proper loudness measure needs
 * weighting curves and a gating standard, and for one person talking the peak
 * is close enough and cannot surprise anybody by clipping.
 */
export function normalise(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const value of samples) {
    const size = Math.abs(value);
    if (size > peak) peak = size;
  }
  // Silence has no peak to scale to, and dividing by it would produce infinity.
  if (peak <= 1e-5) return samples;

  const gain = TARGET_PEAK / peak;
  if (Math.abs(gain - 1) < 0.01) return samples;
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) out[index] = samples[index] * gain;
  return out;
}

/**
 * Pulls down anything below the threshold.
 *
 * Smoothed rather than switched, because a gate that snaps produces a chirp at
 * every word boundary that is worse than the room tone it removed. The window
 * is a few milliseconds either side, which is short enough to follow speech and
 * long enough not to chatter.
 */
export function gate(samples: Float32Array, rate: number, threshold: number): Float32Array {
  if (threshold <= 0 || samples.length === 0) return samples;

  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak <= 1e-5) return samples;

  const limit = peak * threshold;
  const window = Math.max(1, Math.round(rate * 0.01));
  const attack = Math.exp(-1 / (rate * 0.005));
  const release = Math.exp(-1 / (rate * 0.08));

  // Running mean of the absolute value, as a cheap envelope.
  const out = new Float32Array(samples.length);
  let sum = 0;
  let envelope = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += Math.abs(samples[index]);
    if (index >= window) sum -= Math.abs(samples[index - window]);
    const level = sum / Math.min(index + 1, window);
    const wanted = level >= limit ? 1 : 0;
    const rate2 = wanted > envelope ? attack : release;
    envelope = wanted + (envelope - wanted) * rate2;
    out[index] = samples[index] * envelope;
  }
  return out;
}

/** Applies whatever cleanup was asked for, in the order that makes sense. */
export function cleanVoice(
  samples: Float32Array, rate: number, settings: VoiceSettings,
): Float32Array {
  // Rumble first, because normalising before it would scale to a peak that is
  // about to be removed and leave the result quieter than asked for.
  let out = settings.highPass > 0 ? highPass(samples, rate, settings.highPass) : samples;
  if (settings.gate > 0) out = gate(out, rate, settings.gate);
  if (settings.normalise) out = normalise(out);
  return out;
}

export type MusicSettings = {
  /** How loud the bed sits under everything, 0 to 1. */
  level: number;
  /** How far it drops when somebody speaks, 0 to 1. */
  duck: number;
};

export const defaultMusic: MusicSettings = { level: 0.18, duck: 0.75 };

/**
 * The gain the music should have at each moment.
 *
 * Built from the voice's own loudness, with the drop leading slightly and
 * recovering slowly. A bed that ducks the instant somebody speaks and returns
 * the instant they stop draws attention to itself; one that leans out of the
 * way and drifts back does not.
 */
export function duckingEnvelope(
  loudness: Float32Array, columns: number, settings: MusicSettings,
): Float32Array {
  const out = new Float32Array(Math.max(1, columns));
  if (loudness.length === 0) { out.fill(settings.level); return out; }

  let peak = 0;
  for (const value of loudness) peak = Math.max(peak, value);
  const speaking = peak * 0.08;

  const quiet = settings.level * (1 - Math.max(0, Math.min(1, settings.duck)));
  // Asymmetric: down quickly, back slowly.
  const down = 0.35;
  const up = 0.03;

  let gain = settings.level;
  for (let index = 0; index < out.length; index += 1) {
    const at = Math.min(loudness.length - 1, Math.floor((index / out.length) * loudness.length));
    const wanted = loudness[at] > speaking ? quiet : settings.level;
    gain += (wanted - gain) * (wanted < gain ? down : up);
    out[index] = gain;
  }
  return out;
}

/**
 * Mixes a bed under the voice.
 *
 * The music is looped or truncated to the length of the voice, since nobody
 * chooses a track that happens to match their recording, and the result is
 * clamped because two signals added together can exceed what a sample can hold.
 */
export function mixUnder(
  voice: Float32Array, music: Float32Array, envelope: Float32Array,
): Float32Array {
  if (music.length === 0) return voice;
  const out = new Float32Array(voice.length);
  for (let index = 0; index < voice.length; index += 1) {
    const gain = envelope.length
      ? envelope[Math.min(envelope.length - 1, Math.floor((index / voice.length) * envelope.length))]
      : 0;
    const bed = music[index % music.length] * gain;
    const sum = voice[index] + bed;
    out[index] = sum > 1 ? 1 : sum < -1 ? -1 : sum;
  }
  return out;
}
