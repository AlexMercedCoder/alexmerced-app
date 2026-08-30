import { readBoolean, readNumber, readString, requireString, textResult, type McpTool } from '../../lib/webmcp';
import {
  createEntry, createProject, dayOf, dayOfEntry, durationMs, entriesForDay, formatDuration,
  isRunning, roundMs, runningEntry, totalsByProject, totalMs, weekDays, type Entry, type Project,
} from './model';
import { loadSettings, loadWorkspace, saveEntry, saveProject } from './store';

/**
 * Stint's tools. The useful questions here are "what am I doing", "start the
 * clock", and "where did the week go", so those are the three shapes offered.
 */
export function stintTools(onChanged: () => void): McpTool[] {
  return [
    {
      name: 'stint_current',
      description:
        'Say whether a timer is running, what it is on, which project, and for how long. Also gives today’s total.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const { projects, entries } = await loadWorkspace();
        const running = runningEntry(entries);
        const today = dayOf(new Date());
        const todays = entriesForDay(entries, today);

        return textResult({
          running: running
            ? {
                id: running.id,
                description: running.description || '(no description)',
                project: projects.find((project) => project.id === running.projectId)?.name ?? null,
                elapsed: formatDuration(durationMs(running)),
                billable: running.billable,
              }
            : null,
          today: { date: today, total: formatDuration(totalMs(todays)), entries: todays.length },
        });
      },
    },
    {
      name: 'stint_start_timer',
      description:
        'Start the clock on something. Any timer already running is stopped first, because only one thing can be timed at once. If the project does not exist it is created.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What you are working on.' },
          project: { type: 'string', description: 'Project name. Created if it is new.' },
          billable: { type: 'boolean', description: 'True by default.' },
        },
        required: ['description'],
      },
      execute: async (input) => {
        const description = requireString(input, 'description');
        const { projects, entries } = await loadWorkspace();

        const running = runningEntry(entries);
        if (running) {
          await saveEntry({ ...running, end: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }

        const wanted = readString(input, 'project');
        let project: Project | undefined = wanted
          ? projects.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase())
          : undefined;

        if (wanted && !project) {
          project = createProject(wanted);
          await saveProject(project);
        }

        const entry = createEntry(project?.id ?? null, description);
        entry.billable = readBoolean(input, 'billable', true);
        await saveEntry(entry);
        onChanged();

        return textResult({
          started: { id: entry.id, description, project: project?.name ?? null, at: entry.start },
          stopped: running ? { id: running.id, description: running.description, ran: formatDuration(durationMs(running)) } : null,
        });
      },
    },
    {
      name: 'stint_stop_timer',
      description: 'Stop whatever timer is running and report how long it ran.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const { entries } = await loadWorkspace();
        const running = runningEntry(entries);
        if (!running) return textResult({ stopped: null, note: 'Nothing was running.' });

        const now = new Date().toISOString();
        await saveEntry({ ...running, end: now, updatedAt: now });
        onChanged();
        return textResult({
          stopped: { id: running.id, description: running.description || '(no description)', ran: formatDuration(durationMs(running)) },
        });
      },
    },
    {
      name: 'stint_summary',
      description:
        'Report where the time went, for a day, a week, or a range of days. Broken down by project, with billable totals and, where a rate is set, what that comes to. Rounding follows the settings on the page, so the figures match what would be invoiced.',
      inputSchema: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: ['today', 'week', 'all'], description: '"today" by default.' },
          date: { type: 'string', description: 'A date as YYYY-MM-DD, for a day or the week containing it.' },
        },
      },
      execute: async (input) => {
        const { projects, entries } = await loadWorkspace();
        const settings = loadSettings();
        const range = readString(input, 'range', 'today');
        const anchorText = readString(input, 'date');
        const anchor = /^\d{4}-\d{2}-\d{2}$/.test(anchorText) ? new Date(`${anchorText}T12:00:00`) : new Date();

        const days = range === 'week' ? weekDays(anchor, settings.weekStart) : [dayOf(anchor)];
        const selected = range === 'all' ? entries : entries.filter((entry) => days.includes(dayOfEntry(entry)));

        const totals = totalsByProject(selected, projects, settings);
        const billable = selected.filter((entry) => entry.billable);

        return textResult({
          range,
          days: range === 'all' ? 'everything' : days,
          total: formatDuration(roundMs(totalMs(selected), settings)),
          billableTotal: formatDuration(roundMs(totalMs(billable), settings)),
          entries: selected.length,
          currency: settings.currency,
          byProject: totals.map((total) => ({
            project: total.name,
            time: formatDuration(total.ms),
            // The rounded figure is what would be billed, and can differ.
            roundedTime: formatDuration(total.roundedMs),
            billableTime: formatDuration(total.billableMs),
            amount: total.amount > 0 ? Number(total.amount.toFixed(2)) : null,
          })),
        });
      },
    },
    {
      name: 'stint_log_time',
      description:
        'Record time that has already been worked, rather than timing it live. Give a description, how long, and optionally which day and project.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          minutes: { type: 'number', description: 'How long, in minutes.' },
          project: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD. Today when omitted.' },
          billable: { type: 'boolean' },
        },
        required: ['description', 'minutes'],
      },
      execute: async (input) => {
        const description = requireString(input, 'description');
        const minutes = readNumber(input, 'minutes', 0);
        if (minutes <= 0) throw new Error('"minutes" must be greater than zero.');

        const { projects } = await loadWorkspace();
        const wanted = readString(input, 'project');
        let project = wanted ? projects.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase()) : undefined;
        if (wanted && !project) {
          project = createProject(wanted);
          await saveProject(project);
        }

        const dateText = readString(input, 'date');
        const day = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : dayOf(new Date());
        // Logged time is placed at midday, so it cannot drift into another day
        // when the clocks change or the reader is in a different zone.
        const start = new Date(`${day}T12:00:00`);
        const end = new Date(start.getTime() + minutes * 60_000);

        const entry: Entry = {
          ...createEntry(project?.id ?? null, description),
          start: start.toISOString(),
          end: end.toISOString(),
          billable: readBoolean(input, 'billable', true),
        };
        await saveEntry(entry);
        onChanged();

        return textResult({ logged: { id: entry.id, description, day, duration: formatDuration(minutes * 60_000), project: project?.name ?? null } });
      },
    },
  ];
}

/** Exported for the page, which wants to know whether anything is running. */
export function timerIsRunning(entries: Entry[]): boolean {
  return entries.some(isRunning);
}
