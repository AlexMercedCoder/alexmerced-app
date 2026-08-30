import { hexToRgb, PdfDocument, rgb, wrapText, type Page, type StandardFont } from '../../lib/pdf/write';
import { measureText } from '../../lib/pdf/fonts';
import {
  computeTotals, formatMoney, formatQuantity, formatRate, lineSubtotal, effectiveRate, type Invoice,
} from './model';

export type Theme = { accent: string; font: 'sans' | 'serif' };

const MARGIN = 54;
const INK = rgb(0.1, 0.11, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.86, 0.88);

type Faces = { regular: StandardFont; bold: StandardFont };

function faces(theme: Theme): Faces {
  return theme.font === 'serif'
    ? { regular: 'Times-Roman', bold: 'Times-Bold' }
    : { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

/** Columns are laid out from the right so the money always lines up. */
type Columns = { description: number; quantity: number; unit: number; tax: number; amount: number; right: number };

function columns(width: number, showTax: boolean): Columns {
  const right = width - MARGIN;
  const amount = right - 78;
  const tax = showTax ? amount - 52 : amount;
  const unit = tax - 74;
  const quantity = unit - 52;
  return { description: MARGIN, quantity, unit, tax, amount, right };
}

function header(page: Page, invoice: Invoice, theme: Theme, face: Faces): number {
  const accent = hexToRgb(theme.accent);
  const width = page.width;

  page.rect(0, 0, width, 6, { fill: accent });

  let top = MARGIN;
  page.text('INVOICE', MARGIN, top, { font: face.bold, size: 26, color: INK });

  // Number, dates, and status sit right-aligned opposite the title.
  const metaWidth = 220;
  const metaX = width - MARGIN - metaWidth;
  let metaTop = MARGIN + 2;
  const meta: [string, string][] = [
    ['Number', invoice.number],
    ['Issued', invoice.issued],
    ['Due', invoice.due],
  ];
  if (invoice.paid) meta.push(['Status', 'Paid']);

  for (const [label, value] of meta) {
    page.text(label, metaX, metaTop, { font: face.regular, size: 9, color: MUTED });
    page.text(value, metaX, metaTop, { font: face.bold, size: 9.5, color: INK, align: 'right', width: metaWidth });
    metaTop += 15;
  }

  top += 42;
  return Math.max(top, metaTop + 8);
}

function parties(page: Page, invoice: Invoice, face: Faces, top: number): number {
  const half = (page.width - MARGIN * 2 - 24) / 2;
  const blocks: [string, typeof invoice.from, number][] = [
    ['From', invoice.from, MARGIN],
    ['Bill to', invoice.to, MARGIN + half + 24],
  ];

  let deepest = top;
  for (const [label, party, x] of blocks) {
    let y = top;
    page.text(label.toUpperCase(), x, y, { font: face.bold, size: 8, color: MUTED });
    y += 14;
    if (party.name) {
      page.text(party.name, x, y, { font: face.bold, size: 11, color: INK });
      y += 16;
    }
    const lines = [
      ...party.addressLines.split('\n').filter(Boolean),
      party.email,
      party.phone,
      party.reference,
    ].filter(Boolean);
    for (const line of lines) {
      y += page.paragraph(line, x, y, half, { font: face.regular, size: 9.5, color: MUTED, lineHeight: 1.35 });
    }
    deepest = Math.max(deepest, y);
  }
  return deepest + 26;
}

function tableHead(page: Page, cols: Columns, face: Faces, top: number, showTax: boolean): number {
  const label = (text: string, x: number, align: 'left' | 'right', width = 0) =>
    page.text(text, x, top, { font: face.bold, size: 8, color: MUTED, align, width });

  label('DESCRIPTION', cols.description, 'left');
  label('QTY', cols.quantity, 'right', cols.unit - cols.quantity - 8);
  label('UNIT', cols.unit, 'right', cols.tax - cols.unit - 8);
  if (showTax) label('TAX', cols.tax, 'right', cols.amount - cols.tax - 8);
  label('AMOUNT', cols.amount, 'right', cols.right - cols.amount);

  const ruleTop = top + 13;
  page.line(MARGIN, ruleTop, cols.right, ruleTop, { color: RULE, width: 0.8 });
  return ruleTop + 10;
}

/**
 * Builds the finished invoice. Rows flow onto continuation pages when they run
 * out of room, and the totals block is kept whole rather than split across a
 * page break.
 */
export async function toPdf(invoice: Invoice, theme: Theme): Promise<Uint8Array> {
  const face = faces(theme);
  const doc = new PdfDocument({
    title: `Invoice ${invoice.number}`,
    author: invoice.from.name || undefined,
    subject: invoice.to.name ? `Invoice for ${invoice.to.name}` : undefined,
    creator: 'Tally on alexmerced.app',
  });

  const totals = computeTotals(invoice);
  const showTax = totals.taxByRate.length > 0 || invoice.defaultTaxRate > 0;

  let page = doc.addPage('letter');
  let cols = columns(page.width, showTax);
  let top = header(page, invoice, theme, face);
  top = parties(page, invoice, face, top);
  top = tableHead(page, cols, face, top, showTax);

  const bottomLimit = () => page.height - MARGIN - 20;

  const newPage = () => {
    page = doc.addPage('letter');
    cols = columns(page.width, showTax);
    page.rect(0, 0, page.width, 6, { fill: hexToRgb(theme.accent) });
    page.text(`Invoice ${invoice.number}, continued`, MARGIN, MARGIN, { font: face.bold, size: 11, color: MUTED });
    top = tableHead(page, cols, face, MARGIN + 24, showTax);
  };

  const rows = invoice.items.filter((item) => item.description.trim() || lineSubtotal(item) !== 0);

  for (const item of rows) {
    const descriptionWidth = cols.quantity - cols.description - 12;
    const lines = wrapText(item.description || '—', face.regular, 10, descriptionWidth);
    const rowHeight = Math.max(lines.length * 14, 18) + 8;

    if (top + rowHeight > bottomLimit()) newPage();

    lines.forEach((line, index) => {
      page.text(line, cols.description, top + index * 14, { font: face.regular, size: 10, color: INK });
    });
    page.text(formatQuantity(item.quantity), cols.quantity, top, { font: face.regular, size: 10, color: INK, align: 'right', width: cols.unit - cols.quantity - 8 });
    page.text(formatMoney(item.unitPrice, invoice.symbol), cols.unit, top, { font: face.regular, size: 10, color: INK, align: 'right', width: cols.tax - cols.unit - 8 });
    if (showTax) {
      page.text(formatRate(effectiveRate(item, invoice)), cols.tax, top, { font: face.regular, size: 10, color: MUTED, align: 'right', width: cols.amount - cols.tax - 8 });
    }
    page.text(formatMoney(lineSubtotal(item), invoice.symbol), cols.amount, top, { font: face.bold, size: 10, color: INK, align: 'right', width: cols.right - cols.amount });

    top += rowHeight;
    page.line(MARGIN, top - 6, cols.right, top - 6, { color: rgb(0.93, 0.94, 0.95), width: 0.6 });
  }

  // ------------------------------------------------------------- totals
  const totalLines: [string, string, boolean][] = [['Subtotal', formatMoney(totals.subtotal, invoice.symbol), false]];
  if (totals.discount > 0) totalLines.push(['Discount', `-${formatMoney(totals.discount, invoice.symbol)}`, false]);
  for (const entry of totals.taxByRate) {
    totalLines.push([`${invoice.taxLabel} ${formatRate(entry.rate)}`, formatMoney(entry.amount, invoice.symbol), false]);
  }
  totalLines.push(['Total', formatMoney(totals.total, invoice.symbol), true]);

  const totalsHeight = totalLines.length * 18 + 28;
  if (top + totalsHeight > bottomLimit()) newPage();

  top += 12;
  const totalsX = cols.unit;
  const totalsWidth = cols.right - totalsX;
  for (const [label, value, strong] of totalLines) {
    if (strong) {
      page.line(totalsX, top - 6, cols.right, top - 6, { color: RULE, width: 0.8 });
      top += 4;
    }
    page.text(label, totalsX, top, { font: strong ? face.bold : face.regular, size: strong ? 12 : 10, color: strong ? INK : MUTED });
    page.text(value, totalsX, top, {
      font: strong ? face.bold : face.regular,
      size: strong ? 12 : 10,
      color: strong ? hexToRgb(theme.accent) : INK,
      align: 'right',
      width: totalsWidth,
    });
    top += strong ? 22 : 18;
  }

  // ------------------------------------------------------------- footer copy
  const notes = [invoice.notes, invoice.terms].filter((text) => text.trim());
  if (notes.length) {
    if (top + notes.length * 40 > bottomLimit()) newPage();
    top += 16;
    page.line(MARGIN, top, cols.right, top, { color: RULE, width: 0.8 });
    top += 14;
    for (const block of notes) {
      top += page.paragraph(block, MARGIN, top, cols.right - MARGIN, { font: face.regular, size: 9.5, color: MUTED, lineHeight: 1.5 }) + 8;
    }
  }

  return doc.build();
}

/** A plain-text version, for pasting into an email body. */
export function toPlainText(invoice: Invoice): string {
  const totals = computeTotals(invoice);
  const out: string[] = [];
  out.push(`INVOICE ${invoice.number}`);
  out.push(`Issued ${invoice.issued}   Due ${invoice.due}`);
  out.push('');
  if (invoice.from.name) out.push(`From: ${invoice.from.name}`);
  if (invoice.to.name) out.push(`Bill to: ${invoice.to.name}`);
  out.push('');

  const rows = invoice.items.filter((item) => item.description.trim() || lineSubtotal(item) !== 0);
  const widest = Math.max(20, ...rows.map((item) => item.description.length));
  for (const item of rows) {
    const left = `${item.description || '-'}`.padEnd(widest);
    const middle = `${formatQuantity(item.quantity)} x ${formatMoney(item.unitPrice, invoice.symbol)}`.padStart(20);
    out.push(`${left}  ${middle}  ${formatMoney(lineSubtotal(item), invoice.symbol).padStart(12)}`);
  }

  out.push('');
  out.push(`Subtotal: ${formatMoney(totals.subtotal, invoice.symbol)}`);
  if (totals.discount > 0) out.push(`Discount: -${formatMoney(totals.discount, invoice.symbol)}`);
  for (const entry of totals.taxByRate) {
    out.push(`${invoice.taxLabel} ${formatRate(entry.rate)}: ${formatMoney(entry.amount, invoice.symbol)}`);
  }
  out.push(`Total: ${formatMoney(totals.total, invoice.symbol)}`);
  if (invoice.notes.trim()) out.push('', invoice.notes.trim());
  if (invoice.terms.trim()) out.push('', invoice.terms.trim());
  return out.join('\n');
}

/** CSV of the line items, for anyone doing their books in a spreadsheet. */
export function toCsv(invoice: Invoice): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [['Invoice', 'Issued', 'Due', 'Client', 'Description', 'Quantity', 'Unit price', 'Tax rate', 'Amount', 'Currency']];
  for (const item of invoice.items) {
    rows.push([
      invoice.number, invoice.issued, invoice.due, invoice.to.name, item.description,
      formatQuantity(item.quantity),
      (item.unitPrice / 100).toFixed(2),
      (effectiveRate(item, invoice) / 100).toFixed(2),
      (lineSubtotal(item) / 100).toFixed(2),
      invoice.currency,
    ]);
  }
  return rows.map((row) => row.map((cell) => escape(String(cell))).join(',')).join('\n');
}

export function measureLabel(text: string, font: StandardFont, size: number): number {
  return measureText(text, font, size);
}
