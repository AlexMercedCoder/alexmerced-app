import { decodeWav, looksLikeWav, type Samples } from './wav';

/**
 * The bridge between stored bytes and something that can be edited.
 *
 * A WAV is decoded here rather than handed to the browser, because the browser
 * resamples to the AudioContext rate on the way in and that quietly changes the
 * file. Anything else goes through the platform decoder, which is the only way
 * to read MP3, AAC, Opus, or FLAC without shipping a decoder.
 */

let context: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!context || context.state === 'closed') {
    context = new AudioContext();
  }
  return context;
}

export class DecodeError extends Error {}

export async function decode(bytes: Uint8Array, mime = ''): Promise<Samples> {
  if (looksLikeWav(bytes)) {
    return decodeWav(bytes);
  }

  const ctx = audioContext();
  try {
    // decodeAudioData detaches the buffer it is given, so it gets a copy.
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    return fromAudioBuffer(buffer);
  } catch {
    throw new DecodeError(
      mime
        ? `This browser could not decode ${mime}. Try WAV, MP3, or WebM.`
        : 'This browser could not decode that file. Try WAV, MP3, or WebM.',
    );
  }
}

export function fromAudioBuffer(buffer: AudioBuffer): Samples {
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()),
  };
}

export function toAudioBuffer(samples: Samples, ctx: BaseAudioContext): AudioBuffer {
  const frames = Math.max(1, samples.channels[0]?.length ?? 0);
  const buffer = ctx.createBuffer(Math.max(1, samples.channels.length), frames, samples.sampleRate);
  // copyToChannel wants a Float32Array over a plain ArrayBuffer, which a slice
  // of a stored buffer is not guaranteed to be.
  samples.channels.forEach((channel, index) => {
    buffer.copyToChannel(new Float32Array(channel), index, 0);
  });
  return buffer;
}

/** What MediaRecorder will actually produce here, best first. */
export function pickRecordingMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;
}
