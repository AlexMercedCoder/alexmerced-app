import { toast } from '../../lib/toast';
import type { MarkSample } from './capture';

/**
 * The moments marked during recording, as something to paste under a video.
 *
 * Marks are recorded as times, because nobody types a chapter title while
 * demonstrating something; the names are added here afterwards.
 */

export type ChapterHost = {
  marks: () => MarkSample[];
  /** Called when a name changes, so it can be written down. */
  onRename: (marks: MarkSample[]) => void;
  goTo: (time: number) => void;
  formatClock: (seconds: number) => string;
  onError: (message: string) => void;
};

/**
 * The list a video site expects.
 *
 * The first chapter has to start at zero or the list is rejected, so one is
 * added when the recording did not begin with a mark.
 */
export function chapterLines(
  marks: MarkSample[], formatClock: (seconds: number) => string,
): string[] {
  // No marks is no list. Without this the added first chapter would stand on
  // its own and a recording nobody marked would produce "0:00 Start".
  if (marks.length === 0) return [];
  const lines = marks.some((mark) => mark.time < 0.5) ? [] : ['0:00 Start'];
  for (const mark of marks) lines.push(`${formatClock(mark.time)} ${mark.label}`);
  return lines;
}

export function mountChapters(
  find: <T extends HTMLElement>(id: string) => T, host: ChapterHost,
): { render: () => void } {
  find<HTMLButtonElement>('ll-chapters-copy').addEventListener('click', async () => {
    const marks = host.marks();
    if (marks.length === 0) return;
    try {
      await navigator.clipboard.writeText(chapterLines(marks, host.formatClock).join('\n'));
      toast('Chapter list copied.');
    } catch {
      host.onError('The browser would not give access to the clipboard.');
    }
  });

  function render(): void {
    const card = find<HTMLElement>('ll-chapters-card');
    const list = find<HTMLOListElement>('ll-chapters');
    const marks = host.marks();
    card.hidden = marks.length === 0;
    list.innerHTML = '';

    for (const [index, mark] of marks.entries()) {
      const row = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'll-time';
      time.textContent = host.formatClock(mark.time);

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'field';
      name.value = mark.label;
      name.setAttribute('aria-label', `Name of the chapter at ${host.formatClock(mark.time)}`);
      name.addEventListener('input', () => {
        const next = [...host.marks()];
        next[index] = { ...mark, label: name.value };
        host.onRename(next);
      });

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn--sm btn--ghost';
      go.textContent = 'Go';
      go.addEventListener('click', () => host.goTo(mark.time));

      row.append(time, name, go);
      list.append(row);
    }
  }

  return { render };
}
