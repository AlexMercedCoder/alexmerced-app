import type { Cue } from './captions';
import type { Crop } from './layout';
import type { RedactBlock } from './redact';
import type { Clip } from './reel';
import type { Shape } from './shapes';
import type { Settings } from './store';
import type { TextBlock } from './text';
import type { SpeedRegion } from './timeline';
import type { Span } from './waveform';
import type { ZoomBlock } from './zooms';

/** The complete undoable editor state, independent of the DOM. */
export type EditorState = {
  settings: Settings;
  zooms: ZoomBlock[];
  texts: TextBlock[];
  cuts: Span[];
  speeds: SpeedRegion[];
  redactions: RedactBlock[];
  captions: Cue[];
  shapes: Shape[];
  crop: Crop;
  trim: { start: number; end: number };
  wallpaper: Uint8Array | null;
  wallpaperMime: string;
  /**
   * The reel, because adding a clip or taking one again is an edit.
   *
   * Leaving it out was worse than an undo that did nothing: the blocks moved
   * back to where they were before the splice while the timeline stayed the
   * new length, so everything landed in the wrong place.
   */
  clips: Clip[];
};

/** Create one owner for all undoable edits; media elements stay in the UI. */
export function createEditorState(settings: Settings): EditorState {
  return {
    settings, zooms: [], texts: [], cuts: [], speeds: [], redactions: [],
    captions: [], shapes: [], crop: { x: 0, y: 0, width: 1, height: 1 },
    trim: { start: 0, end: 0 }, wallpaper: null, wallpaperMime: 'image/png', clips: [],
  };
}
