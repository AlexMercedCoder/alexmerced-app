import { keptDuration, mergeSpans, type Span } from './waveform';
import { mergeBlocks, type ZoomBlock } from './zooms';

/**
 * The whole first pass over a fresh recording, as one press.
 *
 * Both halves of this already existed and both had to be found. Removing the
 * dead air lives behind the Sound track, adding the zooms lives behind the Zoom
 * track, and somebody who has just stopped recording is looking at neither.
 * The result was that the two things the app is best at were the two things
 * least likely to happen.
 *
 * The planning is here rather than in the handler because the decisions are
 * worth being explicit about, and every one of them is a decision about not
 * touching work somebody has already done.
 */

export type TidyInput = {
  /** The quiet stretches, before anything has been clipped to the trim. */
  silences: Span[];
  /** Cuts that are already in place. */
  cuts: Span[];
  trim: { start: number; end: number };
  /** The zooms as they stand, including any placed by hand. */
  zooms: ZoomBlock[];
  /** What the attention pass suggests, whether or not it is wanted. */
  suggested: ZoomBlock[];
};

export type TidyPlan = {
  cuts: Span[];
  zooms: ZoomBlock[];
  /** How many new cuts and zooms this actually adds. */
  addedCuts: number;
  addedZooms: number;
  /** Seconds the cuts take off the finished video. */
  saved: number;
};

/** Below this a cut is not worth the join it introduces. */
const SHORTEST_CUT = 0.05;

/**
 * Works out what a tidy would do, without doing any of it.
 *
 * Two rules, both about not undoing work:
 *
 * A silence outside the trim is ignored. Cutting from a part that is already
 * being thrown away changes nothing and makes the count of what happened a lie.
 *
 * A zoom placed by hand wins. `mergeBlocks` keeps every pinned block and drops
 * any suggestion that overlaps one, so pressing this after an hour of work
 * cannot move a zoom somebody aimed themselves.
 */
export function planTidy(input: TidyInput): TidyPlan {
  const trimmed = input.silences
    .map((span) => ({
      start: Math.max(span.start, input.trim.start),
      end: Math.min(span.end, input.trim.end),
    }))
    .filter((span) => span.end - span.start > SHORTEST_CUT);

  const before = keptDuration(input.cuts, input.trim.start, input.trim.end);
  const cuts = mergeSpans([...input.cuts, ...trimmed]);
  const saved = Math.max(0, before - keptDuration(cuts, input.trim.start, input.trim.end));

  const zooms = mergeBlocks(input.zooms, input.suggested);

  return {
    cuts,
    zooms,
    // What changed, not what was proposed. Overlapping silences merge into
    // fewer cuts than were found, and a suggestion under a pinned zoom is
    // dropped, so counting the inputs would overstate both.
    addedCuts: Math.max(0, cuts.length - input.cuts.length),
    addedZooms: Math.max(0, zooms.length - input.zooms.length),
    saved,
  };
}

/** Whether this would do anything at all. */
export function tidyChangesAnything(plan: TidyPlan): boolean {
  return plan.addedCuts > 0 || plan.addedZooms > 0;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What it did, in a sentence.
 *
 * Said out loud rather than left to be noticed, because this changes the
 * timeline in two places at once and an unexplained edit is indistinguishable
 * from a bug.
 */
export function describeTidy(plan: TidyPlan, formatClock: (seconds: number) => string): string {
  if (!tidyChangesAnything(plan)) {
    return 'Nothing to tidy: no quiet gaps worth cutting, and no zooms to suggest.';
  }
  const parts: string[] = [];
  if (plan.addedCuts > 0) {
    parts.push(`cut ${count(plan.addedCuts, 'quiet gap', 'quiet gaps')}, ${formatClock(plan.saved)} shorter`);
  }
  if (plan.addedZooms > 0) parts.push(`added ${count(plan.addedZooms, 'zoom', 'zooms')}`);
  const said = parts.join(' and ');
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
}
