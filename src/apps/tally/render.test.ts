import { describe, expect, it } from 'vitest';
import { createInvoice, createLineItem, RATE_SCALE, type Invoice } from './model';
import { toCsv, toPdf, toPlainText, type Theme } from './render';

const theme: Theme = { accent: '#0f766e', font: 'sans' };

function sample(mutate: (invoice: Invoice) => void = () => {}): Invoice {
  const invoice = createInvoice('INV-042', new Date('2026-03-01T00:00:00Z'));
  invoice.from = { name: 'Studio', addressLines: '1 Road\nTown', email: 'a@b.com', phone: '', reference: '' };
  invoice.to = { name: 'Client Co', addressLines: '2 Street', email: '', phone: '', reference: '' };
  invoice.items = [createLineItem('Design work', 10, 15000), createLineItem('Hosting', 1, 2500)];
  mutate(invoice);
  return invoice;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

describe('toPdf', () => {
  it('produces a file that starts and ends the way a PDF must', async () => {
    const bytes = await toPdf(sample(), theme);
    expect(text(bytes.slice(0, 8))).toBe('%PDF-1.7');
    expect(text(bytes.slice(-7))).toContain('%%EOF');
  });

  it('carries the invoice number into the document title', async () => {
    const body = text(await toPdf(sample(), theme));
    expect(body).toContain('Invoice INV-042');
  });

  it('flows a long invoice onto more than one page', async () => {
    const many = sample((invoice) => {
      invoice.items = Array.from({ length: 60 }, (_, index) => createLineItem(`Line item number ${index + 1}`, 1, 1000));
    });
    const body = text(await toPdf(many, theme));
    const pageCount = Number(/\/Count (\d+)/.exec(body)?.[1] ?? 0);
    expect(pageCount).toBeGreaterThan(1);
    expect(body).toContain('continued');
  });

  it('keeps a single short invoice on one page', async () => {
    const body = text(await toPdf(sample(), theme));
    expect(/\/Count (\d+)/.exec(body)?.[1]).toBe('1');
  });

  it('omits the tax column when nothing is taxed', async () => {
    const body = text(await toPdf(sample(), theme));
    expect(body).not.toContain('(TAX)');
  });

  it('shows the tax column once a rate is set', async () => {
    const body = text(await toPdf(sample((invoice) => { invoice.defaultTaxRate = 20 * RATE_SCALE; }), theme));
    expect(body).toContain('(TAX)');
  });

  it('accepts the serif theme without changing the structure', async () => {
    const body = text(await toPdf(sample(), { accent: '#7c3aed', font: 'serif' }));
    expect(body).toContain('Times-Roman');
    expect(body).toContain('Times-Bold');
  });

  it('renders an empty invoice rather than throwing', async () => {
    const blank = createInvoice('INV-0', new Date('2026-03-01T00:00:00Z'));
    const bytes = await toPdf(blank, theme);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('escapes parentheses in a client name instead of corrupting the file', async () => {
    const tricky = sample((invoice) => { invoice.to.name = 'Acme (Holdings) Ltd'; });
    const body = text(await toPdf(tricky, theme));
    expect(body).toContain('Acme \\(Holdings\\) Ltd');
  });
});

describe('toPlainText', () => {
  it('lists every line and the total', () => {
    const output = toPlainText(sample((invoice) => { invoice.defaultTaxRate = 10 * RATE_SCALE; }));
    expect(output).toContain('INVOICE INV-042');
    expect(output).toContain('Design work');
    expect(output).toContain('Subtotal: $1,525.00');
    expect(output).toContain('Tax 10%: $152.50');
    expect(output).toContain('Total: $1,677.50');
  });

  it('leaves out empty lines rather than printing blanks', () => {
    const output = toPlainText(sample((invoice) => { invoice.items.push(createLineItem('', 0, 0)); }));
    expect(output.split('\n').filter((line) => line.trim() === '-')).toHaveLength(0);
  });
});

describe('toCsv', () => {
  it('writes a header row and one row per line item', () => {
    const rows = toCsv(sample()).split('\n');
    expect(rows[0]).toContain('Description');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('Design work,10,150.00');
  });

  it('quotes a description containing a comma', () => {
    const csv = toCsv(sample((invoice) => { invoice.items[0].description = 'Design, build, and test'; }));
    expect(csv).toContain('"Design, build, and test"');
  });

  it('doubles quotes inside a value', () => {
    const csv = toCsv(sample((invoice) => { invoice.items[0].description = 'The "big" one'; }));
    expect(csv).toContain('"The ""big"" one"');
  });
});
