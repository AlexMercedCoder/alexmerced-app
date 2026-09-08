import { withWorkspaceLock } from './locks';
import { sendFiles } from './handoff';
export async function startExample(app: string) {
  if (app === 'ordinate' || app === 'limelight') {
    const path = app === 'ordinate' ? '/examples/monthly-sales.csv' : '/examples/short-video.webm';
    const response = await fetch(path); if (!response.ok) throw new Error('The example could not load. Connect and try again.');
    await sendFiles(app, [new File([await response.blob()], path.split('/').pop()!, { type: app === 'ordinate' ? 'text/csv' : 'video/webm' })]); return;
  }
  await withWorkspaceLock(app, async () => {
    if (app === 'laneway') {
      const { createBoard, createCard } = await import('../../apps/laneway/model');
      const { applyImport, saveView } = await import('../../apps/laneway/store');
      const { createEnvelope } = await import('../portable');
      const board = createBoard('Freelance website project');
      const cards = ['Confirm scope and deadline', 'Collect copy and images', 'Build the first draft', 'Review with the client', 'Send the final invoice'].map((title, i) => createCard(board.columns[0].id, title, i));
      await applyImport(JSON.stringify(createEnvelope(app, 1, { boards: [board], cards }, { boards: 1, cards: cards.length })), 'merge');
      saveView({ boardId: board.id, showArchive: false, compact: false });
    } else if (app === 'rote') {
      const { createDeck, createCard } = await import('../../apps/rote/model');
      const { applyImport, saveView } = await import('../../apps/rote/store');
      const { createEnvelope } = await import('../portable');
      const deck = createDeck('SQL study deck');
      const cards = [['WHERE', 'Filters rows before grouping.'], ['GROUP BY', 'Combines rows into groups for aggregation.'], ['LEFT JOIN', 'Keeps each left-hand row, even without a matching right-hand row.']].map(([front, back]) => createCard(deck.id, front, back));
      await applyImport(JSON.stringify(createEnvelope(app, 1, { decks: [deck], cards }, { decks: 1, cards: 3 })), 'merge'); saveView({ deckId: deck.id, mode: 'browse' });
    } else if (app === 'tally') {
      const { createInvoice, createLineItem } = await import('../../apps/tally/model');
      const { saveInvoice, saveSelected } = await import('../../apps/tally/store');
      const invoice = createInvoice('EXAMPLE-001'); invoice.to.name = 'Example client'; invoice.items = [createLineItem('Website design, hours', 4, 7500)]; invoice.notes = 'Example invoice. Edit the client, rate, and hours before using it.';
      await saveInvoice(invoice); saveSelected(invoice.id);
    }
  });
  location.assign(`/${app}`);
}
