import { describe, expect, it } from 'vitest';
import { ImportError } from '../../lib/portable';
import { FULL_CROP } from './layout';
import { defaultSettings, type Project } from './store';
import {
  applySidecar, readSidecar, reviveSidecar, sidecarCounts, sidecarFilename,
  sidecarMismatch, sidecarSize, sidecarVideo, toSidecar, writeSidecar,
} from './sidecar';

const bytes = new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Onboarding walkthrough',
    bytes,
    mime: 'video/webm',
    cameraBytes: null,
    duration: 12.5,
    width: 1920,
    height: 1080,
    hasAudio: true,
    pointer: [],
    clicks: [],
    keys: [],
    marks: [],
    start: 1,
    end: 11,
    crop: { ...FULL_CROP },
    wallpaper: null,
    wallpaperMime: 'image/png',
    zooms: [{ id: 'z1', start: 2, end: 4, scale: 1.8, x: 0.4, y: 0.6, pinned: true }],
    texts: [],
    cuts: [{ start: 5, end: 6 }],
    speeds: [],
    redactions: [],
    captions: [],
    shapes: [],
    music: null,
    musicName: '',
    keyframes: null,
    settings: { ...defaultSettings },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('toSidecar', () => {
  it('carries every edit', () => {
    const out = toSidecar(project(), false);
    expect(out.start).toBe(1);
    expect(out.end).toBe(11);
    expect(out.zooms).toHaveLength(1);
    expect(out.cuts).toEqual([{ start: 5, end: 6 }]);
  });

  it('records what the edits were made against', () => {
    // Without this a sidecar can be applied to the wrong video and there is no
    // way to tell, because nothing fails; it just all lands in the wrong place.
    const out = toSidecar(project(), false);
    expect(out.source).toEqual({
      duration: 12.5, width: 1920, height: 1080, bytes: bytes.byteLength, mime: 'video/webm',
    });
  });

  it('leaves the recording out unless it was asked for', () => {
    expect(toSidecar(project(), false).video).toBeUndefined();
    expect(toSidecar(project(), true).video?.bytes).toBe(bytes.byteLength);
  });
});

describe('writeSidecar and readSidecar', () => {
  it('round trips the edits through the file', () => {
    const back = readSidecar(writeSidecar(project(), false)).data;
    expect(back.start).toBe(1);
    expect(back.zooms[0]).toMatchObject({ scale: 1.8, x: 0.4, y: 0.6 });
    expect(back.cuts).toEqual([{ start: 5, end: 6 }]);
  });

  it('round trips the recording itself when it was carried', () => {
    const back = readSidecar(writeSidecar(project(), true)).data;
    const video = sidecarVideo(back);
    expect(video?.mime).toBe('video/webm');
    expect(Array.from(video!.bytes)).toEqual(Array.from(bytes));
  });

  it('writes the site envelope, so it is the same file every app writes', () => {
    const parsed = JSON.parse(writeSidecar(project(), false));
    expect(parsed.format).toBe('alexmerced.app/export');
    expect(parsed.app).toBe('limelight');
    expect(parsed.counts).toMatchObject({ zooms: 1, cuts: 1 });
  });

  it('is readable by eye when it holds only edits', () => {
    // The whole reason to keep the video out is that the file can be mailed,
    // read and kept in a repository.
    expect(writeSidecar(project(), false)).toContain('\n  ');
  });

  it('refuses a file from another app rather than half applying it', () => {
    const foreign = JSON.stringify({
      format: 'alexmerced.app/export', version: 1, app: 'laneway', appVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z', counts: {}, data: {},
    });
    expect(() => readSidecar(foreign)).toThrow(ImportError);
  });

  it('refuses something that is not an export at all', () => {
    expect(() => readSidecar('{"hello":true}')).toThrow(ImportError);
    expect(() => readSidecar('not json')).toThrow(ImportError);
  });
});

describe('reviveSidecar', () => {
  it('insists on knowing how long the recording was', () => {
    expect(() => reviveSidecar({ zooms: [] })).toThrow(ImportError);
    expect(() => reviveSidecar({ source: { duration: 0 } })).toThrow(ImportError);
  });

  it('fills in everything a hand edited file left out', () => {
    const out = reviveSidecar({ source: { duration: 10 } });
    expect(out.name).toBe('Imported recording');
    expect(out.end).toBe(10);
    expect(out.zooms).toEqual([]);
    expect(out.settings.frameRate).toBe(defaultSettings.frameRate);
  });

  it('drops malformed blocks rather than putting them on the timeline', () => {
    const out = reviveSidecar({
      source: { duration: 10 },
      zooms: [{ id: 'z', start: 1, end: 2, scale: 2, x: 0.5, y: 0.5 }, 'nonsense', null],
      cuts: [{ start: 1, end: 2 }, { start: 'x' }],
    });
    expect(out.zooms).toHaveLength(1);
    expect(out.cuts).toEqual([{ start: 1, end: 2 }]);
  });

  it('treats an empty video field as no video', () => {
    expect(reviveSidecar({ source: { duration: 5 }, video: { base64: '' } }).video).toBeUndefined();
  });

  it('rejects a recording that will not decode, with words for a person', () => {
    const broken = reviveSidecar({ source: { duration: 5 }, video: { base64: '!!!not base64!!!' } });
    expect(() => sidecarVideo(broken)).toThrow(ImportError);
  });
});

describe('sidecarMismatch', () => {
  const sidecar = toSidecar(project(), false);

  it('says nothing when the two match', () => {
    expect(sidecarMismatch(sidecar, { duration: 12.5, width: 1920, height: 1080 })).toBeNull();
  });

  it('allows the small drift a re-encode introduces', () => {
    expect(sidecarMismatch(sidecar, { duration: 12.7, width: 1920, height: 1080 })).toBeNull();
  });

  it('catches a different recording by its length', () => {
    const said = sidecarMismatch(sidecar, { duration: 40, width: 1920, height: 1080 });
    expect(said).toMatch(/12\.5 seconds long, and this one is 40/);
  });

  it('catches a different recording by its shape', () => {
    const said = sidecarMismatch(sidecar, { duration: 12.5, width: 1280, height: 720 });
    expect(said).toMatch(/1920 by 1080/);
  });

  it('does not complain about a shape it was never told', () => {
    const vague = reviveSidecar({ source: { duration: 12.5 } });
    expect(sidecarMismatch(vague, { duration: 12.5, width: 1280, height: 720 })).toBeNull();
  });
});

describe('applySidecar', () => {
  it('puts the edits on and keeps the recording that is open', () => {
    const onto = project({ bytes: new Uint8Array([9, 9, 9]), zooms: [], cuts: [], start: 0, end: 12.5 });
    const out = applySidecar(onto, toSidecar(project(), false));
    expect(Array.from(out.bytes)).toEqual([9, 9, 9]);
    expect(out.zooms).toHaveLength(1);
    expect(out.start).toBe(1);
  });

  it('never lets a trim run past the recording it lands on', () => {
    const sidecar = toSidecar(project({ start: 2, end: 400 }), false);
    const out = applySidecar(project({ duration: 12.5 }), sidecar);
    expect(out.end).toBeLessThanOrEqual(12.5);
  });

  it('falls back to the whole recording for a backwards trim', () => {
    const sidecar = { ...toSidecar(project(), false), start: 8, end: 3 };
    expect(applySidecar(project(), sidecar).end).toBe(12.5);
  });
});

describe('the file it writes', () => {
  const when = new Date('2026-03-04T09:08:07.000Z');

  it('is named after the recording and says which kind it is', () => {
    expect(sidecarFilename('Onboarding walkthrough', false, when))
      .toBe('onboarding-walkthrough-2026-03-04-09-08-07-edits.json');
    expect(sidecarFilename('Onboarding walkthrough', true, when))
      .toBe('onboarding-walkthrough-2026-03-04-09-08-07-with-video.json');
  });

  it('copes with a name made entirely of punctuation', () => {
    expect(sidecarFilename('***', false, when)).toBe('recording-2026-03-04-09-08-07-edits.json');
  });

  it('warns roughly what a file with the video in it will weigh', () => {
    // A third larger than the video, which is the number worth knowing before
    // somebody makes a ninety megabyte JSON file by accident.
    expect(sidecarSize(project({ bytes: new Uint8Array(3_000_000) }), true))
      .toBeGreaterThan(3_900_000);
    expect(sidecarSize(project(), false)).toBeLessThan(20_000);
  });

  it('counts what is in it for the summary line', () => {
    expect(sidecarCounts(toSidecar(project(), false))).toMatchObject({ zooms: 1, cuts: 1, shapes: 0 });
  });
});
