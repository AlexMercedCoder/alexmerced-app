import { readString, requireString, textResult, type McpTool } from '../../lib/webmcp';
import { fromMarkdown, toMarkdown, type Deck } from './model';
import { toPdf, toStandaloneHtml } from './render';
import { loadDecks, saveDeck } from './store';

/**
 * Rostrum's tools. Turning an outline into a deck is a natural handoff from an
 * agent, and Markdown is the form both sides already speak.
 */
export function rostrumTools(onChanged: () => void): McpTool[] {
  return [
    {
      name: 'rostrum_create_deck',
      description:
        'Build a slide deck from Markdown and save it to this browser. A first level heading starts a title slide, a second level heading starts a new slide, list items become bullets, and three dashes force a slide break. Returns the deck, and a PDF or a standalone HTML file on request.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string', description: 'The outline.' },
          as: { type: 'string', enum: ['none', 'pdf', 'html'], description: 'Also return the deck as a file.' },
        },
        required: ['title', 'markdown'],
      },
      execute: async (input) => {
        const title = requireString(input, 'title');
        const markdown = requireString(input, 'markdown');
        const as = readString(input, 'as', 'none');

        const deck = fromMarkdown(markdown, title);
        deck.title = title;
        await saveDeck(deck);
        onChanged();

        const summary = {
          id: deck.id,
          title: deck.title,
          slides: deck.slides.length,
          outline: deck.slides.map((slide, index) => ({
            number: index + 1,
            layout: slide.layout,
            title: slide.blocks.find((block) => block.type === 'title')?.text ?? '',
            lines: slide.blocks.filter((block) => block.type !== 'title').length,
          })),
        };

        if (as === 'pdf') {
          // A deck built from Markdown carries no images, so the picture map
          // an interactive deck would supply is empty here.
          const bytes = await toPdf(deck, new Map());
          return textResult({
            ...summary,
            pdf: { filename: `${slug(deck.title)}.pdf`, bytes: bytes.length, dataUri: `data:application/pdf;base64,${base64(bytes)}` },
          });
        }
        if (as === 'html') {
          return textResult({ ...summary, html: toStandaloneHtml(deck, new Map()) });
        }
        return textResult(summary);
      },
    },
    {
      name: 'rostrum_export_deck',
      description:
        'Export a deck that is already saved, as a PDF or as a standalone HTML file that carries its own styling and needs nothing else to open.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Deck id or title.' },
          as: { type: 'string', enum: ['pdf', 'html'] },
        },
        required: ['id'],
      },
      execute: async (input) => {
        const wanted = requireString(input, 'id');
        const decks = await loadDecks();
        const deck = decks.find((entry) => entry.id === wanted || entry.title.toLowerCase() === wanted.toLowerCase());
        if (!deck) return textResult({ error: `No deck matching "${wanted}".`, available: decks.map((entry) => entry.title) });

        if (readString(input, 'as', 'pdf') === 'html') {
          return textResult({ title: deck.title, slides: deck.slides.length, html: toStandaloneHtml(deck, new Map()) });
        }
        const bytes = await toPdf(deck, new Map());
        return textResult({
          title: deck.title,
          slides: deck.slides.length,
          filename: `${slug(deck.title)}.pdf`,
          bytes: bytes.length,
          dataUri: `data:application/pdf;base64,${base64(bytes)}`,
          note: 'Any images placed on slides are left out here, because they live in the page\u2019s own storage rather than in the deck.',
        });
      },
    },
    {
      name: 'rostrum_list_decks',
      description: 'List the decks stored in this browser, with their slide counts.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const decks = await loadDecks();
        return textResult({
          decks: decks.map((deck) => ({
            id: deck.id,
            title: deck.title,
            slides: deck.slides.length,
            theme: deck.theme,
            updatedAt: deck.updatedAt,
          })),
        });
      },
    },
    {
      name: 'rostrum_read_deck',
      description: 'Read a deck back as Markdown, so it can be edited and rebuilt.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Deck id or title.' } },
        required: ['id'],
      },
      execute: async (input) => {
        const wanted = requireString(input, 'id');
        const decks = await loadDecks();
        const deck = decks.find((entry) => entry.id === wanted || entry.title.toLowerCase() === wanted.toLowerCase());
        if (!deck) return textResult({ error: `No deck matching "${wanted}".`, available: decks.map((entry) => entry.title) });
        return textResult({ id: deck.id, title: deck.title, slides: deck.slides.length, markdown: toMarkdown(deck) });
      },
    },
  ];
}

function slug(title: string): string {
  return title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'deck';
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export type { Deck };
