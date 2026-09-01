/**
 * Turning the talking into words, on this machine.
 *
 * This is the one part of the app that fetches anything. Speech recognition
 * needs a model, a model cannot be written out by hand, and the alternative is
 * sending somebody's recording to a server, which is the thing this whole site
 * exists not to do. So the model comes down once, from a public CDN, and runs
 * here.
 *
 * The rules it lives by:
 *
 * - Nothing is fetched until somebody presses the button. Opening the page,
 *   recording, editing and exporting never touch the network.
 * - The audio never leaves the browser. Only the model travels, and it travels
 *   towards you.
 * - Everything downstream works without it. A transcript can still be imported
 *   or typed, so a blocked CDN or an offline machine costs a convenience rather
 *   than a capability.
 */

/** Pinned, so a CDN publishing a new major cannot change what runs here. */
const LIBRARY = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

export type WhisperSize = 'tiny' | 'base' | 'small';

export const WHISPER_MODELS: {
  id: WhisperSize; model: string; label: string; note: string;
  /** Roughly what comes down, used as a floor for the progress figure. */
  bytes: number;
}[] = [
  { id: 'tiny', model: 'onnx-community/whisper-tiny.en', label: 'Quick', note: 'about 40 MB, roughly real time', bytes: 42_000_000 },
  { id: 'base', model: 'onnx-community/whisper-base.en', label: 'Better', note: 'about 80 MB, slower and more accurate', bytes: 82_000_000 },
  { id: 'small', model: 'onnx-community/whisper-small.en', label: 'Best', note: 'about 250 MB, considerably slower', bytes: 250_000_000 },
];

export type TranscribeProgress = {
  stage: 'library' | 'model' | 'listening';
  /** 0 to 1 where it is known, or null while a step reports nothing useful. */
  ratio: number | null;
  detail?: string;
};

export type TranscribedCue = { start: number; end: number; text: string };

/** Whisper is trained at sixteen kilohertz and expects mono. */
export const WHISPER_RATE = 16000;

export function canTranscribe(): boolean {
  return typeof WebAssembly !== 'undefined' && typeof fetch === 'function';
}

/**
 * The share of the download that is done, across every file at once.
 *
 * Separated out because it is the part with a right answer, and the part that
 * was wrong twice. Progress arrives per file, so reporting it as given makes
 * the bar reach 100% for a tokenizer and then fall to 21% for an encoder.
 * Accumulating bytes fixes the sawtooth but not the fall, because the large
 * files have not been announced when the small ones finish. The model's known
 * size is the floor, so the figure starts small and only climbs.
 */
export function overallRatio(
  files: Iterable<{ loaded: number; total: number }>, floorBytes: number,
): number | null {
  let loaded = 0;
  let total = 0;
  for (const file of files) {
    loaded += file.loaded;
    total += file.total;
  }
  const denominator = Math.max(total, floorBytes);
  if (denominator <= 0) return null;
  return Math.min(1, loaded / denominator);
}

type Pipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<{
  text?: string;
  chunks?: { text?: string; timestamp?: [number | null, number | null] }[];
}>;

/**
 * Loaded once per page, and kept.
 *
 * Building the pipeline is the expensive part after the download: the weights
 * have to be read and the runtime started. Somebody transcribing a second
 * recording should not pay for that again.
 */
let cached: { key: string; pipeline: Pipeline } | null = null;
let loading: Promise<Pipeline> | null = null;

async function loadPipeline(
  size: WhisperSize, onProgress: (progress: TranscribeProgress) => void,
): Promise<Pipeline> {
  const entry = WHISPER_MODELS.find((option) => option.id === size) ?? WHISPER_MODELS[0];
  if (cached?.key === entry.model) return cached.pipeline;
  // A second press while the first is still loading joins it rather than
  // starting a parallel download of the same eighty megabytes.
  if (loading) return loading;

  loading = (async () => {
    onProgress({ stage: 'library', ratio: null });
    // Vite would try to resolve and bundle this at build time; it is meant to
    // be fetched at runtime and only when asked for.
    const transformers = await import(/* @vite-ignore */ `${LIBRARY}/dist/transformers.js`) as {
      pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Pipeline>;
      env: { allowLocalModels: boolean; backends: { onnx: { wasm: { wasmPaths: string } } } };
    };

    // No local model directory exists on this origin, and asking for one first
    // produces a 404 for every file before it falls back to the hub.
    transformers.env.allowLocalModels = false;
    transformers.env.backends.onnx.wasm.wasmPaths = `${LIBRARY}/dist/`;

    onProgress({ stage: 'model', ratio: 0, detail: entry.note });

    // Progress is reported per file, and a model is half a dozen of them. Shown
    // as given, the bar reaches 100% for the tokenizer, drops to 21% for the
    // encoder, and reads as broken. Bytes are accumulated across every file
    // instead.
    //
    // Accumulating alone is not enough: the first file to finish is a small one
    // and the big ones have not been announced yet, so the figure still hit
    // 100% and then fell by 90 points. The model's known size is used as a
    // floor for the denominator, so early progress reads small and honest and
    // the figure only climbs.
    const files = new Map<string, { loaded: number; total: number }>();
    const pipeline = await transformers.pipeline('automatic-speech-recognition', entry.model, {
      dtype: 'q8',
      progress_callback: (report: {
        status?: string; progress?: number; file?: string; loaded?: number; total?: number;
      }) => {
        if (report.status !== 'progress' || !report.file) return;
        if (typeof report.loaded === 'number' && typeof report.total === 'number' && report.total > 0) {
          files.set(report.file, { loaded: report.loaded, total: report.total });
        }

        let total = 0;
        for (const bytes of files.values()) total += bytes.total;
        onProgress({
          stage: 'model',
          ratio: overallRatio(files.values(), entry.bytes),
          detail: `${Math.round(Math.max(total, entry.bytes) / 1e6)} MB in total`,
        });
      },
    });

    cached = { key: entry.model, pipeline };
    return pipeline;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * Mixes to mono and resamples to what Whisper expects.
 *
 * Linear interpolation rather than anything cleverer: the model was trained on
 * ordinary speech at this rate and the difference a better resampler would make
 * is far smaller than the difference the microphone made.
 */
export function forWhisper(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const source = buffer.getChannelData(0);
  const mixed = channels === 1 ? source : (() => {
    const out = new Float32Array(buffer.length);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let at = 0; at < buffer.length; at += 1) out[at] += data[at] / channels;
    }
    return out;
  })();

  if (buffer.sampleRate === WHISPER_RATE) return mixed;
  const ratio = buffer.sampleRate / WHISPER_RATE;
  const length = Math.floor(mixed.length / ratio);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(mixed.length - 1, left + 1);
    const mix = position - left;
    out[index] = mixed[left] * (1 - mix) + mixed[right] * mix;
  }
  return out;
}

/**
 * Turns what Whisper returns into cues.
 *
 * The chunks carry timestamps, but the last one often has no end: the model
 * stops rather than closing the final segment. That becomes the audio's own
 * length, and anything still malformed is dropped rather than producing a
 * subtitle that shows forever.
 */
export function cuesFrom(
  chunks: { text?: string; timestamp?: [number | null, number | null] }[] | undefined,
  duration: number,
): TranscribedCue[] {
  if (!Array.isArray(chunks)) return [];
  const out: TranscribedCue[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const text = (chunk.text ?? '').trim();
    if (!text) continue;
    const start = chunk.timestamp?.[0];
    if (typeof start !== 'number' || !Number.isFinite(start)) continue;

    // A missing end is normal and gets filled in. An end that is present but
    // before the start is corrupt, and must be rejected rather than filled in:
    // treating the two the same turned a backwards timestamp into a subtitle
    // that ran to the end of the recording.
    const stated = chunk.timestamp?.[1];
    const given = typeof stated === 'number' && Number.isFinite(stated);
    if (given && stated <= start) continue;

    const next = chunks[index + 1]?.timestamp?.[0];
    const end = given
      ? stated
      : typeof next === 'number' && next > start ? next : duration;
    if (!(end > start)) continue;
    out.push({ start, end: Math.min(end, duration), text });
  }
  return out;
}

/**
 * Transcribes audio that has already been decoded.
 *
 * Long recordings are handled in thirty second windows with an overlap, which
 * is what Whisper was built for: it cannot attend to more than that at once,
 * and the overlap is what stops a word being cut in half at a boundary.
 */
export async function transcribe(
  buffer: AudioBuffer,
  size: WhisperSize,
  onProgress: (progress: TranscribeProgress) => void,
): Promise<TranscribedCue[]> {
  const pipeline = await loadPipeline(size, onProgress);
  const audio = forWhisper(buffer);

  onProgress({ stage: 'listening', ratio: null });
  const result = await pipeline(audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const cues = cuesFrom(result.chunks, buffer.duration);
  // A model that produced words but no usable timings is still worth something,
  // so the whole thing becomes one cue rather than nothing at all.
  if (cues.length === 0 && result.text?.trim()) {
    return [{ start: 0, end: buffer.duration, text: result.text.trim() }];
  }
  return cues;
}

/** Forgets the loaded model, for freeing memory when it will not be used again. */
export function releaseModel(): void {
  cached = null;
}
