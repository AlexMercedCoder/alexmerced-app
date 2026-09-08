import { describe, expect, it, vi } from 'vitest';
import { canExportInWorker } from './offload';
import {
  alignCuesToSegments,
  captionStyle,
  defaultCaptionStyle,
  excerptProject,
  mergeCues,
  overlappingCues,
  replaceWords,
  shiftCues,
  snapShift,
} from './enhancements';
import { segmentsOf } from './timeline';
import { defaultComposition } from './layout';
import { defaultZoom } from './zoom';
import type { Project } from './render';
import type { Cue } from './captions';
import { createProject, loadProject, reviveSettings, saveProject } from './store';
import { freezeExport } from './exportQueue';
const cue = (id: string, start: number, end: number, text = id): Cue => ({ id, start, end, text });
const project: Project = {
  video: null,
  source: new Blob(),
  duration: 20,
  sourceWidth: 640,
  sourceHeight: 360,
  pointer: [],
  clicks: [],
  composition: defaultComposition,
  zoom: defaultZoom,
  frameRate: 24,
  bitrate: 1000000,
  showClicks: false,
  showCursor: false,
  format: 'webm',
  gifColours: 128,
  keepAudio: false,
  start: 0,
  end: 20,
  cuts: [],
  speeds: [],
};
describe('Limelight editing additions', () => {
  it('replaces literal matches without interpreting regex or replacement tokens', () => {
    expect(replaceWords([cue('a', 0, 1, 'A.b a.B')], 'a.b', '$&')[0].text).toBe('$& $&');
    expect(replaceWords([cue('a', 0, 1, 'a [b]')], '[b]', 'c')[0].text).toBe('a c');
  });
  it('refuses shifts that lose words beyond either end', () => {
    const cues = [cue('a', 1, 3)];
    expect(shiftCues(cues, 2, 8)[0]).toMatchObject({ start: 3, end: 5 });
    expect(() => shiftCues(cues, -2, 8)).toThrow();
    expect(() => shiftCues(cues, 6, 8)).toThrow();
    expect(cues[0].start).toBe(1);
  });
  it('merges only adjacent selected lines and keeps the furthest end', () => {
    const cues = [cue('a', 0, 5), cue('b', 1, 2), cue('c', 6, 7)];
    expect(mergeCues(cues, new Set(['a', 'b']))[0]).toMatchObject({
      start: 0,
      end: 5,
      text: 'a b',
    });
    expect(() => mergeCues(cues, new Set(['a', 'c']))).toThrow('adjacent');
  });
  it('finds nested overlaps but not touching cues', () => {
    expect(
      [...overlappingCues([cue('a', 0, 5), cue('b', 1, 2), cue('c', 3, 4), cue('d', 5, 6)])].sort(),
    ).toEqual(['a', 'b', 'c']);
  });
  it('validates stored styles without accepting arbitrary CSS', () => {
    expect(captionStyle(null)).toEqual(defaultCaptionStyle);
    expect(
      captionStyle({ font: 'remote font', opacity: NaN, margin: 99, color: 'url(x)' }),
    ).toMatchObject({ font: 'sans', opacity: 0.72, margin: 0.25, color: '#f6f4ef' });
    expect(
      reviveSettings({ captionStyle: { font: 'mono', position: 'top' } }).captionStyle,
    ).toMatchObject({ font: 'mono', position: 'top' });
  });
  it('snaps a moving block by its nearest edge and preserves its length', () => {
    expect(snapShift('move', 1, 3, 0.9, [4], 0.2)).toBe(1);
    expect(snapShift('start', 1, 3, 0.9, [4], 0.2)).toBe(0.9);
    expect(snapShift('end', 1, 3, 0.9, [4], 0.2)).toBe(1);
  });
  it('aligns captions intersecting the trim even when both endpoints are outside', () => {
    const parts = segmentsOf(
      { start: 5, end: 15 },
      [{ start: 8, end: 10 }],
      [{ id: 's', start: 10, end: 15, speed: 2 }],
    );
    expect(
      alignCuesToSegments([cue('a', 0, 20), cue('b', 8, 10), cue('c', 10, 14)], parts),
    ).toEqual([cue('a', 0, 5.5), cue('c', 3, 5)]);
  });
  it('maps a test range through cuts and speed changes, with relative subtitle times', () => {
    const p = {
      ...project,
      start: 5,
      end: 15,
      cuts: [{ start: 8, end: 10 }],
      speeds: [{ id: 's', start: 10, end: 15, speed: 2 }],
      captions: [cue('a', 0, 5.5)],
    };
    const short = excerptProject(p, [cue('a', 5, 15)], 2, 2);
    expect(short.start).toBe(7);
    expect(short.end).toBe(12);
    expect(short.captions).toEqual([cue('a', 0, 2)]);
    expect(() => excerptProject(p, [], 6, 2)).toThrow();
    expect(p.end).toBe(15);
  });
  it('keeps audio exports on the thread with an audio decoder', () => {
    for (const name of ['Worker', 'OffscreenCanvas', 'VideoDecoder', 'EncodedVideoChunk'])
      vi.stubGlobal(name, class {});
    try {
      expect(canExportInWorker({ ...project, keepAudio: true })).toBe(false);
      expect(canExportInWorker({ ...project, keepAudio: false })).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('freezes queue edits without holding live video elements', async () => {
    const p = { ...project, composition: structuredClone(defaultComposition) };
    const frozen = await freezeExport(p, null);
    p.composition.width = 100;
    expect(frozen.project.composition.width).toBe(1920);
    expect(frozen.project.video).toBeUndefined();
  });
  it('persists independent checkpoints including caption styling and source media', async () => {
    const original = createProject('Original', {
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'video/webm',
      cameraBytes: null,
      duration: 5,
      width: 640,
      height: 360,
      hasAudio: false,
      pointer: [],
      clicks: [],
    });
    await saveProject(original);
    const copy = {
      ...structuredClone(original),
      id: `${original.id}-checkpoint`,
      checkpointOf: original.id,
      name: 'Checkpoint: first cut',
      captions: [cue('a', 0, 1, 'Saved')],
      settings: {
        ...original.settings,
        captionStyle: { ...defaultCaptionStyle, font: 'mono' as const },
      },
    };
    await saveProject(copy);
    copy.captions[0].text = 'Changed';
    const loaded = await loadProject(copy.id);
    expect(loaded?.checkpointOf).toBe(original.id);
    expect(loaded?.captions[0].text).toBe('Saved');
    expect(loaded?.settings.captionStyle?.font).toBe('mono');
    expect(loaded?.bytes).toEqual(original.bytes);
    expect((await loadProject(original.id))?.captions).toEqual([]);
  });
});
