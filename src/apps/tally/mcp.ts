import { readNumber, readString, requireString, textResult, type McpTool } from '../../lib/webmcp';
import {
  computeTotals, createInvoice, createLineItem, formatMoney, formatRate, lineSubtotal, nextNumber,
  parseMoney, parseQuantity, parseRate, statusOf, type Invoice,
} from './model';
import { toCsv, toPdf, toPlainText } from './render';
import { loadInvoices, loadSender, saveInvoice } from './store';

/**
 * Tally's tools. Invoice arithmetic is exactly the kind of thing that should
 * not be done in prose: an agent asked what a job comes to should get the same
 * figure the PDF will show, worked out in whole cents by the same code.
 */
export function tallyTools(onChanged: () => void): McpTool[] {
  return [
    {
      name: 'tally_compute_totals',
      description:
        'Work out what an invoice comes to, without saving anything. Money is held in whole cents so the arithmetic is exact, tax can differ line by line, and a discount is shared across the tax rates in proportion before tax is applied. Returns the subtotal, the discount, tax broken out per rate, and the total.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Each entry is {"description":"...","quantity":2,"unitPrice":150.00,"taxRate":20}. taxRate is a percentage and is optional.',
            items: { type: 'object' },
          },
          defaultTaxRate: { type: 'number', description: 'Percentage applied to lines with no rate of their own.' },
          discountKind: { type: 'string', enum: ['none', 'percent', 'fixed'] },
          discountValue: { type: 'number', description: 'A percentage, or an amount, depending on the kind.' },
          symbol: { type: 'string', description: 'Currency symbol for the formatted figures. "$" by default.' },
        },
        required: ['items'],
      },
      execute: (input) => {
        const invoice = buildInvoice(input);
        const totals = computeTotals(invoice);
        return textResult({
          lines: invoice.items.map((item) => ({
            description: item.description,
            amount: formatMoney(lineSubtotal(item), invoice.symbol),
            amountCents: lineSubtotal(item),
          })),
          subtotal: formatMoney(totals.subtotal, invoice.symbol),
          discount: totals.discount > 0 ? formatMoney(totals.discount, invoice.symbol) : null,
          tax: totals.taxByRate.map((entry) => ({
            rate: formatRate(entry.rate),
            on: formatMoney(entry.base, invoice.symbol),
            amount: formatMoney(entry.amount, invoice.symbol),
          })),
          total: formatMoney(totals.total, invoice.symbol),
          totalCents: totals.total,
        });
      },
    },
    {
      name: 'tally_create_invoice',
      description:
        'Build an invoice and save it to this browser, then return it as a PDF data URI and as plain text for an email. The sender details are reused from the last invoice unless you give new ones. The number carries on from the last invoice unless you set it.',
      inputSchema: {
        type: 'object',
        properties: {
          client: { type: 'string', description: 'Who is being billed.' },
          clientAddress: { type: 'string' },
          clientEmail: { type: 'string' },
          items: { type: 'array', items: { type: 'object' }, description: 'As in tally_compute_totals.' },
          number: { type: 'string', description: 'Invoice number. Carries on from the last one when omitted.' },
          issued: { type: 'string', description: 'YYYY-MM-DD. Today when omitted.' },
          due: { type: 'string', description: 'YYYY-MM-DD. Thirty days out when omitted.' },
          defaultTaxRate: { type: 'number' },
          taxLabel: { type: 'string', description: 'What the tax is called. "Tax" by default.' },
          discountKind: { type: 'string', enum: ['none', 'percent', 'fixed'] },
          discountValue: { type: 'number' },
          symbol: { type: 'string' },
          currency: { type: 'string', description: 'Three letter code, for example USD.' },
          notes: { type: 'string' },
          terms: { type: 'string' },
        },
        required: ['client', 'items'],
      },
      execute: async (input) => {
        const existing = await loadInvoices();
        const invoice = buildInvoice(input);

        invoice.number = readString(input, 'number') || (existing[0] ? nextNumber(existing[0].number) : 'INV-001');
        invoice.to = {
          name: requireString(input, 'client'),
          addressLines: readString(input, 'clientAddress'),
          email: readString(input, 'clientEmail'),
          phone: '',
          reference: '',
        };

        const sender = loadSender();
        if (sender) invoice.from = { ...sender };

        const issued = readString(input, 'issued');
        if (/^\d{4}-\d{2}-\d{2}$/.test(issued)) invoice.issued = issued;
        const due = readString(input, 'due');
        if (/^\d{4}-\d{2}-\d{2}$/.test(due)) invoice.due = due;

        invoice.currency = (readString(input, 'currency', 'USD') || 'USD').toUpperCase().slice(0, 4);
        invoice.notes = readString(input, 'notes');
        invoice.terms = readString(input, 'terms', 'Payment due within 30 days.');

        await saveInvoice(invoice);
        onChanged();

        const totals = computeTotals(invoice);
        const pdf = await toPdf(invoice, { accent: '#0f766e', font: 'sans' });

        return textResult({
          id: invoice.id,
          number: invoice.number,
          client: invoice.to.name,
          total: formatMoney(totals.total, invoice.symbol),
          issued: invoice.issued,
          due: invoice.due,
          plainText: toPlainText(invoice),
          pdf: {
            filename: `${invoice.number.toLowerCase()}.pdf`,
            bytes: pdf.length,
            dataUri: `data:application/pdf;base64,${base64(pdf)}`,
          },
          note: 'Saved to this browser and now on the page, where the sender details can be filled in.',
        });
      },
    },
    {
      name: 'tally_list_invoices',
      description:
        'List the invoices stored in this browser, with their numbers, clients, totals, and whether each is a draft, due, overdue or paid. Use it to answer "who owes me what".',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['all', 'draft', 'due', 'overdue', 'paid'] } },
      },
      execute: async (input) => {
        const wanted = readString(input, 'status', 'all');
        const today = new Date().toISOString().slice(0, 10);
        const invoices = await loadInvoices();

        const described = invoices.map((invoice) => {
          const totals = computeTotals(invoice);
          return {
            id: invoice.id,
            number: invoice.number,
            client: invoice.to.name || '(no client)',
            issued: invoice.issued,
            due: invoice.due,
            status: statusOf(invoice, today),
            total: formatMoney(totals.total, invoice.symbol),
            totalCents: totals.total,
            currency: invoice.currency,
          };
        });

        const filtered = wanted === 'all' ? described : described.filter((invoice) => invoice.status === wanted);
        const outstanding = described
          .filter((invoice) => invoice.status === 'due' || invoice.status === 'overdue')
          .reduce((sum, invoice) => sum + invoice.totalCents, 0);

        return textResult({
          count: filtered.length,
          outstanding: formatMoney(outstanding),
          invoices: filtered,
        });
      },
    },
    {
      name: 'tally_export_invoice',
      description:
        'Get an invoice that is already saved, as a PDF data URI, as plain text for an email, or as CSV of its line items.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The invoice id, or its number.' },
          as: { type: 'string', enum: ['pdf', 'text', 'csv'] },
        },
        required: ['id'],
      },
      execute: async (input) => {
        const wanted = requireString(input, 'id');
        const as = readString(input, 'as', 'pdf');
        const invoices = await loadInvoices();
        const invoice = invoices.find((entry) => entry.id === wanted || entry.number === wanted);
        if (!invoice) {
          return textResult({ error: `No invoice matching "${wanted}".`, available: invoices.map((entry) => entry.number) });
        }

        if (as === 'text') return textResult({ number: invoice.number, text: toPlainText(invoice) });
        if (as === 'csv') return textResult({ number: invoice.number, csv: toCsv(invoice) });

        const pdf = await toPdf(invoice, { accent: '#0f766e', font: 'sans' });
        return textResult({
          number: invoice.number,
          filename: `${invoice.number.toLowerCase()}.pdf`,
          bytes: pdf.length,
          dataUri: `data:application/pdf;base64,${base64(pdf)}`,
        });
      },
    },
  ];
}

/** Turns a tool's loose input into a real invoice the model can work on. */
function buildInvoice(input: Record<string, unknown>): Invoice {
  const invoice = createInvoice();
  const raw = input.items;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('"items" must be a list with at least one line.');

  invoice.items = raw.slice(0, 200).map((entry) => {
    const spec = (entry ?? {}) as Record<string, unknown>;
    const item = createLineItem(typeof spec.description === 'string' ? spec.description : '');

    const quantity = spec.quantity;
    item.quantity = typeof quantity === 'number' ? Math.round(quantity * 1000)
      : parseQuantity(String(quantity ?? '1')) ?? 1000;

    const price = spec.unitPrice;
    item.unitPrice = typeof price === 'number' ? Math.round(price * 100)
      : parseMoney(String(price ?? '0')) ?? 0;

    const rate = spec.taxRate;
    item.taxRate = rate === undefined || rate === null ? null
      : typeof rate === 'number' ? Math.round(rate * 100)
      : parseRate(String(rate));

    return item;
  });

  invoice.defaultTaxRate = Math.max(0, Math.round(readNumber(input, 'defaultTaxRate', 0) * 100));
  invoice.taxLabel = readString(input, 'taxLabel', 'Tax') || 'Tax';
  invoice.symbol = readString(input, 'symbol', '$').slice(0, 3) || '$';

  const kind = readString(input, 'discountKind', 'none');
  if (kind === 'percent' || kind === 'fixed') {
    invoice.discountKind = kind;
    const value = readNumber(input, 'discountValue', 0);
    invoice.discountValue = kind === 'percent' ? Math.round(value * 100) : Math.round(value * 100);
  }

  return invoice;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
