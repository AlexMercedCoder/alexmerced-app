/**
 * What the editor can do, written down once.
 *
 * This exists because the app only explained itself to people who already knew.
 * The gestures that carry the most power were the least visible, and five of
 * the hints sat inside panels that appear only once you have selected
 * something, which puts the instruction behind the discovery it is meant to
 * enable.
 *
 * Everything a person is told now comes from here: the help sheet, the
 * shortcut legend, the tooltip on a track's tab, and the line shown the first
 * time a track is opened. One list, so they cannot drift.
 *
 * The shortcuts especially. Four of them worked and were written down nowhere,
 * because the handler and the legend were separate lists maintained by hand.
 * The handler now dispatches from this list by id, so a shortcut that exists
 * is a shortcut that is documented, by construction.
 */

export type ShortcutGroup = 'Playing' | 'Editing' | 'Adding';

export type ShortcutId =
  | 'play' | 'stepBack' | 'stepForward' | 'toStart' | 'toEnd'
  | 'addZoom' | 'addText' | 'crop' | 'trimStart' | 'trimEnd'
  | 'remove' | 'cancel' | 'undo' | 'redo';

export type Shortcut = {
  id: ShortcutId;
  /** The keys as a person reads them, one entry per key to show in a row. */
  keys: string[];
  /** What the handler matches on. Empty when the key carries a modifier. */
  matches: string[];
  does: string;
  group: ShortcutGroup;
  /** True when it should still fire while a text field has focus. */
  whileTyping?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  { id: 'play', keys: ['Space'], matches: [' '], does: 'Play or pause', group: 'Playing' },
  { id: 'stepBack', keys: ['←'], matches: ['ArrowLeft'], does: 'Back one frame, or a second with Shift', group: 'Playing' },
  { id: 'stepForward', keys: ['→'], matches: ['ArrowRight'], does: 'Forward one frame, or a second with Shift', group: 'Playing' },
  { id: 'toStart', keys: ['Home'], matches: ['Home'], does: 'Jump to the start of the trim', group: 'Playing' },
  { id: 'toEnd', keys: ['End'], matches: ['End'], does: 'Jump to the end of the trim', group: 'Playing' },

  { id: 'crop', keys: ['C'], matches: ['c', 'C'], does: 'Crop the picture', group: 'Editing' },
  { id: 'trimStart', keys: ['I'], matches: ['i', 'I'], does: 'Start the video here', group: 'Editing' },
  { id: 'trimEnd', keys: ['O'], matches: ['o', 'O'], does: 'End the video here', group: 'Editing' },
  { id: 'remove', keys: ['Delete'], matches: ['Delete', 'Backspace'], does: 'Remove the selected block', group: 'Editing' },
  { id: 'cancel', keys: ['Esc'], matches: ['Escape'], does: 'Stop cropping or aiming', group: 'Editing' },
  { id: 'undo', keys: ['Ctrl', 'Z'], matches: [], does: 'Undo', group: 'Editing', whileTyping: true },
  { id: 'redo', keys: ['Ctrl', 'Y'], matches: [], does: 'Redo, or Ctrl and Shift and Z', group: 'Editing', whileTyping: true },

  { id: 'addZoom', keys: ['Z'], matches: ['z', 'Z'], does: 'Add a zoom at the playhead', group: 'Adding' },
  { id: 'addText', keys: ['T'], matches: ['t', 'T'], does: 'Add a caption at the playhead', group: 'Adding' },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['Playing', 'Editing', 'Adding'];

/** Finds the shortcut a key press means, or nothing. */
export function shortcutFor(key: string): Shortcut | undefined {
  return SHORTCUTS.find((entry) => entry.matches.includes(key));
}

export type TrackName = 'sound' | 'zoom' | 'speed' | 'hide' | 'shapes' | 'text';

export type TrackHelp = {
  id: TrackName;
  label: string;
  /** One line, shown on the tab and in the sheet. Says what it is for. */
  what: string;
  /** Shown once, the first time the track is opened. */
  firstTime: string;
  /** Everything you can do here that a button does not already say. */
  gestures: string[];
};

export const TRACK_HELP: TrackHelp[] = [
  {
    id: 'zoom',
    label: 'Zoom',
    what: 'Move the camera in on what matters',
    firstTime: 'Double click a zoom to aim it, then drag on the picture to say what it should look at.',
    gestures: [
      'Drag a zoom to move it, or its edges to make it longer or shorter.',
      'Click one to edit how far it goes in and where it looks.',
      'Double click one to aim it, then drag on the picture.',
      'Right click for split and duplicate.',
    ],
  },
  {
    id: 'sound',
    label: 'Sound',
    what: 'See the talking, and cut the silences',
    firstTime: 'Drag across the waveform to select a stretch, then cut it out.',
    gestures: [
      'Click the waveform to move the playhead.',
      'Drag across it to select a stretch, then press Cut the selection.',
      'Remove silences finds every quiet gap and takes them all out at once.',
    ],
  },
  {
    id: 'speed',
    label: 'Speed',
    what: 'Race through the parts nobody needs to watch',
    firstTime: 'Add a speed change, then drag its edges to cover the boring stretch.',
    gestures: [
      'Drag a speed change to move it, or its edges to cover more.',
      'Click one to set the pace. Above 1 is faster, below is slow motion.',
      'The sound speeds up with the picture, so it changes pitch.',
    ],
  },
  {
    id: 'hide',
    label: 'Cover up',
    what: 'Blur out a key, a name or an address',
    firstTime: 'Add one, then drag on the picture to put it over what should not be seen.',
    gestures: [
      'Drag on the picture to place the box.',
      'Make it follow from here records a second position, so it can track a panel that scrolls.',
      'It is burnt into the exported video, not laid over it.',
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    what: 'Point at things with arrows and boxes',
    firstTime: 'Pick a kind, add it, then drag on the picture. An arrow runs from where you press to where you let go.',
    gestures: [
      'Drag on the picture to draw it.',
      'An arrow runs from where you press to where you let go.',
      'Click a colour to change it, and set the weight and the fade.',
    ],
  },
  {
    id: 'text',
    label: 'Text',
    what: 'Put words on the screen',
    firstTime: 'Double click a caption to edit its words.',
    gestures: [
      'Drag a caption to move it, or its edges to change how long it shows.',
      'Double click one to edit the words.',
      'Right click for split and duplicate.',
    ],
  },
];

export function trackHelp(id: TrackName): TrackHelp {
  return TRACK_HELP.find((entry) => entry.id === id) ?? TRACK_HELP[0];
}

/** Gestures that are not tied to one track. */
export const GENERAL_HELP: { heading: string; points: string[] }[] = [
  {
    heading: 'Getting a recording in',
    points: [
      'Record captures a window, a screen or this tab. The browser asks which.',
      'Recording this tab is the only case where the zoom can follow your cursor exactly, because a browser is not told where the pointer is over another window.',
      'Press M while recording to mark a chapter.',
      'Open a video reads a file you already have.',
      'A recording is written down as it is made, so a crash does not lose it.',
    ],
  },
  {
    heading: 'The picture',
    points: [
      'The preview shows exactly what will be exported.',
      'While a zoom is being aimed, or a box or shape is selected, dragging on the picture places it.',
      'Crop changes the shape of the recording itself, and the zoom moves around inside the crop.',
    ],
  },
  {
    heading: 'Words',
    points: [
      'Transcribe the speech works out the words on this machine. It fetches a model the first time and keeps it; your recording never leaves the browser.',
      'Select lines of transcript and press Cut to remove those seconds from the video.',
      'Subtitles can be burnt into the picture, or saved as SRT or VTT.',
    ],
  },
  {
    heading: 'The timeline, without a mouse',
    points: [
      'Tab moves onto the blocks in the open track, and reaching one selects it.',
      'The arrow keys move the block you are on, and Shift makes every step ten times bigger.',
      'Up and down make it longer or shorter, and holding Alt moves its start instead.',
      'Enter opens it, which is what a double click does.',
      'Delete removes it, and the keyboard stays on the track rather than going back to the top of the page.',
    ],
  },
  {
    heading: 'Finishing',
    points: [
      'Where it is going sets the shape and the output size together.',
      'A look saves the background, padding, shadow and tilt so the next recording can match this one.',
      'Export writes the file. Everything happens on this machine.',
    ],
  },
];
