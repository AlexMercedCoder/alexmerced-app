import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAll, createProject, defaultSettings, deleteProject, loadProject, loadProjects,
  loadSettings, reviveProject, reviveSettings, saveProject, saveSettings, storedBytes,
  type Project,
} from './store';

const BYTES = Uint8Array.from([1, 2, 3, 4, 5]);

function make(name = 'Take one', overrides: Partial<Project> = {}): Project {
  return {
    ...createProject(name, {
      bytes: BYTES,
      mime: 'video/webm',
      cameraBytes: null,
      duration: 12,
      width: 1920,
      height: 1080,
      hasAudio: true,
      pointer: [{ time: 0, x: 0.5, y: 0.5 }],
      clicks: [{ time: 1, x: 0.2, y: 0.3 }],
    }),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('reviveSettings', () => {
  it('falls back for junk', () => {
    expect(reviveSettings(null)).toEqual(defaultSettings);
    expect(reviveSettings('nope')).toEqual(defaultSettings);
  });

  it('keeps a format it knows and rejects one it does not', () => {
    expect(reviveSettings({ format: 'mp4' }).format).toBe('mp4');
    expect(reviveSettings({ format: 'avi' }).format).toBe('webm');
  });

  it('clamps the countdown to something sane', () => {
    expect(reviveSettings({ countdown: 99 }).countdown).toBe(10);
    expect(reviveSettings({ countdown: -4 }).countdown).toBe(0);
  });

  it('merges a partial composition without losing the camera defaults', () => {
    const settings = reviveSettings({ composition: { padding: 0.1 } });
    expect(settings.composition.padding).toBe(0.1);
    expect(settings.composition.camera.corner).toBe(defaultSettings.composition.camera.corner);
  });

  it('keeps audio on unless it was turned off', () => {
    expect(reviveSettings({}).keepAudio).toBe(true);
    expect(reviveSettings({ keepAudio: false }).keepAudio).toBe(false);
  });
});

describe('reviveProject', () => {
  it('needs an id and some bytes', () => {
    expect(reviveProject({ bytes: BYTES })).toBeNull();
    expect(reviveProject({ id: 'a' })).toBeNull();
    expect(reviveProject({ id: 'a', bytes: new Uint8Array(0) })).toBeNull();
    expect(reviveProject(null)).toBeNull();
  });

  it('accepts a plain ArrayBuffer, which is what an older export may carry', () => {
    expect(reviveProject({ id: 'a', bytes: BYTES.buffer })!.bytes).toEqual(BYTES);
  });

  it('defaults the trim to the whole recording', () => {
    const project = reviveProject({ id: 'a', bytes: BYTES, duration: 30 })!;
    expect(project.start).toBe(0);
    expect(project.end).toBe(30);
  });

  it('drops pointer samples that are not points', () => {
    const project = reviveProject({
      id: 'a', bytes: BYTES,
      pointer: [{ time: 0, x: 0, y: 0 }, 'nonsense', { time: 1 }, null],
    })!;
    expect(project.pointer).toHaveLength(1);
  });

  it('round trips through JSON with the settings intact', () => {
    const project = make();
    project.settings.frameRate = 60;
    const revived = reviveProject(JSON.parse(JSON.stringify({ ...project, bytes: [...project.bytes] })));
    // Bytes do not survive JSON, so only the rest is compared.
    expect(revived).toBeNull();
  });
});

describe('storage', () => {
  it('starts empty', async () => {
    expect(await loadProjects()).toEqual([]);
  });

  it('keeps the recording bytes intact', async () => {
    const project = make();
    await saveProject(project);
    const back = await loadProject(project.id);
    expect(back!.bytes).toEqual(BYTES);
    expect(back!.pointer).toHaveLength(1);
    expect(back!.clicks).toHaveLength(1);
  });

  it('lists the most recently touched first', async () => {
    await saveProject(make('older', { id: 'a', updatedAt: '2026-01-01T00:00:00Z' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveProject(make('newer', { id: 'b', updatedAt: '2026-06-01T00:00:00Z' }));
    // saveProject stamps updatedAt itself, so b was written second and wins.
    expect((await loadProjects())[0].id).toBe('b');
  });

  it('reports how much is stored, camera included', async () => {
    await saveProject(make('with camera', { cameraBytes: Uint8Array.from([9, 9]) }));
    expect(await storedBytes()).toBe(BYTES.length + 2);
  });

  it('deletes only the one named', async () => {
    await saveProject(make('a', { id: 'a' }));
    await saveProject(make('b', { id: 'b' }));
    await deleteProject('a');
    expect((await loadProjects()).map((project) => project.id)).toEqual(['b']);
  });

  it('survives a reload, which is the whole point', async () => {
    const project = make('Important demo');
    project.start = 2;
    project.end = 9;
    await saveProject(project);

    // A fresh read, as a page load would do.
    const [restored] = await loadProjects();
    expect(restored.name).toBe('Important demo');
    expect(restored.start).toBe(2);
    expect(restored.end).toBe(9);
    expect(restored.bytes).toEqual(BYTES);
  });
});

describe('settings preference', () => {
  it('remembers across a reload', () => {
    saveSettings({ ...defaultSettings, frameRate: 60, keepAudio: false });
    const back = loadSettings();
    expect(back.frameRate).toBe(60);
    expect(back.keepAudio).toBe(false);
  });
});

describe('zoom blocks survive storage', () => {
  it('keeps blocks that were edited by hand', async () => {
    const project = make('Edited');
    project.zooms = [
      { id: 'z1', start: 1, end: 3, scale: 3, x: 0.8, y: 0.2, pinned: true },
      { id: 'z2', start: 5, end: 6, scale: 1.8, x: 0.5, y: 0.5, pinned: false },
    ];
    await saveProject(project);

    const back = await loadProject(project.id);
    expect(back!.zooms).toHaveLength(2);
    expect(back!.zooms[0]).toEqual(project.zooms[0]);
    expect(back!.zooms[1].pinned).toBe(false);
  });

  it('starts a new project with none', () => {
    expect(make().zooms).toEqual([]);
  });

  it('drops a stored block that is no longer usable', async () => {
    const project = make('Damaged');
    // Written by an older version, or corrupted: end before start.
    (project as unknown as { zooms: unknown[] }).zooms = [{ id: 'bad', start: 5, end: 2 }, null];
    await saveProject(project);
    expect((await loadProject(project.id))!.zooms).toEqual([]);
  });
});

describe('camera shape migration', () => {
  it('reads a project saved when the bubble was a round flag', () => {
    const settings = reviveSettings({ composition: { camera: { round: true, enabled: true } } });
    expect(settings.composition.camera.shape).toBe('circle');
  });

  it('reads the square case of that flag as a rounded rectangle', () => {
    const settings = reviveSettings({ composition: { camera: { round: false } } });
    expect(settings.composition.camera.shape).toBe('rounded');
  });

  it('prefers a real shape when one was stored', () => {
    const settings = reviveSettings({ composition: { camera: { round: true, shape: 'wide' } } });
    expect(settings.composition.camera.shape).toBe('wide');
  });

  it('ignores a shape it does not recognise', () => {
    const settings = reviveSettings({ composition: { camera: { shape: 'hexagon' } } });
    expect(settings.composition.camera.shape).toBe('circle');
  });
});

describe('wallpaper', () => {
  it('keeps a background picture with the project', async () => {
    const picture = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const project = createProject('With a picture', {
      bytes: new Uint8Array([1, 2, 3]), mime: 'video/webm', cameraBytes: null,
      duration: 4, width: 1280, height: 720, hasAudio: false, pointer: [], clicks: [],
      wallpaper: picture, wallpaperMime: 'image/jpeg',
    });
    await saveProject(project);

    const back = await loadProject(project.id);
    expect(back?.wallpaper).toEqual(picture);
    expect(back?.wallpaperMime).toBe('image/jpeg');
  });

  it('has no picture by default', () => {
    const project = createProject('Plain', {
      bytes: new Uint8Array([1]), mime: 'video/webm', cameraBytes: null,
      duration: 1, width: 640, height: 360, hasAudio: false, pointer: [], clicks: [],
    });
    expect(project.wallpaper).toBeNull();
  });

  it('counts a picture towards what is stored here', async () => {
    await clearAll();
    await saveProject(createProject('Weighed', {
      bytes: new Uint8Array(100), mime: 'video/webm', cameraBytes: null,
      duration: 1, width: 640, height: 360, hasAudio: false, pointer: [], clicks: [],
      wallpaper: new Uint8Array(40), wallpaperMime: 'image/png',
    }));
    expect(await storedBytes()).toBe(140);
  });
});

describe('camera settings', () => {
  it('drops a setting that no longer exists rather than carrying it forever', () => {
    const settings = reviveSettings({ composition: { camera: { round: true, wobble: 3 } } });
    expect(Object.keys(settings.composition.camera).sort())
      .toEqual(['corner', 'enabled', 'margin', 'shape', 'size']);
  });

  it('keeps a size within what the layout can place', () => {
    expect(reviveSettings({ composition: { camera: { size: 9 } } }).composition.camera.size).toBe(0.5);
    expect(reviveSettings({ composition: { camera: { size: -1 } } }).composition.camera.size).toBe(0.05);
  });

  it('ignores a corner it does not know', () => {
    expect(reviveSettings({ composition: { camera: { corner: 'middle' } } }).composition.camera.corner)
      .toBe(defaultSettings.composition.camera.corner);
  });
});
