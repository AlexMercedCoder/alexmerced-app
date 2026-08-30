import { beforeEach, describe, expect, it } from 'vitest';
import { toBase64 } from '../../lib/bytes';
import { createEnvelope } from '../../lib/portable';
import {
  APP_ID, APP_VERSION, createClip, defaultSettings, fileStem, nameFromFile, reviveClip,
  reviveSettings, uniqueName, type Clip,
} from './model';
import {
  applyImport, buildExport, clearAll, deleteClip, fromPortable, loadClips, loadSettings,
  saveClip, saveSettings, storedBytes, toPortable, type CadenceExport,
} from './store';
import { encodeWav } from './wav';

function sampleClip(name = 'Take one', seconds = 0.1): Clip {
  const frames = Math.round(seconds * 8000);
  const bytes = encodeWav({ sampleRate: 8000, channels: [new Float32Array(frames).fill(0.25)] }, 16);
  return createClip(name, bytes, 'audio/wav', { duration: seconds, sampleRate: 8000, channelCount: 1 });
}

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('nameFromFile', () => {
  it('drops the extension and tidies separators', () => {
    expect(nameFromFile('voice_memo-01.m4a')).toBe('voice memo 01');
    expect(nameFromFile('recording.wav')).toBe('recording');
  });

  it('keeps a name with no extension', () => {
    expect(nameFromFile('untitled')).toBe('untitled');
  });

  it('falls back rather than returning nothing', () => {
    expect(nameFromFile('.wav')).toBe('Untitled clip');
  });
});

describe('fileStem', () => {
  it('produces something safe for a filesystem', () => {
    expect(fileStem('Take one, final MIX')).toBe('take-one-final-mix');
  });

  it('falls back when nothing usable remains', () => {
    expect(fileStem('///')).toBe('audio');
  });
});

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('Take', ['Other'])).toBe('Take');
  });

  it('numbers a collision', () => {
    expect(uniqueName('Take', ['Take'])).toBe('Take 2');
    expect(uniqueName('Take', ['Take', 'Take 2'])).toBe('Take 3');
  });
});

describe('reviveClip', () => {
  it('rejects a clip with no bytes', () => {
    expect(reviveClip({ id: 'a' })).toBeNull();
    expect(reviveClip({ id: 'a', bytes: new Uint8Array(0) })).toBeNull();
  });

  it('rejects anything with no id', () => {
    expect(reviveClip({ bytes: new Uint8Array([1]) })).toBeNull();
    expect(reviveClip(null)).toBeNull();
  });

  it('accepts a plain ArrayBuffer', () => {
    const revived = reviveClip({ id: 'a', bytes: new Uint8Array([1, 2, 3]).buffer });
    expect(revived!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('replaces impossible numbers with defaults', () => {
    const revived = reviveClip({ id: 'a', bytes: new Uint8Array([1]), sampleRate: -5, channelCount: 0, duration: NaN })!;
    expect(revived.sampleRate).toBe(48000);
    expect(revived.channelCount).toBe(1);
    expect(revived.duration).toBe(0);
  });
});

describe('reviveSettings', () => {
  it('falls back for junk', () => {
    expect(reviveSettings(null)).toEqual(defaultSettings);
  });

  it('clamps values into their usable range', () => {
    const settings = reviveSettings({ fadeSeconds: 999, normaliseTargetDb: 20, silenceThresholdDb: -500 });
    expect(settings.fadeSeconds).toBe(60);
    expect(settings.normaliseTargetDb).toBe(0);
    expect(settings.silenceThresholdDb).toBe(-90);
  });

  it('rejects an export format it does not know', () => {
    expect(reviveSettings({ format: 'mp3' }).format).toBe('wav16');
    expect(reviveSettings({ format: 'wav24' }).format).toBe('wav24');
  });
});

describe('storage', () => {
  it('starts empty rather than seeding audio nobody asked for', async () => {
    expect(await loadClips()).toEqual([]);
  });

  it('keeps clips in the order they were made', async () => {
    const first = { ...sampleClip('First'), createdAt: '2026-01-01T00:00:00Z' };
    const second = { ...sampleClip('Second'), createdAt: '2026-02-01T00:00:00Z' };
    await saveClip(second);
    await saveClip(first);
    expect((await loadClips()).map((clip) => clip.name)).toEqual(['First', 'Second']);
  });

  it('survives a round trip through IndexedDB with the bytes intact', async () => {
    const clip = sampleClip();
    await saveClip(clip);
    const [restored] = await loadClips();
    expect(restored.bytes).toEqual(clip.bytes);
    expect(restored.sampleRate).toBe(8000);
  });

  it('reports how much is stored', async () => {
    const clip = sampleClip();
    await saveClip(clip);
    expect(await storedBytes()).toBe(clip.bytes.length);
  });

  it('deletes only the named clip', async () => {
    const a = sampleClip('a');
    const b = sampleClip('b');
    await saveClip(a);
    await saveClip(b);
    await deleteClip(a.id);
    expect((await loadClips()).map((clip) => clip.name)).toEqual(['b']);
  });
});

describe('portable clips', () => {
  it('round trips through base64 without changing a byte', () => {
    const clip = sampleClip();
    const restored = fromPortable(toPortable(clip))!;
    expect(restored.bytes).toEqual(clip.bytes);
    expect(restored.name).toBe(clip.name);
  });

  it('rejects a payload that is not base64 rather than throwing', () => {
    expect(fromPortable({ id: 'a', bytes: '!!!not base64!!!' })).toBeNull();
  });

  it('rejects a clip with no payload at all', () => {
    expect(fromPortable({ id: 'a' })).toBeNull();
    expect(fromPortable(null)).toBeNull();
  });
});

describe('export and import', () => {
  it('exports every clip with its settings', async () => {
    await saveClip(sampleClip());
    saveSettings({ ...defaultSettings, format: 'wav24' });
    const envelope = await buildExport();
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts).toEqual({ clips: 1 });
    expect(envelope.data.settings.format).toBe('wav24');
    expect(typeof envelope.data.clips[0].bytes).toBe('string');
  });

  it('restores the audio exactly', async () => {
    const clip = sampleClip('Original');
    await saveClip(clip);
    const text = JSON.stringify(await buildExport());
    await clearAll();
    await applyImport(text, 'replace');
    const [restored] = await loadClips();
    expect(restored.bytes).toEqual(clip.bytes);
  });

  it('restores the settings', async () => {
    await saveClip(sampleClip());
    saveSettings({ ...defaultSettings, fadeSeconds: 3 });
    const text = JSON.stringify(await buildExport());
    localStorage.clear();
    expect(loadSettings().fadeSeconds).toBe(defaultSettings.fadeSeconds);
    await applyImport(text, 'replace');
    expect(loadSettings().fadeSeconds).toBe(3);
  });

  it('adds new clips on merge and keeps the ones already here', async () => {
    const mine = sampleClip('Mine');
    await saveClip(mine);

    const theirs = { ...sampleClip('Theirs'), id: 'clip_theirs' };
    const text = JSON.stringify(createEnvelope<CadenceExport>(
      APP_ID, APP_VERSION, { clips: [toPortable(theirs)], settings: defaultSettings }, {},
    ));
    expect(await applyImport(text, 'merge')).toBe(2);
    expect((await loadClips()).map((clip) => clip.name).sort()).toEqual(['Mine', 'Theirs']);
  });

  it('does not duplicate a clip that is already here', async () => {
    const clip = sampleClip();
    await saveClip(clip);
    const text = JSON.stringify(createEnvelope<CadenceExport>(
      APP_ID, APP_VERSION, { clips: [toPortable(clip)], settings: defaultSettings }, {},
    ));
    expect(await applyImport(text, 'merge')).toBe(1);
  });

  it('throws away what was here on replace', async () => {
    await saveClip(sampleClip('Old'));
    const fresh = { ...sampleClip('New'), id: 'clip_new' };
    const text = JSON.stringify(createEnvelope<CadenceExport>(
      APP_ID, APP_VERSION, { clips: [toPortable(fresh)], settings: defaultSettings }, {},
    ));
    await applyImport(text, 'replace');
    expect((await loadClips()).map((clip) => clip.name)).toEqual(['New']);
  });

  it('skips one broken clip rather than failing the whole import', async () => {
    const good = toPortable(sampleClip('Good'));
    const bad = { ...good, id: 'clip_bad', bytes: 'not base64 @@@' };
    const text = JSON.stringify(createEnvelope<CadenceExport>(
      APP_ID, APP_VERSION, { clips: [bad, good], settings: defaultSettings }, {},
    ));
    expect(await applyImport(text, 'replace')).toBe(1);
  });

  it('refuses an export from a different app', async () => {
    const text = JSON.stringify(createEnvelope('loupe', 1, { clips: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow();
  });

  it('refuses an export with no readable audio', async () => {
    const text = JSON.stringify(createEnvelope<CadenceExport>(
      APP_ID, APP_VERSION, { clips: [], settings: defaultSettings }, {},
    ));
    await expect(applyImport(text, 'merge')).rejects.toThrow(/no readable audio/);
  });

  it('handles a clip large enough to break a naive base64 encoder', async () => {
    const big = new Uint8Array(300_000);
    for (let index = 0; index < big.length; index += 1) big[index] = index % 256;
    const clip = createClip('Big', big, 'audio/wav', { duration: 5, sampleRate: 48000, channelCount: 1 });
    expect(toBase64(clip.bytes).length).toBeGreaterThan(300_000);
    expect(fromPortable(toPortable(clip))!.bytes).toEqual(big);
  });
});
