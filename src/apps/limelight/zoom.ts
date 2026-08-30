import type { Interest } from './attention';

/**
 * Turning moments worth looking at into a camera move.
 *
 * The rule that makes this look deliberate rather than nervous: hold still,
 * move decisively, hold still again. A camera that is always drifting is worse
 * than one that never moves, so a zoom has a minimum hold and there is a floor
 * on how often it is allowed to change.
 */

export type ZoomKeyframe = {
  time: number;
  /** 1 is the whole frame. 2 shows half of it. */
  scale: number;
  /** Where the middle of the view sits, 0 to 1. */
  x: number;
  y: number;
};

export type ZoomSettings = {
  enabled: boolean;
  /** How far in to go on a point of interest. */
  scale: number;
  /** How long the move itself takes. */
  moveSeconds: number;
  /** The shortest a zoom is allowed to stay before pulling back out. */
  holdSeconds: number;
  /** How early to arrive before the moment. */
  leadSeconds: number;
};

export const defaultZoom: ZoomSettings = {
  enabled: true,
  scale: 1.8,
  moveSeconds: 0.55,
  holdSeconds: 1.4,
  leadSeconds: 0.25,
};

/**
 * Builds the keyframe track. Each moment becomes: pull in, hold, pull back out,
 * unless the next moment arrives first, in which case the camera slides
 * straight from one to the next without going wide in between.
 *
 * Every keyframe is placed at least one move after the last, which is what
 * keeps the track in order when several moments land almost on top of each
 * other. Without it a flurry of clicks produces keyframes out of sequence and
 * the camera jumps backwards.
 */
export function buildZoomTrack(
  points: Interest[], duration: number, settings: ZoomSettings,
): ZoomKeyframe[] {
  if (!settings.enabled || points.length === 0 || duration <= 0) {
    return [{ time: 0, scale: 1, x: 0.5, y: 0.5 }];
  }

  const scale = Math.max(1, settings.scale);
  const move = Math.max(0.05, settings.moveSeconds);
  const hold = Math.max(0.1, settings.holdSeconds);
  const lead = Math.max(0, settings.leadSeconds);

  const track: ZoomKeyframe[] = [{ time: 0, scale: 1, x: 0.5, y: 0.5 }];
  const ordered = [...points].sort((a, b) => a.time - b.time);

  const push = (frame: ZoomKeyframe) => {
    const last = track[track.length - 1];
    if (frame.time < last.time) return;
    // Two keyframes at the same instant would be a jump cut. The later one wins.
    if (frame.time === last.time) {
      track[track.length - 1] = frame;
      return;
    }
    track.push(frame);
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index];
    const last = track[track.length - 1];

    // Arrive before the action, but never sooner than a full move after the
    // camera last settled.
    const wanted = Math.max(0, point.time - lead);
    const arrive = Math.max(wanted, last.time + move);
    if (arrive > duration) break;

    if (last.scale === 1) {
      // Hold the wide view until the move begins, so the camera is still
      // rather than drifting the whole time.
      push({ time: Math.max(last.time, arrive - move), scale: 1, x: last.x, y: last.y });
    }
    push({ time: arrive, scale, x: point.x, y: point.y });

    const next = ordered[index + 1];
    const nextArrival = next ? Math.max(0, next.time - lead) : Infinity;

    // Pull back out only when there is time to get out and back in again.
    // Otherwise stay in and slide across on the next turn of the loop.
    if (nextArrival > arrive + hold + move * 2) {
      // Both ends are clamped to the recording. Clamping only the release
      // would put it before the hold it is supposed to follow, and it would
      // then be dropped for going backwards.
      const holdUntil = Math.min(duration, arrive + hold);
      push({ time: holdUntil, scale, x: point.x, y: point.y });
      push({ time: Math.min(duration, holdUntil + move), scale: 1, x: 0.5, y: 0.5 });
    }
  }

  const last = track[track.length - 1];
  if (last.scale > 1) {
    push({ time: Math.min(duration, last.time + hold), scale: last.scale, x: last.x, y: last.y });
    push({ time: Math.min(duration, track[track.length - 1].time + move), scale: 1, x: 0.5, y: 0.5 });
  }
  if (track[track.length - 1].time < duration) {
    push({ time: duration, scale: 1, x: 0.5, y: 0.5 });
  }

  return track;
}

/** Smoothstep, which starts and ends at rest rather than jerking into motion. */
export function ease(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

/** The camera position at a moment, eased between the keyframes either side. */
export function zoomAt(track: ZoomKeyframe[], time: number): ZoomKeyframe {
  if (track.length === 0) return { time, scale: 1, x: 0.5, y: 0.5 };
  if (time <= track[0].time) return { ...track[0], time };
  const last = track[track.length - 1];
  if (time >= last.time) return { ...last, time };

  let low = 0;
  let high = track.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (track[middle].time <= time) low = middle;
    else high = middle;
  }

  const before = track[low];
  const after = track[high];
  const span = after.time - before.time;
  const mix = span <= 0 ? 1 : ease((time - before.time) / span);

  return {
    time,
    scale: before.scale + (after.scale - before.scale) * mix,
    x: before.x + (after.x - before.x) * mix,
    y: before.y + (after.y - before.y) * mix,
  };
}

/**
 * The rectangle to take out of the source, in pixels.
 *
 * The centre is pulled back so the view never runs off the edge, because a
 * strip of background where the picture should be is the one thing that makes
 * an automatic zoom look broken.
 */
export function viewRect(
  frame: ZoomKeyframe, width: number, height: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(1, frame.scale);
  const viewWidth = width / scale;
  const viewHeight = height / scale;

  const centreX = frame.x * width;
  const centreY = frame.y * height;

  return {
    x: clamp(centreX - viewWidth / 2, 0, width - viewWidth),
    y: clamp(centreY - viewHeight / 2, 0, height - viewHeight),
    width: viewWidth,
    height: viewHeight,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return value < low ? low : value > high ? high : value;
}
