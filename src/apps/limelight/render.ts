import { encodeGif, type GifFrame } from '../../lib/gif';
import { muxMp4, type Mp4Sample, type Mp4Track } from '../../lib/mp4';
import { alignToZero, encodeOpus } from '../../lib/opus';
import { muxWebm, type WebmSample, type WebmTrack } from '../../lib/webm';
import {
  interestFromPointer, mergeInterest, motionCentre, motionGrid, sampleAt, smoothPath,
  type ClickSample, type Interest, type PointerSample,
} from './attention';
import {
  cameraCrop, cameraRect, contentRect, cornerRadius, evenSize, ripple, roundedPath,
  type Composition,
} from './layout';
import { buildZoomTrack, viewRect, zoomAt, type ZoomKeyframe, type ZoomSettings } from './zoom';

/**
 * Turning a raw recording into the finished thing.
 *
 * Every frame is drawn deliberately: seek the source, take the part the camera
 * is looking at, put it on the background, round its corners, drop the shadow,
 * add the camera bubble and any click ripple, then encode. That is slower than
 * capturing a canvas in real time, but it is exact, and it means a two hour
 * recording and a two second one come out with the same fidelity.
 */

export class RenderError extends Error {}

export type Progress = { stage: string; done: number; total: number };

export type Project = {
  video: HTMLVideoElement;
  camera: HTMLVideoElement | null;
  /** The recording itself, which is where the audio still lives. */
  source: Blob | null;
  duration: number;
  sourceWidth: number;
  sourceHeight: number;
  pointer: PointerSample[];
  clicks: ClickSample[];
  composition: Composition;
  zoom: ZoomSettings;
  frameRate: number;
  bitrate: number;
  showClicks: boolean;
  showCursor: boolean;
  /** What to write. */
  format: OutputFormat;
  gifColours: number;
  /**
   * The camera move, when the timeline has one. Passing it in rather than
   * rebuilding it here is what guarantees the export matches the preview,
   * including any zoom that was moved or resized by hand.
   */
  keyframes?: ZoomKeyframe[] | null;
  /** Whether to carry the recorded audio into the export. */
  keepAudio: boolean;
  /** Seconds into the recording that the export begins and ends. */
  start: number;
  end: number;
};

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new RenderError('The recording would not seek to that point.')); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', failed);
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(failed, 8000);
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.currentTime = time;
  });
}

/**
 * Finds the moments worth zooming to.
 *
 * A real pointer track is used when there is one. Otherwise the frames are
 * sampled a few times a second and the places the picture changed are used
 * instead, which works on any recording at all.
 */
export async function findInterest(
  project: Project,
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<{ points: Interest[]; source: 'pointer' | 'motion' | 'none' }> {
  if (project.pointer.length > 0 || project.clicks.length > 0) {
    return {
      points: mergeInterest(interestFromPointer(project.pointer, project.clicks)),
      source: 'pointer',
    };
  }

  // Four samples a second is enough to catch a menu opening and cheap enough
  // to run over a long recording.
  const samplesPerSecond = 4;
  const total = Math.max(1, Math.floor(project.duration * samplesPerSecond));
  const width = 320;
  const height = Math.max(2, Math.round((project.sourceHeight / project.sourceWidth) * 320));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new RenderError('This browser would not give a drawing surface.');

  let previous: Uint8ClampedArray | null = null;
  const found: Interest[] = [];

  for (let index = 0; index < total; index += 1) {
    if (signal.aborted) throw new RenderError('Cancelled.');
    const time = (index / samplesPerSecond);
    await seekTo(project.video, Math.min(project.duration - 1e-3, time));
    context.drawImage(project.video, 0, 0, width, height);
    const current = context.getImageData(0, 0, width, height).data;

    if (previous) {
      const centre = motionCentre(motionGrid(previous, current, width, height));
      if (centre && centre.weight > 0.08) found.push({ ...centre, time });
    }
    previous = current;

    if (index % 8 === 0) onProgress({ stage: 'Looking for the action', done: index + 1, total });
  }

  return { points: mergeInterest(found, 1.2, 0.15), source: found.length ? 'motion' : 'none' };
}

/** Paints one finished frame. Kept separate so the preview and the export agree. */
export function drawFrame(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  project: Project,
  time: number,
  view: ZoomKeyframe,
  cursor: { x: number; y: number } | null,
): void {
  const composition = project.composition;
  const { width, height } = composition;

  // ------------------------------------------------------------- background
  context.save();
  if (composition.background === 'none') {
    context.clearRect(0, 0, width, height);
  } else if (composition.background === 'solid') {
    context.fillStyle = composition.colours[0];
    context.fillRect(0, 0, width, height);
  } else if (composition.background === 'gradient') {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, composition.colours[0]);
    gradient.addColorStop(1, composition.colours[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  } else {
    // A blurred, enlarged copy of the recording itself behind the inset one.
    context.filter = 'blur(48px) brightness(0.7)';
    context.drawImage(project.video, -width * 0.1, -height * 0.1, width * 1.2, height * 1.2);
    context.filter = 'none';
  }
  context.restore();

  // ------------------------------------------------------------- recording
  const content = contentRect(composition, project.sourceWidth, project.sourceHeight);
  const radius = cornerRadius(composition, content);
  const source = viewRect(view, project.sourceWidth, project.sourceHeight);

  if (composition.shadow > 0 && composition.background !== 'none') {
    context.save();
    context.shadowColor = `rgba(0, 0, 0, ${Math.min(1, composition.shadow) * 0.55})`;
    context.shadowBlur = Math.max(8, Math.min(width, height) * 0.045);
    context.shadowOffsetY = Math.max(4, Math.min(width, height) * 0.012);
    context.fillStyle = '#000';
    context.fill(roundedPath(content, radius));
    context.restore();
  }

  context.save();
  context.clip(roundedPath(content, radius));
  context.drawImage(
    project.video,
    source.x, source.y, source.width, source.height,
    content.x, content.y, content.width, content.height,
  );
  context.restore();

  // ------------------------------------------------------------- cursor and clicks
  /** Where a point in the recording lands in the finished frame, or null if outside the view. */
  const project2 = (x: number, y: number): { x: number; y: number } | null => {
    const px = x * project.sourceWidth;
    const py = y * project.sourceHeight;
    if (px < source.x || px > source.x + source.width || py < source.y || py > source.y + source.height) return null;
    return {
      x: content.x + ((px - source.x) / source.width) * content.width,
      y: content.y + ((py - source.y) / source.height) * content.height,
    };
  };

  if (project.showClicks) {
    context.save();
    for (const click of project.clicks) {
      const state = ripple(time - click.time);
      if (!state) continue;
      const at = project2(click.x, click.y);
      if (!at) continue;
      const maximum = Math.min(width, height) * 0.06;
      context.beginPath();
      context.arc(at.x, at.y, Math.max(1, state.radius * maximum), 0, Math.PI * 2);
      context.strokeStyle = `rgba(255, 255, 255, ${state.opacity * 0.9})`;
      context.lineWidth = Math.max(2, maximum * 0.09);
      context.stroke();
    }
    context.restore();
  }

  if (project.showCursor && cursor) {
    const at = project2(cursor.x, cursor.y);
    if (at) drawCursor(context, at.x, at.y, Math.min(width, height) * 0.022);
  }

  // ------------------------------------------------------------- camera
  const bubble = cameraRect(composition);
  if (bubble && project.camera && project.camera.videoWidth > 0) {
    const crop = cameraCrop(project.camera.videoWidth, project.camera.videoHeight);
    context.save();
    if (composition.camera.round) {
      context.beginPath();
      context.arc(bubble.x + bubble.width / 2, bubble.y + bubble.height / 2, bubble.width / 2, 0, Math.PI * 2);
      context.closePath();
      context.clip();
    } else {
      context.clip(roundedPath(bubble, bubble.width * 0.08));
    }
    context.drawImage(
      project.camera,
      crop.x, crop.y, crop.width, crop.height,
      bubble.x, bubble.y, bubble.width, bubble.height,
    );
    context.restore();

    context.save();
    context.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    context.lineWidth = Math.max(2, bubble.width * 0.015);
    if (composition.camera.round) {
      context.beginPath();
      context.arc(bubble.x + bubble.width / 2, bubble.y + bubble.height / 2, bubble.width / 2, 0, Math.PI * 2);
      context.stroke();
    } else {
      context.stroke(roundedPath(bubble, bubble.width * 0.08));
    }
    context.restore();
  }
}

/** The familiar arrow, drawn rather than taken from the frame. */
function drawCursor(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  x: number, y: number, size: number,
): void {
  const path = new Path2D();
  path.moveTo(x, y);
  path.lineTo(x, y + size);
  path.lineTo(x + size * 0.25, y + size * 0.76);
  path.lineTo(x + size * 0.42, y + size * 1.12);
  path.lineTo(x + size * 0.58, y + size * 1.05);
  path.lineTo(x + size * 0.41, y + size * 0.7);
  path.lineTo(x + size * 0.7, y + size * 0.68);
  path.closePath();

  context.save();
  context.shadowColor = 'rgba(0, 0, 0, 0.4)';
  context.shadowBlur = size * 0.3;
  context.fillStyle = '#fff';
  context.fill(path);
  context.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  context.lineWidth = Math.max(1, size * 0.05);
  context.shadowColor = 'transparent';
  context.stroke(path);
  context.restore();
}

export type OutputFormat = 'webm' | 'mp4' | 'gif';

export type ExportResult = { blob: Blob; frames: number; hasAudio: boolean; extension: string; note: string | null };

/**
 * What this browser can actually write.
 *
 * H.264 in particular is not everywhere, and AAC encoding is rarer still, so
 * the answer decides both what to offer and what to warn about.
 */
export async function capabilities(width: number, height: number): Promise<{
  webm: boolean; mp4: boolean; aac: boolean; gif: boolean;
}> {
  const gif = true;
  if (typeof VideoEncoder === 'undefined') return { webm: false, mp4: false, aac: false, gif };

  const supported = async (codec: string) => {
    try {
      return (await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 2_000_000, framerate: 30 })).supported === true;
    } catch {
      return false;
    }
  };

  const aac = typeof AudioEncoder !== 'undefined' && await (async () => {
    try {
      return (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 })).supported === true;
    } catch {
      return false;
    }
  })();

  return {
    webm: await supported('vp09.00.10.08') || await supported('vp8'),
    mp4: (await h264Codec(width, height)) !== null,
    aac,
    gif,
  };
}

/**
 * Picks an H.264 profile and level the browser will accept.
 *
 * The level has to be high enough for the pixel rate, and a browser that
 * refuses one level will often accept a higher one, so this works upwards
 * rather than guessing.
 */
export async function h264Codec(width: number, height: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const pixels = width * height;

  // Main profile, at levels covering 720p, 1080p, 1440p and 4K.
  const levels = pixels > 1920 * 1080 ? ['4d0034', '4d0033', '640034'] : ['4d002a', '4d001f', '42002a', '42001f'];
  for (const level of levels) {
    const codec = `avc1.${level}`;
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate: 2_000_000, framerate: 30, avc: { format: 'avc' },
      });
      if (support.supported) return codec;
    } catch {
      // Try the next.
    }
  }
  return null;
}

/**
 * Renders every frame and writes the file.
 *
 * The compositing is identical whatever comes out: the same canvas, the same
 * zoom, the same background. Only the encoding and the container differ, which
 * is why the format is a branch at the end rather than three separate paths.
 */
export async function render(
  project: Project,
  points: Interest[],
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const size = evenSize(project.composition.width, project.composition.height);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { alpha: project.composition.background === 'none' });
  if (!context) throw new RenderError('This browser would not give a drawing surface.');

  const track = project.keyframes?.length
    ? project.keyframes
    : buildZoomTrack(points, project.duration, project.zoom);
  const smoothed = project.pointer.length ? smoothPath(project.pointer) : [];
  const cursorTrack: PointerSample[] = smoothed.map((point, index) => ({
    time: project.pointer[index].time, x: point.x, y: point.y,
  }));

  const from = Math.max(0, project.start);
  const to = Math.min(project.duration, project.end > project.start ? project.end : project.duration);
  const span = Math.max(1 / project.frameRate, to - from);
  const total = Math.max(1, Math.round(span * project.frameRate));
  const step = 1 / project.frameRate;

  /** Composes one frame onto the canvas. Shared by every format. */
  const compose = async (index: number): Promise<number> => {
    const time = index * step;
    const sourceTime = from + time;
    await seekTo(project.video, Math.min(project.duration - 1e-3, sourceTime));
    if (project.camera) {
      await seekTo(project.camera, Math.min(Math.max(0, project.camera.duration - 1e-3), sourceTime)).catch(() => {});
    }
    // The zoom track and the cursor are both in source time.
    drawFrame(context, project, sourceTime, zoomAt(track, sourceTime), cursorTrack.length ? sampleAt(cursorTrack, sourceTime) : null);
    return time;
  };

  // ------------------------------------------------------------------ GIF
  if (project.format === 'gif') {
    const frames: GifFrame[] = [];
    const delay = Math.max(2, Math.round(100 / project.frameRate));

    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw new RenderError('Cancelled.');
      await compose(index);
      frames.push({ pixels: context.getImageData(0, 0, size.width, size.height).data, delay });
      if (index % 4 === 0 || index === total - 1) onProgress({ stage: 'Rendering', done: index + 1, total });
    }

    onProgress({ stage: 'Building the GIF', done: total, total });
    const bytes = encodeGif(frames, {
      width: size.width,
      height: size.height,
      colours: Math.max(2, Math.min(256, project.gifColours)),
      dither: true,
    });
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: 'image/gif' }),
      frames: total,
      hasAudio: false,
      extension: 'gif',
      note: 'A GIF has no sound and at most 256 colours a frame.',
    };
  }

  // ------------------------------------------------------------------ video
  if (typeof VideoEncoder === 'undefined') {
    throw new RenderError('This browser does not offer WebCodecs, so video cannot be encoded here.');
  }

  const wantsMp4 = project.format === 'mp4';
  const codec = wantsMp4
    ? await h264Codec(size.width, size.height)
    : ((await VideoEncoder.isConfigSupported({
        codec: 'vp09.00.10.08', width: size.width, height: size.height, bitrate: project.bitrate, framerate: project.frameRate,
      })).supported ? 'vp09.00.10.08' : 'vp8');

  if (!codec) {
    throw new RenderError('This browser cannot encode H.264 at that size, so MP4 is not available. WebM will work.');
  }

  const chunks: { data: Uint8Array; timestamp: number; duration: number; keyframe: boolean }[] = [];
  let description: Uint8Array | undefined;
  let failure: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      // MP4 needs the avcC record, which only arrives with the first chunk.
      const config: unknown = metadata?.decoderConfig?.description;
      if (config && !description) {
        description = config instanceof ArrayBuffer
          ? new Uint8Array(config)
          : ArrayBuffer.isView(config)
            ? new Uint8Array(config.buffer as ArrayBuffer, config.byteOffset, config.byteLength)
            : undefined;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? Math.round(1_000_000 / project.frameRate),
        keyframe: chunk.type === 'key',
      });
    },
    error: (error) => { failure = error; },
  });

  encoder.configure({
    codec,
    width: size.width,
    height: size.height,
    bitrate: project.bitrate,
    framerate: project.frameRate,
    latencyMode: 'quality',
    // Asking for the avc format is what makes the encoder hand back an avcC
    // record. The alternative, annex B, carries its parameters inline and
    // cannot be put in an MP4 without being rewritten.
    ...(wantsMp4 ? { avc: { format: 'avc' as const } } : {}),
  });

  const durationUs = Math.round(1_000_000 / project.frameRate);
  const keyframeEvery = Math.max(1, Math.round(project.frameRate * 2));

  for (let index = 0; index < total; index += 1) {
    if (signal.aborted) { encoder.close(); throw new RenderError('Cancelled.'); }
    if (failure) { encoder.close(); throw failure; }

    const time = await compose(index);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(time * 1_000_000), duration: durationUs });
    try {
      encoder.encode(frame, { keyFrame: index % keyframeEvery === 0 });
    } finally {
      frame.close();
    }

    if (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 8));
    if (index % 4 === 0 || index === total - 1) onProgress({ stage: 'Rendering', done: index + 1, total });
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  // ------------------------------------------------------------------ sound
  let audio: Awaited<ReturnType<typeof encodeOpus>> = null;
  let note: string | null = null;

  if (project.keepAudio && project.source) {
    onProgress({ stage: 'Encoding the sound', done: 0, total: 1 });
    audio = await encodeOpus(project.source, { start: from, end: to, track: 2 });
    if (!audio) note = 'No sound was found in the recording, so this is silent.';
  }

  onProgress({ stage: 'Writing the file', done: total, total });

  if (wantsMp4) {
    if (!description) throw new RenderError('The encoder gave no configuration record, so an MP4 cannot be written.');

    const tracks: Mp4Track[] = [{
      kind: 'video', description, width: size.width, height: size.height, frameRate: project.frameRate,
    }];
    const samples: Mp4Sample[] = chunks.map((chunk) => ({
      track: 1, timestamp: chunk.timestamp, duration: chunk.duration, data: chunk.data, keyframe: chunk.keyframe,
    }));

    if (audio) {
      // Opus in MP4 is standardised and plays in Chrome, Edge and Firefox, but
      // Safari will show the picture and stay silent. Saying so is better than
      // letting someone find out after they have sent it to somebody.
      tracks.push({
        kind: 'audio', description: audio.track.kind === 'audio' ? audio.track.codecPrivate ?? new Uint8Array(0) : new Uint8Array(0),
        codec: 'opus', sampleRate: 48000, channels: audio.track.kind === 'audio' ? audio.track.channels : 2,
      });
      for (const sample of alignToZero(audio.samples)) {
        samples.push({ track: 2, timestamp: sample.timestamp, duration: 20_000, data: sample.data, keyframe: true });
      }
      note = 'The sound is Opus, which most players handle but Safari does not. Use WebM if it has to play everywhere.';
    }

    const file = muxMp4({ tracks }, samples);
    return {
      blob: new Blob([file as unknown as BlobPart], { type: 'video/mp4' }),
      frames: total, hasAudio: audio !== null, extension: 'mp4', note,
    };
  }

  const videoTrack: WebmTrack = {
    kind: 'video',
    codec: codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
    width: size.width,
    height: size.height,
    frameDuration: Math.round(1_000_000_000 / project.frameRate),
  };

  const tracks: WebmTrack[] = [videoTrack];
  const all: WebmSample[] = chunks.map((chunk) => ({
    track: 1, timestamp: chunk.timestamp, data: chunk.data, keyframe: chunk.keyframe,
  }));

  if (audio) {
    tracks.push(audio.track);
    all.push(...alignToZero(audio.samples));
  }

  const file = muxWebm({ tracks, writingApp: 'Limelight on alexmerced.app' }, all);
  return {
    blob: new Blob([file as unknown as BlobPart], { type: 'video/webm' }),
    frames: total, hasAudio: audio !== null, extension: 'webm', note,
  };
}
