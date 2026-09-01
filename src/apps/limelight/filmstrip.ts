import { openFrameSource } from './frames';

/**
 * Thumbnails along the trim bar, so you can see what you are trimming.
 *
 * Until now every position in this editor was picked against a plain grey bar.
 * You could see that a cut was four seconds long and nothing about what was in
 * those four seconds, so placing anything meant scrubbing to look, going back
 * to the bar, and holding the picture in your head in between.
 *
 * This became affordable when the export stopped seeking for every frame.
 * Twelve thumbnails used to mean twelve decoder seeks, each rewinding to the
 * previous keyframe; the same sequential source the export uses walks the file
 * once and hands over what it passes.
 */

export type StripPlan = {
  /** When to grab each thumbnail, in seconds. */
  times: number[];
  /** How wide each one is drawn, in device pixels. */
  slot: number;
  height: number;
};

/**
 * Works out how many thumbnails fit and which moments they show.
 *
 * Each one stands for a slice of the recording, and shows the middle of its
 * slice rather than the start. Showing the start puts the first thumbnail at
 * time zero, which on a screen recording is a blank desktop before anything has
 * happened, and wastes the one people look at first.
 */
export function planStrip(
  width: number, height: number, duration: number, aspect: number,
): StripPlan {
  if (!(width > 0) || !(height > 0) || !(duration > 0) || !(aspect > 0)) {
    return { times: [], slot: 0, height: 0 };
  }
  const slot = Math.max(8, Math.round(height * aspect));
  // One more than fits, so the strip runs past the right edge rather than
  // stopping short of it and leaving a grey gap where the last frame should be.
  const count = Math.max(1, Math.ceil(width / slot));
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    times.push(Math.min(duration, ((index + 0.5) / count) * duration));
  }
  return { times, slot, height };
}

export type StripHandle = {
  /** Draws the strip for a recording. Safe to call again; the last call wins. */
  draw: (blob: Blob, duration: number, video: HTMLVideoElement) => Promise<void>;
  /** Empties it, for when the recording goes away. */
  clear: () => void;
};

/** Pulls one frame out by seeking, for browsers the sequential path cannot serve. */
async function seekFrame(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.01) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    // A seek that never completes must not leave the strip half drawn forever.
    setTimeout(done, 600);
    video.currentTime = time;
  });
}

export function mountFilmstrip(canvas: HTMLCanvasElement): StripHandle {
  // Each draw takes a token. A later one starting means an earlier one stops,
  // which matters because a strip takes a moment and the recording can be
  // replaced while it is being drawn.
  let token = 0;

  function clear(): void {
    token += 1;
    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function draw(blob: Blob, duration: number, video: HTMLVideoElement): Promise<void> {
    token += 1;
    const mine = token;
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);

    const aspect = video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : 16 / 9;
    const plan = planStrip(width, height, duration, aspect);
    if (plan.times.length === 0) return;

    const source = await openFrameSource(blob).catch(() => null);
    // The element is the fallback, and it is also what the preview is playing
    // from, so its position has to be handed back afterwards.
    const before = video.currentTime;

    try {
      for (const [index, time] of plan.times.entries()) {
        if (mine !== token) return;
        const x = index * plan.slot;

        let drawn = false;
        if (source) {
          const frame = await source.frameAt(time);
          if (mine !== token) return;
          if (frame) {
            // Cover rather than fit: a letterboxed thumbnail wastes the little
            // height there is on black.
            const scale = Math.max(plan.slot / frame.displayWidth, plan.height / frame.displayHeight);
            const w = frame.displayWidth * scale;
            const h = frame.displayHeight * scale;
            context.drawImage(frame, x + (plan.slot - w) / 2, (plan.height - h) / 2, w, h);
            drawn = true;
          }
        }

        if (!drawn) {
          await seekFrame(video, time);
          if (mine !== token) return;
          if (video.videoWidth > 0) {
            const scale = Math.max(plan.slot / video.videoWidth, plan.height / video.videoHeight);
            const w = video.videoWidth * scale;
            const h = video.videoHeight * scale;
            context.drawImage(video, x + (plan.slot - w) / 2, (plan.height - h) / 2, w, h);
          }
        }
      }
    } finally {
      source?.close();
      if (!source && Math.abs(video.currentTime - before) > 0.01) {
        await seekFrame(video, before).catch(() => {});
      }
    }
  }

  return { draw, clear };
}
