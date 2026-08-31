/**
 * The words, and editing by them.
 *
 * The waveform says where somebody stopped talking. A transcript says what
 * they said, and that changes the editing model: select a sentence, delete it,
 * and the video loses those seconds. Cuts already do the hard part, so a
 * transcript is mostly a matter of knowing which seconds a sentence occupies.
 *
 * Speech recognition itself is not here. Doing it locally needs a model of tens
 * of megabytes that has to be vendored deliberately rather than invented, so
 * this reads a transcript that already exists: SRT or VTT from any source, or
 * typed in. Everything downstream of having one works either way.
 */

export type Cue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{1,2}):(\d{2})[,.](\d{1,3})/;

/** Reads a timestamp in either format, since SRT uses a comma and VTT a dot. */
export function parseTime(value: string): number | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  if (match[1] !== undefined) {
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      + Number(match[4].padEnd(3, '0')) / 1000;
  }
  return Number(match[5]) * 60 + Number(match[6]) + Number(match[7].padEnd(3, '0')) / 1000;
}

export function formatTime(seconds: number, comma = false): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${comma ? ',' : '.'}${pad(ms, 3)}`;
}

/**
 * Reads SRT or VTT.
 *
 * One parser for both, because they differ in the separator inside a timestamp,
 * an optional header, and cue numbering, none of which is worth two code paths.
 * Anything that is not a recognisable cue is skipped rather than failing the
 * whole file: a transcript with one malformed block is still worth having.
 */
export function parseCaptions(text: string, makeId: () => string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0])) lines.shift();

    const arrowIndex = lines.findIndex((line) => line.includes('-->'));
    if (arrowIndex === -1) continue;

    const [from, to] = lines[arrowIndex].split('-->');
    const start = parseTime(from ?? '');
    const end = parseTime(to ?? '');
    if (start === null || end === null || end <= start) continue;

    const body = lines.slice(arrowIndex + 1).join('\n').trim();
    if (!body) continue;
    cues.push({ id: makeId(), start, end, text: body });
  }
  return sortCues(cues);
}

export function sortCues(cues: Cue[]): Cue[] {
  return [...cues]
    .filter((cue) => cue.end > cue.start && cue.text.trim().length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export function toSrt(cues: Cue[]): string {
  return sortCues(cues)
    .map((cue, index) =>
      `${index + 1}\n${formatTime(cue.start, true)} --> ${formatTime(cue.end, true)}\n${cue.text}`)
    .join('\n\n')
    .concat('\n');
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${sortCues(cues)
    .map((cue) => `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.text}`)
    .join('\n\n')}\n`;
}

/** The cues showing at a moment. */
export function cuesAt(cues: Cue[], time: number): Cue[] {
  return sortCues(cues).filter((cue) => time >= cue.start && time <= cue.end);
}

/**
 * Shifts and drops cues so they still line up after the video was cut.
 *
 * A transcript is written against the recording, but it is shown against the
 * finished video, and those stop agreeing the moment anything is removed. A cue
 * entirely inside a cut goes; one that straddles a cut is trimmed to the part
 * that survives, which is better than dropping a whole sentence because its
 * first word was in a pause somebody removed.
 */
export function alignToEdit(
  cues: Cue[], toEdited: (source: number) => number, isRemoved: (source: number) => boolean,
): Cue[] {
  const out: Cue[] = [];
  for (const cue of sortCues(cues)) {
    const startRemoved = isRemoved(cue.start);
    const endRemoved = isRemoved(Math.max(cue.start, cue.end - 1e-4));
    if (startRemoved && endRemoved) continue;

    const start = toEdited(cue.start);
    const end = toEdited(cue.end);
    if (end - start < 0.05) continue;
    out.push({ ...cue, start, end });
  }
  return out;
}

/**
 * The stretches a set of cues occupies, for deleting a passage of transcript.
 *
 * This is what makes editing by transcript the same operation as cutting: the
 * selected sentences become spans, and the spans become cuts, and everything
 * downstream already knows what a cut means.
 */
export function spansOf(cues: Cue[], ids: string[]): { start: number; end: number }[] {
  const wanted = new Set(ids);
  return sortCues(cues)
    .filter((cue) => wanted.has(cue.id))
    .map((cue) => ({ start: cue.start, end: cue.end }));
}

/** Splits a cue in two at a moment, for fixing a caption that runs on. */
export function splitCue(cues: Cue[], id: string, at: number, makeId: () => string): Cue[] {
  const cue = cues.find((entry) => entry.id === id);
  if (!cue || at - cue.start < 0.1 || cue.end - at < 0.1) return cues;
  // The words cannot be split sensibly by time, so they stay with the first
  // half and the second starts empty for somebody to fill in.
  return sortCues([
    ...cues.filter((entry) => entry.id !== id),
    { ...cue, end: at },
    { id: makeId(), start: at, end: cue.end, text: '…' },
  ]);
}

export function reviveCues(value: unknown, makeId: () => string): Cue[] {
  if (!Array.isArray(value)) return [];
  return sortCues(value
    .filter((entry): entry is Cue =>
      typeof entry === 'object' && entry !== null
      && Number.isFinite((entry as Cue).start) && Number.isFinite((entry as Cue).end)
      && typeof (entry as Cue).text === 'string')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : makeId(),
      start: Math.max(0, entry.start),
      end: entry.end,
      text: entry.text,
    })));
}
