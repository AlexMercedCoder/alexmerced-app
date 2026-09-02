/**
 * More than one recording on one timeline.
 *
 * Everything in this editor addresses source seconds. A zoom sits at 4.2, a
 * caption runs from 9 to 12, a cut removes 20 to 24. That worked because there
 * was exactly one recording and its own clock was the timeline's clock.
 *
 * The reel keeps that true while allowing several recordings. Clips are laid
 * end to end on one continuous line of seconds, and everything downstream goes
 * on addressing that line without knowing it is made of pieces. Only two things
 * ever need to look inside: whatever is fetching a frame, and whatever is
 * assembling the sound.
 *
 * A clip is a window onto a recording rather than a whole one, which is what
 * makes a retake possible: recording over the middle of a take splits the clip
 * either side of it and drops the new one in between.
 */

export type Clip = {
  id: string;
  /** A person's name for the take. Empty falls back to its position. */
  name?: string;
  /** Which recording this comes from. */
  source: string;
  /** The window of that recording to use, in its own seconds. */
  in: number;
  out: number;
  /** Clip-local audio. One is unchanged, zero is silent. */
  gain?: number;
  muted?: boolean;
  /** Seconds over which sound enters and leaves. */
  fadeIn?: number;
  fadeOut?: number;
};

/** A clip with its position on the reel worked out. */
export type Placed = Clip & {
  /** Where it starts on the reel, in reel seconds. */
  at: number;
  /** How long it runs. */
  length: number;
};

export function clipLength(clip: Clip): number {
  return Math.max(0, clip.out - clip.in);
}

/** Where each clip sits, laid end to end with no gaps. */
export function layout(clips: Clip[]): Placed[] {
  const out: Placed[] = [];
  let at = 0;
  for (const clip of clips) {
    const length = clipLength(clip);
    if (length <= 0) continue;
    out.push({ ...clip, at, length });
    at += length;
  }
  return out;
}

export function reelDuration(clips: Clip[]): number {
  return clips.reduce((total, clip) => total + clipLength(clip), 0);
}

/**
 * Which recording to show for a moment on the reel, and where in it.
 *
 * Past the end it clamps to the last frame there is rather than returning
 * nothing, because a rounding error on the final frame of an export must not
 * turn into a hole in the video.
 */
export function sourceOf(
  placed: Placed[], time: number,
): { source: string; time: number; clip: string } | null {
  if (placed.length === 0) return null;
  const wanted = Math.max(0, time);
  for (const clip of placed) {
    if (wanted < clip.at + clip.length) {
      return {
        source: clip.source,
        time: clip.in + Math.max(0, wanted - clip.at),
        clip: clip.id,
      };
    }
  }
  const last = placed[placed.length - 1];
  return { source: last.source, time: last.out, clip: last.id };
}

/** Where one clip gives way to the next, for drawing the joins. */
export function joins(placed: Placed[]): number[] {
  return placed.slice(1).map((clip) => clip.at);
}

/**
 * Cuts the reel at a moment, so a clip can be dropped in there.
 *
 * A clip that straddles the moment becomes two windows onto the same
 * recording. One that already starts or ends there is left alone: splitting on
 * a boundary would add an empty clip, and an empty clip is a join with nothing
 * between it.
 */
export function splitAt(clips: Clip[], time: number, makeId: () => string): Clip[] {
  const out: Clip[] = [];
  let at = 0;
  for (const clip of clips) {
    const length = clipLength(clip);
    const inside = time > at && time < at + length;
    if (inside) {
      const offset = clip.in + (time - at);
      out.push({ ...clip, out: offset });
      out.push({ ...clip, id: makeId(), in: offset });
    } else {
      out.push(clip);
    }
    at += length;
  }
  return out;
}

/**
 * Everything outside a stretch of the reel, as clips.
 *
 * The stretch itself is dropped, which is what replacing it means. Used by both
 * halves of a retake: what comes before, and what comes after.
 */
export function without(clips: Clip[], span: { start: number; end: number }, makeId: () => string): Clip[] {
  const from = Math.min(span.start, span.end);
  const to = Math.max(span.start, span.end);
  // A stretch of no length removes nothing. Without this the overlap branch
  // below splits a clip in two at that point, which changes nothing visible and
  // leaves a join in the reel that nobody asked for.
  if (to <= from) return clips;
  const out: Clip[] = [];
  let at = 0;
  for (const clip of clips) {
    const length = clipLength(clip);
    const end = at + length;
    // Wholly inside the stretch, so it goes.
    if (at >= from && end <= to) { at = end; continue; }
    // Wholly outside it, so it stays.
    if (end <= from || at >= to) { out.push(clip); at = end; continue; }

    // Overlapping, so the part outside survives. Both halves can survive at
    // once, when the stretch is in the middle of one clip.
    if (at < from) out.push({ ...clip, out: clip.in + (from - at) });
    if (end > to) out.push({ ...clip, id: makeId(), in: clip.in + (to - at) });
    at = end;
  }
  return out;
}

export type Splice = {
  clips: Clip[];
  /** Where the new material starts on the reel. */
  at: number;
  /** How much longer or shorter everything after it has become. */
  shift: number;
};

/**
 * Puts a recording in place of a stretch of the reel.
 *
 * This is a retake. The stretch being replaced is almost never the same length
 * as what replaces it, so everything after it moves, and the amount it moves by
 * is returned rather than applied here: zooms, captions, shapes, cuts and speed
 * regions all live on the same line of seconds and all have to move with it.
 */
export function splice(
  clips: Clip[], span: { start: number; end: number }, replacement: Clip, makeId: () => string,
): Splice {
  const from = Math.max(0, Math.min(span.start, span.end));
  const to = Math.max(from, Math.max(span.start, span.end));
  // Removing the stretch leaves a boundary exactly where the replacement goes.
  // When the stretch is empty there is nothing to remove and no boundary, so
  // one is made: inserting at four seconds has to split the clip at four
  // seconds, not put the new material after the whole thing.
  const kept = splitAt(without(clips, { start: from, end: to }, makeId), from, makeId);

  const before: Clip[] = [];
  const after: Clip[] = [];
  let at = 0;
  for (const clip of kept) {
    // Measured against the reel with the stretch already gone, so anything
    // sitting at or past the hole belongs after the replacement.
    (at < from ? before : after).push(clip);
    at += clipLength(clip);
  }

  return {
    clips: [...before, replacement, ...after],
    at: from,
    shift: clipLength(replacement) - (to - from),
  };
}

/**
 * Moves everything that sits after a moment.
 *
 * A block straddling the splice is left where it starts rather than stretched:
 * a caption that ran across the passage being replaced was written about what
 * used to be there, and guessing how much of it still applies would be worse
 * than leaving it visible and wrong in one place a person can see.
 */
export function shiftAfter<T extends { start: number; end: number }>(
  blocks: T[], from: number, shift: number,
): T[] {
  if (shift === 0) return blocks;
  return blocks.map((block) => (block.start >= from
    ? { ...block, start: Math.max(0, block.start + shift), end: Math.max(0, block.end + shift) }
    : block));
}

/** A reel of exactly one recording, which is what every project starts as. */
export function singleClip(source: string, duration: number, id = 'clip-1'): Clip {
  return { id, source, in: 0, out: Math.max(0, duration) };
}

/** Whether this is still the plain one recording case. */
export function isSingle(clips: Clip[]): boolean {
  return clips.length <= 1;
}

/**
 * Whether the reel is still exactly the untouched first recording.
 *
 * Counting clips is not enough: after removing from a two-clip reel, the one
 * survivor may be a different take or only a window of the first one. That is
 * still a reel and must keep its clip/source mapping when saved and rendered.
 */
export function isPlainRecording(clips: Clip[], source: string, duration: number): boolean {
  if (clips.length === 0) return true;
  if (clips.length !== 1) return false;
  const [clip] = clips;
  return clip.source === source
    && Math.abs(clip.in) < 0.001
    && Math.abs(clip.out - Math.max(0, duration)) < 0.001;
}

export function reviveClips(value: unknown, makeId: () => string): Clip[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Clip =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as Clip).source === 'string'
      && Number.isFinite((entry as Clip).in) && Number.isFinite((entry as Clip).out))
    .map((entry) => {
      const input = entry as Clip;
      const start = Math.max(0, input.in);
      const end = Math.max(0, input.out);
      const length = Math.max(0, end - start);
      const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
      const gain = Number.isFinite(input.gain) ? Math.max(0, Math.min(2, input.gain!)) : 1;
      const fadeIn = Number.isFinite(input.fadeIn) ? Math.max(0, Math.min(length, input.fadeIn!)) : 0;
      const fadeOut = Number.isFinite(input.fadeOut) ? Math.max(0, Math.min(length, input.fadeOut!)) : 0;
      return {
        id: typeof input.id === 'string' ? input.id : makeId(),
        source: input.source,
        in: start,
        out: end,
        ...(name ? { name } : {}),
        ...(gain !== 1 ? { gain } : {}),
        ...(input.muted === true ? { muted: true } : {}),
        ...(fadeIn > 0 ? { fadeIn } : {}),
        ...(fadeOut > 0 ? { fadeOut } : {}),
      };
    })
    .filter((clip) => clip.out > clip.in);
}

/**
 * Segments of the reel, rewritten as segments of the recordings underneath.
 *
 * The trim, the cuts and the speed regions all describe the reel, and a single
 * one of their segments can run across a join. The sound has to be assembled
 * out of the right recordings in the right order, so each segment is split at
 * every boundary it crosses and each piece is given the recording it belongs to
 * along with that recording's own seconds.
 */
export function acrossClips(
  placed: Placed[],
  segments: { start: number; end: number; speed: number }[],
): {
  start: number; end: number; speed: number; source: string;
  gain?: number; muted?: boolean; fadeIn?: number; fadeOut?: number;
  clipFrom?: number; clipLength?: number;
}[] {
  const out: ReturnType<typeof acrossClips> = [];
  for (const segment of segments) {
    for (const clip of placed) {
      const from = Math.max(segment.start, clip.at);
      const to = Math.min(segment.end, clip.at + clip.length);
      if (to <= from) continue;
      out.push({
        start: clip.in + (from - clip.at),
        end: clip.in + (to - clip.at),
        speed: segment.speed,
        source: clip.source,
        ...(clip.gain !== undefined ? { gain: clip.gain } : {}),
        ...(clip.muted ? { muted: true } : {}),
        ...(clip.fadeIn ? { fadeIn: clip.fadeIn } : {}),
        ...(clip.fadeOut ? { fadeOut: clip.fadeOut } : {}),
        ...((clip.fadeIn || clip.fadeOut) ? {
          clipFrom: from - clip.at,
          clipLength: clip.length,
        } : {}),
      });
    }
  }
  return out;
}

/** Takes a clip off the reel. */
export function removeClip(clips: Clip[], id: string): Clip[] {
  return clips.filter((clip) => clip.id !== id);
}

/**
 * Swaps a clip with its neighbour.
 *
 * By -1 for earlier and 1 for later. At either end there is nothing to swap
 * with, and the reel comes back unchanged rather than the clip falling off it.
 */
export function moveClip(clips: Clip[], id: string, by: -1 | 1): Clip[] {
  const from = clips.findIndex((clip) => clip.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= clips.length) return clips;
  const out = [...clips];
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}

/** Moves a clip to an exact position, as drag and drop needs. */
export function moveClipTo(clips: Clip[], id: string, index: number): Clip[] {
  const from = clips.findIndex((clip) => clip.id === id);
  if (from < 0) return clips;
  const to = Math.max(0, Math.min(clips.length - 1, Math.round(index)));
  if (from === to) return clips;
  const out = [...clips];
  const [moving] = out.splice(from, 1);
  out.splice(to, 0, moving);
  return out;
}

/** Changes the editable, clip-local properties without touching its identity. */
export function updateClip(
  clips: Clip[], id: string,
  change: Partial<Pick<Clip, 'name' | 'in' | 'out' | 'gain' | 'muted' | 'fadeIn' | 'fadeOut'>>,
  sourceDuration = Number.POSITIVE_INFINITY,
): Clip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0) return clips;
  const clip = clips[index];
  const limit = Number.isFinite(sourceDuration) ? Math.max(0.05, sourceDuration) : Number.POSITIVE_INFINITY;
  let start = Math.max(0, Math.min(change.in ?? clip.in, limit - 0.05));
  let end = Math.max(start + 0.05, Math.min(change.out ?? clip.out, limit));
  if (end > limit) { end = limit; start = Math.min(start, Math.max(0, end - 0.05)); }
  const length = end - start;
  const name = (change.name ?? clip.name ?? '').trim().slice(0, 80);
  const gain = Math.max(0, Math.min(2, change.gain ?? clip.gain ?? 1));
  const fadeIn = Math.max(0, Math.min(length, change.fadeIn ?? clip.fadeIn ?? 0));
  const fadeOut = Math.max(0, Math.min(length, change.fadeOut ?? clip.fadeOut ?? 0));
  const next: Clip = {
    ...clip, in: start, out: end,
    ...(name ? { name } : { name: undefined }),
    ...(gain !== 1 ? { gain } : { gain: undefined }),
    ...((change.muted ?? clip.muted) ? { muted: true } : { muted: undefined }),
    ...(fadeIn > 0 ? { fadeIn } : { fadeIn: undefined }),
    ...(fadeOut > 0 ? { fadeOut } : { fadeOut: undefined }),
  };
  const out = [...clips];
  out[index] = next;
  return out;
}

/**
 * Moves everything on the timeline to follow the clips it was written against.
 *
 * `shiftAfter` is right for an insertion, where everything past a point moves
 * by the same amount. Removing or reordering is not that: a caption written
 * over the third take belongs to the third take, and if that take moves to the
 * front the caption goes with it rather than staying at nineteen seconds where
 * something else is now.
 *
 * A block whose clip is gone goes too. It was about a passage that no longer
 * exists, and leaving it would put words over whatever moved into that gap.
 */
export function remapBlocks<T extends { start: number; end: number }>(
  blocks: T[], before: Placed[], after: Placed[], makeId?: () => string,
): { blocks: T[]; dropped: number } {
  const moved = new Map(after.map((clip) => [clip.id, clip]));
  const out: T[] = [];
  let dropped = 0;

  for (const block of blocks) {
    const homes = before.filter((clip) =>
      block.end > clip.at && block.start < clip.at + clip.length);
    if (homes.length === 0) {
      // Past the end of every clip, which is where a block sits when the reel
      // has shrunk under it. Kept where it is; the caller clamps.
      out.push(block);
      continue;
    }
    let kept = 0;
    for (const home of homes) {
      const now = moved.get(home.id);
      if (!now) continue;
      const localStart = Math.max(block.start, home.at) - home.at;
      const localEnd = Math.min(block.end, home.at + home.length) - home.at;
      if (localStart >= now.length) continue;
      const keptEnd = Math.min(localEnd, now.length);
      if (keptEnd <= localStart) continue;
      const piece = {
        ...block,
        start: now.at + localStart,
        end: now.at + keptEnd,
      };
      if (kept > 0 && makeId && 'id' in piece && typeof piece.id === 'string') piece.id = makeId();
      out.push(piece);
      kept += 1;
    }
    if (kept === 0) dropped += 1;
  }
  return { blocks: out.sort((a, b) => a.start - b.start || a.end - b.end), dropped };
}
