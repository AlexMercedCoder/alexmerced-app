import { createInvoice, createLineItem, lineSubtotal, type Invoice } from '../../apps/tally/model';
import { durationMs, roundMs, type Entry, type Project, type Settings } from '../../apps/stint/model';
export function invoiceFromTime(project: Project, entries: Entry[], settings: Settings): Invoice {
  const completed = entries.filter(e => e.projectId === project.id && e.billable && e.end);
  if (!completed.length) throw new Error('No completed billable entries for this project in the selected range.');
  const invoice = createInvoice(`DRAFT-${new Date().toISOString().slice(0, 10)}`);
  invoice.to.name = project.client; invoice.currency = settings.currency;
  invoice.symbol = settings.currency === 'USD' ? '$' : settings.currency === 'EUR' ? '€' : settings.currency === 'GBP' ? '£' : settings.currency;
  const ms = roundMs(completed.reduce((sum, entry) => sum + durationMs(entry), 0), settings);
  invoice.items = [createLineItem(`${project.name}: ${completed.map(e => e.description).filter(Boolean).join('; ') || 'Tracked time'}`, Math.round(ms / 3600000 * 1000) / 1000, Math.round(project.rate * 100))];
  // Tally stores quantities to three decimal places. Preserve Stint's exact
  // rounded charge when a fraction of an hour cannot be represented that way.
  const amount = Math.round(ms / 3600000 * project.rate * 100);
  if (lineSubtotal(invoice.items[0]) !== amount) {
    invoice.items = [createLineItem(`${project.name}: ${(ms / 3600000).toFixed(6)} hours at ${project.rate} ${settings.currency}/hour. Exact time charge.`, 1, amount)];
  }
  invoice.notes = 'Draft from Stint. Check the client, hours, rate, currency, and tax before sending. The time entries have not been marked as invoiced.';
  return invoice;
}
