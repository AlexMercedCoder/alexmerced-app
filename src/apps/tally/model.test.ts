import { describe, expect, it } from 'vitest';
import {
  addDays, computeTotals, createInvoice, createLineItem, daysBetween, formatMoney, formatQuantity,
  formatRate, lineSubtotal, nextNumber, parseMoney, parseQuantity, parseRate, QUANTITY_SCALE,
  RATE_SCALE, reviveInvoice, roundCents, starterInvoice, statusOf, type Invoice,
} from './model';

function build(mutate: (invoice: Invoice) => void): Invoice {
  const invoice = createInvoice('INV-100', new Date('2026-03-01T00:00:00Z'));
  invoice.items = [];
  mutate(invoice);
  return invoice;
}

describe('money rounding', () => {
  it('rounds half away from zero in both directions', () => {
    expect(roundCents(10.5)).toBe(11);
    expect(roundCents(-10.5)).toBe(-11);
    expect(roundCents(10.4)).toBe(10);
  });

  it('keeps a line subtotal exact for fractional quantities', () => {
    // 12.5 hours at $150.00 is exactly $1,875.00, not 1874.9999...
    const item = createLineItem('Work', 12.5, 15000);
    expect(lineSubtotal(item)).toBe(187500);
  });

  it('handles a third of an hour without drift', () => {
    const item = { ...createLineItem('Work', 1, 10000), quantity: 333 };
    expect(lineSubtotal(item)).toBe(3330);
  });
});

describe('computeTotals', () => {
  it('sums lines with no tax and no discount', () => {
    const invoice = build((draft) => {
      draft.items = [createLineItem('A', 2, 1000), createLineItem('B', 3, 500)];
    });
    const totals = computeTotals(invoice);
    expect(totals.subtotal).toBe(3500);
    expect(totals.tax).toBe(0);
    expect(totals.total).toBe(3500);
  });

  it('applies the invoice default rate to lines with no rate of their own', () => {
    const invoice = build((draft) => {
      draft.defaultTaxRate = 20 * RATE_SCALE;
      draft.items = [createLineItem('A', 1, 10000)];
    });
    const totals = computeTotals(invoice);
    expect(totals.tax).toBe(2000);
    expect(totals.total).toBe(12000);
  });

  it('lets a line override the default rate', () => {
    const invoice = build((draft) => {
      draft.defaultTaxRate = 20 * RATE_SCALE;
      draft.items = [{ ...createLineItem('Zero rated', 1, 10000), taxRate: 0 }];
    });
    expect(computeTotals(invoice).tax).toBe(0);
  });

  it('breaks tax out per rate so the summary can show its working', () => {
    const invoice = build((draft) => {
      draft.defaultTaxRate = 20 * RATE_SCALE;
      draft.items = [
        createLineItem('Standard', 1, 10000),
        { ...createLineItem('Reduced', 1, 10000), taxRate: 5 * RATE_SCALE },
        { ...createLineItem('Exempt', 1, 10000), taxRate: 0 },
      ];
    });
    const totals = computeTotals(invoice);
    expect(totals.taxByRate).toEqual([
      { rate: 500, base: 10000, amount: 500 },
      { rate: 2000, base: 10000, amount: 2000 },
    ]);
    expect(totals.tax).toBe(2500);
    expect(totals.total).toBe(32500);
  });

  it('takes a percentage discount before tax', () => {
    const invoice = build((draft) => {
      draft.defaultTaxRate = 10 * RATE_SCALE;
      draft.discountKind = 'percent';
      draft.discountValue = 10 * RATE_SCALE;
      draft.items = [createLineItem('A', 1, 10000)];
    });
    const totals = computeTotals(invoice);
    expect(totals.discount).toBe(1000);
    expect(totals.taxable).toBe(9000);
    expect(totals.tax).toBe(900);
    expect(totals.total).toBe(9900);
  });

  it('shares a fixed discount across rates in proportion', () => {
    const invoice = build((draft) => {
      draft.defaultTaxRate = 20 * RATE_SCALE;
      draft.discountKind = 'fixed';
      draft.discountValue = 10000;
      draft.items = [
        createLineItem('Standard', 1, 30000),
        { ...createLineItem('Exempt', 1, 10000), taxRate: 0 },
      ];
    });
    const totals = computeTotals(invoice);
    // $100 off $400 is a quarter, so $75 comes off the standard-rated line.
    expect(totals.discount).toBe(10000);
    expect(totals.taxByRate).toEqual([{ rate: 2000, base: 22500, amount: 4500 }]);
    expect(totals.total).toBe(30000 + 4500);
  });

  it('never discounts past zero', () => {
    const invoice = build((draft) => {
      draft.discountKind = 'fixed';
      draft.discountValue = 999999;
      draft.items = [createLineItem('A', 1, 5000)];
    });
    const totals = computeTotals(invoice);
    expect(totals.discount).toBe(5000);
    expect(totals.total).toBe(0);
  });

  it('survives an invoice with no lines at all', () => {
    const invoice = build((draft) => {
      draft.discountKind = 'percent';
      draft.discountValue = 5000;
    });
    const totals = computeTotals(invoice);
    expect(totals.subtotal).toBe(0);
    expect(totals.total).toBe(0);
  });

  it('keeps the per-rate bases summing to the discounted subtotal', () => {
    const invoice = build((draft) => {
      draft.defaultTaxRate = 7 * RATE_SCALE;
      draft.discountKind = 'percent';
      draft.discountValue = 13 * RATE_SCALE;
      draft.items = [
        createLineItem('A', 3, 3333),
        createLineItem('B', 7, 1111),
        { ...createLineItem('C', 1, 9999), taxRate: 0 },
      ];
    });
    const totals = computeTotals(invoice);
    const bases = totals.taxByRate.reduce((sum, entry) => sum + entry.base, 0);
    const exempt = totals.taxable - bases;
    expect(exempt).toBeGreaterThan(0);
    expect(bases + exempt).toBe(totals.taxable);
  });
});

describe('parsing', () => {
  it('reads money written the way people write it', () => {
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('$99')).toBe(9900);
    expect(parseMoney('0.5')).toBe(50);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('-12.34')).toBe(-1234);
  });

  it('truncates beyond two decimal places rather than rounding up a charge', () => {
    expect(parseMoney('1.999')).toBe(199);
  });

  it('returns null for nothing usable', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-')).toBeNull();
  });

  it('reads quantities and rates', () => {
    expect(parseQuantity('2.5')).toBe(2500);
    expect(parseRate('7.5')).toBe(750);
    expect(parseRate('-1')).toBeNull();
  });
});

describe('formatting', () => {
  it('groups thousands and always shows two decimal places', () => {
    expect(formatMoney(123456789)).toBe('$1,234,567.89');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(-1250, '£')).toBe('-£12.50');
  });

  it('drops pointless decimals from quantities and rates', () => {
    expect(formatQuantity(QUANTITY_SCALE)).toBe('1');
    expect(formatQuantity(2500)).toBe('2.5');
    expect(formatRate(2000)).toBe('20%');
    expect(formatRate(750)).toBe('7.5%');
  });
});

describe('dates and numbering', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-01-20', 30)).toBe('2026-02-19');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('counts days between two dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30);
  });

  it('increments the trailing number and keeps the padding', () => {
    expect(nextNumber('INV-001')).toBe('INV-002');
    expect(nextNumber('INV-099')).toBe('INV-100');
    expect(nextNumber('2026-7')).toBe('2026-8');
    expect(nextNumber('draft')).toBe('draft-2');
  });
});

describe('statusOf', () => {
  const ready = (mutate: (invoice: Invoice) => void = () => {}) => {
    const invoice = createInvoice('INV-1', new Date('2026-03-01T00:00:00Z'));
    invoice.to.name = 'Client';
    invoice.items = [createLineItem('Work', 1, 1000)];
    mutate(invoice);
    return invoice;
  };

  it('calls an invoice with no client a draft', () => {
    expect(statusOf(createInvoice(), '2026-03-01')).toBe('draft');
  });

  it('calls a paid invoice paid even when it is late', () => {
    expect(statusOf(ready((i) => { i.paid = true; }), '2027-01-01')).toBe('paid');
  });

  it('separates due from overdue at the due date', () => {
    const invoice = ready((i) => { i.due = '2026-03-31'; });
    expect(statusOf(invoice, '2026-03-31')).toBe('due');
    expect(statusOf(invoice, '2026-04-01')).toBe('overdue');
  });
});

describe('reviveInvoice', () => {
  it('rejects anything without an id', () => {
    expect(reviveInvoice(null)).toBeNull();
    expect(reviveInvoice({ number: 'INV-1' })).toBeNull();
  });

  it('round trips a starter invoice through JSON unchanged', () => {
    const original = starterInvoice(new Date('2026-03-01T00:00:00Z'));
    const revived = reviveInvoice(JSON.parse(JSON.stringify(original)));
    expect(revived).toEqual(original);
  });

  it('replaces junk fields with usable defaults', () => {
    const revived = reviveInvoice({
      id: 'inv_1', number: '', issued: 'nonsense', currency: 'usdollar',
      defaultTaxRate: -5, discountKind: 'sideways', items: ['nope', null],
    })!;
    expect(revived.number).toBe('INV-001');
    expect(revived.issued).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(revived.currency).toBe('USDO');
    expect(revived.defaultTaxRate).toBe(0);
    expect(revived.discountKind).toBe('none');
    expect(revived.items).toHaveLength(1);
  });

  it('keeps a due date that is already present', () => {
    const revived = reviveInvoice({ id: 'inv_1', issued: '2026-01-01', due: '2026-01-15' })!;
    expect(revived.due).toBe('2026-01-15');
  });
});
