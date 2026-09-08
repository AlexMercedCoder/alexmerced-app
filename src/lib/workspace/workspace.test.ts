import { describe, expect, it } from 'vitest';
import { encode, decode, validateArchive } from './archive';
import { previewImport } from './importPreview';
import { compatible } from './handoff';
import { invoiceFromTime } from './invoice';
import { createEnvelope } from '../portable';
import { createProject, createEntry, defaultSettings } from '../../apps/stint/model';

describe('workspace portability', () => {
  it('preserves binary media and user objects with tag-like fields', async () => {
    const input = { media: new Blob([new Uint8Array([0, 255, 12])], { type: 'video/webm' }), samples: new Float32Array([0.1, -0.5]), raw: new Uint8Array([5, 6]).buffer, user: { tag: 'blob', data: ['bytes', 'fake'] } };
    const result = decode(JSON.parse(JSON.stringify(await encode(input))));
    expect(result.media.type).toBe('video/webm'); expect([...new Uint8Array(await result.media.arrayBuffer())]).toEqual([0, 255, 12]);
    expect([...result.samples]).toEqual([...input.samples]); expect(result.raw).toBeInstanceOf(ArrayBuffer); expect(result.user).toEqual(input.user);
  });
  it('rejects unknown workspaces, missing stores, foreign preferences and duplicate IDs', () => {
    const valid = () => ({ format: 'alexmerced.app/backup', version: 1, createdAt: '', workspaces: [{ app: 'laneway', stores: { boards: [{ id: 'a' }], cards: [] }, preferences: { 'laneway:view': '{}' } }] });
    expect(validateArchive(valid()).workspaces).toHaveLength(1);
    const unknown = valid(); unknown.workspaces[0].app = '__proto__'; expect(() => validateArchive(unknown)).toThrow();
    const duplicate = valid(); duplicate.workspaces[0].stores.boards.push({ id: 'a' }); expect(() => validateArchive(duplicate)).toThrow(/duplicate/);
    const foreign = valid(); Object.assign(foreign.workspaces[0].preferences, { 'tally:sender': '{}' }); expect(() => validateArchive(foreign)).toThrow(/preference/);
    const missing = valid(); delete (missing.workspaces[0].stores as any).cards; expect(() => validateArchive(missing)).toThrow(/missing/);
  });
  it('uses actual incoming rows, not claimed record counts, in previews', () => {
    const incoming = createEnvelope('laneway', 1, { boards: [{ id: 'a' }, { id: 'b' }] }, { boards: 9000 });
    const current = createEnvelope('laneway', 1, { boards: [{ id: 'a' }] }, { boards: 1 });
    expect(previewImport(JSON.stringify(incoming), 'laneway', current).lines.join(' ')).toContain('2 incoming, 1 matching IDs, 1 new');
    expect(() => previewImport(JSON.stringify(incoming), 'rote', current)).toThrow();
  });
  it('routes compatible files without offering PDF processing for arbitrary text', () => {
    expect(compatible({ name: 'report.csv', type: '' })).toEqual(['quarry', 'ordinate', 'decanter']);
    expect(compatible({ name: 'photo.png', type: 'image/png' })).toContain('quire');
    expect(compatible({ name: 'unknown.exe', type: '' })).toEqual([]);
  });
  it('invoices only completed billable time for one project using its rate and currency', () => {
    const project = { ...createProject('Design'), rate: 75, client: 'Example' };
    const entry = { ...createEntry(project.id, 'Draft'), start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:30:00Z' };
    const invoice = invoiceFromTime(project, [entry, { ...entry, projectId: 'other' }, { ...entry, billable: false }, { ...entry, end: null }], { ...defaultSettings, currency: 'EUR' });
    expect(invoice.items).toHaveLength(1); expect(invoice.items[0]).toMatchObject({ quantity: 1500, unitPrice: 7500 }); expect(invoice.currency).toBe('EUR'); expect(invoice.to.name).toBe('Example');
    expect(() => invoiceFromTime(project, [{ ...entry, end: null }], defaultSettings)).toThrow(/completed/);
  });
});

it('restores preferences with records and rolls back when a record cannot be cloned', async () => {
  const { restore, capture } = await import('./archive');
  const original = { format: 'alexmerced.app/backup' as const, version: 1 as const, createdAt: '', workspaces: [{ app: 'laneway', stores: { boards: [{ id: 'original', name: 'Keep this' }], cards: [] }, preferences: { 'laneway:view': '{"boardId":"original"}' } }] };
  await restore(original, ['laneway'], () => {});
  expect((await capture('laneway')).preferences).toEqual(original.workspaces[0].preferences);
  const broken = { ...original, workspaces: [{ ...original.workspaces[0], stores: { boards: [{ id: 'bad', cannotClone: () => {} }], cards: [] } }] };
  await expect(restore(broken, ['laneway'], () => {})).rejects.toThrow();
  expect(await capture('laneway')).toEqual(original.workspaces[0]);
});

it('keeps the Stint charge exact when fractional hours exceed invoice quantity precision', async () => {
  const { lineSubtotal } = await import('../../apps/tally/model');
  const project = { ...createProject('Review'), rate: 75 };
  const entry = { ...createEntry(project.id), start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:01:00Z' };
  const invoice = invoiceFromTime(project, [entry], defaultSettings);
  expect(lineSubtotal(invoice.items[0])).toBe(125);
  expect(invoice.items[0].description).toContain('Exact time charge');
});
