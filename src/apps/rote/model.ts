import { createId } from '../../lib/id';

export const APP_ID = 'rote';
export const APP_VERSION = 1;

export type Deck = {
  id: string;
  name: string;
  description: string;
  /** How many new cards to introduce per day. */
  newPerDay: number;
  createdAt: string;
  updatedAt: string;
};

export type Card = {
  id: string;
  deckId: string;
  front: string;
  back: string;
  tags: string[];
  /** SM-2 state. */
  ease: number;
  interval: number;
  repetitions: number;
  /** ISO date, no time: reviews are scheduled by day. */
  due: string | null;
  lapses: number;
  reviews: number;
  lastGrade: Grade | null;
  lastReviewed: string | null;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Grades follow SM-2's zero to five scale, narrowed to the four a person can
 * actually tell apart while reviewing.
 */
export const GRADES = [
  { id: 0, key: 'again', label: 'Again', hint: 'Did not remember it', tone: 'bad' },
  { id: 3, key: 'hard', label: 'Hard', hint: 'Remembered, but it was a struggle', tone: 'warn' },
  { id: 4, key: 'good', label: 'Good', hint: 'Remembered after a moment', tone: 'ok' },
  { id: 5, key: 'easy', label: 'Easy', hint: 'Instant', tone: 'great' },
] as const;

export type Grade = 0 | 3 | 4 | 5;

export const MIN_EASE = 1.3;
export const STARTING_EASE = 2.5;

export function createDeck(name: string, description = '', now: Date = new Date()): Deck {
  const stamp = now.toISOString();
  return { id: createId('deck'), name, description, newPerDay: 20, createdAt: stamp, updatedAt: stamp };
}

export function createCard(deckId: string, front = '', back = '', now: Date = new Date()): Card {
  const stamp = now.toISOString();
  return {
    id: createId('card'),
    deckId,
    front,
    back,
    tags: [],
    ease: STARTING_EASE,
    interval: 0,
    repetitions: 0,
    due: null,
    lapses: 0,
    reviews: 0,
    lastGrade: null,
    lastReviewed: null,
    suspended: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** The day part of a date, which is the granularity scheduling works at. */
export function dayOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(year, month - 1, date + count);
  return dayOf(shifted);
}

export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000);
}

/**
 * SM-2, as published by Piotr Wozniak, with the conventional adjustments:
 * a failed card returns to the start of the ladder but keeps a reduced ease,
 * and ease never falls below 1.3 or the interval collapses.
 */
export function schedule(card: Card, grade: Grade, now: Date = new Date()): Card {
  const today = dayOf(now);
  const stamp = now.toISOString();

  let { ease, interval, repetitions, lapses } = card;

  // The published ease adjustment, q being the grade.
  ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
  if (ease < MIN_EASE) ease = MIN_EASE;

  if (grade < 3) {
    repetitions = 0;
    interval = 1;
    lapses += 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(interval * ease);
    // An easy answer earns a little extra room.
    if (grade === 5) interval = Math.round(interval * 1.15);
  }

  if (interval < 1) interval = 1;

  return {
    ...card,
    ease: Math.round(ease * 1000) / 1000,
    interval,
    repetitions,
    lapses,
    reviews: card.reviews + 1,
    lastGrade: grade,
    lastReviewed: stamp,
    due: addDays(today, interval),
    updatedAt: stamp,
  };
}

export type CardState = 'new' | 'learning' | 'review' | 'suspended';

export function stateOf(card: Card): CardState {
  if (card.suspended) return 'suspended';
  if (card.due === null) return 'new';
  return card.repetitions < 2 ? 'learning' : 'review';
}

export function isDue(card: Card, now: Date = new Date()): boolean {
  if (card.suspended) return false;
  if (card.due === null) return true;
  return daysBetween(card.due, dayOf(now)) >= 0;
}

/** Cards that are blank on either side are not worth showing. */
export function isUsable(card: Card): boolean {
  return card.front.trim().length > 0 && card.back.trim().length > 0;
}

/**
 * The queue for a session: everything overdue first, oldest due date first,
 * then new cards up to the deck's daily allowance.
 */
export function buildQueue(cards: Card[], deck: Deck, now: Date = new Date()): Card[] {
  const usable = cards.filter((card) => card.deckId === deck.id && isUsable(card) && !card.suspended);
  const today = dayOf(now);

  const due = usable
    .filter((card) => card.due !== null && daysBetween(card.due, today) >= 0)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));

  const fresh = usable
    .filter((card) => card.due === null)
    .slice(0, Math.max(0, deck.newPerDay));

  return [...due, ...fresh];
}

export type DeckStats = {
  total: number;
  due: number;
  new: number;
  learning: number;
  review: number;
  suspended: number;
  /** Share of graded reviews that were not failures. */
  retention: number | null;
  averageEase: number | null;
};

export function deckStats(cards: Card[], deckId: string, now: Date = new Date()): DeckStats {
  const owned = cards.filter((card) => card.deckId === deckId);
  const graded = owned.filter((card) => card.reviews > 0);
  const lapses = owned.reduce((sum, card) => sum + card.lapses, 0);
  const reviews = owned.reduce((sum, card) => sum + card.reviews, 0);

  return {
    total: owned.length,
    due: owned.filter((card) => isUsable(card) && isDue(card, now)).length,
    new: owned.filter((card) => stateOf(card) === 'new').length,
    learning: owned.filter((card) => stateOf(card) === 'learning').length,
    review: owned.filter((card) => stateOf(card) === 'review').length,
    suspended: owned.filter((card) => card.suspended).length,
    retention: reviews > 0 ? Math.round(((reviews - lapses) / reviews) * 1000) / 10 : null,
    averageEase: graded.length ? Math.round((graded.reduce((sum, c) => sum + c.ease, 0) / graded.length) * 100) / 100 : null,
  };
}

/** A rough forecast of how many cards fall due over the next fortnight. */
export function forecast(cards: Card[], deckId: string, days = 14, now: Date = new Date()): { day: string; count: number }[] {
  const today = dayOf(now);
  const owned = cards.filter((card) => card.deckId === deckId && !card.suspended && card.due !== null);

  return Array.from({ length: days }, (_, offset) => {
    const day = addDays(today, offset);
    const count = owned.filter((card) => {
      const distance = daysBetween(card.due!, day);
      return offset === 0 ? distance >= 0 : distance === 0;
    }).length;
    return { day, count };
  });
}

// --------------------------------------------------------------------- csv

/** Parses a CSV of front,back[,tags] the way a person would export from a spreadsheet. */
export function parseCardCsv(text: string, deckId: string, now: Date = new Date()): { cards: Card[]; skipped: number } {
  const rows = parseCsvRows(text);
  const cards: Card[] = [];
  let skipped = 0;

  const hasHeader = rows.length > 0 && /^(front|question|term)$/i.test((rows[0][0] ?? '').trim());
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const [front = '', back = '', tags = ''] = row;
    if (!front.trim() || !back.trim()) { skipped += 1; continue; }
    const card = createCard(deckId, front.trim(), back.trim(), now);
    card.tags = tags.split(/[;|]/).map((tag) => tag.trim()).filter(Boolean);
    cards.push(card);
  }

  return { cards, skipped };
}

/** A small RFC 4180 reader: quoted fields, doubled quotes, embedded newlines. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const character = text[i];

    if (inQuotes) {
      if (character === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += character; i += 1; continue;
    }

    if (character === '"' && field === '') { inQuotes = true; i += 1; continue; }
    if (character === ',') { endField(); i += 1; continue; }
    if (character === '\r') { i += 1; continue; }
    if (character === '\n') { endRow(); i += 1; continue; }
    field += character; i += 1;
  }

  if (field !== '' || row.length > 0) endRow();
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

export function toCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function cardsToCsv(cards: Card[]): string {
  const lines = ['front,back,tags'];
  for (const card of cards) {
    lines.push([card.front, card.back, card.tags.join(';')].map(toCsvField).join(','));
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- reviving

export function reviveDeck(value: unknown): Deck | null {
  if (typeof value !== 'object' || value === null) return null;
  const deck = value as Partial<Deck>;
  if (typeof deck.id !== 'string') return null;
  const stamp = new Date().toISOString();
  return {
    id: deck.id,
    name: typeof deck.name === 'string' && deck.name.trim() ? deck.name : 'Untitled deck',
    description: typeof deck.description === 'string' ? deck.description : '',
    newPerDay: typeof deck.newPerDay === 'number' && deck.newPerDay >= 0 ? Math.floor(deck.newPerDay) : 20,
    createdAt: typeof deck.createdAt === 'string' ? deck.createdAt : stamp,
    updatedAt: typeof deck.updatedAt === 'string' ? deck.updatedAt : stamp,
  };
}

export function reviveCard(value: unknown): Card | null {
  if (typeof value !== 'object' || value === null) return null;
  const card = value as Partial<Card>;
  if (typeof card.id !== 'string' || typeof card.deckId !== 'string') return null;
  const stamp = new Date().toISOString();
  const grade = card.lastGrade;

  return {
    id: card.id,
    deckId: card.deckId,
    front: typeof card.front === 'string' ? card.front : '',
    back: typeof card.back === 'string' ? card.back : '',
    tags: Array.isArray(card.tags) ? card.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    ease: typeof card.ease === 'number' && card.ease >= MIN_EASE ? card.ease : STARTING_EASE,
    interval: typeof card.interval === 'number' && card.interval >= 0 ? Math.floor(card.interval) : 0,
    repetitions: typeof card.repetitions === 'number' && card.repetitions >= 0 ? Math.floor(card.repetitions) : 0,
    due: typeof card.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.due) ? card.due : null,
    lapses: typeof card.lapses === 'number' && card.lapses >= 0 ? Math.floor(card.lapses) : 0,
    reviews: typeof card.reviews === 'number' && card.reviews >= 0 ? Math.floor(card.reviews) : 0,
    lastGrade: grade === 0 || grade === 3 || grade === 4 || grade === 5 ? grade : null,
    lastReviewed: typeof card.lastReviewed === 'string' ? card.lastReviewed : null,
    suspended: card.suspended === true,
    createdAt: typeof card.createdAt === 'string' ? card.createdAt : stamp,
    updatedAt: typeof card.updatedAt === 'string' ? card.updatedAt : stamp,
  };
}

/** Cards whose deck vanished would be unreachable, so they are dropped. */
export function reconcile(decks: Deck[], cards: Card[]): Card[] {
  const ids = new Set(decks.map((deck) => deck.id));
  return cards.filter((card) => ids.has(card.deckId));
}

export function starterDeck(now: Date = new Date()): { deck: Deck; cards: Card[] } {
  const deck = createDeck('How Rote works', 'A short deck about the app itself, so the first review has something in it.', now);
  const pairs: [string, string][] = [
    ['What does Rote schedule reviews with?', 'SM-2, the algorithm behind most spaced repetition software. Each answer adjusts the card’s ease, which sets how fast its interval grows.'],
    ['What happens when you press Again?', 'The card returns to the start of the ladder and comes back tomorrow, and its ease drops so it grows more slowly from then on.'],
    ['Where is this deck stored?', 'In this browser, in IndexedDB. Nothing is uploaded. Use Export to take a copy with you.'],
    ['How do you get cards in quickly?', 'Import a CSV of front,back,tags. A spreadsheet with two columns is enough.'],
    ['What does ease mean?', 'A multiplier on the interval, starting at 2.5 and never falling below 1.3. Higher ease means the gaps grow faster.'],
  ];

  const cards = pairs.map(([front, back]) => createCard(deck.id, front, back, now));
  return { deck, cards };
}
