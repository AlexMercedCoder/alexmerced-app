import { describe, expect, it } from 'vitest';
import {
  ROUNDING_INCREMENTS,
  createEntry,
  createProject,
  dayOf,
  defaultSettings,
  durationMs,
  entriesForDay,
  entriesToCsv,
  formatDuration,
  isRunning,
  parseDuration,
  reconcile,
  recentDescriptions,
  reviveEntry,
  reviveProject,
  reviveSettings,
  roundMs,
  runningEntry,
  startOfWeek,
  stopExtraTimers,
  totalMs,
  totalsByDay,
  totalsByProject,
  weekDays,
  type Entry,
  type Settings,
} from './model';

const NOW = new Date(2026, 5, 15, 14, 30, 0);
const at = (hour: number, minute = 0) => new Date(2026, 5, 15, hour, minute, 0).toISOString();

const entry = (overrides: Partial<Entry> = {}): Entry => ({
  ...createEntry('p1', 'work', NOW),
  start: at(9),
  end: at(10),
  ...overrides,
});

describe('duration', () => {
  it('measures a finished entry', () => {
    expect(durationMs(entry({ start: at(9), end: at(10, 30) }))).toBe(90 * 60_000);
  });

  it('measures a running entry up to now', () => {
    expect(durationMs(entry({ start: at(14), end: null }), NOW)).toBe(30 * 60_000);
  });

  it('never returns a negative duration', () => {
    expect(durationMs(entry({ start: at(10), end: at(9) }))).toBe(0);
  });

  it('returns zero for unparseable times', () => {
    expect(durationMs(entry({ start: 'nonsense', end: null }), NOW)).toBe(0);
  });

  it('knows which entry is running', () => {
    const list = [entry({ id: 'done' }), entry({ id: 'live', end: null })];
    expect(runningEntry(list)?.id).toBe('live');
    expect(isRunning(list[0])).toBe(false);
  });
});

describe('rounding', () => {
  const settings = (over: Partial<Settings>): Settings => ({ ...defaultSettings, ...over });

  it('leaves the duration alone with no increment', () => {
    expect(roundMs(7 * 60_000, settings({ increment: 0 }))).toBe(7 * 60_000);
  });

  it('rounds to the nearest increment', () => {
    expect(roundMs(7 * 60_000, settings({ increment: 15, mode: 'nearest' }))).toBe(0);
    expect(roundMs(8 * 60_000, settings({ increment: 15, mode: 'nearest' }))).toBe(15 * 60_000);
  });

  it('rounds up', () => {
    expect(roundMs(1 * 60_000, settings({ increment: 15, mode: 'up' }))).toBe(15 * 60_000);
    expect(roundMs(16 * 60_000, settings({ increment: 15, mode: 'up' }))).toBe(30 * 60_000);
  });

  it('rounds down', () => {
    expect(roundMs(29 * 60_000, settings({ increment: 15, mode: 'down' }))).toBe(15 * 60_000);
  });

  it('leaves zero as zero even when rounding up', () => {
    expect(roundMs(0, settings({ increment: 15, mode: 'up' }))).toBe(0);
  });

  it('handles the six minute increment lawyers use', () => {
    expect(ROUNDING_INCREMENTS).toContain(6);
    expect(roundMs(7 * 60_000, settings({ increment: 6, mode: 'up' }))).toBe(12 * 60_000);
  });
});

describe('formatDuration', () => {
  it('formats as a clock', () => {
    expect(formatDuration(3_661_000)).toBe('01:01:01');
    expect(formatDuration(0)).toBe('00:00:00');
  });

  it('formats compactly', () => {
    expect(formatDuration(90 * 60_000, 'compact')).toBe('1h 30m');
    expect(formatDuration(60 * 60_000, 'compact')).toBe('1h');
    expect(formatDuration(5 * 60_000, 'compact')).toBe('5m');
    expect(formatDuration(9000, 'compact')).toBe('9s');
  });

  it('formats as decimal hours for invoicing', () => {
    expect(formatDuration(90 * 60_000, 'decimal')).toBe('1.50');
  });
});

describe('parseDuration', () => {
  it('reads clock notation', () => {
    expect(parseDuration('1:30')).toBe(90 * 60_000);
    expect(parseDuration('0:45')).toBe(45 * 60_000);
    expect(parseDuration('2:00:30')).toBe((120 * 60 + 30) * 1000);
  });

  it('reads unit notation', () => {
    expect(parseDuration('1h 30m')).toBe(90 * 60_000);
    expect(parseDuration('90m')).toBe(90 * 60_000);
    expect(parseDuration('1.5h')).toBe(90 * 60_000);
    expect(parseDuration('45s')).toBe(45_000);
  });

  it('reads a bare number as minutes', () => {
    expect(parseDuration('30')).toBe(30 * 60_000);
  });

  it('returns null for nonsense', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('later')).toBeNull();
  });
});

describe('weeks', () => {
  it('starts the week on Monday by default', () => {
    // 15 June 2026 is a Monday.
    expect(dayOf(startOfWeek(NOW, 1))).toBe('2026-06-15');
  });

  it('starts on Sunday when asked', () => {
    expect(dayOf(startOfWeek(NOW, 0))).toBe('2026-06-14');
  });

  it('returns seven consecutive days', () => {
    const days = weekDays(NOW, 1);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-06-15');
    expect(days[6]).toBe('2026-06-21');
  });

  it('handles a date mid-week', () => {
    const thursday = new Date(2026, 5, 18);
    expect(weekDays(thursday, 1)[0]).toBe('2026-06-15');
  });
});

describe('reports', () => {
  const projects = [
    { ...createProject('Alpha', 'blue', NOW), id: 'p1', rate: 100 },
    { ...createProject('Beta', 'red', NOW), id: 'p2', rate: 0 },
  ];

  it('totals by project, largest first', () => {
    const totals = totalsByProject([
      entry({ projectId: 'p2', start: at(9), end: at(10) }),
      entry({ projectId: 'p1', start: at(9), end: at(12) }),
    ], projects, defaultSettings, NOW);

    expect(totals.map((t) => t.name)).toEqual(['Alpha', 'Beta']);
    expect(totals[0].ms).toBe(3 * 3_600_000);
  });

  it('groups entries with no project under a placeholder', () => {
    const totals = totalsByProject([entry({ projectId: null })], projects, defaultSettings, NOW);
    expect(totals[0].name).toBe('No project');
  });

  it('bills only billable time, at the project rate', () => {
    const totals = totalsByProject([
      entry({ projectId: 'p1', start: at(9), end: at(11), billable: true }),
      entry({ projectId: 'p1', start: at(11), end: at(12), billable: false }),
    ], projects, defaultSettings, NOW);

    expect(totals[0].ms).toBe(3 * 3_600_000);
    expect(totals[0].billableMs).toBe(2 * 3_600_000);
    expect(totals[0].amount).toBe(200);
  });

  it('bills nothing for a project with no rate', () => {
    const totals = totalsByProject([entry({ projectId: 'p2', start: at(9), end: at(12) })], projects, defaultSettings, NOW);
    expect(totals[0].amount).toBe(0);
  });

  it('applies rounding to the billed amount', () => {
    const rounded: Settings = { ...defaultSettings, increment: 30, mode: 'up' };
    const totals = totalsByProject([entry({ projectId: 'p1', start: at(9), end: at(9, 5) })], projects, rounded, NOW);
    // Five minutes rounds up to half an hour, so half the hourly rate.
    expect(totals[0].amount).toBe(50);
  });

  it('sums a set of entries', () => {
    expect(totalMs([entry({ start: at(9), end: at(10) }), entry({ start: at(10), end: at(11) })], NOW)).toBe(2 * 3_600_000);
  });

  it('groups entries by day, newest first within the day', () => {
    const list = [
      entry({ id: 'early', start: at(9), end: at(10) }),
      entry({ id: 'late', start: at(13), end: at(14) }),
      entry({ id: 'other', start: new Date(2026, 5, 14, 9).toISOString(), end: new Date(2026, 5, 14, 10).toISOString() }),
    ];
    expect(entriesForDay(list, '2026-06-15').map((e) => e.id)).toEqual(['late', 'early']);
  });

  it('totals each day of a range', () => {
    const list = [entry({ start: at(9), end: at(11) })];
    const totals = totalsByDay(list, ['2026-06-14', '2026-06-15'], NOW);
    expect(totals[0].ms).toBe(0);
    expect(totals[1].ms).toBe(2 * 3_600_000);
  });

  it('suggests the most used descriptions', () => {
    const list = [
      entry({ description: 'writing' }), entry({ description: 'writing' }),
      entry({ description: 'meeting' }), entry({ description: '' }),
    ];
    expect(recentDescriptions(list)).toEqual(['writing', 'meeting']);
  });
});

describe('CSV export', () => {
  const projects = [{ ...createProject('Alpha', 'blue', NOW), id: 'p1', rate: 50, client: 'Acme' }];

  it('writes a header and one row per entry', () => {
    const csv = entriesToCsv([entry({ start: at(9), end: at(10) })], projects, defaultSettings, NOW);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('date,start,end,duration');
    expect(lines).toHaveLength(2);
  });

  it('includes decimal hours and the billed amount', () => {
    const csv = entriesToCsv([entry({ start: at(9), end: at(10, 30) })], projects, defaultSettings, NOW);
    expect(csv).toContain('1.50');
    expect(csv).toContain('75.00');
  });

  it('quotes a description containing a comma', () => {
    const csv = entriesToCsv([entry({ description: 'wrote docs, then tests' })], projects, defaultSettings, NOW);
    expect(csv).toContain('"wrote docs, then tests"');
  });

  it('orders rows oldest first', () => {
    const csv = entriesToCsv([
      entry({ description: 'second', start: at(13), end: at(14) }),
      entry({ description: 'first', start: at(9), end: at(10) }),
    ], projects, defaultSettings, NOW);
    expect(csv.indexOf('first')).toBeLessThan(csv.indexOf('second'));
  });
});

describe('reviving imported records', () => {
  it('rejects an entry with no start', () => {
    expect(reviveEntry({ id: 'a' })).toBeNull();
    expect(reviveEntry({ id: 'a', start: 'not a date' })).toBeNull();
  });

  it('repairs an end that precedes its start', () => {
    const revived = reviveEntry({ id: 'a', start: at(10), end: at(9) });
    expect(revived?.end).toBe(at(10));
    expect(durationMs(revived!)).toBe(0);
  });

  it('keeps a running entry running', () => {
    expect(reviveEntry({ id: 'a', start: at(9) })?.end).toBeNull();
  });

  it('defaults an unknown project colour', () => {
    expect(reviveProject({ id: 'p', color: 'chartreuse' })?.color).toBe('blue');
  });

  it('rejects a negative rate', () => {
    expect(reviveProject({ id: 'p', rate: -50 })?.rate).toBe(0);
  });

  it('unassigns entries whose project vanished', () => {
    const project = { ...createProject('kept', 'blue', NOW), id: 'kept' };
    const entries = reconcile([project], [entry({ projectId: 'gone' }), entry({ projectId: 'kept' })]);
    expect(entries[0].projectId).toBeNull();
    expect(entries[1].projectId).toBe('kept');
  });

  it('stops all but the newest timer', () => {
    const list = [
      entry({ id: 'old', start: at(9), end: null }),
      entry({ id: 'new', start: at(13), end: null }),
    ];
    const fixed = stopExtraTimers(list, NOW);
    expect(fixed.find((e) => e.id === 'old')?.end).not.toBeNull();
    expect(fixed.find((e) => e.id === 'new')?.end).toBeNull();
  });

  it('leaves a single timer alone', () => {
    const list = [entry({ id: 'only', end: null })];
    expect(stopExtraTimers(list, NOW)).toBe(list);
  });

  it('clamps nonsense settings', () => {
    const settings = reviveSettings({ increment: 7, mode: 'sideways', weekStart: 5, currency: '' });
    expect(settings.increment).toBe(0);
    expect(settings.mode).toBe('nearest');
    expect(settings.weekStart).toBe(1);
    expect(settings.currency).toBe('USD');
  });

  it('keeps valid settings', () => {
    const settings = reviveSettings({ increment: 15, mode: 'up', weekStart: 0, currency: 'GBP' });
    expect(settings).toEqual({ increment: 15, mode: 'up', weekStart: 0, currency: 'GBP' });
  });
});
