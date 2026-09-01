/**
 * Saying out loud what the page has just done.
 *
 * Everything in the editor was visible only. A recording starting, an export
 * finishing, a model coming down, a block being deleted: all of it changed
 * pixels and announced nothing, so somebody working by ear had no way to tell
 * whether a key press had done anything at all.
 *
 * A live region is easy to add and easy to make useless. The two ways it goes
 * wrong are both about volume: progress arrives many times a second, and the
 * same message written twice by two renders gets read twice. Both are handled
 * here rather than at each of the thirty call sites.
 */

/** How much progress has to have been made before it is worth saying again. */
const PROGRESS_STEP = 0.25;

/** And how long, for a stage that reports no figure at all. */
const PROGRESS_GAP = 5000;

/** The window in which the same words are treated as one event, not two. */
const REPEAT_GAP = 700;

export type SpeechMemory = {
  /** The last thing said, and when. */
  text: string;
  at: number;
  /** The progress figure that was last said out loud, or -1 before any. */
  ratio: number;
};

export function emptyMemory(): SpeechMemory {
  return { text: '', at: -Infinity, ratio: -1 };
}

/**
 * Whether these exact words are just the same event arriving twice.
 *
 * Renders are not idempotent from a listener's point of view. Adding a caption
 * redraws the track and the panel, and if both said "caption added" it would be
 * read twice with no way to tell that nothing happened the second time.
 */
export function isRepeat(text: string, memory: SpeechMemory, at: number): boolean {
  return text === memory.text && at - memory.at < REPEAT_GAP;
}

/**
 * Whether a progress figure has moved enough to be worth another sentence.
 *
 * A quarter at a time. Fewer is not enough to tell that anything is happening
 * on a long export, and more turns a two minute render into a monologue. A
 * stage with no figure at all falls back to time, so "Fetching the model" is
 * repeated occasionally rather than said once and then silence.
 */
export function progressWorthSaying(
  ratio: number | null, memory: SpeechMemory, at: number,
): boolean {
  if (ratio === null) return at - memory.at >= PROGRESS_GAP;
  if (ratio >= 1) return memory.ratio < 1;
  return ratio - memory.ratio >= PROGRESS_STEP;
}

/** Rounds a share to the nearest quarter, which is what gets said. */
export function asPercent(ratio: number): string {
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

export type Speaker = {
  /** Something that has happened. Said once. */
  say: (text: string) => void;
  /** Something that is happening. Said occasionally. */
  progress: (label: string, ratio: number | null) => void;
  /** A stage has ended, so the next one starts from nothing. */
  settle: () => void;
};

/**
 * Wires a live region up to those rules.
 *
 * The clock is passed in so the rate limiting can be tested without waiting.
 */
export function mountSpeaker(region: HTMLElement, clock: () => number = () => Date.now()): Speaker {
  let memory = emptyMemory();

  const write = (text: string, at: number, ratio = -1): void => {
    // Assigning the same string twice does not always re-announce, and an
    // empty string first is the usual way to force it.
    if (region.textContent === text) region.textContent = '';
    region.textContent = text;
    memory = { text, at, ratio };
  };

  return {
    say(text) {
      const at = clock();
      if (!text.trim() || isRepeat(text, memory, at)) return;
      write(text, at);
    },
    progress(label, ratio) {
      const at = clock();
      if (!progressWorthSaying(ratio, memory, at)) return;
      write(ratio === null ? label : `${label}, ${asPercent(ratio)}`, at, ratio ?? -1);
    },
    settle() {
      memory = emptyMemory();
    },
  };
}
