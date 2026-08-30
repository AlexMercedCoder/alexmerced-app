import { encodeGif, type GifFrame } from '../../lib/gif';
import {
  errorResult, fileResult, readBoolean, readEnum, readNumber, requireString, textResult,
  type McpTool,
} from '../../lib/webmcp';
import { clampJob, concerns, defaultJob, estimateBytes, evenly, fitWithin, formatDuration, FORMATS, frameCount, gifDelay, outputDuration, type Job, type OutputFormat, type SourceInfo } from './model';
import { codecSupported, inspect, PipelineError, run, type Progress } from './pipeline';

/**
 * Cutaway's tools. Video is the heaviest thing here, so these say what a job
 * will cost before running it, and the conversion itself reports honestly that
 * it takes real time.
 */
export function cutawayTools(): McpTool[] {
  return [
    {
      name: 'cutaway_describe_video',
      description:
        'Read a video and report its length, size, and whether it has audio, along with which output formats this browser can actually encode. Call it before converting, because AV1 in particular is not available everywhere.',
      inputSchema: {
        type: 'object',
        properties: { video: { type: 'string', description: 'A data: URI, blob: URL, or http URL.' } },
        required: ['video'],
      },
      execute: async (input) => {
        const loaded = await open(requireString(input, 'video'));
        try {
          const support: Record<string, boolean> = {};
          for (const format of FORMATS) {
            support[format.id] = await codecSupported(format.id, loaded.info.width, loaded.info.height);
          }
          return textResult({
            duration: Number(loaded.info.duration.toFixed(2)),
            readable: formatDuration(loaded.info.duration),
            width: loaded.info.width,
            height: loaded.info.height,
            bytes: loaded.info.bytes,
            hasAudio: loaded.info.hasAudio,
            canEncode: support,
            formats: FORMATS.map((format) => ({ id: format.id, label: format.label, note: format.note })),
          });
        } finally {
          loaded.dispose();
        }
      },
    },
    {
      name: 'cutaway_plan_conversion',
      description:
        'Say what a conversion would produce before running it: the length, the frame count, a rough file size, and any warnings worth heeding. Video jobs are slow, so this is worth calling first on anything long.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string' },
          format: { type: 'string', enum: FORMATS.map((format) => format.id) },
          start: { type: 'number' },
          end: { type: 'number' },
          width: { type: 'number' },
          frameRate: { type: 'number' },
          speed: { type: 'number' },
        },
        required: ['video'],
      },
      execute: async (input) => {
        const loaded = await open(requireString(input, 'video'));
        try {
          const job = jobFrom(input, loaded.info);
          return textResult({
            format: job.format,
            outputDuration: Number(outputDuration(job).toFixed(2)),
            frames: frameCount(job),
            size: `${job.width} by ${job.height}`,
            roughBytes: estimateBytes(job),
            warnings: concerns(job, loaded.info),
            note: 'Every frame is read by seeking to it, so expect roughly a second per frame on a busy machine.',
          });
        } finally {
          loaded.dispose();
        }
      },
    },
    {
      name: 'cutaway_convert_video',
      description:
        'Trim, resize and convert a video, and get the result back as a WebM, an animated GIF, or every frame as a PNG in a ZIP. Frames are read by seeking to each one, so this is exact but slow: keep clips short. Call cutaway_plan_conversion first if you are unsure.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string' },
          format: {
            type: 'string',
            enum: FORMATS.map((format) => format.id),
            description: '"webm-vp9" by default. "gif" for an animated GIF, "frames" for stills in a ZIP.',
          },
          start: { type: 'number', description: 'Seconds. Zero by default.' },
          end: { type: 'number', description: 'Seconds. The end of the video by default.' },
          width: { type: 'number', description: 'Output width. The height follows to keep the shape.' },
          frameRate: { type: 'number', description: '30 by default, or 15 for a GIF.' },
          speed: { type: 'number', description: '2 is twice as fast.' },
          keepAudio: { type: 'boolean' },
          gifColours: { type: 'number', description: '2 to 256. 128 by default.' },
          gifDither: { type: 'boolean' },
        },
        required: ['video'],
      },
      execute: async (input) => {
        const source = requireString(input, 'video');
        const loaded = await open(source);
        try {
          const job = jobFrom(input, loaded.info);

          if (!(await codecSupported(job.format, job.width, job.height))) {
            return errorResult(
              `This browser cannot encode ${FORMATS.find((format) => format.id === job.format)?.label}.`,
              { tryInstead: 'webm-vp8, gif, or frames' },
            );
          }
          if (frameCount(job) > 900) {
            return errorResult(
              `That is ${frameCount(job)} frames, which would take far too long through a tool call. Trim it, lower the frame rate, or use the page itself.`,
              { warnings: concerns(job, loaded.info) },
            );
          }

          const stages: string[] = [];
          const result = await run({
            video: loaded.video,
            file: loaded.file,
            job,
            signal: new AbortController().signal,
            onProgress: (progress: Progress) => {
              if (!stages.includes(progress.stage)) stages.push(progress.stage);
            },
          });

          const bytes = new Uint8Array(await result.blob.arrayBuffer());
          const mime = job.format === 'gif' ? 'image/gif' : job.format === 'frames' ? 'application/zip' : 'video/webm';

          return fileResult(result.filename, bytes, mime, {
            format: job.format,
            frames: result.frames,
            duration: Number(outputDuration(job).toFixed(2)),
            size: `${job.width} by ${job.height}`,
            warnings: concerns(job, loaded.info),
          });
        } finally {
          loaded.dispose();
        }
      },
    },
    {
      name: 'cutaway_extract_frame',
      description:
        'Take a single frame out of a video at a given moment and return it as a PNG. Useful for a thumbnail, or for looking at what is on screen at a particular time.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string' },
          at: { type: 'number', description: 'Seconds from the start.' },
          width: { type: 'number', description: 'Output width. The source width by default.' },
        },
        required: ['video', 'at'],
      },
      execute: async (input) => {
        const loaded = await open(requireString(input, 'video'));
        try {
          const at = Math.max(0, Math.min(loaded.info.duration - 1e-3, readNumber(input, 'at', 0)));
          const width = evenly(readNumber(input, 'width', loaded.info.width));
          const fitted = fitWithin(loaded.info.width, loaded.info.height, width, 1e9);

          await seek(loaded.video, at);
          const canvas = new OffscreenCanvas(fitted.width, fitted.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('This browser would not give a drawing surface.');
          context.drawImage(loaded.video, 0, 0, fitted.width, fitted.height);

          const blob = await canvas.convertToBlob({ type: 'image/png' });
          return fileResult('frame.png', new Uint8Array(await blob.arrayBuffer()), 'image/png', {
            at: Number(at.toFixed(3)),
            width: fitted.width,
            height: fitted.height,
          });
        } finally {
          loaded.dispose();
        }
      },
    },
  ];
}

function jobFrom(input: Record<string, unknown>, info: SourceInfo): Job {
  const job = defaultJob(info);
  const format = readEnum(input, 'format', FORMATS.map((entry) => entry.id) as [OutputFormat, ...OutputFormat[]], 'webm-vp9');
  job.format = format;

  job.start = Math.max(0, readNumber(input, 'start', 0));
  job.end = readNumber(input, 'end', info.duration);
  job.speed = readNumber(input, 'speed', 1);
  job.frameRate = readNumber(input, 'frameRate', format === 'gif' ? 15 : 30);
  job.keepAudio = readBoolean(input, 'keepAudio', info.hasAudio && format !== 'gif' && format !== 'frames');
  job.gifColours = readNumber(input, 'gifColours', 128);
  job.gifDither = readBoolean(input, 'gifDither', true);

  const width = readNumber(input, 'width', job.width);
  const fitted = fitWithin(info.width, info.height, width, 1e9);
  job.width = fitted.width;
  job.height = fitted.height;

  return clampJob(job, info);
}

type Loaded = { video: HTMLVideoElement; file: File; info: SourceInfo; dispose: () => void };

async function open(source: string): Promise<Loaded> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`That video could not be fetched (${response.status}).`);
  const blob = await response.blob();
  const file = new File([blob], 'video', { type: blob.type || 'video/webm' });

  try {
    const loaded = await inspect(file);
    return {
      video: loaded.video,
      file,
      info: loaded.info,
      dispose: () => {
        URL.revokeObjectURL(loaded.url);
        loaded.video.removeAttribute('src');
        loaded.video.load();
      },
    };
  } catch (error) {
    throw new Error(error instanceof PipelineError ? error.message : 'That file could not be read as a video.');
  }
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { window.clearTimeout(timer); resolve(); };
    const timer = window.setTimeout(() => reject(new Error('The video would not seek there.')), 8000);
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = time;
  });
}
