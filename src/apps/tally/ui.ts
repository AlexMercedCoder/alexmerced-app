import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob, downloadFile } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { toast } from '../../lib/toast';
import {
  addDays, computeTotals, createInvoice, createLineItem, effectiveRate, formatMoney, formatQuantity,
  formatRate, lineSubtotal, nextNumber, parseMoney, parseQuantity, parseRate, statusOf,
  type DiscountKind, type Invoice, type LineItem, type Party,
} from './model';
import { toCsv, toPdf, toPlainText, type Theme } from './render';
import { registerTools } from '../../lib/webmcp';
import { tallyTools } from './mcp';
import {
  applyImport, buildExport, clearAll, deleteInvoice, loadInvoices, loadSelected, loadSender,
  saveInvoice, saveSelected, saveSender, sortInvoices,
} from './store';

const THEME_KEY = 'tally:theme';

const ACCENTS = [
  { id: '#0f766e', label: 'Teal' },
  { id: '#1d4ed8', label: 'Blue' },
  { id: '#b45309', label: 'Amber' },
  { id: '#9f1239', label: 'Crimson' },
  { id: '#334155', label: 'Slate' },
];

function loadTheme(): Theme {
  const stored = readPref<Partial<Theme>>(THEME_KEY, {});
  return {
    accent: ACCENTS.some((entry) => entry.id === stored.accent) ? stored.accent! : ACCENTS[0].id,
    font: stored.font === 'serif' ? 'serif' : 'sans',
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A filename that survives a filesystem, derived from the invoice number. */
function safeName(invoice: Invoice): string {
  const client = invoice.to.name.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const number = invoice.number.replace(/[^a-z0-9-]+/gi, '-');
  return [number, client].filter(Boolean).join('-').toLowerCase() || 'invoice';
}

export async function mountTally(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const listEl = $<HTMLDivElement>('ty-list');
  const emptyEl = $<HTMLDivElement>('ty-list-empty');
  const editorEl = $<HTMLDivElement>('ty-editor');
  const itemsEl = $<HTMLDivElement>('ty-items');
  const totalsEl = $<HTMLDivElement>('ty-totals');
  const previewEl = $<HTMLIFrameElement>('ty-preview');

  let invoices: Invoice[] = [];
  let current: Invoice | null = null;
  let theme = loadTheme();
  let previewUrl: string | null = null;
  let previewTimer = 0;

  // ------------------------------------------------------------------ state

  const touch = async () => {
    if (!current) return;
    current.updatedAt = new Date().toISOString();
    await saveInvoice(current);
    invoices = sortInvoices(invoices.map((invoice) => (invoice.id === current!.id ? current! : invoice)));
    renderList();
    renderTotals();
    schedulePreview();
  };

  const select = (id: string) => {
    current = invoices.find((invoice) => invoice.id === id) ?? invoices[0] ?? null;
    saveSelected(current?.id ?? null);
    renderList();
    renderEditor();
    renderItems();
    renderTotals();
    schedulePreview();
  };

  // ------------------------------------------------------------------ list

  function renderList(): void {
    const day = today();
    listEl.innerHTML = '';
    for (const invoice of invoices) {
      const status = statusOf(invoice, day);
      const totals = computeTotals(invoice);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ty-row';
      row.dataset.id = invoice.id;
      if (current && invoice.id === current.id) row.setAttribute('aria-current', 'true');
      row.innerHTML = `
        <span class="ty-row__top">
          <strong>${escapeHtml(invoice.number)}</strong>
          <span class="ty-chip ty-chip--${status}">${status}</span>
        </span>
        <span class="ty-row__client">${escapeHtml(invoice.to.name || 'No client yet')}</span>
        <span class="ty-row__foot">
          <span>${invoice.issued}</span>
          <strong>${escapeHtml(formatMoney(totals.total, invoice.symbol))}</strong>
        </span>`;
      row.addEventListener('click', () => select(invoice.id));
      listEl.append(row);
    }
    emptyEl.hidden = invoices.length > 0;
    editorEl.hidden = invoices.length === 0;
  }

  // ------------------------------------------------------------------ editor

  function bindField(id: string, read: (invoice: Invoice) => string, write: (invoice: Invoice, value: string) => void): void {
    const input = $<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
    input.addEventListener('input', async () => {
      if (!current) return;
      write(current, input.value);
      await touch();
    });
    (input as { _read?: (invoice: Invoice) => string })._read = read;
  }

  const fields: [string, (i: Invoice) => string, (i: Invoice, v: string) => void][] = [
    ['ty-number', (i) => i.number, (i, v) => { i.number = v; }],
    ['ty-issued', (i) => i.issued, (i, v) => { if (v) i.issued = v; }],
    ['ty-due', (i) => i.due, (i, v) => { if (v) i.due = v; }],
    ['ty-symbol', (i) => i.symbol, (i, v) => { i.symbol = v.slice(0, 3) || '$'; }],
    ['ty-currency', (i) => i.currency, (i, v) => { i.currency = v.toUpperCase().slice(0, 4); }],
    ['ty-tax-label', (i) => i.taxLabel, (i, v) => { i.taxLabel = v || 'Tax'; }],
    ['ty-notes', (i) => i.notes, (i, v) => { i.notes = v; }],
    ['ty-terms', (i) => i.terms, (i, v) => { i.terms = v; }],
  ];

  const partyFields: [string, 'from' | 'to', keyof Party][] = [
    ['ty-from-name', 'from', 'name'],
    ['ty-from-address', 'from', 'addressLines'],
    ['ty-from-email', 'from', 'email'],
    ['ty-from-reference', 'from', 'reference'],
    ['ty-to-name', 'to', 'name'],
    ['ty-to-address', 'to', 'addressLines'],
    ['ty-to-email', 'to', 'email'],
    ['ty-to-reference', 'to', 'reference'],
  ];

  for (const [id, read, write] of fields) bindField(id, read, write);

  for (const [id, side, key] of partyFields) {
    const input = $<HTMLInputElement | HTMLTextAreaElement>(id);
    input.addEventListener('input', async () => {
      if (!current) return;
      current[side][key] = input.value;
      // The sender is the same on every invoice, so remember it for the next one.
      if (side === 'from') saveSender(current.from);
      await touch();
    });
  }

  const defaultTaxEl = $<HTMLInputElement>('ty-default-tax');
  defaultTaxEl.addEventListener('input', async () => {
    if (!current) return;
    current.defaultTaxRate = parseRate(defaultTaxEl.value) ?? 0;
    await touch();
    renderItems();
  });

  const discountKindEl = $<HTMLSelectElement>('ty-discount-kind');
  const discountValueEl = $<HTMLInputElement>('ty-discount-value');
  const discountRow = $<HTMLDivElement>('ty-discount-row');

  const readDiscount = () => {
    if (!current) return;
    const kind = discountKindEl.value as DiscountKind;
    current.discountKind = kind;
    current.discountValue =
      kind === 'percent' ? parseRate(discountValueEl.value) ?? 0
      : kind === 'fixed' ? Math.max(0, parseMoney(discountValueEl.value) ?? 0)
      : 0;
    discountRow.hidden = kind === 'none';
    discountValueEl.placeholder = kind === 'percent' ? '10' : '0.00';
  };
  discountKindEl.addEventListener('change', async () => { readDiscount(); await touch(); });
  discountValueEl.addEventListener('input', async () => { readDiscount(); await touch(); });

  const paidEl = $<HTMLInputElement>('ty-paid');
  paidEl.addEventListener('change', async () => {
    if (!current) return;
    current.paid = paidEl.checked;
    await touch();
  });

  function renderEditor(): void {
    if (!current) return;
    for (const [id, read] of fields) {
      $<HTMLInputElement>(id).value = read(current);
    }
    for (const [id, side, key] of partyFields) {
      $<HTMLInputElement>(id).value = current[side][key];
    }
    defaultTaxEl.value = current.defaultTaxRate ? String(current.defaultTaxRate / 100) : '';
    discountKindEl.value = current.discountKind;
    discountRow.hidden = current.discountKind === 'none';
    discountValueEl.value =
      current.discountKind === 'percent' ? String(current.discountValue / 100)
      : current.discountKind === 'fixed' ? (current.discountValue / 100).toFixed(2)
      : '';
    paidEl.checked = current.paid;
  }

  // ------------------------------------------------------------------ items

  function renderItems(): void {
    if (!current) return;
    itemsEl.innerHTML = '';
    current.items.forEach((item, index) => {
      itemsEl.append(itemRow(item, index));
    });
  }

  function itemRow(item: LineItem, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ty-item';
    row.dataset.id = item.id;

    const description = document.createElement('textarea');
    description.className = 'ty-item__desc';
    description.rows = 1;
    description.placeholder = 'What are you charging for?';
    description.value = item.description;
    description.setAttribute('aria-label', `Line ${index + 1} description`);

    const grow = () => {
      description.style.height = 'auto';
      description.style.height = `${description.scrollHeight}px`;
    };
    description.addEventListener('input', async () => {
      item.description = description.value;
      grow();
      await touch();
    });
    requestAnimationFrame(grow);

    const quantity = numberInput(formatQuantity(item.quantity), 'Qty', async (value) => {
      item.quantity = parseQuantity(value) ?? 0;
      await touch();
      amount.textContent = formatMoney(lineSubtotal(item), current!.symbol);
    });
    quantity.setAttribute('aria-label', `Line ${index + 1} quantity`);

    const unit = numberInput((item.unitPrice / 100).toFixed(2), 'Unit', async (value) => {
      item.unitPrice = parseMoney(value) ?? 0;
      await touch();
      amount.textContent = formatMoney(lineSubtotal(item), current!.symbol);
    });
    unit.setAttribute('aria-label', `Line ${index + 1} unit price`);

    const tax = numberInput(item.taxRate === null ? '' : String(item.taxRate / 100), 'Tax %', async (value) => {
      item.taxRate = value.trim() === '' ? null : parseRate(value) ?? 0;
      await touch();
    });
    tax.placeholder = formatRate(current!.defaultTaxRate);
    tax.title = 'Leave blank to use the invoice default';
    tax.setAttribute('aria-label', `Line ${index + 1} tax rate`);

    const amount = document.createElement('span');
    amount.className = 'ty-item__amount';
    amount.textContent = formatMoney(lineSubtotal(item), current!.symbol);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ty-item__remove';
    remove.innerHTML = '&times;';
    remove.title = 'Remove this line';
    remove.setAttribute('aria-label', `Remove line ${index + 1}`);
    remove.addEventListener('click', async () => {
      if (!current) return;
      current.items = current.items.filter((entry) => entry.id !== item.id);
      if (!current.items.length) current.items = [createLineItem('', 1, 0)];
      await touch();
      renderItems();
    });

    row.append(description, quantity, unit, tax, amount, remove);
    return row;
  }

  function numberInput(value: string, placeholder: string, onInput: (value: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'ty-item__num';
    input.inputMode = 'decimal';
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  $<HTMLButtonElement>('ty-add-item').addEventListener('click', async () => {
    if (!current) return;
    current.items.push(createLineItem('', 1, 0));
    await touch();
    renderItems();
    itemsEl.querySelector<HTMLTextAreaElement>('.ty-item:last-child .ty-item__desc')?.focus();
  });

  // ------------------------------------------------------------------ totals

  function renderTotals(): void {
    if (!current) return;
    const totals = computeTotals(current);
    const rows: string[] = [
      `<div class="ty-total"><span>Subtotal</span><strong>${escapeHtml(formatMoney(totals.subtotal, current.symbol))}</strong></div>`,
    ];
    if (totals.discount > 0) {
      rows.push(`<div class="ty-total"><span>Discount</span><strong>-${escapeHtml(formatMoney(totals.discount, current.symbol))}</strong></div>`);
    }
    for (const entry of totals.taxByRate) {
      rows.push(`<div class="ty-total"><span>${escapeHtml(current.taxLabel)} ${escapeHtml(formatRate(entry.rate))} on ${escapeHtml(formatMoney(entry.base, current.symbol))}</span><strong>${escapeHtml(formatMoney(entry.amount, current.symbol))}</strong></div>`);
    }
    rows.push(`<div class="ty-total ty-total--grand"><span>Total</span><strong>${escapeHtml(formatMoney(totals.total, current.symbol))}</strong></div>`);
    totalsEl.innerHTML = rows.join('');
  }

  // ------------------------------------------------------------------ preview

  function schedulePreview(): void {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void renderPreview(), 400);
  }

  async function renderPreview(): Promise<void> {
    if (!current) return;
    try {
      const bytes = await toPdf(current, theme);
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
      // Revoke the old object URL only after the new one is attached, so the
      // frame never flashes empty between updates.
      const next = URL.createObjectURL(blob);
      previewEl.src = next;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = next;
    } catch (error) {
      console.error(error);
    }
  }

  // ------------------------------------------------------------------ actions

  $<HTMLButtonElement>('ty-new').addEventListener('click', async () => {
    const previous = invoices[0];
    const invoice = createInvoice(previous ? nextNumber(previous.number) : 'INV-001');
    const sender = loadSender();
    if (sender) invoice.from = { ...sender };
    if (previous) {
      invoice.currency = previous.currency;
      invoice.symbol = previous.symbol;
      invoice.defaultTaxRate = previous.defaultTaxRate;
      invoice.taxLabel = previous.taxLabel;
      invoice.terms = previous.terms;
    }
    await saveInvoice(invoice);
    invoices = sortInvoices([...invoices, invoice]);
    select(invoice.id);
    $<HTMLInputElement>('ty-to-name').focus();
    toast(`Started ${invoice.number}.`, { kind: 'good' });
  });

  $<HTMLButtonElement>('ty-duplicate').addEventListener('click', async () => {
    if (!current) return;
    const copy: Invoice = {
      ...structuredClone(current),
      id: createInvoice().id,
      number: nextNumber(current.number),
      issued: today(),
      due: addDays(today(), 30),
      paid: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    copy.items = copy.items.map((item) => ({ ...item, id: createLineItem().id }));
    await saveInvoice(copy);
    invoices = sortInvoices([...invoices, copy]);
    select(copy.id);
    toast(`Copied to ${copy.number}.`, { kind: 'good' });
  });

  $<HTMLButtonElement>('ty-delete').addEventListener('click', async () => {
    if (!current) return;
    if (!confirm(`Delete ${current.number}? This cannot be undone.`)) return;
    const removed = current.id;
    await deleteInvoice(removed);
    invoices = invoices.filter((invoice) => invoice.id !== removed);
    current = invoices[0] ?? null;
    saveSelected(current?.id ?? null);
    renderList();
    if (current) { renderEditor(); renderItems(); renderTotals(); schedulePreview(); }
  });

  $<HTMLButtonElement>('ty-pdf').addEventListener('click', async () => {
    if (!current) return;
    const bytes = await toPdf(current, theme);
    downloadBlob(`${safeName(current)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }));
    toast('PDF saved to your downloads folder.', { kind: 'good' });
  });

  $<HTMLButtonElement>('ty-csv').addEventListener('click', () => {
    if (!current) return;
    downloadFile(`${safeName(current)}.csv`, toCsv(current), 'text/csv');
    toast('CSV saved.', { kind: 'good' });
  });

  $<HTMLButtonElement>('ty-copy-text').addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(toPlainText(current));
      toast('Plain text copied to the clipboard.', { kind: 'good' });
    } catch {
      toast('The browser would not let this page use the clipboard.', { kind: 'error' });
    }
  });

  // ------------------------------------------------------------------ theme

  const accentsEl = $<HTMLDivElement>('ty-accents');
  for (const entry of ACCENTS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'ty-swatch';
    swatch.style.setProperty('--swatch', entry.id);
    swatch.title = entry.label;
    swatch.setAttribute('aria-label', `${entry.label} accent`);
    swatch.dataset.accent = entry.id;
    swatch.addEventListener('click', () => {
      theme = { ...theme, accent: entry.id };
      writePref(THEME_KEY, theme);
      markAccents();
      void renderPreview();
    });
    accentsEl.append(swatch);
  }
  function markAccents(): void {
    for (const swatch of accentsEl.querySelectorAll<HTMLButtonElement>('.ty-swatch')) {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.accent === theme.accent));
    }
  }

  const fontEl = $<HTMLSelectElement>('ty-font');
  fontEl.addEventListener('change', () => {
    theme = { ...theme, font: fontEl.value === 'serif' ? 'serif' : 'sans' };
    writePref(THEME_KEY, theme);
    void renderPreview();
  });

  // ------------------------------------------------------------------ start

  /**
   * Reloads everything from storage and redraws. Shared by the import
   * flow and by the agent tools, so a change an agent makes shows up on
   * the page rather than sitting invisibly in the database.
   */
  async function refreshFromStore(): Promise<void> {
    invoices = await loadInvoices();
    select(loadSelected() ?? invoices[0]?.id ?? '');
  }

  wireDataMenu(root, {
    app: 'tally',
    buildExport,
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `${count} invoice${count === 1 ? '' : 's'} in place.`;
    },
    onImported: refreshFromStore,
    onClearAll: async () => {
      await clearAll();
      invoices = await loadInvoices();
      select(invoices[0]?.id ?? '');
    },
    clearWarning: 'Every invoice stored in this browser will be deleted.',
  });

  invoices = await loadInvoices();
  fontEl.value = theme.font;
  markAccents();
  select(loadSelected() ?? invoices[0]?.id ?? '');

  // Everything this app can do, offered to an agent on this page.
  registerTools(tallyTools(refreshFromStore));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
