/**
 * What Cutaway knows without touching a video: the shape of a job, and the
 * arithmetic that decides how big the output will be and how long it will take.
 */

export const APP_ID = 'cutaway';
export const APP_VERSION = 1;

export type OutputFormat = 'webm-vp9' | 'webm-vp8' | 'webm-av1' | 'gif' | 'frames';

export const FORMATS: { id: OutputFormat; label: string; note: string; codec: string; container: string }[] = [
  { id: 'webm-vp9', label: 'WebM, VP9', note: 'The best quality for the size. Plays in every current browser.', codec: 'vp09.00.10.08', container: 'webm' },
  { id: 'webm-vp8', label: 'WebM, VP8', note: 'Older and faster to encode, and accepted almost anywhere.', codec: 'vp8', container: 'webm' },
  { id: 'webm-av1', label: 'WebM, AV1', note: 'Smallest files, slowest to encode. Not every browser can make one.', codec: 'av01.0.04M.08', container: 'webm' },
  { id: 'gif', label: 'Animated GIF', note: 'Large files and 256 colours, but it plays anywhere at all.', codec: '', container: 'gif' },
  { id: 'frames', label: 'Still frames', note: 'Every frame as a PNG, in a ZIP.', codec: '', container: 'zip' },
];

export type Job = {
  /** Seconds from the start of the source. */
  start: number;
  end: number;
  width: number;
  height: number;
  frameRate: number;
  format: OutputFormat;
  /** Bits per second for video, ignored by GIF and frames. */
  bitrate: number;
  keepAudio: boolean;
  /** Playback speed. Two makes it twice as fast and half as long. */
  speed: number;
  gifColours: number;
  gifDither: boolean;
};

export type SourceInfo = {
  name: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  bytes: number;
};

export function defaultJob(source: SourceInfo): Job {
  const scale = fitWithin(source.width, source.height, 1280, 1280);
  return {
    start: 0,
    end: source.duration,
    width: scale.width,
    height: scale.height,
    frameRate: 30,
    format: 'webm-vp9',
    bitrate: suggestBitrate(scale.width, scale.height, 30),
    keepAudio: source.hasAudio,
    speed: 1,
    gifColours: 128,
    gifDither: true,
  };
}

/**
 * Scales down to fit a box, never up, and keeps both dimensions even because
 * every video codec here works in two by two blocks and will refuse an odd size.
 */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
  return {
    width: evenly(width * scale),
    height: evenly(height * scale),
  };
}

export function evenly(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * A starting bitrate, from the pixel rate. Not a formula anyone standardised,
 * just a figure that lands in the right neighbourhood for screen content and
 * ordinary footage alike.
 */
export function suggestBitrate(width: number, height: number, frameRate: number): number {
  const pixels = width * height * frameRate;
  const bits = Math.round(pixels * 0.07);
  return Math.max(120_000, Math.min(20_000_000, bits));
}

export function clampJob(job: Job, source: SourceInfo): Job {
  const start = clamp(job.start, 0, Math.max(0, source.duration));
  const end = clamp(job.end, start, Math.max(start, source.duration));
  return {
    ...job,
    start,
    end,
    width: evenly(clamp(job.width, 2, 7680)),
    height: evenly(clamp(job.height, 2, 4320)),
    frameRate: clamp(job.frameRate, 1, 120),
    bitrate: Math.round(clamp(job.bitrate, 50_000, 100_000_000)),
    speed: clamp(job.speed, 0.1, 8),
    gifColours: Math.round(clamp(job.gifColours, 2, 256)),
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return value < low ? low : value > high ? high : value;
}

/** The length of the clip once the trim and the speed are both applied. */
export function outputDuration(job: Job): number {
  return Math.max(0, (job.end - job.start) / Math.max(0.1, job.speed));
}

export function frameCount(job: Job): number {
  return Math.max(1, Math.round(outputDuration(job) * job.frameRate));
}

/**
 * A rough size, so nobody starts a job that would produce a gigabyte without
 * being told. GIF is estimated from pixels rather than bitrate, since it has no
 * rate control at all.
 */
export function estimateBytes(job: Job): number {
  if (job.format === 'gif') {
    // Roughly a byte per pixel per frame before compression, and GIF's LZW
    // typically gets a third of that back on real footage.
    return Math.round(job.width * job.height * frameCount(job) * 0.33);
  }
  if (job.format === 'frames') {
    return Math.round(job.width * job.height * 3 * 0.5 * frameCount(job));
  }
  const video = (job.bitrate / 8) * outputDuration(job);
  const audio = job.keepAudio ? (96_000 / 8) * outputDuration(job) : 0;
  return Math.round(video + audio);
}

/** Warnings worth showing before a job runs, in the order they matter. */
export function concerns(job: Job, source: SourceInfo): string[] {
  const notes: string[] = [];
  const duration = outputDuration(job);

  if (duration <= 0) notes.push('The start and end are the same, so there is nothing to export.');
  if (job.format === 'gif') {
    if (duration > 15) notes.push('A GIF this long will be very large. Under fifteen seconds is usually the limit of what is worth sharing.');
    if (job.width > 800) notes.push('GIFs get big quickly with width. Around 640 pixels is a common ceiling.');
    if (job.frameRate > 25) notes.push('Most GIF players round the delay to hundredths of a second, so anything past about 25 frames a second is wasted.');
  }
  if (job.format === 'frames' && frameCount(job) > 2000) {
    notes.push(`That is ${frameCount(job).toLocaleString('en-US')} separate images. Consider a shorter range or a lower frame rate.`);
  }
  if (job.width > source.width || job.height > source.height) {
    notes.push('The output is larger than the source, which cannot add detail that was never there.');
  }
  if (job.keepAudio && !source.hasAudio) {
    notes.push('This file has no audio track, so there is none to keep.');
  }
  if (job.format !== 'gif' && job.format !== 'frames' && job.speed !== 1 && job.keepAudio) {
    notes.push('Changing speed drops the audio, because moving it in step would change its pitch.');
  }
  return notes;
}

/** GIF delays are in hundredths of a second, and zero means "as fast as possible". */
export function gifDelay(frameRate: number): number {
  return Math.max(2, Math.round(100 / Math.max(1, frameRate)));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const hundredths = Math.floor((seconds - whole) * 100);
  return `${minutes}:${String(rest).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/** A filename safe on every filesystem, keeping the source name recognisable. */
export function outputName(sourceName: string, format: OutputFormat): string {
  const stem = sourceName.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'clip';
  const entry = FORMATS.find((candidate) => candidate.id === format);
  return `${stem}.${entry?.container ?? 'webm'}`;
}
