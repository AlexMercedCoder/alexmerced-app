import { createId } from '../../lib/id';

export const APP_ID = 'tally';
export const APP_VERSION = 1;

/**
 * Money is held in integer minor units throughout. Floating point cents are
 * how invoices end up a penny out, and an invoice that is a penny out is worse
 * than useless.
 */
export type Cents = number;

export type LineItem = {
  id: string;
  description: string;
  /** Thousandths of a unit, so 1.5 hours is 1500. */
  quantity: number;
  unitPrice: Cents;
  /** Percent, in hundredths: 20% is 2000. Null means the invoice default. */
  taxRate: number | null;
};

export type Party = {
  name: string;
  addressLines: string;
  email: string;
  phone: string;
  /** Tax number, company number, whatever the jurisdiction wants. */
  reference: string;
};

export type DiscountKind = 'none' | 'percent' | 'fixed';

export type Invoice = {
  id: string;
  number: string;
  issued: string;
  due: string;
  currency: string;
  /** Where the symbol sits relative to the number. */
  symbol: string;
  from: Party;
  to: Party;
  items: LineItem[];
  /** Percent in hundredths, applied to items with no rate of their own. */
  defaultTaxRate: number;
  taxLabel: string;
  discountKind: DiscountKind;
  /** Percent in hundredths, or an amount in cents, depending on the kind. */
  discountValue: number;
  notes: string;
  terms: string;
  paid: boolean;
  createdAt: string;
  updatedAt: string;
};

export const QUANTITY_SCALE = 1000;
export const RATE_SCALE = 100;

export function createLineItem(description = '', quantity = 1, unitPrice = 0): LineItem {
  return { id: createId('item'), description, quantity: quantity * QUANTITY_SCALE, unitPrice, taxRate: null };
}

export function emptyParty(): Party {
  return { name: '', addressLines: '', email: '', phone: '', reference: '' };
}

export function createInvoice(number = 'INV-001', now: Date = new Date()): Invoice {
  const stamp = now.toISOString();
  const issued = now.toISOString().slice(0, 10);
  return {
    id: createId('inv'),
    number,
    issued,
    due: addDays(issued, 30),
    currency: 'USD',
    symbol: '$',
    from: emptyParty(),
    to: emptyParty(),
    items: [createLineItem('', 1, 0)],
    defaultTaxRate: 0,
    taxLabel: 'Tax',
    discountKind: 'none',
    discountValue: 0,
    notes: '',
    terms: 'Payment due within 30 days.',
    paid: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + count));
  return shifted.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// --------------------------------------------------------------------- money

/** Rounds half away from zero, which is what invoices are expected to do. */
export function roundCents(value: number): Cents {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function lineSubtotal(item: LineItem): Cents {
  return roundCents((item.quantity * item.unitPrice) / QUANTITY_SCALE);
}

export function effectiveRate(item: LineItem, invoice: Invoice): number {
  return item.taxRate === null ? invoice.defaultTaxRate : item.taxRate;
}

export type Totals = {
  subtotal: Cents;
  discount: Cents;
  taxable: Cents;
  /** Tax broken out per rate, since a tax summary has to show its working. */
  taxByRate: { rate: number; base: Cents; amount: Cents }[];
  tax: Cents;
  total: Cents;
};

/**
 * A discount reduces each line proportionally before tax, so a mixed-rate
 * invoice still charges the right tax on the discounted amount.
 */
export function computeTotals(invoice: Invoice): Totals {
  const lines = invoice.items.map((item) => ({ item, gross: lineSubtotal(item) }));
  const subtotal = lines.reduce((sum, line) => sum + line.gross, 0);

  let discount = 0;
  if (invoice.discountKind === 'percent') {
    discount = roundCents((subtotal * invoice.discountValue) / (RATE_SCALE * 100));
  } else if (invoice.discountKind === 'fixed') {
    discount = Math.min(invoice.discountValue, subtotal);
  }
  if (discount < 0) discount = 0;

  const taxable = subtotal - discount;

  const byRate = new Map<number, Cents>();
  for (const line of lines) {
    const rate = effectiveRate(line.item, invoice);
    // Share the discount out in proportion to each line's contribution.
    const share = subtotal === 0 ? 0 : roundCents((discount * line.gross) / subtotal);
    const base = line.gross - share;
    byRate.set(rate, (byRate.get(rate) ?? 0) + base);
  }

  const taxByRate = [...byRate.entries()]
    .filter(([rate]) => rate > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([rate, base]) => ({ rate, base, amount: roundCents((base * rate) / (RATE_SCALE * 100)) }));

  const tax = taxByRate.reduce((sum, entry) => sum + entry.amount, 0);

  return { subtotal, discount, taxable, taxByRate, tax, total: taxable + tax };
}

export function formatMoney(cents: Cents, symbol = '$'): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100).toLocaleString('en-US');
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol}${whole}.${fraction}`;
}

/** Two decimal places at most, with trailing zeros dropped. */
function trimDecimals(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function formatQuantity(quantity: number): string {
  return trimDecimals(quantity / QUANTITY_SCALE);
}

export function formatRate(rate: number): string {
  return `${trimDecimals(rate / RATE_SCALE)}%`;
}

/** Parses "1,234.56" or "1234.5" into cents without floating point drift. */
export function parseMoney(text: string): Cents | null {
  const cleaned = text.replace(/[^0-9.\-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const negative = cleaned.startsWith('-');
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function parseQuantity(text: string): number | null {
  const value = Number(text.replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * QUANTITY_SCALE);
}

export function parseRate(text: string): number | null {
  const value = Number(text.replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * RATE_SCALE);
}

/** Bumps the trailing number in an invoice number, keeping any padding. */
export function nextNumber(previous: string): string {
  const match = /^(.*?)(\d+)(\D*)$/.exec(previous);
  if (!match) return `${previous}-2`;
  const [, prefix, digits, suffix] = match;
  const incremented = String(Number(digits) + 1).padStart(digits.length, '0');
  return `${prefix}${incremented}${suffix}`;
}

export type InvoiceStatus = 'draft' | 'paid' | 'due' | 'overdue';

export function statusOf(invoice: Invoice, today: string): InvoiceStatus {
  if (invoice.paid) return 'paid';
  if (!invoice.to.name.trim() || invoice.items.every((item) => !item.description.trim())) return 'draft';
  return daysBetween(invoice.due, today) > 0 ? 'overdue' : 'due';
}

// --------------------------------------------------------------------- reviving

export function reviveParty(value: unknown): Party {
  const party = (typeof value === 'object' && value !== null ? value : {}) as Partial<Party>;
  const text = (key: keyof Party) => (typeof party[key] === 'string' ? (party[key] as string) : '');
  return {
    name: text('name'),
    addressLines: text('addressLines'),
    email: text('email'),
    phone: text('phone'),
    reference: text('reference'),
  };
}

export function reviveLineItem(value: unknown): LineItem | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Partial<LineItem>;
  return {
    id: typeof item.id === 'string' ? item.id : createId('item'),
    description: typeof item.description === 'string' ? item.description : '',
    quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? Math.round(item.quantity) : QUANTITY_SCALE,
    unitPrice: typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) ? Math.round(item.unitPrice) : 0,
    taxRate: typeof item.taxRate === 'number' && item.taxRate >= 0 ? Math.round(item.taxRate) : null,
  };
}

export function reviveInvoice(value: unknown): Invoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const invoice = value as Partial<Invoice>;
  if (typeof invoice.id !== 'string') return null;

  const items = Array.isArray(invoice.items)
    ? invoice.items.map(reviveLineItem).filter((item): item is LineItem => item !== null)
    : [];
  const stamp = new Date().toISOString();
  const day = (input: unknown, fallback: string) =>
    typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : fallback;
  const today = stamp.slice(0, 10);

  const kinds = new Set(['none', 'percent', 'fixed']);

  return {
    id: invoice.id,
    number: typeof invoice.number === 'string' && invoice.number.trim() ? invoice.number : 'INV-001',
    issued: day(invoice.issued, today),
    due: day(invoice.due, addDays(day(invoice.issued, today), 30)),
    currency: typeof invoice.currency === 'string' ? invoice.currency.slice(0, 4).toUpperCase() : 'USD',
    symbol: typeof invoice.symbol === 'string' && invoice.symbol ? invoice.symbol.slice(0, 3) : '$',
    from: reviveParty(invoice.from),
    to: reviveParty(invoice.to),
    items: items.length ? items : [createLineItem('', 1, 0)],
    defaultTaxRate: typeof invoice.defaultTaxRate === 'number' && invoice.defaultTaxRate >= 0 ? Math.round(invoice.defaultTaxRate) : 0,
    taxLabel: typeof invoice.taxLabel === 'string' && invoice.taxLabel.trim() ? invoice.taxLabel : 'Tax',
    discountKind: kinds.has(invoice.discountKind as string) ? (invoice.discountKind as DiscountKind) : 'none',
    discountValue: typeof invoice.discountValue === 'number' && invoice.discountValue >= 0 ? Math.round(invoice.discountValue) : 0,
    notes: typeof invoice.notes === 'string' ? invoice.notes : '',
    terms: typeof invoice.terms === 'string' ? invoice.terms : '',
    paid: invoice.paid === true,
    createdAt: typeof invoice.createdAt === 'string' ? invoice.createdAt : stamp,
    updatedAt: typeof invoice.updatedAt === 'string' ? invoice.updatedAt : stamp,
  };
}

export function starterInvoice(now: Date = new Date()): Invoice {
  const invoice = createInvoice('INV-001', now);
  invoice.from = {
    name: 'Your name or company',
    addressLines: '123 Example Street\nSomewhere',
    email: 'you@example.com',
    phone: '',
    reference: '',
  };
  invoice.to = {
    name: 'Client name',
    addressLines: '456 Another Road\nElsewhere',
    email: 'accounts@example.com',
    phone: '',
    reference: '',
  };
  invoice.items = [
    { ...createLineItem('Consulting, week one', 20, 15000) },
    { ...createLineItem('Consulting, week two', 12.5, 15000) },
    { ...createLineItem('Travel', 1, 24500) },
  ];
  invoice.defaultTaxRate = 0;
  invoice.notes = 'Thank you. Bank details on request.';
  return invoice;
}
