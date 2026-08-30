import { encodeGif, type GifFrame } from '../../lib/gif';
import { muxWebm, type WebmSample, type WebmTrack } from '../../lib/webm';
import { zipBlob } from '../../lib/zip';
import { evenly, FORMATS, gifDelay, type Job, type SourceInfo } from './model';

/**
 * The part that actually moves pixels.
 *
 * Frames come out of a video element by seeking and drawing, rather than by
 * demuxing the container. That is slower than reading the compressed stream,
 * but it works with every format the browser can play rather than only the ones
 * a hand-written demuxer would understand, and it is exact: a seek lands on a
 * frame, and the frame drawn is the frame at that time.
 */

export class PipelineError extends Error {}

export type Progress = { stage: string; done: number; total: number };

export type Cancelled = { cancelled: true };

export type ExportResult = { blob: Blob; filename: string; frames: number };

/** Loads a file into a video element and reports what is in it. */
export async function inspect(file: File): Promise<{ video: HTMLVideoElement; url: string; info: SourceInfo }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new PipelineError(`${file.name} is not a video this browser can play.`));
    });

    // A stream with no declared duration reports Infinity until it is seeked.
    if (!Number.isFinite(video.duration)) {
      await seekTo(video, 1e6).catch(() => {});
      await seekTo(video, 0).catch(() => {});
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0 || video.videoWidth === 0) {
      throw new PipelineError(`${file.name} has no video track this browser can read.`);
    }

    return {
      video,
      url,
      info: {
        name: file.name,
        duration,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: await hasAudioTrack(file),
        bytes: file.size,
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * There is no reliable way to ask a video element whether it has audio, so the
 * file is handed to the audio decoder and the answer is whether that worked.
 */
async function hasAudioTrack(file: File): Promise<boolean> {
  try {
    const context = new OfflineAudioContext(1, 1, 48000);
    // Only the first few megabytes are needed to find out.
    const slice = await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer();
    await context.decodeAudioData(slice);
    return true;
  } catch {
    return false;
  }
}

export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new PipelineError('The video would not seek to that point.')); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', failed);
      window.clearTimeout(timer);
    };
    // A seek past the end, or into a damaged region, can simply never fire.
    const timer = window.setTimeout(failed, 8000);
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.currentTime = time;
  });
}

/** Whether a codec can actually be encoded here, asked of the browser itself. */
export async function codecSupported(format: Job['format'], width: number, height: number): Promise<boolean> {
  const entry = FORMATS.find((candidate) => candidate.id === format);
  if (!entry?.codec) return true;
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: entry.codec,
      width: evenly(width),
      height: evenly(height),
      bitrate: 1_000_000,
      framerate: 30,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

type RunOptions = {
  video: HTMLVideoElement;
  file: File;
  job: Job;
  onProgress: (progress: Progress) => void;
  signal: AbortSignal;
};

/** Draws one frame of the video onto a canvas at the output size. */
function drawFrame(video: HTMLVideoElement, canvas: OffscreenCanvas, context: OffscreenCanvasRenderingContext2D): void {
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new PipelineError('Cancelled.');
}

/**
 * Walks the requested range, one output frame at a time, handing each to a
 * callback. Seeking per frame is the slow part, but it is also the only way to
 * be sure every frame is the one that belongs at that timestamp.
 */
async function eachFrame(
  options: RunOptions,
  onFrame: (canvas: OffscreenCanvas, index: number, timestampUs: number) => Promise<void> | void,
): Promise<number> {
  const { video, job, onProgress, signal } = options;
  const canvas = new OffscreenCanvas(job.width, job.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new PipelineError('This browser would not give a drawing surface.');

  const step = 1 / job.frameRate;
  const total = Math.max(1, Math.round(((job.end - job.start) / job.speed) * job.frameRate));

  for (let index = 0; index < total; index += 1) {
    checkCancelled(signal);
    // Output frame n shows source time start + n * step * speed.
    const sourceTime = Math.min(job.end - 1e-4, job.start + index * step * job.speed);
    await seekTo(video, sourceTime);
    drawFrame(video, canvas, context);
    await onFrame(canvas, index, Math.round((index * step) * 1_000_000));
    if (index % 4 === 0 || index === total - 1) {
      onProgress({ stage: 'Reading frames', done: index + 1, total });
    }
  }
  return total;
}

// --------------------------------------------------------------------- WebM

async function encodeVideoTrack(options: RunOptions): Promise<{ samples: WebmSample[]; track: WebmTrack; frames: number }> {
  const entry = FORMATS.find((candidate) => candidate.id === options.job.format);
  if (!entry?.codec) throw new PipelineError('That format has no video codec.');
  if (typeof VideoEncoder === 'undefined') {
    throw new PipelineError('This browser does not offer WebCodecs, so it cannot re-encode video.');
  }

  const samples: WebmSample[] = [];
  let failure: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ track: 1, timestamp: chunk.timestamp, data, keyframe: chunk.type === 'key' });
    },
    error: (error) => { failure = error; },
  });

  encoder.configure({
    codec: entry.codec,
    width: options.job.width,
    height: options.job.height,
    bitrate: options.job.bitrate,
    framerate: options.job.frameRate,
    latencyMode: 'quality',
  });

  const durationUs = Math.round(1_000_000 / options.job.frameRate);
  // A keyframe every two seconds, which is what makes the result seekable.
  const keyframeEvery = Math.max(1, Math.round(options.job.frameRate * 2));

  const frames = await eachFrame(options, async (canvas, index, timestamp) => {
    if (failure) throw failure;
    const frame = new VideoFrame(canvas, { timestamp, duration: durationUs });
    try {
      encoder.encode(frame, { keyFrame: index % keyframeEvery === 0 });
    } finally {
      frame.close();
    }
    // Letting the queue run away uses memory without going any faster.
    if (encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  });

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  return {
    samples,
    frames,
    track: {
      kind: 'video',
      codec: entry.codec.startsWith('vp09') ? 'V_VP9' : entry.codec.startsWith('av01') ? 'V_AV1' : 'V_VP8',
      width: options.job.width,
      height: options.job.height,
      frameDuration: Math.round(1_000_000_000 / options.job.frameRate),
    },
  };
}

/** Decodes the source audio, trims it, and re-encodes it as Opus. */
async function encodeAudioTrack(
  options: RunOptions, trackNumber: number,
): Promise<{ samples: WebmSample[]; track: WebmTrack } | null> {
  if (typeof AudioEncoder === 'undefined') return null;

  let buffer: AudioBuffer;
  try {
    const bytes = await options.file.arrayBuffer();
    const context = new OfflineAudioContext(2, 48000, 48000);
    buffer = await context.decodeAudioData(bytes);
  } catch {
    return null;
  }

  const rate = 48000;
  const channels = Math.min(2, buffer.numberOfChannels);
  const startFrame = Math.floor(options.job.start * buffer.sampleRate);
  const endFrame = Math.min(buffer.length, Math.ceil(options.job.end * buffer.sampleRate));
  if (endFrame <= startFrame) return null;

  // Resample by linear interpolation, which is inaudible on speech and music
  // alike at these rates and avoids pulling in a resampler.
  const sourceLength = endFrame - startFrame;
  const targetLength = Math.round((sourceLength / buffer.sampleRate) * rate);
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    const target = new Float32Array(targetLength);
    for (let index = 0; index < targetLength; index += 1) {
      const position = startFrame + (index * buffer.sampleRate) / rate;
      const left = Math.floor(position);
      const right = Math.min(endFrame - 1, left + 1);
      const mix = position - left;
      target[index] = source[left] * (1 - mix) + source[right] * mix;
    }
    planes.push(target);
  }

  const samples: WebmSample[] = [];
  let failure: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ track: trackNumber, timestamp: chunk.timestamp, data, keyframe: true });
    },
    error: (error) => { failure = error; },
  });

  try {
    encoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate: 96_000 });
  } catch {
    return null;
  }

  // Opus works in twenty millisecond frames.
  const chunkFrames = rate / 50;
  for (let offset = 0; offset < targetLength; offset += chunkFrames) {
    checkCancelled(options.signal);
    if (failure) break;
    const length = Math.min(chunkFrames, targetLength - offset);
    // AudioData wants the channels one after another, not interleaved.
    const flat = new Float32Array(length * channels);
    for (let channel = 0; channel < channels; channel += 1) {
      flat.set(planes[channel].subarray(offset, offset + length), channel * length);
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: rate,
      numberOfFrames: length,
      numberOfChannels: channels,
      timestamp: Math.round((offset / rate) * 1_000_000),
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
    track: { kind: 'audio', codec: 'A_OPUS', sampleRate: rate, channels },
  };
}

// --------------------------------------------------------------------- entry point

export async function run(options: RunOptions): Promise<ExportResult> {
  const { job } = options;

  if (job.format === 'gif') return runGif(options);
  if (job.format === 'frames') return runFrames(options);

  options.onProgress({ stage: 'Starting the encoder', done: 0, total: 1 });
  const video = await encodeVideoTrack(options);

  const tracks: WebmTrack[] = [video.track];
  const samples: WebmSample[] = [...video.samples];

  // Speed changes drop the audio rather than shifting its pitch, which the
  // model warns about before the job starts.
  if (job.keepAudio && job.speed === 1) {
    options.onProgress({ stage: 'Encoding audio', done: 0, total: 1 });
    const audio = await encodeAudioTrack(options, 2);
    if (audio) {
      tracks.push(audio.track);
      samples.push(...audio.samples);
    }
  }

  options.onProgress({ stage: 'Writing the file', done: 1, total: 1 });
  const file = muxWebm({ tracks, writingApp: 'Cutaway on alexmerced.app' }, samples);

  return {
    blob: new Blob([file as unknown as BlobPart], { type: 'video/webm' }),
    filename: 'clip.webm',
    frames: video.frames,
  };
}

async function runGif(options: RunOptions): Promise<ExportResult> {
  const frames: GifFrame[] = [];
  const delay = gifDelay(options.job.frameRate);

  const count = await eachFrame(options, (canvas) => {
    const context = canvas.getContext('2d');
    if (!context) throw new PipelineError('This browser would not give a drawing surface.');
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    frames.push({ pixels: image.data, delay });
  });

  options.onProgress({ stage: 'Building the GIF', done: 0, total: frames.length });
  const bytes = encodeGif(frames, {
    width: options.job.width,
    height: options.job.height,
    colours: options.job.gifColours,
    dither: options.job.gifDither,
  });

  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: 'image/gif' }),
    filename: 'clip.gif',
    frames: count,
  };
}

async function runFrames(options: RunOptions): Promise<ExportResult> {
  const entries: { name: string; bytes: Uint8Array }[] = [];

  const count = await eachFrame(options, async (canvas, index) => {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    entries.push({
      name: `frame-${String(index + 1).padStart(5, '0')}.png`,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  });

  options.onProgress({ stage: 'Building the archive', done: entries.length, total: entries.length });
  return { blob: zipBlob(entries), filename: 'frames.zip', frames: count };
}
