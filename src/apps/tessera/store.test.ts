import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import {
  APP_ID,
  applyImport,
  buildExport,
  clearAll,
  createSavedCode,
  defaultStyle,
  deleteCode,
  loadCodes,
  loadStyle,
  reviveSavedCode,
  saveCode,
  saveStyle,
} from './store';

const NOW = new Date('2026-06-15T12:00:00Z');
const sample = (name: string, at = NOW) =>
  createSavedCode(name, 'url', { url: 'https://alexmerced.app' }, 'https://alexmerced.app', defaultStyle, at);

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

describe('style preferences', () => {
  it('starts from the defaults', () => {
    expect(loadStyle()).toEqual(defaultStyle);
  });

  it('clamps values that are out of range', () => {
    saveStyle({ ...defaultStyle, scale: 900, quietZone: -5, minVersion: 99 });
    const style = loadStyle();
    expect(style.scale).toBe(40);
    expect(style.quietZone).toBe(0);
    expect(style.minVersion).toBe(40);
  });

  it('rejects a colour that is not a six digit hex value', () => {
    saveStyle({ ...defaultStyle, dark: 'red', light: '#GGGGGG' });
    expect(loadStyle().dark).toBe(defaultStyle.dark);
    expect(loadStyle().light).toBe(defaultStyle.light);
  });

  it('rejects an unknown error correction level', () => {
    saveStyle({ ...defaultStyle, ec: 'Z' as 'L' });
    expect(loadStyle().ec).toBe(defaultStyle.ec);
  });
});

describe('saved codes', () => {
  it('round trips through IndexedDB, newest first', async () => {
    await saveCode(sample('First', new Date('2026-01-01T00:00:00Z')));
    await saveCode(sample('Second', new Date('2026-05-01T00:00:00Z')));
    expect((await loadCodes()).map((c) => c.name)).toEqual(['Second', 'First']);
  });

  it('deletes a code', async () => {
    const code = sample('Doomed');
    await saveCode(code);
    await deleteCode(code.id);
    expect(await loadCodes()).toHaveLength(0);
  });
});

describe('reviveSavedCode', () => {
  it('rejects a record with no payload', () => {
    expect(reviveSavedCode({ id: 'a' })).toBeNull();
    expect(reviveSavedCode({ id: 'a', payload: '' })).toBeNull();
    expect(reviveSavedCode(null)).toBeNull();
  });

  it('fills in a missing name and style', () => {
    const revived = reviveSavedCode({ id: 'a', payload: 'x' });
    expect(revived?.name).toBe('Untitled code');
    expect(revived?.style).toEqual(defaultStyle);
  });
});

describe('export and import', () => {
  it('exports codes with a count and the current style', async () => {
    await saveCode(sample('One'));
    const envelope = await buildExport(NOW);
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.counts.codes).toBe(1);
    expect(envelope.data.style).toEqual(defaultStyle);
  });

  it('replaces the library on replace', async () => {
    await saveCode(sample('Local'));
    const file = JSON.stringify(createEnvelope(APP_ID, 1, { codes: [sample('FromFile')], style: defaultStyle }, { codes: 1 }));
    await applyImport(file, 'replace');
    expect((await loadCodes()).map((c) => c.name)).toEqual(['FromFile']);
  });

  it('merges libraries', async () => {
    await saveCode(sample('Local'));
    const file = JSON.stringify(createEnvelope(APP_ID, 1, { codes: [sample('FromFile')], style: defaultStyle }, { codes: 1 }));
    expect(await applyImport(file, 'merge')).toBe(2);
  });

  it('refuses an export with nothing readable in it', async () => {
    const file = JSON.stringify(createEnvelope(APP_ID, 1, { codes: [{ nope: 1 }], style: defaultStyle }, { codes: 1 }));
    await expect(applyImport(file, 'merge')).rejects.toThrow(/no readable codes/);
  });

  it('refuses a file from another app', async () => {
    const file = JSON.stringify(createEnvelope('reckoner', 1, { tape: [] }, {}));
    await expect(applyImport(file, 'merge')).rejects.toThrow(/came from "reckoner"/);
  });
});
