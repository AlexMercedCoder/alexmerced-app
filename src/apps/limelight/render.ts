import { encodeGif, type GifFrame } from '../../lib/gif';
import { muxMp4, type Mp4Sample, type Mp4Track } from '../../lib/mp4';
import { alignToZero, encodeAac, encodeOpus } from '../../lib/opus';
import { muxWebm, type WebmSample, type WebmTrack } from '../../lib/webm';
import {
  interestFromPointer, mergeInterest, motionCentre, motionGrid, sampleAt, smoothPath,
  type ClickSample, type Interest, type PointerSample,
} from './attention';
import {
  cameraAspect, cameraCrop, cameraRect, contentRect, cornerRadius, coverRect, cropRect, evenSize,
  ripple, roundedPath, type Composition, type Crop,
} from './layout';
import {
  cornersBounds, hasTilt, plateMotion, tiltCorners, type MotionSettings, type Point, type Tilt,
} from './plate';
import { textsAt, wrapText, type TextBlock } from './text';
import { cuesAt, type Cue } from './captions';
import { boundsOf, shapesAt, type Shape } from './shapes';
import {
  duckingEnvelope, cleanVoice, mixUnder, type MusicSettings, type VoiceSettings,
} from './sound';

/** Root mean square per column, for the ducking envelope. */
function coarseLoudness(samples: Float32Array, columns: number): Float32Array {
  const out = new Float32Array(Math.max(1, columns));
  if (samples.length === 0) return out;
  const per = samples.length / out.length;
  for (let index = 0; index < out.length; index += 1) {
    const from = Math.floor(index * per);
    const to = Math.max(from + 1, Math.min(samples.length, Math.floor((index + 1) * per)));
    let sum = 0;
    for (let at = from; at < to; at += 1) sum += samples[at] * samples[at];
    out[index] = Math.sqrt(sum / (to - from));
  }
  return out;
}
import { type Span } from './waveform';
import { editedDuration, segmentsOf, sourceAt, type SpeedRegion } from './timeline';
import { rectAt, redactionsAt, type RedactBlock } from './redact';
import { openFrameSource, type FrameSource } from './frames';
import { acrossClips, layout, sourceOf, type Clip, type Placed } from './reel';
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

/**
 * Thrown when an export can only be finished with a video element.
 *
 * A decoder handles almost every recording. When one refuses, the seeking path
 * takes over, and that needs an element, which a worker does not have. This
 * says so precisely so the caller can start again on the main thread rather
 * than reporting a failure to somebody who did nothing wrong.
 */
export class NeedsElementError extends Error {
  constructor(message = 'This recording has to be exported on the main thread.') {
    super(message);
    this.name = 'NeedsElementError';
  }
}

export class RenderError extends Error {}

export type Progress = { stage: string; done: number; total: number };

export type Project = {
  /**
   * The recording as an element, for seeking when a decoder cannot be used.
   *
   * Absent in a worker, where there is no DOM to hold one. Everything the
   * export needs beyond it comes from the decoder, so the only thing missing
   * is the fallback, and an export that would have needed it fails with
   * `NeedsElementError` for the caller to run here instead.
   */
  video?: HTMLVideoElement | null;
  camera?: HTMLVideoElement | null;
  /** The recording itself, which is where the audio still lives. */
  source: Blob | null;
  /**
   * The reel, when the timeline holds more than the one recording.
   *
   * Left out, everything behaves exactly as it did: one recording, one clock,
   * `source` and `video` above. Given, the seconds everything else works in are
   * the reel's, and these say which recording each of them belongs to.
   */
  clips?: Clip[];
  /** The other recordings the clips name, by id. */
  takes?: Map<string, { blob: Blob; video: HTMLVideoElement }>;
  duration: number;
  sourceWidth: number;
  sourceHeight: number;
  pointer: PointerSample[];
  clicks: ClickSample[];
  /** The part of the source to keep. Everything outside it is never drawn. */
  crop?: Crop | null;
  /** A picture to use as the background, when one was chosen. */
  wallpaper?: CanvasImageSource | null;
  /** Captions laid over the finished frame. */
  texts?: TextBlock[];
  /** How the recording plate leans in space. */
  tilt?: Tilt;
  /** How the plate arrives and leaves. */
  motion?: MotionSettings;
  composition: Composition;
  zoom: ZoomSettings;
  frameRate: number;
  bitrate: number;
  showClicks: boolean;
  showCursor: boolean;
  /** How large to draw the cursor, as a multiple of the default. */
  cursorSize?: number;
  /** Dims everything but a circle around the pointer. 0 is off. */
  spotlight?: number;
  /** Draws the shortcuts that were pressed. */
  showKeys?: boolean;
  keys?: { time: number; label: string }[];
  /** Subtitles, already aligned to the finished video's own clock. */
  captions?: Cue[];
  /** Height of a caption as a fraction of the frame. */
  captionSize?: number;
  /** Arrows, boxes and highlights laid over the finished frame. */
  shapes?: Shape[];
  /** Levelling, rumble filtering and gating for the recorded voice. */
  voice?: VoiceSettings;
  /** A bed to put under the narration, already at the encoder's sample rate. */
  music?: Float32Array | null;
  musicSettings?: MusicSettings;
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
  /** Stretches inside that range which are skipped over. */
  cuts?: Span[];
  /** Stretches that run faster or slower than recorded. */
  speeds?: SpeedRegion[];
  /** Rectangles covered over, burnt into the picture rather than laid on top. */
  redactions?: RedactBlock[];
  /**
   * A decoded frame to draw instead of the video element.
   *
   * Set while exporting, where frames arrive from a decoder running straight
   * through the file rather than from seeking the element to each one. Nothing
   * else about the compositing changes, which is what keeps the preview and the
   * export producing the same picture.
   */
  frame?: CanvasImageSource | null;
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
    if (!project.video) throw new NeedsElementError();
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
  } else if (composition.background === 'image' && project.wallpaper) {
    const source = wallpaperSize(project.wallpaper);
    const fit = coverRect(width, height, source.width, source.height);
    context.drawImage(project.wallpaper, fit.x, fit.y, fit.width, fit.height);
  } else if (composition.background === 'gradient' || composition.background === 'image') {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, composition.colours[0]);
    gradient.addColorStop(1, composition.colours[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  } else {
    // A blurred, enlarged copy of the recording itself behind the inset one.
    const behind = cropRect(project.crop, project.sourceWidth, project.sourceHeight);
    context.filter = 'blur(48px) brightness(0.7)';
    context.drawImage(
      redact(project, time),
      behind.x, behind.y, behind.width, behind.height,
      -width * 0.1, -height * 0.1, width * 1.2, height * 1.2,
    );
    context.filter = 'none';
  }
  context.restore();

  // ------------------------------------------------------------- recording
  // The crop is the recording as far as everything below is concerned: it sets
  // the shape that gets fitted to the frame, and the zoom moves around inside
  // it rather than around the original.
  // Redactions are burnt into the source before anything else looks at it, so
  // the zoom, the crop and the tilt all carry them and there is no path that
  // renders the frame without them. A redaction applied as an overlay could be
  // missed by a code path that draws the picture some other way, and shipping a
  // recording with an uncovered API key is the worst bug this app could have.
  const picture = redact(project, time);
  const region = cropRect(project.crop, project.sourceWidth, project.sourceHeight);
  const placed = contentRect(composition, region.width, region.height);

  // An entrance moves and fades the plate, so it has to be settled before the
  // shadow is drawn under it or the two would come apart.
  const move = project.motion
    ? plateMotion(project.motion, time, project.start, project.end)
    : { opacity: 1, scale: 1, offsetX: 0, offsetY: 0 };
  const content = move.scale === 1 && move.offsetX === 0 && move.offsetY === 0
    ? placed
    : {
        x: placed.x + (placed.width * (1 - move.scale)) / 2 + move.offsetX * width,
        y: placed.y + (placed.height * (1 - move.scale)) / 2 + move.offsetY * height,
        width: placed.width * move.scale,
        height: placed.height * move.scale,
      };

  const tilt = project.tilt;
  const radius = cornerRadius(composition, content);
  const inner = viewRect(view, region.width, region.height);
  const source = {
    x: region.x + inner.x,
    y: region.y + inner.y,
    width: inner.width,
    height: inner.height,
  };

  if (composition.shadow > 0 && composition.background !== 'none' && move.opacity > 0) {
    context.save();
    context.globalAlpha = move.opacity;
    context.shadowColor = `rgba(0, 0, 0, ${Math.min(1, composition.shadow) * 0.55})`;
    context.shadowBlur = Math.max(8, Math.min(width, height) * 0.045);
    context.shadowOffsetY = Math.max(4, Math.min(width, height) * 0.012);
    context.fillStyle = '#000';
    if (tilt && hasTilt(tilt)) {
      const corners = tiltCorners(content, tilt);
      context.beginPath();
      context.moveTo(corners[0].x, corners[0].y);
      for (const corner of corners.slice(1)) context.lineTo(corner.x, corner.y);
      context.closePath();
      context.fill();
    } else {
      context.fill(roundedPath(content, radius));
    }
    context.restore();
  }

  context.save();
  context.globalAlpha = move.opacity;
  if (tilt && hasTilt(tilt)) {
    drawTilted(context, picture, source, content, radius, tilt);
  } else {
    context.clip(roundedPath(content, radius));
    context.drawImage(
      picture,
      source.x, source.y, source.width, source.height,
      content.x, content.y, content.width, content.height,
    );
  }
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

  // A spotlight dims everything but a circle around the pointer. Drawn before
  // the cursor so the cursor itself stays bright inside it.
  const spotlight = project.spotlight ?? 0;
  if (spotlight > 0 && cursor) {
    const at = project2(cursor.x, cursor.y);
    if (at) {
      const radius = Math.min(width, height) * 0.16;
      const fade = context.createRadialGradient(at.x, at.y, radius * 0.55, at.x, at.y, radius * 1.7);
      fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
      fade.addColorStop(1, `rgba(0, 0, 0, ${Math.min(0.85, spotlight)})`);
      context.save();
      context.fillStyle = fade;
      context.fillRect(0, 0, width, height);
      context.restore();
    }
  }

  if (project.showCursor && cursor) {
    const at = project2(cursor.x, cursor.y);
    const scale = Math.max(0.5, Math.min(4, project.cursorSize ?? 1));
    if (at) drawCursor(context, at.x, at.y, Math.min(width, height) * 0.022 * scale);
  }

  // ------------------------------------------------------------- keystrokes
  if (project.showKeys && project.keys?.length) {
    drawKeys(context, project.keys, time, width, height);
  }

  // ------------------------------------------------------------- camera
  const bubble = cameraRect(composition);
  if (bubble && project.camera && project.camera.videoWidth > 0) {
    const shape = composition.camera.shape;
    const crop = cameraCrop(project.camera.videoWidth, project.camera.videoHeight, cameraAspect(shape));
    // A circle is a rounded rectangle whose radius is half its shorter edge, so
    // one path covers every shape and the clip and the ring cannot disagree.
    const outline = roundedPath(
      bubble,
      shape === 'circle' ? Math.min(bubble.width, bubble.height) / 2
        : shape === 'square' ? 0
          : Math.min(bubble.width, bubble.height) * 0.08,
    );

    context.save();
    context.clip(outline);
    context.drawImage(
      project.camera,
      crop.x, crop.y, crop.width, crop.height,
      bubble.x, bubble.y, bubble.width, bubble.height,
    );
    context.restore();

    context.save();
    context.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    context.lineWidth = Math.max(2, Math.min(bubble.width, bubble.height) * 0.015);
    context.stroke(outline);
    context.restore();
  }

  // ------------------------------------------------------------- overlays
  // Last, so nothing laid on top is half hidden behind the camera bubble.
  if (project.texts && project.texts.length > 0) {
    drawTexts(context, project.texts, time, width, height);
  }
  if (project.shapes?.length) {
    drawShapes(context, project.shapes, time, width, height);
  }
  if (project.captions?.length) {
    drawCaptions(context, project.captions, time, width, height, project.captionSize ?? 0.045);
  }
}

/**
 * Draws the arrows, boxes and highlights.
 *
 * Under the captions, because a subtitle is read and a shape is looked at, and
 * the reading should win when they collide.
 */
function drawShapes(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  shapes: Shape[], time: number, width: number, height: number,
): void {
  const unit = Math.min(width, height);
  for (const { shape, opacity } of shapesAt(shapes, time)) {
    if (opacity <= 0) continue;
    const box = boundsOf(shape);
    const x = box.x * width;
    const y = box.y * height;
    const w = box.width * width;
    const h = box.height * height;
    const line = Math.max(1, shape.thickness * unit);

    context.save();
    context.globalAlpha = opacity;
    context.strokeStyle = shape.colour;
    context.fillStyle = shape.colour;
    context.lineWidth = line;
    context.lineJoin = 'round';
    context.lineCap = 'round';

    if (shape.kind === 'highlight') {
      // Multiply so the text underneath still reads, which is the difference
      // between a highlighter and a sticker.
      context.globalCompositeOperation = 'multiply';
      context.globalAlpha = opacity * 0.45;
      context.fillRect(x, y, w, h);
    } else if (shape.kind === 'box') {
      context.strokeRect(x, y, w, h);
    } else if (shape.kind === 'ellipse') {
      context.beginPath();
      context.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
      context.stroke();
    } else {
      drawArrow(context, shape, width, height, line);
    }
    context.restore();
  }
}

/** An arrow from its tail to its head, with the head scaled to the line. */
function drawArrow(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  shape: Shape, width: number, height: number, line: number,
): void {
  const fromX = shape.x * width;
  const fromY = shape.y * height;
  const toX = (shape.x + shape.width) * width;
  const toY = (shape.y + shape.height) * height;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const head = Math.max(line * 3, 8);

  // The shaft stops short of the point, or the head's fill and the shaft's
  // round cap overlap and the tip looks blunt.
  const shaftX = toX - Math.cos(angle) * head * 0.8;
  const shaftY = toY - Math.sin(angle) * head * 0.8;

  context.beginPath();
  context.moveTo(fromX, fromY);
  context.lineTo(shaftX, shaftY);
  context.stroke();

  context.beginPath();
  context.moveTo(toX, toY);
  context.lineTo(toX - Math.cos(angle - 0.42) * head, toY - Math.sin(angle - 0.42) * head);
  context.lineTo(toX - Math.cos(angle + 0.42) * head, toY - Math.sin(angle + 0.42) * head);
  context.closePath();
  context.fill();
}

/**
 * Draws the recording onto a tilted plate.
 *
 * Canvas only has an affine transform, which cannot make parallel lines
 * converge. So the plate is cut into thin horizontal strips and each is placed
 * with its own matrix, following the quad's left and right edges down. A strip
 * of a trapezium is a parallelogram to within a fraction of a pixel once it is
 * thin enough, and the seams are covered by drawing each strip a touch taller
 * than its share.
 *
 * The rounded corners are applied first, on an offscreen plate, because
 * rounding a shape that is already tilted would round it in the wrong space and
 * the corners would come out lopsided.
 */
function drawTilted(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  video: CanvasImageSource,
  source: { x: number; y: number; width: number; height: number },
  content: { x: number; y: number; width: number; height: number },
  radius: number,
  tilt: Tilt,
): void {
  const plateWidth = Math.max(2, Math.round(content.width));
  const plateHeight = Math.max(2, Math.round(content.height));

  const plate = scratch(plateWidth, plateHeight);
  const plateContext = plate.getContext('2d');
  if (!plateContext) return;

  plateContext.setTransform(1, 0, 0, 1, 0, 0);
  plateContext.clearRect(0, 0, plateWidth, plateHeight);
  plateContext.save();
  plateContext.clip(roundedPath({ x: 0, y: 0, width: plateWidth, height: plateHeight }, radius));
  plateContext.drawImage(
    video,
    source.x, source.y, source.width, source.height,
    0, 0, plateWidth, plateHeight,
  );
  plateContext.restore();

  const [topLeft, topRight, bottomRight, bottomLeft] = tiltCorners(content, tilt);
  const mix = (a: Point, b: Point, t: number): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  // Enough strips that the tallest edge moves less than a pixel across one.
  const span = Math.max(1, cornersBounds([topLeft, topRight, bottomRight, bottomLeft]).height);
  const strips = Math.max(24, Math.min(600, Math.ceil(span)));
  const step = 1 / strips;
  const sliceHeight = plateHeight / strips;

  for (let index = 0; index < strips; index += 1) {
    const top = index * step;
    const bottom = top + step;

    const leftTop = mix(topLeft, bottomLeft, top);
    const rightTop = mix(topRight, bottomRight, top);
    const leftBottom = mix(topLeft, bottomLeft, bottom);

    context.save();
    // The matrix that carries the plate's own coordinates onto this strip:
    // across follows the strip's top edge, down follows the left edge. It
    // multiplies with whatever transform is already in place rather than
    // replacing it, so this composes instead of resetting the frame.
    context.transform(
      (rightTop.x - leftTop.x) / plateWidth,
      (rightTop.y - leftTop.y) / plateWidth,
      (leftBottom.x - leftTop.x) / sliceHeight,
      (leftBottom.y - leftTop.y) / sliceHeight,
      leftTop.x,
      leftTop.y,
    );
    // A hair of overlap, so neighbouring strips leave no gap between them.
    context.drawImage(
      plate,
      0, index * sliceHeight, plateWidth, sliceHeight + 1,
      0, 0, plateWidth, sliceHeight + 1,
    );
    context.restore();
  }
}

/** The font stack. Whatever the machine has, so nothing is fetched to draw text. */
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Draws the captions showing at a moment.
 *
 * Measuring happens against the same context that draws, which is the only way
 * the wrapping in the preview and the wrapping in the export can be guaranteed
 * to agree.
 */
export function drawTexts(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  texts: TextBlock[],
  time: number,
  width: number,
  height: number,
): void {
  const shorter = Math.min(width, height);

  for (const { block, opacity } of textsAt(texts, time)) {
    const fontSize = Math.max(8, block.size * shorter);
    const lineHeight = fontSize * 1.25;
    const padding = fontSize * 0.45;

    context.save();
    context.globalAlpha = opacity;
    context.font = `600 ${fontSize}px ${FONT}`;
    context.textBaseline = 'middle';

    // Captions are given four fifths of the frame to wrap inside, so a long one
    // does not run to the very edge where it is hard to read.
    const lines = wrapText(block.text, width * 0.8, (line) => context.measureText(line).width);
    const widest = lines.reduce((most, line) => Math.max(most, context.measureText(line).width), 0);
    const boxWidth = widest + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2 - (lineHeight - fontSize);

    // x and y name the middle of the caption, so it stays put as the text grows.
    const centreX = block.x * width;
    const centreY = block.y * height;
    const left = Math.max(0, Math.min(width - boxWidth, centreX - boxWidth / 2));
    const top = Math.max(0, Math.min(height - boxHeight, centreY - boxHeight / 2));

    if (block.plate > 0) {
      context.fillStyle = `rgba(0, 0, 0, ${Math.min(1, block.plate) * 0.75})`;
      context.fill(roundedPath(
        { x: left, y: top, width: boxWidth, height: boxHeight },
        Math.min(fontSize * 0.35, boxHeight / 2),
      ));
    }

    context.fillStyle = block.colour;
    context.textAlign = block.align === 'centre' ? 'center' : block.align;
    const textX = block.align === 'left' ? left + padding
      : block.align === 'right' ? left + boxWidth - padding
        : left + boxWidth / 2;

    for (let index = 0; index < lines.length; index += 1) {
      context.fillText(lines[index], textX, top + padding + fontSize / 2 + index * lineHeight);
    }
    context.restore();
  }
}

/** The familiar arrow, drawn rather than taken from the frame. */
/**
 * Draws the shortcuts pressed around a moment.
 *
 * A short window rather than the whole recording, and stacked upwards so the
 * most recent is nearest the bottom, which is where the eye already is when
 * somebody is watching hands rather than reading.
 */
/**
 * Draws the subtitle showing at a moment.
 *
 * Centred near the bottom on a plate, which is what makes text readable over a
 * screen recording where the background underneath is arbitrary. Wrapped to the
 * frame rather than trusting the cue's own line breaks, since a caption written
 * for a wide video would run off a tall one.
 */
function drawCaptions(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  cues: Cue[], time: number, width: number, height: number, size: number,
): void {
  const showing = cuesAt(cues, time);
  if (showing.length === 0) return;

  const fontSize = Math.max(12, Math.round(height * Math.max(0.02, Math.min(0.12, size))));
  context.save();
  context.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textBaseline = 'middle';
  context.textAlign = 'center';

  const maxWidth = width * 0.82;
  const measure = (line: string) => context.measureText(line).width;
  const lines: string[] = [];
  for (const cue of showing) lines.push(...wrapText(cue.text, maxWidth, measure));

  const lineHeight = fontSize * 1.28;
  const padding = fontSize * 0.5;
  const blockHeight = lines.length * lineHeight + padding * 2;
  const bottom = height - height * 0.06;
  const top = bottom - blockHeight;

  let widest = 0;
  for (const line of lines) widest = Math.max(widest, context.measureText(line).width);
  const boxWidth = Math.min(width * 0.94, widest + padding * 2.4);

  context.fillStyle = 'rgba(10, 10, 12, 0.72)';
  context.fill(roundedPath(
    { x: width / 2 - boxWidth / 2, y: top, width: boxWidth, height: blockHeight },
    fontSize * 0.28,
  ));

  context.fillStyle = '#f6f4ef';
  for (const [index, line] of lines.entries()) {
    context.fillText(line, width / 2, top + padding + lineHeight * (index + 0.5));
  }
  context.restore();
}

function drawKeys(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  keys: { time: number; label: string }[],
  time: number, width: number, height: number,
): void {
  const window = 1.6;
  const recent = keys
    .filter((key) => time - key.time >= 0 && time - key.time <= window)
    .slice(-4)
    .reverse();
  if (recent.length === 0) return;

  const size = Math.max(14, Math.round(Math.min(width, height) * 0.032));
  const padX = size * 0.55;
  const padY = size * 0.34;
  const gap = size * 0.4;
  context.save();
  context.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  context.textBaseline = 'middle';

  let bottom = height - Math.round(height * 0.06);
  for (const key of recent) {
    const age = (time - key.time) / window;
    // Fades out over the last third of its life rather than vanishing.
    context.globalAlpha = age > 0.66 ? Math.max(0, 1 - (age - 0.66) / 0.34) : 1;
    const textWidth = context.measureText(key.label).width;
    const boxWidth = textWidth + padX * 2;
    const boxHeight = size + padY * 2;
    const x = Math.round(width / 2 - boxWidth / 2);
    const y = Math.round(bottom - boxHeight);

    context.fillStyle = 'rgba(16, 16, 20, 0.82)';
    context.fill(roundedPath({ x, y, width: boxWidth, height: boxHeight }, boxHeight * 0.28));
    context.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    context.lineWidth = Math.max(1, size * 0.05);
    context.stroke(roundedPath({ x, y, width: boxWidth, height: boxHeight }, boxHeight * 0.28));
    context.fillStyle = '#f4f2ec';
    context.fillText(key.label, x + padX, y + boxHeight / 2);

    bottom = y - gap;
  }
  context.restore();
}

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
  const cuts = project.cuts ?? [];
  // What survives the cuts, at whatever speed each piece runs. The frame count
  // comes from the finished length rather than the trimmed span, and with no
  // cuts and no speed regions that is exactly the trimmed span again.
  const segments = segmentsOf({ start: from, end: to }, cuts, project.speeds ?? []);
  const span = Math.max(1 / project.frameRate, editedDuration(segments));
  const total = Math.max(1, Math.round(span * project.frameRate));
  const step = 1 / project.frameRate;

  /**
   * Frames straight from a decoder walking the file, when that is possible.
   *
   * Null means this browser or this file cannot do it, and every frame is
   * fetched by seeking the element instead. That is the old behaviour and it
   * still produces the same picture, just far more slowly.
   */
  // Read once and share. The video path and the audio path both want the whole
  // file, and reading it twice meant two full copies of the recording live at
  // the same time for the length of the export.
  let sourceBytes: ArrayBuffer | null = null;
  let source: FrameSource | null = null;
  if (project.source instanceof Blob) {
    sourceBytes = await project.source.arrayBuffer().catch(() => null);
    source = await openFrameSource(project.source, sourceBytes ?? undefined);
  }

  /**
   * The reel, and a decoder for each recording on it.
   *
   * A plain recording leaves `clips` out and stays on the single `source`
   * above. An edited reel may contain even one clip when the other clips were
   * removed. Each source is opened as it is first needed: a decoder holds
   * hardware buffers, and a reel of eight takes would hold eight of them for the
   * whole export while using one at a time.
   */
  const placed: Placed[] = project.clips && project.clips.length > 0
    ? layout(project.clips)
    : [];
  const decoders = new Map<string, FrameSource | null>();
  const opened = new Set<string>();

  async function frameSourceFor(id: string): Promise<FrameSource | null> {
    if (opened.has(id)) return decoders.get(id) ?? null;
    opened.add(id);
    const take = project.takes?.get(id);
    const made = take ? await openFrameSource(take.blob).catch(() => null) : null;
    decoders.set(id, made);
    return made;
  }

  try {
    /** Composes one frame onto the canvas. Shared by every format. */
    const compose = async (index: number): Promise<number> => {
      const time = index * step;
      // Edited time in, source time out.
      const sourceTime = sourceAt(segments, time);

      // On a reel, the moment belongs to one of several recordings, and the
      // time inside that recording is what everything below wants.
      const spot = placed.length > 0 ? sourceOf(placed, sourceTime) : null;
      const element = spot ? project.takes?.get(spot.source)?.video ?? project.video : project.video;
      const at = spot ? spot.time : sourceTime;

      let decoded: VideoFrame | null = null;
      if (spot) {
        const clipSource = await frameSourceFor(spot.source);
        if (clipSource) {
          decoded = await clipSource.frameAt(at);
          // A decoder that stops producing has hit something it cannot handle.
          // Forgetting it here sends this clip, and only this clip, down the
          // seeking path for the rest of the export.
          if (!decoded) { clipSource.close(); decoders.set(spot.source, null); }
        }
      } else if (source) {
        decoded = await source.frameAt(at);
        // A source that stops producing has hit something it cannot decode. The
        // seeking path picks up from here rather than the export failing.
        if (!decoded) { source.close(); source = null; }
      }
      if (!decoded) {
        if (!element) throw new NeedsElementError();
        // Clamped against the element's own length, which on a reel is this
        // clip's recording rather than the whole timeline.
        const limit = Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : project.duration;
        await seekTo(element, Math.max(0, Math.min(limit - 1e-3, at)));
      }
      if (project.camera) {
        await seekTo(project.camera, Math.min(Math.max(0, project.camera.duration - 1e-3), sourceTime)).catch(() => {});
      }

      // The zoom track and the cursor are both in source time.
      //
      // The element goes along with the frame: without it, a clip that fell back
      // to seeking would seek the right video and then draw the first one.
      const frameProject = decoded
        ? { ...project, frame: decoded, video: element }
        : element === project.video ? project : { ...project, video: element };
      drawFrame(context, frameProject, sourceTime, zoomAt(track, sourceTime), cursorTrack.length ? sampleAt(cursorTrack, sourceTime) : null);
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
    let aac: Awaited<ReturnType<typeof encodeAac>> = null;
    let note: string | null = null;

    if (project.keepAudio && project.source) {
      onProgress({ stage: 'Encoding the sound', done: 0, total: 1 });
      // The kept pieces, so the sound skips exactly what the picture skips.
      // The kept pieces with their speeds, so the sound skips and hurries exactly
    // where the picture does.
    const voice = project.voice;
    const bed = project.music;
    const music = project.musicSettings;
    const cleaning = voice && (voice.normalise || voice.highPass > 0 || voice.gate > 0);
    const bedding = bed && bed.length > 0 && music && music.level > 0;

    // On a reel each piece of sound comes from the recording its clip belongs
    // to, so the segments are rewritten into those recordings' own seconds
    // before the encoder sees them.
    const audioSpans = placed.length > 0 ? acrossClips(placed, segments) : segments;
    const takes = new Map<string, Blob>();
    for (const [id, take] of project.takes ?? []) takes.set(id, take.blob);

    const audioOptions = {
      start: from, end: to, track: 2, spans: audioSpans,
      ...(placed.length > 0 ? { sources: takes } : {}),
      // Applied after the kept pieces are joined, so a filter's state does not
      // restart at every cut and click at the joins.
      process: cleaning || bedding
        ? (samples: Float32Array, rate: number) => {
          const cleaned = cleaning ? cleanVoice(samples, rate, voice) : samples;
          if (!bedding) return cleaned;
          // The envelope comes from the voice itself, so the bed ducks for
          // whatever the person actually said rather than a fixed pattern.
          const columns = Math.max(1, Math.round(cleaned.length / (rate * 0.05)));
          return mixUnder(cleaned, bed, duckingEnvelope(coarseLoudness(cleaned, columns), columns, music));
        }
        : undefined,
    };
    // Safari's MP4 support expects AAC. Use it whenever this browser exposes
    // the encoder, and retain the existing Opus path as an explicit fallback.
    if (wantsMp4) aac = await encodeAac(sourceBytes ?? project.source, audioOptions);
    if (!aac) audio = await encodeOpus(sourceBytes ?? project.source, audioOptions);
    if (!audio && !aac) note = 'No sound was found in the recording, so this is silent.';
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

      if (aac) {
        tracks.push({
          kind: 'audio', description: aac.description, codec: 'aac',
          sampleRate: aac.sampleRate, channels: aac.channels,
        });
        for (const sample of alignToZero(aac.samples)) {
          samples.push({
            track: 2, timestamp: sample.timestamp, duration: aac.sampleDuration,
            data: sample.data, keyframe: true,
          });
        }
      } else if (audio) {
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
        frames: total, hasAudio: audio !== null || aac !== null, extension: 'mp4', note,
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
  } finally {
    // A VideoFrame holds a hardware buffer until it is closed, and the
    // decoder holds more, so this matters even on the paths that threw.
    source?.close();
    for (const decoder of decoders.values()) decoder?.close();
    // Dropping the reference lets the whole recording be collected as soon as
    // the export is done rather than at the next natural scope exit.
    sourceBytes = null;
  }
}

/** An image source's own dimensions, whichever kind of source it is. */
function wallpaperSize(source: CanvasImageSource): { width: number; height: number } {
  const candidate = source as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  return {
    width: candidate.naturalWidth || (typeof candidate.width === 'number' ? candidate.width : 0) || 1,
    height: candidate.naturalHeight || (typeof candidate.height === 'number' ? candidate.height : 0) || 1,
  };
}

/**
 * A reusable offscreen canvas.
 *
 * The plate is redrawn every frame, and allocating a fresh canvas of a couple
 * of megapixels thirty times a second is the kind of thing that makes an export
 * spend its time in the garbage collector rather than in the encoder.
 */
let scratchCanvas: OffscreenCanvas | null = null;
let redactCanvas: OffscreenCanvas | null = null;
let blurCanvas: OffscreenCanvas | null = null;

/** A scratch canvas for blurring, which grows to fit and never shrinks. */
function blurPatch(width: number, height: number): OffscreenCanvas {
  if (!blurCanvas || blurCanvas.width < width || blurCanvas.height < height) {
    blurCanvas = new OffscreenCanvas(
      Math.max(width, blurCanvas?.width ?? 0),
      Math.max(height, blurCanvas?.height ?? 0),
    );
  }
  return blurCanvas;
}

/**
 * The recording with its redactions burnt in.
 *
 * Returns the untouched picture when there is nothing to cover, so the common
 * case costs nothing. Otherwise the frame is copied onto a canvas of its own,
 * the boxes are applied there, and that canvas is what everything downstream
 * draws.
 *
 * Coordinates are fractions of the whole source frame, so a redaction stays on
 * its target through a crop or a change of output size.
 */
function redact(project: Project, time: number): CanvasImageSource {
  const source = project.frame ?? project.video ?? null;
  if (!source) throw new NeedsElementError();
  const blocks = project.redactions?.length ? redactionsAt(project.redactions, time) : [];
  if (blocks.length === 0) return source;

  const width = project.sourceWidth;
  const height = project.sourceHeight;
  if (!redactCanvas || redactCanvas.width !== width || redactCanvas.height !== height) {
    redactCanvas = new OffscreenCanvas(width, height);
  }
  const context = redactCanvas.getContext('2d');
  if (!context) return source;

  context.filter = 'none';
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  for (const block of blocks) {
    const box = rectAt(block, time);
    const x = box.x * width;
    const y = box.y * height;
    const w = Math.max(1, box.width * width);
    const h = Math.max(1, box.height * height);

    if (block.style === 'solid') {
      context.fillStyle = '#101014';
      context.fillRect(x, y, w, h);
      continue;
    }

    if (block.style === 'pixelate') {
      // Down to a handful of blocks and back up. Drawn through a second canvas
      // because scaling a region onto itself reads the pixels it is writing.
      const small = scratch(Math.max(1, Math.round(w / 24)), Math.max(1, Math.round(h / 24)));
      const smallContext = small.getContext('2d');
      if (!smallContext) continue;
      smallContext.imageSmoothingEnabled = true;
      smallContext.clearRect(0, 0, small.width, small.height);
      smallContext.drawImage(redactCanvas, x, y, w, h, 0, 0, small.width, small.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
      context.imageSmoothingEnabled = true;
      continue;
    }

    // Blur, done by shrinking rather than by a large radius.
    //
    // Two measurements got this right. Blurring the whole frame per box cost
    // 17ms at 1080p against a 33ms budget; blurring only the box's
    // neighbourhood barely helped, at 15ms, because the expense is the radius,
    // not the area. A 36 pixel blur over any region is slow.
    //
    // Shrinking the region, blurring it small, and scaling it back gives the
    // same look for a fraction of the work. For a redaction it is better than
    // the same look: throwing the pixels away destroys the detail rather than
    // averaging it, and a blur that can be sharpened back up is not a
    // redaction at all.
    const shrink = 8;
    const pad = Math.max(4, Math.round(Math.min(w, h) / 6));
    const regionX = Math.max(0, Math.floor(x - pad));
    const regionY = Math.max(0, Math.floor(y - pad));
    const regionW = Math.min(width - regionX, Math.ceil(w + pad * 2));
    const regionH = Math.min(height - regionY, Math.ceil(h + pad * 2));
    if (regionW <= 0 || regionH <= 0) continue;

    const smallW = Math.max(1, Math.round(regionW / shrink));
    const smallH = Math.max(1, Math.round(regionH / shrink));
    const patch = blurPatch(smallW, smallH);
    const patchContext = patch.getContext('2d');
    if (!patchContext) continue;

    patchContext.filter = 'none';
    patchContext.clearRect(0, 0, smallW, smallH);
    patchContext.imageSmoothingEnabled = true;
    // Padding is what lets the softening sample real neighbouring pixels rather
    // than smearing the box's own edge inwards and leaving the text legible.
    patchContext.drawImage(redactCanvas, regionX, regionY, regionW, regionH, 0, 0, smallW, smallH);
    // A small blur on the small copy, which costs almost nothing and takes the
    // blockiness off the edges when it is scaled back up.
    patchContext.filter = 'blur(2px)';
    patchContext.drawImage(patch, 0, 0, smallW, smallH, 0, 0, smallW, smallH);
    patchContext.filter = 'none';

    context.save();
    context.beginPath();
    context.rect(x, y, w, h);
    context.clip();
    context.imageSmoothingEnabled = true;
    context.drawImage(patch, 0, 0, smallW, smallH, regionX, regionY, regionW, regionH);
    context.restore();
  }

  return redactCanvas;
}

function scratch(width: number, height: number): OffscreenCanvas {
  if (!scratchCanvas || scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas = new OffscreenCanvas(width, height);
  }
  return scratchCanvas;
}
