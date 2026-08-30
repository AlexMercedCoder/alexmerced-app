import { createId } from '../../lib/id';

export const APP_ID = 'stint';
export const APP_VERSION = 1;

export const PROJECT_COLORS = [
  { id: 'slate', hex: '#64748b' }, { id: 'red', hex: '#dc4b45' }, { id: 'amber', hex: '#d08512' },
  { id: 'green', hex: '#2c9463' }, { id: 'teal', hex: '#0f9b7e' }, { id: 'blue', hex: '#2f6f9f' },
  { id: 'violet', hex: '#7255c4' }, { id: 'pink', hex: '#c14a86' },
] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number]['id'];

export type Project = {
  id: string;
  name: string;
  client: string;
  color: ProjectColor;
  /** Per hour. Zero means the project is not billed. */
  rate: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Entry = {
  id: string;
  projectId: string | null;
  description: string;
  tags: string[];
  /** ISO timestamps. A null end means the timer is still running. */
  start: string;
  end: string | null;
  billable: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Rounding is a billing convention, not a measurement. */
export const ROUNDING_INCREMENTS = [0, 1, 5, 6, 10, 15, 30, 60] as const;
export type RoundingIncrement = (typeof ROUNDING_INCREMENTS)[number];
export type RoundingMode = 'nearest' | 'up' | 'down';

export type Settings = {
  increment: RoundingIncrement;
  mode: RoundingMode;
  currency: string;
  /** 0 is Sunday, 1 is Monday. */
  weekStart: 0 | 1;
};

export const defaultSettings: Settings = { increment: 0, mode: 'nearest', currency: 'USD', weekStart: 1 };

export function createProject(name: string, color: ProjectColor = 'blue', now: Date = new Date()): Project {
  const stamp = now.toISOString();
  return { id: createId('proj'), name, client: '', color, rate: 0, archived: false, createdAt: stamp, updatedAt: stamp };
}

export function createEntry(projectId: string | null, description = '', now: Date = new Date()): Entry {
  const stamp = now.toISOString();
  return {
    id: createId('entry'),
    projectId,
    description,
    tags: [],
    start: stamp,
    end: null,
    billable: true,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// --------------------------------------------------------------------- duration

/** Milliseconds an entry covers. A running entry is measured up to now. */
export function durationMs(entry: Entry, now: Date = new Date()): number {
  const start = Date.parse(entry.start);
  const end = entry.end ? Date.parse(entry.end) : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

export function isRunning(entry: Entry): boolean {
  return entry.end === null;
}

export function runningEntry(entries: Entry[]): Entry | undefined {
  return entries.find(isRunning);
}

/**
 * Applies the billing rounding to a duration.
 *
 * Rounding is deliberately separate from the recorded times: the entry keeps
 * what actually happened, and rounding is applied when the number is reported.
 */
export function roundMs(ms: number, settings: Settings): number {
  if (!settings.increment) return ms;
  const step = settings.increment * 60_000;
  if (ms === 0) return 0;

  if (settings.mode === 'up') return Math.ceil(ms / step) * step;
  if (settings.mode === 'down') return Math.floor(ms / step) * step;
  return Math.round(ms / step) * step;
}

export function formatDuration(ms: number, style: 'clock' | 'compact' | 'decimal' = 'clock'): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (style === 'decimal') return (ms / 3_600_000).toFixed(2);
  if (style === 'compact') {
    if (hours && minutes) return `${hours}h ${minutes}m`;
    if (hours) return `${hours}h`;
    if (minutes) return `${minutes}m`;
    return `${seconds}s`;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;

  // 1:30 or 01:30:00
  const clock = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(trimmed);
  if (clock) {
    return (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0)) * 1000;
  }

  // 1h 30m, 90m, 1.5h
  const units = [...trimmed.matchAll(/([\d.]+)\s*(h|m|s)/g)];
  if (units.length) {
    let total = 0;
    for (const [, value, unit] of units) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return null;
      total += amount * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000);
    }
    return total;
  }

  // A bare number is taken as minutes, which is what people mean.
  const bare = Number(trimmed);
  return Number.isFinite(bare) ? bare * 60_000 : null;
}

// --------------------------------------------------------------------- days and weeks

export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayOfEntry(entry: Entry): string {
  return dayOf(new Date(entry.start));
}

export function startOfWeek(date: Date, weekStart: 0 | 1): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = (copy.getDay() - weekStart + 7) % 7;
  copy.setDate(copy.getDate() - shift);
  return copy;
}

export function weekDays(date: Date, weekStart: 0 | 1): string[] {
  const first = startOfWeek(date, weekStart);
  return Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset);
    return dayOf(day);
  });
}

// --------------------------------------------------------------------- reports

export type ProjectTotal = {
  projectId: string | null;
  name: string;
  color: ProjectColor | null;
  ms: number;
  roundedMs: number;
  billableMs: number;
  amount: number;
};

export function totalsByProject(entries: Entry[], projects: Project[], settings: Settings, now: Date = new Date()): ProjectTotal[] {
  const byProject = new Map<string | null, { ms: number; billableMs: number }>();

  for (const entry of entries) {
    const ms = durationMs(entry, now);
    const bucket = byProject.get(entry.projectId) ?? { ms: 0, billableMs: 0 };
    bucket.ms += ms;
    if (entry.billable) bucket.billableMs += ms;
    byProject.set(entry.projectId, bucket);
  }

  const totals: ProjectTotal[] = [];
  for (const [projectId, bucket] of byProject) {
    const project = projects.find((item) => item.id === projectId);
    const roundedBillable = roundMs(bucket.billableMs, settings);
    totals.push({
      projectId,
      name: project?.name ?? 'No project',
      color: project?.color ?? null,
      ms: bucket.ms,
      roundedMs: roundMs(bucket.ms, settings),
      billableMs: bucket.billableMs,
      amount: Math.round(((roundedBillable / 3_600_000) * (project?.rate ?? 0)) * 100) / 100,
    });
  }

  return totals.sort((a, b) => b.ms - a.ms);
}

export function totalMs(entries: Entry[], now: Date = new Date()): number {
  return entries.reduce((sum, entry) => sum + durationMs(entry, now), 0);
}

export function entriesForDay(entries: Entry[], day: string): Entry[] {
  return entries
    .filter((entry) => dayOfEntry(entry) === day)
    .sort((a, b) => b.start.localeCompare(a.start));
}

export function entriesInRange(entries: Entry[], days: string[]): Entry[] {
  const wanted = new Set(days);
  return entries.filter((entry) => wanted.has(dayOfEntry(entry)));
}

export type DayTotal = { day: string; ms: number };

export function totalsByDay(entries: Entry[], days: string[], now: Date = new Date()): DayTotal[] {
  return days.map((day) => ({ day, ms: totalMs(entriesForDay(entries, day), now) }));
}

/** Suggestions for the description box, most used first. */
export function recentDescriptions(entries: Entry[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const text = entry.description.trim();
    if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([text]) => text);
}

export function allTags(entries: Entry[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) for (const tag of entry.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// --------------------------------------------------------------------- csv

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function entriesToCsv(entries: Entry[], projects: Project[], settings: Settings, now: Date = new Date()): string {
  const lines = ['date,start,end,duration,hours,project,client,description,tags,billable,amount'];

  for (const entry of [...entries].sort((a, b) => a.start.localeCompare(b.start))) {
    const project = projects.find((item) => item.id === entry.projectId);
    const ms = roundMs(durationMs(entry, now), settings);
    const hours = ms / 3_600_000;
    const start = new Date(entry.start);
    const end = entry.end ? new Date(entry.end) : null;

    lines.push([
      dayOf(start),
      start.toTimeString().slice(0, 8),
      end ? end.toTimeString().slice(0, 8) : '',
      formatDuration(ms),
      hours.toFixed(2),
      project?.name ?? '',
      project?.client ?? '',
      entry.description,
      entry.tags.join(';'),
      entry.billable ? 'yes' : 'no',
      entry.billable && project?.rate ? (hours * project.rate).toFixed(2) : '',
    ].map(csvField).join(','));
  }

  return lines.join('\n');
}

// --------------------------------------------------------------------- reviving

export function reviveProject(value: unknown): Project | null {
  if (typeof value !== 'object' || value === null) return null;
  const project = value as Partial<Project>;
  if (typeof project.id !== 'string') return null;
  const known = new Set(PROJECT_COLORS.map((color) => color.id as string));
  const stamp = new Date().toISOString();
  return {
    id: project.id,
    name: typeof project.name === 'string' && project.name.trim() ? project.name : 'Untitled project',
    client: typeof project.client === 'string' ? project.client : '',
    color: known.has(project.color as string) ? (project.color as ProjectColor) : 'blue',
    rate: typeof project.rate === 'number' && Number.isFinite(project.rate) && project.rate >= 0 ? project.rate : 0,
    archived: project.archived === true,
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : stamp,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : stamp,
  };
}

export function reviveEntry(value: unknown): Entry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Partial<Entry>;
  if (typeof entry.id !== 'string' || typeof entry.start !== 'string') return null;
  if (!Number.isFinite(Date.parse(entry.start))) return null;

  const end = typeof entry.end === 'string' && Number.isFinite(Date.parse(entry.end)) ? entry.end : null;
  // An end before its start would produce a negative duration.
  const validEnd = end && Date.parse(end) >= Date.parse(entry.start) ? end : end ? entry.start : null;
  const stamp = new Date().toISOString();

  return {
    id: entry.id,
    projectId: typeof entry.projectId === 'string' ? entry.projectId : null,
    description: typeof entry.description === 'string' ? entry.description : '',
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    start: entry.start,
    end: validEnd,
    billable: entry.billable !== false,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : stamp,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : stamp,
  };
}

/** An entry pointing at a project that is gone becomes an unassigned entry. */
export function reconcile(projects: Project[], entries: Entry[]): Entry[] {
  const ids = new Set(projects.map((project) => project.id));
  return entries.map((entry) => (entry.projectId && !ids.has(entry.projectId) ? { ...entry, projectId: null } : entry));
}

/** Only one timer can run, so a file with several is repaired on the way in. */
export function stopExtraTimers(entries: Entry[], now: Date = new Date()): Entry[] {
  const running = entries.filter(isRunning).sort((a, b) => b.start.localeCompare(a.start));
  if (running.length <= 1) return entries;

  const keep = running[0].id;
  const stamp = now.toISOString();
  return entries.map((entry) =>
    isRunning(entry) && entry.id !== keep ? { ...entry, end: stamp, updatedAt: stamp } : entry,
  );
}

export function reviveSettings(value: unknown): Settings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Settings>;
  const increments = new Set<number>(ROUNDING_INCREMENTS);
  return {
    increment: increments.has(raw.increment as number) ? (raw.increment as RoundingIncrement) : 0,
    mode: raw.mode === 'up' || raw.mode === 'down' ? raw.mode : 'nearest',
    currency: typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.slice(0, 4) : 'USD',
    weekStart: raw.weekStart === 0 ? 0 : 1,
  };
}
