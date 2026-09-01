import { describe, expect, it } from 'vitest';
import {
  GENERAL_HELP, SHORTCUT_GROUPS, SHORTCUTS, shortcutFor, TRACK_HELP, trackHelp,
} from './help';

describe('SHORTCUTS', () => {
  it('gives every entry keys a person can read and a plain description', () => {
    for (const entry of SHORTCUTS) {
      expect(entry.keys.length).toBeGreaterThan(0);
      expect(entry.does.length).toBeGreaterThan(3);
      expect(entry.keys.every((key) => key.trim().length > 0)).toBe(true);
    }
  });

  it('never uses one id twice, since the handler dispatches on it', () => {
    const ids = SHORTCUTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never binds the same key to two different things', () => {
    const seen = new Set<string>();
    for (const entry of SHORTCUTS) {
      for (const key of entry.matches) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('puts every entry in a group the legend knows how to show', () => {
    for (const entry of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(entry.group);
  });

  it('leaves matches empty exactly when the shortcut needs a modifier', () => {
    // Undo and redo are handled before the modifier guard, so they cannot be
    // matched by a bare key and must not claim one.
    for (const entry of SHORTCUTS) {
      const modified = entry.keys.includes('Ctrl');
      expect(entry.matches.length === 0).toBe(modified);
    }
  });

  it('covers everything the editor can do from the keyboard', () => {
    // The list the handler dispatches from. A shortcut that works and is not
    // written down is the defect this guards: four of them were missing from
    // the legend because the handler and the legend were separate lists.
    const expected = [
      'play', 'stepBack', 'stepForward', 'toStart', 'toEnd',
      'crop', 'trimStart', 'trimEnd', 'remove', 'cancel', 'undo', 'redo',
      'addZoom', 'addText',
    ];
    expect(SHORTCUTS.map((entry) => entry.id).sort()).toEqual([...expected].sort());
  });
});

describe('shortcutFor', () => {
  it('finds one by its key', () => {
    expect(shortcutFor(' ')?.id).toBe('play');
    expect(shortcutFor('ArrowLeft')?.id).toBe('stepBack');
  });

  it('accepts either case of a letter', () => {
    expect(shortcutFor('z')?.id).toBe('addZoom');
    expect(shortcutFor('Z')?.id).toBe('addZoom');
  });

  it('treats Backspace as Delete, which is what people press', () => {
    expect(shortcutFor('Backspace')?.id).toBe('remove');
  });

  it('finds nothing for a key that means nothing', () => {
    expect(shortcutFor('q')).toBeUndefined();
  });
});

describe('TRACK_HELP', () => {
  it('describes every track the picker offers', () => {
    expect(TRACK_HELP.map((entry) => entry.id).sort())
      .toEqual(['hide', 'shapes', 'sound', 'speed', 'text', 'zoom']);
  });

  it('says what each track is for, without naming the control', () => {
    for (const entry of TRACK_HELP) {
      expect(entry.what.length).toBeGreaterThan(10);
      // A description that just repeats the label teaches nothing.
      expect(entry.what.toLowerCase()).not.toBe(entry.label.toLowerCase());
    }
  });

  it('has a first-time line for each, since that is the one people read', () => {
    for (const entry of TRACK_HELP) {
      expect(entry.firstTime.length).toBeGreaterThan(20);
      expect(entry.firstTime.endsWith('.')).toBe(true);
    }
  });

  it('lists the gestures, which are the part no button explains', () => {
    for (const entry of TRACK_HELP) {
      expect(entry.gestures.length).toBeGreaterThanOrEqual(3);
      for (const gesture of entry.gestures) expect(gesture.endsWith('.')).toBe(true);
    }
  });

  it('mentions dragging wherever dragging is how the track works', () => {
    for (const id of ['zoom', 'speed', 'hide', 'shapes', 'text'] as const) {
      const joined = trackHelp(id).gestures.join(' ').toLowerCase();
      expect(joined).toContain('drag');
    }
  });

  it('falls back to something rather than nothing for an unknown track', () => {
    expect(trackHelp('nonsense' as 'zoom')).toBeTruthy();
  });
});

describe('GENERAL_HELP', () => {
  it('covers getting a recording in, the picture, words and finishing', () => {
    expect(GENERAL_HELP.map((entry) => entry.heading)).toEqual([
      'Getting a recording in', 'The picture', 'Words', 'Finishing',
    ]);
  });

  it('has real points under every heading', () => {
    for (const entry of GENERAL_HELP) {
      expect(entry.points.length).toBeGreaterThan(1);
      for (const point of entry.points) expect(point.endsWith('.')).toBe(true);
    }
  });

  it('is explicit that the transcription fetches something and the audio does not leave', () => {
    const words = GENERAL_HELP.find((entry) => entry.heading === 'Words')!.points.join(' ');
    expect(words).toMatch(/fetches a model/i);
    expect(words).toMatch(/never leaves the browser/i);
  });
});
