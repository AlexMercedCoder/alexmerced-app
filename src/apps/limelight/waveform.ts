/**
 * The recording's sound, as something you can see and act on.
 *
 * A screen recording is mostly someone talking over a screen, and the editing
 * decisions that matter are about the talking: where a sentence ends, where a
 * stumble happened, where nothing was said for four seconds. None of that is
 * visible in a strip of video frames, so trimming without it is guesswork.
 *
 * Two things come out of the same pass. Peaks, for drawing, and silences, for
 * cutting. They share the decode because decoding is the expensive part.
 */

/** One column of the drawn waveform: the loudest and quietest sample in it. */
export type Peak = { min: number; max: number };

export type Span = { start: number; end: number };

/**
 * Reduces samples to a fixed number of columns.
 *
 * Columns rather than seconds, because the result is drawn once into a bitmap
 * at a chosen width and then stretched. Recomputing on every resize would mean
 * decoding again, and the decode is the slow part.
 */
export function peaksFrom(samples: Float32Array, columns: number): Peak[] {
  const count = Math.max(1, Math.floor(columns));
  if (samples.length === 0) return Array.from({ length: count }, () => ({ min: 0, max: 0 }));

  const per = samples.length / count;
  const peaks: Peak[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = Math.floor(index * per);
    // At least one sample per column, or a recording shorter than the width
    // being drawn produces empty columns in the middle of the picture.
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((index + 1) * per)));
    let min = 1;
    let max = -1;
    for (let at = from; at < to; at += 1) {
      const value = samples[at];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks.push({ min, max });
  }
  return peaks;
}

/**
 * Mixes every channel down to one, which is all a waveform needs.
 *
 * Averaged rather than taking the first channel: a voice panned to one side
 * would otherwise look like silence.
 */
export function monoFrom(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0);

  const mixed = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let at = 0; at < length; at += 1) mixed[at] += data[at];
  }
  for (let at = 0; at < length; at += 1) mixed[at] /= channels;
  return mixed;
}

/** Loudness per column, 0 to 1, which is what silence detection reads. */
export function loudnessFrom(samples: Float32Array, columns: number): Float32Array {
  const count = Math.max(1, Math.floor(columns));
  const out = new Float32Array(count);
  if (samples.length === 0) return out;

  const per = samples.length / count;
  for (let index = 0; index < count; index += 1) {
    const from = Math.floor(index * per);
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((index + 1) * per)));
    // Root mean square rather than peak. A single click in an otherwise quiet
    // stretch should not make the whole stretch count as speech.
    let sum = 0;
    for (let at = from; at < to; at += 1) sum += samples[at] * samples[at];
    out[index] = Math.sqrt(sum / (to - from));
  }
  return out;
}

export type SilenceOptions = {
  /** Below this loudness counts as quiet, relative to the recording's own peak. */
  threshold: number;
  /** Quiet has to last this long before it is worth cutting. */
  minSeconds: number;
  /** Left at each end of a cut so speech does not start abruptly. */
  padSeconds: number;
};

export const defaultSilence: SilenceOptions = {
  threshold: 0.06,
  minSeconds: 0.6,
  padSeconds: 0.12,
};

/**
 * Finds the stretches worth cutting.
 *
 * The threshold is relative to the recording's own loudest moment rather than
 * an absolute level, because one person's microphone gain is not another's, and
 * an absolute figure would find everything or nothing depending on the room.
 *
 * Padding is subtracted from both ends of every span, which is what stops a cut
 * from clipping the breath before a word. A span that padding shrinks below the
 * minimum is dropped rather than kept as a sliver.
 */
export function findSilences(
  loudness: Float32Array, duration: number, options: SilenceOptions = defaultSilence,
): Span[] {
  if (loudness.length === 0 || duration <= 0) return [];

  let loudest = 0;
  for (const value of loudness) if (value > loudest) loudest = value;
  // A recording with no sound at all is not one long silence to be cut; it is a
  // recording with no sound, and cutting all of it would leave nothing.
  if (loudest <= 1e-6) return [];

  const limit = loudest * options.threshold;
  const perColumn = duration / loudness.length;
  const spans: Span[] = [];

  let from: number | null = null;
  for (let index = 0; index <= loudness.length; index += 1) {
    const quiet = index < loudness.length && loudness[index] < limit;
    if (quiet && from === null) from = index;
    if (!quiet && from !== null) {
      const start = from * perColumn + options.padSeconds;
      const end = index * perColumn - options.padSeconds;
      if (end - start >= options.minSeconds) spans.push({ start, end });
      from = null;
    }
  }
  return spans;
}

/**
 * Merges overlapping or touching spans and puts them in order.
 *
 * Cuts come from two places, found silences and hand-made selections, and two
 * cuts that touch are one cut. Leaving them separate would make the arithmetic
 * that maps edited time back to source time count the overlap twice.
 */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans]
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/** What is left after the cuts, in source time. */
export function keptSpans(cuts: Span[], start: number, end: number): Span[] {
  const kept: Span[] = [];
  let cursor = start;
  for (const cut of mergeSpans(cuts)) {
    if (cut.end <= start || cut.start >= end) continue;
    const from = Math.max(start, cut.start);
    const to = Math.min(end, cut.end);
    if (from > cursor) kept.push({ start: cursor, end: from });
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) kept.push({ start: cursor, end });
  return kept;
}

/** How long the finished video runs once the cuts are taken out. */
export function keptDuration(cuts: Span[], start: number, end: number): number {
  return keptSpans(cuts, start, end).reduce((total, span) => total + (span.end - span.start), 0);
}

/**
 * Maps a position in the finished video back to where it is in the recording.
 *
 * Everything downstream of a cut works in edited time: the export walks frame
 * by frame through what is left, and each frame has to know which moment of the
 * source to draw. Anything past the end clamps to the last kept moment rather
 * than running off, so a rounding error at the final frame cannot ask for a
 * time that does not exist.
 */
export function sourceTimeAt(cuts: Span[], start: number, end: number, edited: number): number {
  const kept = keptSpans(cuts, start, end);
  if (kept.length === 0) return start;

  let remaining = Math.max(0, edited);
  for (const span of kept) {
    const length = span.end - span.start;
    if (remaining < length) return span.start + remaining;
    remaining -= length;
  }
  return kept[kept.length - 1].end;
}

/**
 * Decodes the recording's audio and reduces it, off the main thread as far as
 * the platform allows.
 *
 * Returns null when there is no audio, which is the common case for a silent
 * screen capture and not an error. A file the decoder refuses returns null too:
 * a waveform is a convenience, and failing to draw one should never stop
 * somebody editing their video.
 */
export async function analyseAudio(
  blob: Blob, columns = 2000,
): Promise<{ peaks: Peak[]; loudness: Float32Array; duration: number } | null> {
  const Context = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;

  let context: AudioContext | null = null;
  try {
    const bytes = await blob.arrayBuffer();
    context = new Context();
    const buffer = await context.decodeAudioData(bytes);
    if (buffer.numberOfChannels === 0 || buffer.length === 0) return null;
    const mono = monoFrom(buffer);
    return {
      peaks: peaksFrom(mono, columns),
      loudness: loudnessFrom(mono, columns),
      duration: buffer.duration,
    };
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}
