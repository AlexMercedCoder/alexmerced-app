import { readPref, writePref } from '../../lib/prefs';
import {
  GENERAL_HELP, SHORTCUT_GROUPS, SHORTCUTS, trackHelp, TRACK_HELP, type TrackName,
} from './help';

/**
 * Everything the editor tells you about itself, built.
 *
 * The words all live in help.ts, which is also what the shortcut handler
 * dispatches from and what the track tabs are labelled from. This is only the
 * markup for them: the sheet, the strip of keys under the timeline, and the
 * line shown the first time a track is opened.
 *
 * Separate from the editor because it needs almost nothing from it. Given a
 * root element and a way to find things by id, it builds itself, which is the
 * test of whether a section of a large file was worth lifting out.
 */

export type HelpHandle = {
  /** Opens the sheet. */
  open: () => void;
  /** Shows the once-per-track line, or hides it if that track has been seen. */
  showFirstTime: (track: TrackName) => void;
  /** Marks the track as seen and hides the line. */
  dismissFirstTime: (track: TrackName) => void;
};

/** Keys as a person reads them, with a plus between each. */
export function keycap(keys: string[]): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'll-keycap';
  for (const [index, key] of keys.entries()) {
    if (index > 0) holder.append(document.createTextNode('+'));
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    holder.append(kbd);
  }
  return holder;
}

function section(heading: string, extra?: string): { element: HTMLElement; body: HTMLElement } {
  const element = document.createElement('section');
  const title = document.createElement('h3');
  title.textContent = heading;
  if (extra) {
    const what = document.createElement('em');
    what.textContent = `: ${extra}`;
    title.append(what);
  }
  element.append(title);
  return { element, body: element };
}

function bullets(points: string[]): HTMLElement {
  const list = document.createElement('ul');
  for (const point of points) {
    const item = document.createElement('li');
    item.textContent = point;
    list.append(item);
  }
  return list;
}

/**
 * The sheet.
 *
 * Every track, then the things that belong to no track, then the keys grouped
 * the way the list groups them. A dialog rather than a panel so Escape and the
 * backdrop work without being written.
 */
export function buildHelpSheet(root: HTMLElement): HTMLDialogElement {
  const sheet = document.createElement('dialog');
  sheet.className = 'll-sheet';
  sheet.id = 'll-sheet';

  const head = document.createElement('div');
  head.className = 'll-sheet__head';
  const title = document.createElement('h2');
  title.textContent = 'What you can do here';
  const close = document.createElement('button');
  close.className = 'btn btn--sm';
  close.textContent = 'Close';
  close.addEventListener('click', () => sheet.close());
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'll-sheet__body';

  for (const track of TRACK_HELP) {
    const made = section(track.label, track.what.toLowerCase());
    made.body.append(bullets(track.gestures));
    body.append(made.element);
  }

  for (const group of GENERAL_HELP) {
    const made = section(group.heading);
    made.body.append(bullets(group.points));
    body.append(made.element);
  }

  for (const group of SHORTCUT_GROUPS) {
    const made = section(`${group} from the keyboard`);
    const grid = document.createElement('div');
    grid.className = 'll-keygrid';
    for (const entry of SHORTCUTS.filter((shortcut) => shortcut.group === group)) {
      const row = document.createElement('div');
      row.className = 'll-keyrow';
      const says = document.createElement('span');
      says.textContent = entry.does;
      row.append(keycap(entry.keys), says);
      grid.append(row);
    }
    made.body.append(grid);
    body.append(made.element);
  }

  sheet.append(head, body);
  root.append(sheet);
  return sheet;
}

/** The strip under the timeline, from the same list as the sheet. */
export function renderKeyStrip(strip: HTMLElement, onMore: () => void): void {
  strip.innerHTML = '';
  for (const entry of SHORTCUTS) {
    const item = document.createElement('span');
    item.append(keycap(entry.keys), document.createTextNode(entry.does.toLowerCase()));
    strip.append(item);
  }
  const more = document.createElement('span');
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'btn btn--sm btn--ghost';
  link.textContent = 'Everything else';
  link.addEventListener('click', onMore);
  more.append(link);
  strip.append(more);
}

/** Where the tracks somebody has already met are remembered. */
export const SEEN_KEY = 'limelight:tracks-seen';

export function mountHelp(root: HTMLElement, find: <T extends HTMLElement>(id: string) => T): HelpHandle {
  const sheet = buildHelpSheet(root);
  const openButton = find<HTMLButtonElement>('ll-help-open');
  const open = () => {
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
  };
  openButton.addEventListener('click', open);
  renderKeyStrip(find<HTMLDivElement>('ll-keys'), open);

  let seen: string[] = readPref<string[]>(SEEN_KEY, []);

  return {
    open,
    showFirstTime(track) {
      const holder = find<HTMLParagraphElement>('ll-firsttime');
      if (seen.includes(track)) { holder.hidden = true; return; }
      find<HTMLSpanElement>('ll-firsttime-text').textContent = trackHelp(track).firstTime;
      holder.hidden = false;
    },
    dismissFirstTime(track) {
      if (!seen.includes(track)) {
        seen = [...seen, track];
        writePref(SEEN_KEY, seen);
      }
      find<HTMLParagraphElement>('ll-firsttime').hidden = true;
    },
  };
}
