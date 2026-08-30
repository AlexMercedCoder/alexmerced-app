import { createId } from '../../lib/id';

/**
 * Captions laid over the recording.
 *
 * The same shape as a zoom block, on purpose: a thing with a start, an end and
 * a place on the timeline, edited by dragging. Keeping the two alike means the
 * timeline behaves the same way whichever track you are working in, which
 * matters more than either feature does on its own.
 *
 * Text is drawn into the frame at export time rather than composited from HTML,
 * so what the preview shows and what the file contains are produced by the same
 * code and cannot drift apart.
 */

export type TextAlign = 'left' | 'centre' | 'right';

export type TextBlock = {
  id: string;
  text: string;
  /** Seconds into the recording. */
  start: number;
  end: number;
  /** Where the text sits in the finished frame, 0 to 1. */
  x: number;
  y: number;
  /** Line height as a fraction of the output's shorter edge. */
  size: number;
  colour: string;
  /** How solid the plate behind the text is. Zero draws no plate. */
  plate: number;
  align: TextAlign;
  /** How long the text takes to appear and to leave. */
  fade: number;
};

/** The shortest caption worth having, in seconds. */
export const MIN_TEXT = 0.4;

/** How long a new caption runs before you change it. */
export const DEFAULT_TEXT_SECONDS = 2.5;

export function defaultText(at: number, duration: number): TextBlock {
  const start = Math.max(0, Math.min(at, Math.max(0, duration - MIN_TEXT)));
  return {
    id: createId('txt'),
    text: 'Say something here',
    start,
    end: Math.min(duration, start + DEFAULT_TEXT_SECONDS),
    x: 0.5,
    y: 0.86,
    size: 0.06,
    colour: '#ffffff',
    plate: 0.55,
    align: 'centre',
    fade: 0.25,
  };
}

/**
 * Adds a caption at a moment.
 *
 * Captions may overlap, unlike zooms: two things can be said at once, and a
 * title over a subtitle is an ordinary thing to want. So this always adds.
 */
export function addText(blocks: TextBlock[], at: number, duration: number): TextBlock[] {
  if (duration <= 0) return blocks;
  return [...blocks, defaultText(at, duration)].sort((a, b) => a.start - b.start);
}

export function removeText(blocks: TextBlock[], id: string): TextBlock[] {
  return blocks.filter((block) => block.id !== id);
}

export function updateText(blocks: TextBlock[], id: string, change: Partial<TextBlock>): TextBlock[] {
  return blocks.map((block) => (block.id === id ? { ...block, ...change, id: block.id } : block));
}

/** Pulls one caption back inside the recording without disturbing the others. */
export function constrainText(blocks: TextBlock[], id: string, duration: number): TextBlock[] {
  return blocks
    .map((block) => {
      if (block.id !== id) return block;
      const length = Math.max(MIN_TEXT, Math.min(duration, block.end - block.start));
      const start = Math.max(0, Math.min(block.start, Math.max(0, duration - length)));
      return { ...block, start, end: Math.min(duration, start + length) };
    })
    .sort((a, b) => a.start - b.start);
}

export function reviveTexts(value: unknown): TextBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: TextBlock[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const block = entry as Partial<TextBlock>;
    if (typeof block.text !== 'string') continue;

    const number = (input: unknown, low: number, high: number, spare: number) =>
      typeof input === 'number' && Number.isFinite(input) ? Math.max(low, Math.min(high, input)) : spare;

    const start = number(block.start, 0, Number.MAX_SAFE_INTEGER, 0);
    const end = number(block.end, 0, Number.MAX_SAFE_INTEGER, start + DEFAULT_TEXT_SECONDS);

    blocks.push({
      id: typeof block.id === 'string' && block.id ? block.id : createId('txt'),
      text: block.text,
      start,
      end: Math.max(start + MIN_TEXT, end),
      x: number(block.x, 0, 1, 0.5),
      y: number(block.y, 0, 1, 0.86),
      size: number(block.size, 0.01, 0.4, 0.06),
      colour: typeof block.colour === 'string' && block.colour ? block.colour : '#ffffff',
      plate: number(block.plate, 0, 1, 0.55),
      align: block.align === 'left' || block.align === 'right' ? block.align : 'centre',
      fade: number(block.fade, 0, 3, 0.25),
    });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

/**
 * How solid a caption is at a moment, or zero when it is not on screen.
 *
 * A fade longer than half the caption would cross over itself and the text
 * would never reach full strength, so it is capped at half either way.
 */
export function opacityAt(block: TextBlock, time: number): number {
  if (time < block.start || time > block.end) return 0;
  const length = block.end - block.start;
  const fade = Math.max(0, Math.min(block.fade, length / 2));
  if (fade === 0) return 1;

  const since = time - block.start;
  const until = block.end - time;
  return Math.max(0, Math.min(1, Math.min(since / fade, until / fade)));
}

/** The captions showing at a moment, with how solid each one is. */
export function textsAt(blocks: TextBlock[], time: number): { block: TextBlock; opacity: number }[] {
  const showing: { block: TextBlock; opacity: number }[] = [];
  for (const block of blocks) {
    const opacity = opacityAt(block, time);
    if (opacity > 0) showing.push({ block, opacity });
  }
  return showing;
}

/**
 * Breaks a caption into lines.
 *
 * Line breaks that were typed are always kept. Beyond that, words are moved to
 * the next line when they would not fit, and a single word too long for the
 * width is left to overflow rather than broken mid-word, because a caption with
 * a hyphen inserted into somebody's name reads worse than one that is wide.
 */
export function wrapText(text: string, maxWidth: number, measure: (line: string) => number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(''); continue; }

    let line = '';
    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}
