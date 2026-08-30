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

export type ExportResult = { blob: Blob; frames: number };

/** Renders the whole thing and encodes it. */
export async function render(
  project: Project,
  points: Interest[],
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  if (typeof VideoEncoder === 'undefined') {
    throw new RenderError('This browser does not offer WebCodecs, so the finished video cannot be encoded here.');
  }

  const size = evenSize(project.composition.width, project.composition.height);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { alpha: project.composition.background === 'none' });
  if (!context) throw new RenderError('This browser would not give a drawing surface.');

  const track = buildZoomTrack(points, project.duration, project.zoom);
  const smoothed = project.pointer.length ? smoothPath(project.pointer) : [];
  const cursorTrack: PointerSample[] = smoothed.map((point, index) => ({
    time: project.pointer[index].time, x: point.x, y: point.y,
  }));

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

  const codec = (await VideoEncoder.isConfigSupported({
    codec: 'vp09.00.10.08', width: size.width, height: size.height, bitrate: project.bitrate, framerate: project.frameRate,
  })).supported ? 'vp09.00.10.08' : 'vp8';

  encoder.configure({
    codec,
    width: size.width,
    height: size.height,
    bitrate: project.bitrate,
    framerate: project.frameRate,
    latencyMode: 'quality',
  });

  const total = Math.max(1, Math.round(project.duration * project.frameRate));
  const step = 1 / project.frameRate;
  const durationUs = Math.round(1_000_000 / project.frameRate);
  const keyframeEvery = Math.max(1, Math.round(project.frameRate * 2));

  for (let index = 0; index < total; index += 1) {
    if (signal.aborted) { encoder.close(); throw new RenderError('Cancelled.'); }
    if (failure) { encoder.close(); throw failure; }

    const time = index * step;
    await seekTo(project.video, Math.min(project.duration - 1e-3, time));
    if (project.camera) {
      // The camera runs on its own clock, so it is seeked to the same moment.
      await seekTo(project.camera, Math.min(Math.max(0, project.camera.duration - 1e-3), time)).catch(() => {});
    }

    drawFrame(context, project, time, zoomAt(track, time), cursorTrack.length ? sampleAt(cursorTrack, time) : null);

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

  onProgress({ stage: 'Writing the file', done: total, total });

  const videoTrack: WebmTrack = {
    kind: 'video',
    codec: codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8',
    width: size.width,
    height: size.height,
    frameDuration: Math.round(1_000_000_000 / project.frameRate),
  };

  const file = muxWebm({ tracks: [videoTrack], writingApp: 'Limelight on alexmerced.app' }, samples);
  return { blob: new Blob([file as unknown as BlobPart], { type: 'video/webm' }), frames: total };
}
