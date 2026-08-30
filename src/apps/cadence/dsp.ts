import { frameCount, type Samples } from './wav';

/**
 * Sample level operations. All of them return new buffers rather than editing in
 * place, so an undo stack is just a list of previous results.
 */

export function mapChannels(samples: Samples, transform: (channel: Float32Array, index: number) => Float32Array): Samples {
  return { sampleRate: samples.sampleRate, channels: samples.channels.map(transform) };
}

export function silence(sampleRate: number, seconds: number, channelCount = 1): Samples {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  return { sampleRate, channels: Array.from({ length: channelCount }, () => new Float32Array(frames)) };
}

/** Keeps the frames between two times, clamped to what actually exists. */
export function trim(samples: Samples, startSeconds: number, endSeconds: number): Samples {
  const total = frameCount(samples);
  const start = Math.max(0, Math.min(total, Math.round(startSeconds * samples.sampleRate)));
  const end = Math.max(start, Math.min(total, Math.round(endSeconds * samples.sampleRate)));
  return mapChannels(samples, (channel) => channel.slice(start, end));
}

/** Removes the frames between two times, joining what is left. */
export function cut(samples: Samples, startSeconds: number, endSeconds: number): Samples {
  const total = frameCount(samples);
  const start = Math.max(0, Math.min(total, Math.round(startSeconds * samples.sampleRate)));
  const end = Math.max(start, Math.min(total, Math.round(endSeconds * samples.sampleRate)));
  return mapChannels(samples, (channel) => {
    const output = new Float32Array(total - (end - start));
    output.set(channel.subarray(0, start), 0);
    output.set(channel.subarray(end), start);
    return output;
  });
}

export function gain(samples: Samples, factor: number): Samples {
  return mapChannels(samples, (channel) => {
    const output = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) output[index] = channel[index] * factor;
    return output;
  });
}

export function decibelsToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDecibels(factor: number): number {
  return factor <= 0 ? -Infinity : 20 * Math.log10(factor);
}

export function peak(samples: Samples): number {
  let highest = 0;
  for (const channel of samples.channels) {
    for (let index = 0; index < channel.length; index += 1) {
      const value = Math.abs(channel[index]);
      if (value > highest) highest = value;
    }
  }
  return highest;
}

/** Root mean square across every channel, which tracks perceived level better than peak. */
export function rms(samples: Samples): number {
  let sum = 0;
  let count = 0;
  for (const channel of samples.channels) {
    for (let index = 0; index < channel.length; index += 1) {
      sum += channel[index] * channel[index];
      count += 1;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/**
 * Brings the loudest sample up to a target, in decibels below full scale.
 * A target of -1 leaves a little headroom, which is what you want before an
 * encoder that can overshoot.
 */
export function normalisePeak(samples: Samples, targetDb = -1): Samples {
  const current = peak(samples);
  if (current === 0) return samples;
  return gain(samples, decibelsToGain(targetDb) / current);
}

/** Matches average level instead of peak level, then guards against clipping. */
export function normaliseRms(samples: Samples, targetDb = -18): Samples {
  const current = rms(samples);
  if (current === 0) return samples;

  let factor = decibelsToGain(targetDb) / current;
  // Raising the average can push the peaks past full scale, so pull back if so.
  const highest = peak(samples) * factor;
  if (highest > 1) factor /= highest;
  return gain(samples, factor);
}

export type FadeShape = 'linear' | 'equalPower' | 'exponential';

export function fadeCurve(position: number, shape: FadeShape): number {
  const t = position < 0 ? 0 : position > 1 ? 1 : position;
  if (shape === 'equalPower') return Math.sin((t * Math.PI) / 2);
  // A squared curve sounds more like a hand on a fader than a straight line does.
  if (shape === 'exponential') return t * t;
  return t;
}

export function fadeIn(samples: Samples, seconds: number, shape: FadeShape = 'equalPower'): Samples {
  const length = Math.min(frameCount(samples), Math.round(seconds * samples.sampleRate));
  if (length <= 0) return samples;
  return mapChannels(samples, (channel) => {
    const output = Float32Array.from(channel);
    for (let index = 0; index < length; index += 1) output[index] *= fadeCurve(index / length, shape);
    return output;
  });
}

export function fadeOut(samples: Samples, seconds: number, shape: FadeShape = 'equalPower'): Samples {
  const total = frameCount(samples);
  const length = Math.min(total, Math.round(seconds * samples.sampleRate));
  if (length <= 0) return samples;
  return mapChannels(samples, (channel) => {
    const output = Float32Array.from(channel);
    for (let index = 0; index < length; index += 1) {
      output[total - 1 - index] *= fadeCurve(index / length, shape);
    }
    return output;
  });
}

export function reverse(samples: Samples): Samples {
  return mapChannels(samples, (channel) => Float32Array.from(channel).reverse());
}

/** Averages every channel down to one. */
export function toMono(samples: Samples): Samples {
  if (samples.channels.length <= 1) return samples;
  const frames = frameCount(samples);
  const output = new Float32Array(frames);
  for (const channel of samples.channels) {
    for (let index = 0; index < frames; index += 1) output[index] += channel[index] / samples.channels.length;
  }
  return { sampleRate: samples.sampleRate, channels: [output] };
}

export function toStereo(samples: Samples): Samples {
  if (samples.channels.length >= 2) return { sampleRate: samples.sampleRate, channels: samples.channels.slice(0, 2) };
  const source = samples.channels[0] ?? new Float32Array(0);
  return { sampleRate: samples.sampleRate, channels: [Float32Array.from(source), Float32Array.from(source)] };
}

/**
 * Linear interpolation resampling. Good enough for changing a file's rate or
 * its speed; a proper windowed sinc would be better but is far slower and the
 * difference is inaudible on speech.
 */
export function resample(samples: Samples, targetRate: number): Samples {
  if (targetRate === samples.sampleRate || samples.sampleRate <= 0) return samples;
  const ratio = targetRate / samples.sampleRate;
  const frames = Math.max(0, Math.round(frameCount(samples) * ratio));

  return {
    sampleRate: targetRate,
    channels: samples.channels.map((channel) => {
      const output = new Float32Array(frames);
      if (channel.length === 0) return output;
      for (let index = 0; index < frames; index += 1) {
        const position = index / ratio;
        const left = Math.floor(position);
        const right = Math.min(channel.length - 1, left + 1);
        const mix = position - left;
        output[index] = channel[left] * (1 - mix) + channel[right] * mix;
      }
      return output;
    }),
  };
}

/**
 * Changes playback speed the simple way, which moves the pitch with it. That is
 * the honest thing to offer without a phase vocoder, and the app says so.
 */
export function changeSpeed(samples: Samples, factor: number): Samples {
  if (factor <= 0 || factor === 1) return samples;
  const stretched = resample(samples, samples.sampleRate / factor);
  return { sampleRate: samples.sampleRate, channels: stretched.channels };
}

/**
 * Joins clips end to end. Everything is brought up to the highest sample rate
 * and the widest channel count present, so a mono voice memo can sit next to a
 * stereo recording without one of them playing at the wrong speed.
 */
export function join(clips: Samples[], crossfadeSeconds = 0): Samples {
  const usable = clips.filter((clip) => frameCount(clip) > 0);
  if (usable.length === 0) return { sampleRate: clips[0]?.sampleRate ?? 48000, channels: [new Float32Array(0)] };
  if (usable.length === 1 && crossfadeSeconds <= 0) return usable[0];

  const sampleRate = Math.max(...usable.map((clip) => clip.sampleRate));
  const channelCount = Math.max(...usable.map((clip) => clip.channels.length));

  const prepared = usable.map((clip) => {
    let aligned = clip.sampleRate === sampleRate ? clip : resample(clip, sampleRate);
    if (aligned.channels.length < channelCount) {
      const source = aligned.channels[0] ?? new Float32Array(0);
      aligned = {
        sampleRate,
        channels: Array.from({ length: channelCount }, (_, index) => Float32Array.from(aligned.channels[index] ?? source)),
      };
    }
    return aligned;
  });

  const overlap = Math.max(0, Math.round(crossfadeSeconds * sampleRate));
  const total = prepared.reduce((sum, clip) => sum + frameCount(clip), 0) - overlap * (prepared.length - 1);

  const channels = Array.from({ length: channelCount }, () => new Float32Array(Math.max(0, total)));
  let cursor = 0;

  prepared.forEach((clip, clipIndex) => {
    const frames = frameCount(clip);
    const blend = clipIndex === 0 ? 0 : Math.min(overlap, frames);

    for (let channel = 0; channel < channelCount; channel += 1) {
      const source = clip.channels[channel];
      const target = channels[channel];
      for (let index = 0; index < frames; index += 1) {
        const at = cursor + index;
        if (at >= target.length) break;
        if (index < blend) {
          // Equal power on both sides keeps the loudness steady through the join.
          const position = index / blend;
          target[at] = target[at] * fadeCurve(1 - position, 'equalPower') + source[index] * fadeCurve(position, 'equalPower');
        } else {
          target[at] = source[index];
        }
      }
    }
    cursor += frames - blend;
  });

  return { sampleRate, channels };
}

/**
 * Finds where the audio actually starts and stops, so leading and trailing
 * silence can be dropped. The threshold is in decibels below full scale.
 */
export function findBounds(samples: Samples, thresholdDb = -50, padSeconds = 0.05): { start: number; end: number } {
  const total = frameCount(samples);
  if (total === 0) return { start: 0, end: 0 };
  const threshold = decibelsToGain(thresholdDb);

  const loudAt = (frame: number) => {
    for (const channel of samples.channels) {
      if (Math.abs(channel[frame]) >= threshold) return true;
    }
    return false;
  };

  let first = 0;
  while (first < total && !loudAt(first)) first += 1;
  if (first === total) return { start: 0, end: 0 };

  let last = total - 1;
  while (last > first && !loudAt(last)) last -= 1;

  const pad = Math.round(padSeconds * samples.sampleRate);
  return {
    start: Math.max(0, first - pad) / samples.sampleRate,
    end: Math.min(total, last + 1 + pad) / samples.sampleRate,
  };
}

export function trimSilence(samples: Samples, thresholdDb = -50, padSeconds = 0.05): Samples {
  const bounds = findBounds(samples, thresholdDb, padSeconds);
  if (bounds.end <= bounds.start) return { sampleRate: samples.sampleRate, channels: samples.channels.map(() => new Float32Array(0)) };
  return trim(samples, bounds.start, bounds.end);
}

/**
 * Reduces the waveform to min and max pairs per pixel column. Drawing every
 * sample would be both slow and wrong, since a column covers thousands of them.
 */
export function waveformPeaks(samples: Samples, columns: number): { min: Float32Array; max: Float32Array } {
  const width = Math.max(1, Math.floor(columns));
  const min = new Float32Array(width).fill(0);
  const max = new Float32Array(width).fill(0);
  const frames = frameCount(samples);
  if (frames === 0) return { min, max };

  const perColumn = frames / width;
  for (let column = 0; column < width; column += 1) {
    const from = Math.floor(column * perColumn);
    const to = Math.min(frames, Math.max(from + 1, Math.floor((column + 1) * perColumn)));
    let low = Infinity;
    let high = -Infinity;
    for (const channel of samples.channels) {
      for (let index = from; index < to; index += 1) {
        const value = channel[index];
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    min[column] = Number.isFinite(low) ? low : 0;
    max[column] = Number.isFinite(high) ? high : 0;
  }
  return { min, max };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const hundredths = Math.floor((seconds - whole) * 100);
  return `${minutes}:${String(rest).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}
