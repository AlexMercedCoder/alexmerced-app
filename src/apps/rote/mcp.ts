import { readNumber, readString, requireString, textResult, truncate, type McpTool } from '../../lib/webmcp';
import {
  buildQueue, createCard, createDeck, dayOf, deckStats, forecast, GRADES, isDue, schedule,
  stateOf, type Card, type Grade,
} from './model';
import { loadWorkspace, saveCard, saveCards, saveDeck } from './store';

/**
 * Rote's tools. Turning something an agent just explained into cards is the
 * obvious use, so adding them in bulk is the main one, alongside reading what
 * is due and recording an answer.
 */
export function roteTools(onChanged: () => void): McpTool[] {
  return [
    {
      name: 'rote_list_decks',
      description:
        'List the decks, how many cards each holds, how many are new, learning, or due today, and what the next two weeks of reviews look like.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const { decks, cards } = await loadWorkspace();
        return textResult({
          today: dayOf(new Date()),
          decks: decks.map((deck) => {
            const stats = deckStats(cards, deck.id);
            return {
              id: deck.id,
              name: deck.name,
              description: deck.description || undefined,
              ...stats,
              next14Days: forecast(cards, deck.id, 14).filter((day) => day.count > 0),
            };
          }),
        });
      },
    },
    {
      name: 'rote_add_cards',
      description:
        'Add flashcards to a deck, several at a time. Give pairs of front and back. If the deck name is new, the deck is created. This is the quickest way to turn something just explained into revision material.',
      inputSchema: {
        type: 'object',
        properties: {
          deck: { type: 'string', description: 'Deck name or id. Created if it is new.' },
          cards: {
            type: 'array',
            description: 'Each entry is {"front":"question","back":"answer"}.',
            items: { type: 'object' },
          },
        },
        required: ['deck', 'cards'],
      },
      execute: async (input) => {
        const wanted = requireString(input, 'deck');
        const raw = input.cards;
        if (!Array.isArray(raw) || raw.length === 0) throw new Error('"cards" must be a list with at least one card.');

        const workspace = await loadWorkspace();
        let deck = workspace.decks.find((entry) => entry.id === wanted || entry.name.toLowerCase() === wanted.toLowerCase());
        let created = false;
        if (!deck) {
          deck = createDeck(wanted);
          await saveDeck(deck);
          created = true;
        }

        const skipped: string[] = [];
        const made: Card[] = [];
        for (const entry of raw.slice(0, 500)) {
          const spec = (entry ?? {}) as Record<string, unknown>;
          const front = typeof spec.front === 'string' ? spec.front.trim() : '';
          const back = typeof spec.back === 'string' ? spec.back.trim() : '';
          if (!front || !back) {
            skipped.push(front || back || '(empty)');
            continue;
          }
          made.push(createCard(deck.id, front, back));
        }

        if (made.length === 0) return textResult({ error: 'Every card was missing a front or a back.', skipped });

        await saveCards(made);
        onChanged();
        return textResult({
          deck: deck.name,
          deckCreated: created,
          added: made.length,
          skipped: skipped.length ? skipped : undefined,
        });
      },
    },
    {
      name: 'rote_due_cards',
      description:
        'List the cards waiting to be reviewed, in the order the scheduler would show them. Use this to run through a session, then report each answer with rote_review_card.',
      inputSchema: {
        type: 'object',
        properties: {
          deck: { type: 'string', description: 'Deck name or id. All decks when omitted.' },
          limit: { type: 'number', description: '20 by default.' },
        },
      },
      execute: async (input) => {
        const { decks, cards } = await loadWorkspace();
        const wanted = readString(input, 'deck');
        const limit = Math.max(1, Math.min(200, Math.round(readNumber(input, 'limit', 20))));

        const chosen = wanted
          ? decks.filter((deck) => deck.id === wanted || deck.name.toLowerCase() === wanted.toLowerCase())
          : decks;
        if (wanted && chosen.length === 0) {
          return textResult({ error: `No deck called "${wanted}".`, decks: decks.map((deck) => deck.name) });
        }

        const queue = chosen.flatMap((deck) =>
          buildQueue(cards, deck).map((card) => ({ deck: deck.name, card })));
        const trimmed = truncate(queue, limit);

        return textResult({
          due: trimmed.total,
          returned: trimmed.items.length,
          cards: trimmed.items.map((entry) => ({
            id: entry.card.id,
            deck: entry.deck,
            front: entry.card.front,
            back: entry.card.back,
            state: stateOf(entry.card),
            dueOn: entry.card.due,
          })),
        });
      },
    },
    {
      name: 'rote_review_card',
      description:
        'Record how a card went, and get back when it will next be shown. Grades are "again" for a miss, then "hard", "good" and "easy". The interval is worked out by SM-2, the same algorithm the page uses.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          grade: { type: 'string', enum: ['again', 'hard', 'good', 'easy'] },
        },
        required: ['id', 'grade'],
      },
      execute: async (input) => {
        const id = requireString(input, 'id');
        // The scheduler works in SM-2's numeric grades; the tool takes words.
        const named = requireString(input, 'grade').toLowerCase();
        const entry = GRADES.find((candidate) => candidate.key === named);
        if (!entry) throw new Error('"grade" must be one of again, hard, good, easy.');
        const grade = entry.id as Grade;

        const { cards } = await loadWorkspace();
        const card = cards.find((entry) => entry.id === id);
        if (!card) return textResult({ error: `No card with id "${id}".` });

        const updated = schedule(card, grade);
        await saveCard(updated);
        onChanged();

        return textResult({
          id,
          grade: named,
          state: stateOf(updated),
          nextDue: updated.due,
          intervalDays: updated.interval,
          ease: Number(updated.ease.toFixed(2)),
          lapses: updated.lapses,
        });
      },
    },
    {
      name: 'rote_search_cards',
      description: 'Find cards by their fronts or backs, across every deck.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (input) => {
        const terms = requireString(input, 'query').toLowerCase().split(/\s+/).filter(Boolean);
        const { decks, cards } = await loadWorkspace();
        const now = new Date();

        const matched = cards.filter((card) => {
          const haystack = `${card.front} ${card.back}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });

        return textResult({
          matches: matched.length,
          cards: matched.slice(0, 50).map((card) => ({
            id: card.id,
            deck: decks.find((deck) => deck.id === card.deckId)?.name ?? 'Unknown',
            front: card.front,
            back: card.back,
            state: stateOf(card),
            due: card.due,
            dueNow: isDue(card, now),
          })),
        });
      },
    },
  ];
}
