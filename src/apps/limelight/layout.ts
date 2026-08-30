/**
 * Where everything sits in the finished frame.
 *
 * The look this is after is the one every product demo uses now: the recording
 * inset on a coloured field, corners rounded, a soft shadow under it. None of
 * that is decoration for its own sake. Padding gives the eye somewhere to rest,
 * and the inset makes a screen recording read as a picture of a screen rather
 * than as the viewer's own desktop.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type BackgroundKind = 'none' | 'solid' | 'gradient' | 'blur';

export type CameraCorner = 'bottomRight' | 'bottomLeft' | 'topRight' | 'topLeft';

export type Composition = {
  /** Output size. */
  width: number;
  height: number;
  background: BackgroundKind;
  /** Two colours; a solid background uses the first. */
  colours: [string, string];
  /** Inset as a fraction of the shorter output edge, 0 to 0.2. */
  padding: number;
  /** Corner radius as a fraction of the shorter recording edge, 0 to 0.1. */
  radius: number;
  shadow: number;
  camera: {
    enabled: boolean;
    corner: CameraCorner;
    /** Diameter as a fraction of the shorter output edge. */
    size: number;
    round: boolean;
    /** Inset from the edges, as a fraction of the shorter output edge. */
    margin: number;
  };
};

export const defaultComposition: Composition = {
  width: 1920,
  height: 1080,
  background: 'gradient',
  colours: ['#1f2937', '#4c5b7a'],
  padding: 0.05,
  radius: 0.02,
  shadow: 0.6,
  camera: { enabled: false, corner: 'bottomRight', size: 0.22, round: true, margin: 0.03 },
};

export const PRESETS: { id: string; label: string; colours: [string, string]; background: BackgroundKind }[] = [
  { id: 'slate', label: 'Slate', colours: ['#1f2937', '#4c5b7a'], background: 'gradient' },
  { id: 'paper', label: 'Paper', colours: ['#f4f1ea', '#ded8cc'], background: 'gradient' },
  { id: 'ink', label: 'Ink', colours: ['#101014', '#101014'], background: 'solid' },
  { id: 'moss', label: 'Moss', colours: ['#243b2f', '#4a7a5c'], background: 'gradient' },
  { id: 'rust', label: 'Rust', colours: ['#3b1f18', '#a8562f'], background: 'gradient' },
  { id: 'none', label: 'No background', colours: ['#000000', '#000000'], background: 'none' },
];

/**
 * Fits the recording inside the padded area, keeping its shape.
 *
 * The recording is never stretched. A 16:10 capture on a 16:9 output gets bars
 * of background above and below, which is the honest thing to show.
 */
export function contentRect(composition: Composition, sourceWidth: number, sourceHeight: number): Rect {
  const { width, height } = composition;
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width, height };

  const inset = Math.max(0, Math.min(0.2, composition.padding)) * Math.min(width, height);
  const available = { width: Math.max(1, width - inset * 2), height: Math.max(1, height - inset * 2) };

  const scale = Math.min(available.width / sourceWidth, available.height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;

  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

/** Corner radius in pixels, capped so it can never round away the whole picture. */
export function cornerRadius(composition: Composition, content: Rect): number {
  const fraction = Math.max(0, Math.min(0.1, composition.radius));
  return Math.min(fraction * Math.min(content.width, content.height), Math.min(content.width, content.height) / 2);
}

/** Where the camera bubble goes, in the chosen corner with its margin. */
export function cameraRect(composition: Composition): Rect | null {
  const camera = composition.camera;
  if (!camera.enabled) return null;

  const shorter = Math.min(composition.width, composition.height);
  const size = Math.max(16, Math.min(0.5, camera.size) * shorter);
  const margin = Math.max(0, Math.min(0.2, camera.margin)) * shorter;

  const left = camera.corner === 'topLeft' || camera.corner === 'bottomLeft';
  const top = camera.corner === 'topLeft' || camera.corner === 'topRight';

  return {
    x: left ? margin : composition.width - size - margin,
    y: top ? margin : composition.height - size - margin,
    width: size,
    height: size,
  };
}

/**
 * The square to take out of a camera frame so a wide picture fills a circle
 * without being squashed. Centred horizontally, and a little above centre
 * vertically, because that is where a face sits in a webcam frame.
 */
export function cameraCrop(sourceWidth: number, sourceHeight: number): Rect {
  const side = Math.min(sourceWidth, sourceHeight);
  return {
    x: (sourceWidth - side) / 2,
    y: Math.max(0, (sourceHeight - side) / 2 - side * 0.06),
    width: side,
    height: side,
  };
}

/** Even dimensions, since every video codec here works in two by two blocks. */
export function evenSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
  };
}

export const OUTPUT_SIZES: { id: string; label: string; width: number; height: number }[] = [
  { id: '4k', label: '3840 by 2160, 4K', width: 3840, height: 2160 },
  { id: '1440p', label: '2560 by 1440', width: 2560, height: 1440 },
  { id: '1080p', label: '1920 by 1080', width: 1920, height: 1080 },
  { id: '720p', label: '1280 by 720', width: 1280, height: 720 },
  { id: 'square', label: '1080 square', width: 1080, height: 1080 },
  { id: 'vertical', label: '1080 by 1920, vertical', width: 1080, height: 1920 },
  { id: 'portrait', label: '1080 by 1350, portrait', width: 1080, height: 1350 },
];

/** How hard to push the encoder, as a multiplier on the suggested bitrate. */
export const QUALITY: { id: 'low' | 'medium' | 'high'; label: string; factor: number }[] = [
  { id: 'low', label: 'Smaller file', factor: 0.5 },
  { id: 'medium', label: 'Balanced', factor: 1 },
  { id: 'high', label: 'Best quality', factor: 1.8 },
];

/** A rounded rectangle path, for clipping the recording and drawing its shadow. */
export function roundedPath(rect: Rect, radius: number): Path2D {
  const path = new Path2D();
  const r = Math.max(0, Math.min(radius, Math.min(rect.width, rect.height) / 2));
  path.moveTo(rect.x + r, rect.y);
  path.lineTo(rect.x + rect.width - r, rect.y);
  path.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r, r);
  path.lineTo(rect.x + rect.width, rect.y + rect.height - r);
  path.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - r, rect.y + rect.height, r);
  path.lineTo(rect.x + r, rect.y + rect.height);
  path.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r, r);
  path.lineTo(rect.x, rect.y + r);
  path.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
  path.closePath();
  return path;
}

/** A click ripple's radius and opacity at a moment, or null once it is over. */
export function ripple(elapsed: number, duration = 0.6): { radius: number; opacity: number } | null {
  if (elapsed < 0 || elapsed > duration) return null;
  const t = elapsed / duration;
  return {
    // Expands quickly then slows, which reads as an impact rather than a bubble.
    radius: 1 - (1 - t) ** 3,
    opacity: (1 - t) ** 2,
  };
}
