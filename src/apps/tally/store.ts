import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, mergeByNewest, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, reviveInvoice, starterInvoice, type Invoice, type Party } from './model';

const DB_NAME = 'tally';
const DB_VERSION = 1;
const SENDER_KEY = 'tally:sender';
const SELECTED_KEY = 'tally:selected';

let invoices: Collection<Invoice> | null = null;

async function connect(): Promise<Collection<Invoice>> {
  if (invoices) return invoices;
  const db = await openDatabase(DB_NAME, DB_VERSION, [{ name: 'invoices', keyPath: 'id' }]);
  invoices = new Collection<Invoice>(db, 'invoices');
  return invoices;
}

/**
 * The sender details live in a preference rather than on each invoice, because
 * they belong to the person and every new invoice should inherit them.
 */
export function loadSender(): Party | null {
  const stored = readPref<Party | null>(SENDER_KEY, null);
  return stored && typeof stored === 'object' ? stored : null;
}
export function saveSender(party: Party): void { writePref(SENDER_KEY, party); }

export function loadSelected(): string | null { return readPref<string | null>(SELECTED_KEY, null); }
export function saveSelected(id: string | null): void { writePref(SELECTED_KEY, id); }

export async function loadInvoices(now: Date = new Date()): Promise<Invoice[]> {
  const store = await connect();
  let list = (await store.all()).map(reviveInvoice).filter((invoice): invoice is Invoice => invoice !== null);
  if (list.length === 0) {
    const seed = starterInvoice(now);
    await store.put(seed);
    list = [seed];
  }
  return sortInvoices(list);
}

/** Newest issue date first, then newest edit, so the current work is on top. */
export function sortInvoices(list: Invoice[]): Invoice[] {
  return [...list].sort((a, b) => b.issued.localeCompare(a.issued) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveInvoice(invoice: Invoice): Promise<void> { await (await connect()).put(invoice); }
export async function deleteInvoice(id: string): Promise<void> { await (await connect()).delete(id); }
export async function clearAll(): Promise<void> { await (await connect()).clear(); }

export type TallyExport = { invoices: Invoice[]; sender: Party | null };

export async function buildExport(now: Date = new Date()) {
  const list = await loadInvoices(now);
  return createEnvelope<TallyExport>(APP_ID, APP_VERSION, { invoices: list, sender: loadSender() }, { invoices: list.length }, now);
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<TallyExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.invoices) ? envelope.data.invoices : [])
    .map(reviveInvoice)
    .filter((invoice): invoice is Invoice => invoice !== null);
  if (!incoming.length) throw new Error('That export contains no readable invoices.');

  const store = await connect();
  if (envelope.data.sender && typeof envelope.data.sender === 'object') saveSender(envelope.data.sender);

  if (mode === 'replace') {
    await store.replaceAll(incoming);
    return incoming.length;
  }
  const current = (await store.all()).map(reviveInvoice).filter((invoice): invoice is Invoice => invoice !== null);
  const merged = mergeByNewest(current, incoming);
  await store.replaceAll(merged);
  return merged.length;
}
