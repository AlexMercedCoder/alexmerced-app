import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, APP_VERSION, createInvoice, createLineItem, type Invoice } from './model';
import {
  applyImport, buildExport, clearAll, deleteInvoice, loadInvoices, loadSender,
  saveInvoice, saveSender, sortInvoices, type TallyExport,
} from './store';

beforeEach(async () => {
  await clearAll();
  localStorage.clear();
});

function make(id: string, issued: string, updatedAt: string): Invoice {
  const invoice = createInvoice('INV-1', new Date(`${issued}T00:00:00Z`));
  return { ...invoice, id, issued, updatedAt };
}

describe('loadInvoices', () => {
  it('seeds a starter invoice on first run so the page is never blank', async () => {
    const list = await loadInvoices();
    expect(list).toHaveLength(1);
    expect(list[0].items.length).toBeGreaterThan(1);
  });

  it('does not re-seed once something exists', async () => {
    await loadInvoices();
    const again = await loadInvoices();
    expect(again).toHaveLength(1);
  });
});

describe('sortInvoices', () => {
  it('puts the newest issue date first', () => {
    const sorted = sortInvoices([make('a', '2026-01-01', 'x'), make('b', '2026-05-01', 'x')]);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('breaks ties on the same day by most recently edited', () => {
    const sorted = sortInvoices([
      make('a', '2026-01-01', '2026-01-01T01:00:00Z'),
      make('b', '2026-01-01', '2026-01-01T09:00:00Z'),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('export and import', () => {
  it('carries the sender details alongside the invoices', async () => {
    await loadInvoices();
    saveSender({ name: 'Me', addressLines: 'Here', email: 'me@example.com', phone: '', reference: '' });
    const envelope = await buildExport();
    expect(envelope.app).toBe(APP_ID);
    expect(envelope.data.sender?.name).toBe('Me');
    expect(envelope.counts).toEqual({ invoices: 1 });
  });

  it('replaces everything in replace mode', async () => {
    await loadInvoices();
    const replacement = make('inv_new', '2026-06-01', '2026-06-01T00:00:00Z');
    const text = JSON.stringify(createEnvelope<TallyExport>(APP_ID, APP_VERSION, { invoices: [replacement], sender: null }, {}));
    expect(await applyImport(text, 'replace')).toBe(1);
    const list = await loadInvoices();
    expect(list.map((i) => i.id)).toEqual(['inv_new']);
  });

  it('keeps the newer copy of a conflicting invoice when merging', async () => {
    const mine = make('inv_1', '2026-01-01', '2026-05-01T00:00:00Z');
    mine.number = 'MINE';
    await saveInvoice(mine);

    const theirs = { ...mine, number: 'THEIRS', updatedAt: '2026-01-01T00:00:00Z' };
    const text = JSON.stringify(createEnvelope<TallyExport>(APP_ID, APP_VERSION, { invoices: [theirs], sender: null }, {}));
    await applyImport(text, 'merge');

    const list = await loadInvoices();
    expect(list.find((i) => i.id === 'inv_1')!.number).toBe('MINE');
  });

  it('restores the sender from an import', async () => {
    const sender = { name: 'Imported', addressLines: '', email: '', phone: '', reference: '' };
    const text = JSON.stringify(createEnvelope<TallyExport>(APP_ID, APP_VERSION, { invoices: [make('a', '2026-01-01', 'x')], sender }, {}));
    await applyImport(text, 'replace');
    expect(loadSender()?.name).toBe('Imported');
  });

  it('refuses an export from a different app', async () => {
    const text = JSON.stringify(createEnvelope('rote', 1, { invoices: [] }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow();
  });

  it('refuses an export with nothing readable in it', async () => {
    const text = JSON.stringify(createEnvelope<TallyExport>(APP_ID, APP_VERSION, { invoices: [], sender: null }, {}));
    await expect(applyImport(text, 'merge')).rejects.toThrow(/no readable invoices/);
  });
});

describe('deleteInvoice', () => {
  it('removes only the one named', async () => {
    await saveInvoice(make('a', '2026-01-01', 'x'));
    await saveInvoice(make('b', '2026-02-01', 'x'));
    await deleteInvoice('a');
    const list = await loadInvoices();
    expect(list.map((i) => i.id)).toEqual(['b']);
  });
});

describe('round trip', () => {
  it('survives a full export and reimport with line items intact', async () => {
    const invoice = make('inv_round', '2026-04-04', '2026-04-04T00:00:00Z');
    invoice.items = [createLineItem('Design', 3.5, 12500), createLineItem('Build', 10, 15000)];
    invoice.defaultTaxRate = 2000;
    await saveInvoice(invoice);

    const text = JSON.stringify(await buildExport());
    await clearAll();
    await applyImport(text, 'replace');

    const restored = (await loadInvoices()).find((i) => i.id === 'inv_round')!;
    expect(restored.items.map((i) => i.description)).toEqual(['Design', 'Build']);
    expect(restored.items[0].quantity).toBe(3500);
    expect(restored.defaultTaxRate).toBe(2000);
  });
});
