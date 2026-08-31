import type { WebmSample, WebmTrack } from './webm';

/**
 * Turning recorded audio into an Opus track a muxer will accept.
 *
 * WebCodecs will encode Opus but wants AudioData in planar float, twenty
 * milliseconds at a time, and the browser's decoder hands back an AudioBuffer
 * at whatever rate it feels like. This is the bit in between, shared by every
 * app that has to put sound in a file.
 */

export class AudioTrackError extends Error {}

/** Opus is defined at 48 kHz, and anything else is resampled on the way in anyway. */
export const OPUS_RATE = 48000;

/** Opus works in twenty millisecond frames. */
const FRAME_SIZE = OPUS_RATE / 50;

export type AudioTrackOptions = {
  /** Seconds into the source to start. */
  start?: number;
  /** Seconds into the source to stop. Defaults to the end. */
  end?: number;
  /** Track number in the container. */
  track?: number;
  bitrate?: number;
  /** Forced channel count. Otherwise the source's, capped at two. */
  channels?: 1 | 2;
  /**
   * The pieces to keep, in source seconds, when the middle has been cut.
   *
   * Given, these are encoded end to end as one continuous track, so the sound
   * matches a video that skips the same stretches. Omitted, the single
   * start-to-end window is used, which is what every caller did before cuts
   * existed.
   */
  spans?: { start: number; end: number }[];
};

export type EncodedAudio = { samples: WebmSample[]; track: WebmTrack; duration: number };

export function canEncodeAudio(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
}

/**
 * Decodes whatever the browser can read, trims it, and re-encodes it as Opus.
 *
 * Returns null rather than throwing when there is simply no audio, because a
 * silent screen recording is an ordinary thing and not a failure.
 */
export async function encodeOpus(
  source: Blob | ArrayBuffer | Uint8Array,
  options: AudioTrackOptions = {},
): Promise<EncodedAudio | null> {
  if (!canEncodeAudio()) return null;

  const buffer = await decodeAudio(source);
  if (!buffer) return null;

  const channels = Math.min(2, options.channels ?? buffer.numberOfChannels) as 1 | 2;
  const start = Math.max(0, options.start ?? 0);
  const end = Math.min(buffer.duration, options.end ?? buffer.duration);
  if (end <= start) return null;

  const spans = (options.spans ?? []).filter((span) => span.end > span.start);
  const planes = spans.length > 0
    ? joinSpans(buffer, spans, channels)
    : resampleTo48k(buffer, start, end, channels);
  const frames = planes[0].length;
  if (frames === 0) return null;

  const samples: WebmSample[] = [];
  let failure: Error | null = null;
  let description: Uint8Array | undefined;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      // The first output carries the decoder configuration, and inside it the
      // OpusHead. A Matroska file without that as CodecPrivate will not play:
      // the channel count, the sample rate and the pre-skip all live there, so
      // a player has nothing to initialise the decoder with.
      const config: unknown = metadata?.decoderConfig?.description;
      if (config && !description) {
        // The description arrives as either a buffer or a view over one.
        description = config instanceof ArrayBuffer
          ? new Uint8Array(config)
          : ArrayBuffer.isView(config)
            ? new Uint8Array(config.buffer as ArrayBuffer, config.byteOffset, config.byteLength)
            : undefined;
      }

      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({
        track: options.track ?? 2,
        timestamp: chunk.timestamp,
        data,
        // Every Opus packet stands on its own, so all of them are keyframes.
        keyframe: true,
      });
    },
    error: (error) => { failure = error; },
  });

  try {
    encoder.configure({
      codec: 'opus',
      sampleRate: OPUS_RATE,
      numberOfChannels: channels,
      bitrate: options.bitrate ?? 128_000,
    });
  } catch {
    return null;
  }

  for (let offset = 0; offset < frames; offset += FRAME_SIZE) {
    if (failure) break;
    const length = Math.min(FRAME_SIZE, frames - offset);

    // AudioData in planar form wants the channels one after another, not
    // interleaved, however natural interleaving would feel.
    const flat = new Float32Array(length * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      flat.set(planes[channel].subarray(offset, offset + length), channel * length);
    }

    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_RATE,
      numberOfFrames: length,
      numberOfChannels: channels,
      timestamp: Math.round((offset / OPUS_RATE) * 1_000_000),
      data: flat,
    });
    encoder.encode(data);
    data.close();
  }

  await encoder.flush();
  encoder.close();
  if (failure || samples.length === 0) return null;

  return {
    samples,
    duration: frames / OPUS_RATE,
    track: {
      kind: 'audio',
      codec: 'A_OPUS',
      sampleRate: OPUS_RATE,
      channels,
      codecPrivate: description ?? opusHead(channels),
    },
  };
}

/** Reads any format the browser can, and reports nothing when there is no audio. */
async function decodeAudio(source: Blob | ArrayBuffer | Uint8Array): Promise<AudioBuffer | null> {
  const bytes = source instanceof Blob
    ? await source.arrayBuffer()
    : source instanceof Uint8Array
      // decodeAudioData detaches what it is given, so it gets a copy.
      ? source.slice().buffer
      : source.slice(0);

  try {
    const context = new OfflineAudioContext(1, 1, OPUS_RATE);
    return await context.decodeAudioData(bytes as ArrayBuffer);
  } catch {
    return null;
  }
}

/**
 * Linear interpolation to 48 kHz, taking only the window asked for.
 *
 * A windowed sinc would be better on paper. On speech and screen-recording
 * audio the difference is inaudible, and this avoids pulling in a resampler
 * for something that runs once per export.
 */
/**
 * Resamples several windows and lays them end to end.
 *
 * Each span is resampled on its own rather than the whole buffer being
 * resampled and then sliced, so the joins land on whole output samples. Slicing
 * afterwards would put a cut mid-sample and click.
 */
export function joinSpans(
  buffer: AudioBuffer, spans: { start: number; end: number }[], channels: number,
): Float32Array[] {
  const pieces = spans.map((span) => resampleTo48k(buffer, span.start, span.end, channels));
  const total = pieces.reduce((sum, piece) => sum + piece[0].length, 0);

  const planes: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const target = new Float32Array(total);
    let at = 0;
    for (const piece of pieces) {
      target.set(piece[channel], at);
      at += piece[channel].length;
    }
    planes.push(target);
  }
  return planes;
}

export function resampleTo48k(
  buffer: AudioBuffer, start: number, end: number, channels: number,
): Float32Array[] {
  const startFrame = Math.floor(start * buffer.sampleRate);
  const endFrame = Math.min(buffer.length, Math.ceil(end * buffer.sampleRate));
  const sourceLength = Math.max(0, endFrame - startFrame);
  const targetLength = Math.round((sourceLength / buffer.sampleRate) * OPUS_RATE);

  const planes: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    const target = new Float32Array(targetLength);

    if (buffer.sampleRate === OPUS_RATE) {
      // Nothing to do but copy the window.
      target.set(source.subarray(startFrame, startFrame + targetLength));
    } else {
      for (let index = 0; index < targetLength; index += 1) {
        const position = startFrame + (index * buffer.sampleRate) / OPUS_RATE;
        const left = Math.floor(position);
        const right = Math.min(endFrame - 1, left + 1);
        const mix = position - left;
        target[index] = (source[left] ?? 0) * (1 - mix) + (source[right] ?? 0) * mix;
      }
    }
    planes.push(target);
  }
  return planes;
}

/**
 * Shifts every timestamp so a track starts at zero.
 *
 * Video frames are re-timed from the trim point during rendering, but audio is
 * encoded from a window of the original. Without this the two would be offset
 * by however far into the recording the trim began, which is exactly the drift
 * that makes a video feel broken.
 */
export function alignToZero(samples: WebmSample[]): WebmSample[] {
  if (samples.length === 0) return samples;
  const first = Math.min(...samples.map((sample) => sample.timestamp));
  if (first === 0) return samples;
  return samples.map((sample) => ({ ...sample, timestamp: sample.timestamp - first }));
}

/**
 * A minimal OpusHead, for the rare browser that encodes Opus without handing
 * back a decoder description. Nineteen bytes: the magic, version 1, the
 * channel count, a zero pre-skip, the input rate, no gain, and mapping family
 * zero, which covers mono and stereo.
 */
export function opusHead(channels: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1;
  head[9] = channels;
  const view = new DataView(head.buffer);
  view.setUint16(10, 0, true);
  view.setUint32(12, OPUS_RATE, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}
