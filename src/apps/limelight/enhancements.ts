import { sortCues, type Cue } from './captions';
import { editedAt, editedDuration, segmentsOf, sourceAt } from './timeline';
import type { Project } from './render';
import type { Segment } from './timeline';

export type CaptionStyle = {
  font: 'sans' | 'serif' | 'mono';
  color: string;
  background: string;
  opacity: number;
  position: 'top' | 'center' | 'bottom';
  lineHeight: number;
  margin: number;
};
export const defaultCaptionStyle: CaptionStyle = {
  font: 'sans',
  color: '#f6f4ef',
  background: '#0a0a0c',
  opacity: 0.72,
  position: 'bottom',
  lineHeight: 1.28,
  margin: 0.06,
};
export function captionStyle(value: unknown): CaptionStyle {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<CaptionStyle>;
  const number = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  const color = (c: unknown, fallback: string) =>
    typeof c === 'string' && /^#[a-f0-9]{6}$/i.test(c) ? c : fallback;
  return {
    font: v.font === 'serif' || v.font === 'mono' ? v.font : 'sans',
    color: color(v.color, defaultCaptionStyle.color),
    background: color(v.background, defaultCaptionStyle.background),
    opacity: number(v.opacity, 0.72, 0, 1),
    position: v.position === 'top' || v.position === 'center' ? v.position : 'bottom',
    lineHeight: number(v.lineHeight, 1.28, 1, 2),
    margin: number(v.margin, 0.06, 0, 0.25),
  };
}
export function replaceWords(cues: Cue[], find: string, replacement: string): Cue[] {
  if (!find) return cues;
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return cues.map((c) => ({ ...c, text: c.text.replace(pattern, () => replacement) }));
}
export function shiftCues(cues: Cue[], seconds: number, duration: number): Cue[] {
  if (!Number.isFinite(seconds)) throw new Error('Enter a valid timing shift.');
  if (cues.some((c) => c.start + seconds < 0 || c.end + seconds > duration))
    throw new Error('The shift would move a subtitle outside the recording.');
  return cues.map((c) => ({ ...c, start: c.start + seconds, end: c.end + seconds }));
}
export function mergeCues(cues: Cue[], ids: Set<string>): Cue[] {
  const sorted = sortCues(cues),
    chosen = sorted.filter((c) => ids.has(c.id));
  if (chosen.length < 2) throw new Error('Select at least two adjacent subtitle lines.');
  const first = sorted.indexOf(chosen[0]);
  if (sorted.slice(first, first + chosen.length).some((c) => !ids.has(c.id)))
    throw new Error('Select adjacent lines to merge.');
  return sortCues([
    ...sorted.filter((c) => !ids.has(c.id)),
    {
      ...chosen[0],
      end: Math.max(...chosen.map((c) => c.end)),
      text: chosen.map((c) => c.text).join(' '),
    },
  ]);
}
export function overlappingCues(cues: Cue[]): Set<string> {
  const sorted = sortCues(cues),
    ids = new Set<string>();
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
      ids.add(sorted[i].id);
      ids.add(sorted[j].id);
    }
  return ids;
}
export function snapShift(
  edge: 'start' | 'end' | 'move',
  start: number,
  end: number,
  shift: number,
  targets: number[],
  tolerance: number,
): number {
  const edges = edge === 'move' ? [start, end] : [edge === 'start' ? start : end];
  let best = tolerance,
    result = shift;
  for (const at of edges)
    for (const target of targets) {
      const difference = target - (at + shift);
      if (Math.abs(difference) < best) {
        best = Math.abs(difference);
        result = shift + difference;
      }
    }
  return result;
}
export function alignCuesToSegments(cues: Cue[], parts: Segment[]): Cue[] {
  return cues.flatMap((cue) => {
    const intersections = parts
      .map((p) => ({ start: Math.max(p.start, cue.start), end: Math.min(p.end, cue.end) }))
      .filter((p) => p.end > p.start);
    if (!intersections.length) return [];
    return [
      {
        ...cue,
        start: editedAt(parts, intersections[0].start),
        end: editedAt(parts, intersections.at(-1)!.end),
      },
    ];
  });
}
export function exportDuration(project: Project): number {
  return editedDuration(
    segmentsOf(
      { start: project.start, end: project.end },
      project.cuts ?? [],
      project.speeds ?? [],
    ),
  );
}
/** Select in edited seconds, then rebuild subtitle times relative to this export. */
export function excerptProject(
  project: Project,
  sourceCues: Cue[],
  from: number,
  seconds: number,
): Project {
  const full = segmentsOf(
    { start: project.start, end: project.end },
    project.cuts ?? [],
    project.speeds ?? [],
  );
  const total = editedDuration(full);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(seconds) ||
    from < 0 ||
    seconds <= 0 ||
    from >= total
  )
    throw new Error('Choose a test range inside the finished video.');
  const start = sourceAt(full, from),
    end = sourceAt(full, Math.min(total, from + seconds));
  const parts = segmentsOf({ start, end }, project.cuts ?? [], project.speeds ?? []);
  return {
    ...project,
    start,
    end,
    captions: project.captions?.length ? alignCuesToSegments(sourceCues, parts) : [],
  };
}
