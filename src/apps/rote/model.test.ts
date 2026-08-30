import { describe, expect, it } from 'vitest';
import {
  GRADES,
  MIN_EASE,
  STARTING_EASE,
  addDays,
  buildQueue,
  cardsToCsv,
  createCard,
  createDeck,
  dayOf,
  daysBetween,
  deckStats,
  forecast,
  isDue,
  isUsable,
  parseCardCsv,
  parseCsvRows,
  reconcile,
  reviveCard,
  reviveDeck,
  schedule,
  starterDeck,
  stateOf,
  type Card,
  type Grade,
} from './model';

const NOW = new Date(2026, 5, 15, 9, 0, 0); // 15 June 2026, local time
const card = (overrides: Partial<Card> = {}): Card => ({ ...createCard('deck1', 'front', 'back', NOW), ...overrides });

describe('day arithmetic', () => {
  it('formats a local date', () => {
    expect(dayOf(NOW)).toBe('2026-06-15');
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-06-28', 5)).toBe('2026-07-03');
  });

  it('adds days across a year boundary', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('subtracts', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts days between dates in both directions', () => {
    expect(daysBetween('2026-06-15', '2026-06-20')).toBe(5);
    expect(daysBetween('2026-06-20', '2026-06-15')).toBe(-5);
    expect(daysBetween('2026-06-15', '2026-06-15')).toBe(0);
  });

  it('handles a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('SM-2 scheduling', () => {
  it('sends a brand new card one day out on a good answer', () => {
    const result = schedule(card(), 4, NOW);
    expect(result.repetitions).toBe(1);
    expect(result.interval).toBe(1);
    expect(result.due).toBe('2026-06-16');
  });

  it('sends the second good answer six days out', () => {
    const first = schedule(card(), 4, NOW);
    const second = schedule(first, 4, NOW);
    expect(second.repetitions).toBe(2);
    expect(second.interval).toBe(6);
  });

  it('multiplies by ease from the third repetition', () => {
    let current = card();
    current = schedule(current, 4, NOW);
    current = schedule(current, 4, NOW);
    const before = current.interval;
    current = schedule(current, 4, NOW);
    expect(current.interval).toBe(Math.round(before * current.ease));
    expect(current.interval).toBeGreaterThan(before);
  });

  it('grows the interval further on an easy answer', () => {
    let good = card();
    let easy = card();
    for (let i = 0; i < 4; i += 1) { good = schedule(good, 4, NOW); easy = schedule(easy, 5, NOW); }
    expect(easy.interval).toBeGreaterThan(good.interval);
  });

  it('raises ease on easy and lowers it on hard', () => {
    expect(schedule(card(), 5, NOW).ease).toBeGreaterThan(STARTING_EASE);
    expect(schedule(card(), 3, NOW).ease).toBeLessThan(STARTING_EASE);
  });

  it('leaves ease unchanged on a good answer', () => {
    expect(schedule(card(), 4, NOW).ease).toBeCloseTo(STARTING_EASE, 6);
  });

  it('resets repetitions and counts a lapse on a failure', () => {
    let current = card();
    for (let i = 0; i < 5; i += 1) current = schedule(current, 4, NOW);
    const failed = schedule(current, 0, NOW);
    expect(failed.repetitions).toBe(0);
    expect(failed.interval).toBe(1);
    expect(failed.lapses).toBe(1);
    expect(failed.due).toBe('2026-06-16');
  });

  it('never lets ease fall below the floor', () => {
    let current = card();
    for (let i = 0; i < 40; i += 1) current = schedule(current, 0, NOW);
    expect(current.ease).toBeGreaterThanOrEqual(MIN_EASE);
  });

  it('never schedules a card for the same day', () => {
    let current = card();
    for (const grade of [0, 3, 4, 5, 0, 4, 5, 3] as Grade[]) {
      current = schedule(current, grade, NOW);
      expect(current.interval).toBeGreaterThanOrEqual(1);
      expect(daysBetween(dayOf(NOW), current.due!)).toBeGreaterThanOrEqual(1);
    }
  });

  it('counts every review and records the last grade', () => {
    let current = card();
    current = schedule(current, 4, NOW);
    current = schedule(current, 3, NOW);
    expect(current.reviews).toBe(2);
    expect(current.lastGrade).toBe(3);
    expect(current.lastReviewed).toBe(NOW.toISOString());
  });

  it('grows intervals faster for a consistently easy card than a hard one', () => {
    let easy = card();
    let hard = card();
    for (let i = 0; i < 6; i += 1) { easy = schedule(easy, 5, NOW); hard = schedule(hard, 3, NOW); }
    expect(easy.interval).toBeGreaterThan(hard.interval * 2);
  });

  it('offers four grades a person can tell apart', () => {
    expect(GRADES.map((g) => g.id)).toEqual([0, 3, 4, 5]);
  });
});

describe('card state', () => {
  it('calls an unseen card new', () => {
    expect(stateOf(card())).toBe('new');
  });

  it('calls a card in its first repetitions learning', () => {
    expect(stateOf(schedule(card(), 4, NOW))).toBe('learning');
  });

  it('calls a card past two repetitions a review card', () => {
    let current = card();
    current = schedule(current, 4, NOW);
    current = schedule(current, 4, NOW);
    expect(stateOf(current)).toBe('review');
  });

  it('reports suspension over everything else', () => {
    expect(stateOf(card({ suspended: true, due: '2026-01-01' }))).toBe('suspended');
  });
});

describe('isDue', () => {
  it('treats a new card as due', () => {
    expect(isDue(card(), NOW)).toBe(true);
  });

  it('treats an overdue card as due', () => {
    expect(isDue(card({ due: '2026-06-01' }), NOW)).toBe(true);
  });

  it('treats today as due', () => {
    expect(isDue(card({ due: '2026-06-15' }), NOW)).toBe(true);
  });

  it('treats tomorrow as not due', () => {
    expect(isDue(card({ due: '2026-06-16' }), NOW)).toBe(false);
  });

  it('never treats a suspended card as due', () => {
    expect(isDue(card({ suspended: true }), NOW)).toBe(false);
  });
});

describe('buildQueue', () => {
  const deck = { ...createDeck('D', '', NOW), id: 'deck1', newPerDay: 2 };

  it('puts overdue cards first, oldest first', () => {
    const queue = buildQueue([
      card({ id: 'b', due: '2026-06-10' }),
      card({ id: 'a', due: '2026-06-01' }),
      card({ id: 'c', due: '2026-06-15' }),
    ], deck, NOW);
    expect(queue.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts new cards after due ones', () => {
    const queue = buildQueue([card({ id: 'new' }), card({ id: 'due', due: '2026-06-10' })], deck, NOW);
    expect(queue.map((c) => c.id)).toEqual(['due', 'new']);
  });

  it('caps new cards at the daily allowance', () => {
    const cards = Array.from({ length: 10 }, (_, i) => card({ id: `n${i}` }));
    expect(buildQueue(cards, deck, NOW)).toHaveLength(2);
  });

  it('leaves out cards not yet due', () => {
    expect(buildQueue([card({ due: '2026-07-01' })], deck, NOW)).toHaveLength(0);
  });

  it('leaves out suspended and unusable cards', () => {
    const queue = buildQueue([
      card({ id: 'suspended', suspended: true }),
      card({ id: 'blank', front: '', back: '' }),
      card({ id: 'fine' }),
    ], deck, NOW);
    expect(queue.map((c) => c.id)).toEqual(['fine']);
  });

  it('ignores cards from another deck', () => {
    expect(buildQueue([card({ deckId: 'other' })], deck, NOW)).toHaveLength(0);
  });
});

describe('isUsable', () => {
  it('needs both sides', () => {
    expect(isUsable(card({ front: 'a', back: 'b' }))).toBe(true);
    expect(isUsable(card({ front: '  ', back: 'b' }))).toBe(false);
    expect(isUsable(card({ front: 'a', back: '' }))).toBe(false);
  });
});

describe('deckStats', () => {
  it('counts each state', () => {
    const stats = deckStats([
      card({ id: '1' }),
      card({ id: '2', due: '2026-06-01', repetitions: 1 }),
      card({ id: '3', due: '2026-12-01', repetitions: 5 }),
      card({ id: '4', suspended: true }),
      card({ id: '5', deckId: 'other' }),
    ], 'deck1', NOW);

    expect(stats.total).toBe(4);
    expect(stats.new).toBe(1);
    expect(stats.learning).toBe(1);
    expect(stats.review).toBe(1);
    expect(stats.suspended).toBe(1);
    expect(stats.due).toBe(2);
  });

  it('reports retention from reviews and lapses', () => {
    const stats = deckStats([card({ reviews: 10, lapses: 2 })], 'deck1', NOW);
    expect(stats.retention).toBe(80);
  });

  it('reports no retention before any reviews', () => {
    expect(deckStats([card()], 'deck1', NOW).retention).toBeNull();
  });

  it('averages ease over reviewed cards only', () => {
    const stats = deckStats([card({ reviews: 1, ease: 2.0 }), card({ reviews: 1, ease: 3.0 }), card()], 'deck1', NOW);
    expect(stats.averageEase).toBe(2.5);
  });
});

describe('forecast', () => {
  it('returns one entry per day', () => {
    expect(forecast([], 'deck1', 14, NOW)).toHaveLength(14);
  });

  it('rolls everything overdue into today', () => {
    const days = forecast([card({ due: '2026-01-01' }), card({ due: '2026-06-15' })], 'deck1', 7, NOW);
    expect(days[0].count).toBe(2);
  });

  it('places a future card on its own day', () => {
    const days = forecast([card({ due: '2026-06-18' })], 'deck1', 7, NOW);
    expect(days[3]).toEqual({ day: '2026-06-18', count: 1 });
    expect(days[2].count).toBe(0);
  });
});

describe('CSV', () => {
  it('reads simple rows', () => {
    expect(parseCsvRows('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('reads quoted fields with commas', () => {
    expect(parseCsvRows('a,"b, still b"')).toEqual([['a', 'b, still b']]);
  });

  it('reads doubled quotes', () => {
    expect(parseCsvRows('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('reads a newline inside a quoted field', () => {
    expect(parseCsvRows('"line one\nline two",x')).toEqual([['line one\nline two', 'x']]);
  });

  it('ignores carriage returns', () => {
    expect(parseCsvRows('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('drops entirely blank rows', () => {
    expect(parseCsvRows('a,b\n\n\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('builds cards and skips incomplete rows', () => {
    const result = parseCardCsv('front,back,tags\nhello,hola,spanish\nonly one side,\n', 'deck1', NOW);
    expect(result.cards).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.cards[0].front).toBe('hello');
    expect(result.cards[0].tags).toEqual(['spanish']);
  });

  it('detects and skips a header row', () => {
    const withHeader = parseCardCsv('front,back\na,b', 'deck1', NOW);
    const without = parseCardCsv('a,b', 'deck1', NOW);
    expect(withHeader.cards).toHaveLength(1);
    expect(without.cards).toHaveLength(1);
    expect(withHeader.cards[0].front).toBe('a');
  });

  it('splits tags on semicolons', () => {
    const result = parseCardCsv('a,b,one;two;three', 'deck1', NOW);
    expect(result.cards[0].tags).toEqual(['one', 'two', 'three']);
  });

  it('round trips through export and import', () => {
    const original = parseCardCsv('what is 2+2?,"four, obviously",math;easy', 'deck1', NOW).cards;
    const reparsed = parseCardCsv(cardsToCsv(original), 'deck1', NOW).cards;
    expect(reparsed[0].front).toBe(original[0].front);
    expect(reparsed[0].back).toBe(original[0].back);
    expect(reparsed[0].tags).toEqual(original[0].tags);
  });
});

describe('reviving imported records', () => {
  it('rejects records with no id', () => {
    expect(reviveDeck({})).toBeNull();
    expect(reviveCard({ id: 'x' })).toBeNull();
  });

  it('repairs an ease below the floor', () => {
    expect(reviveCard({ id: 'a', deckId: 'd', ease: 0.2 })?.ease).toBe(STARTING_EASE);
  });

  it('drops a malformed due date', () => {
    expect(reviveCard({ id: 'a', deckId: 'd', due: 'tomorrow' })?.due).toBeNull();
    expect(reviveCard({ id: 'a', deckId: 'd', due: '2026-06-15' })?.due).toBe('2026-06-15');
  });

  it('drops a grade outside the scale', () => {
    expect(reviveCard({ id: 'a', deckId: 'd', lastGrade: 2 })?.lastGrade).toBeNull();
    expect(reviveCard({ id: 'a', deckId: 'd', lastGrade: 5 })?.lastGrade).toBe(5);
  });

  it('defaults a nonsense daily allowance', () => {
    expect(reviveDeck({ id: 'd', newPerDay: -4 })?.newPerDay).toBe(20);
  });

  it('drops cards whose deck vanished', () => {
    const deck = createDeck('kept', '', NOW);
    const kept = card({ deckId: deck.id, id: 'kept' });
    const orphan = card({ deckId: 'gone', id: 'orphan' });
    expect(reconcile([deck], [kept, orphan]).map((c) => c.id)).toEqual(['kept']);
  });
});

describe('starterDeck', () => {
  it('gives a new visitor a usable deck', () => {
    const { deck, cards } = starterDeck(NOW);
    expect(cards.length).toBeGreaterThan(3);
    expect(cards.every((c) => c.deckId === deck.id)).toBe(true);
    expect(cards.every(isUsable)).toBe(true);
  });
});
