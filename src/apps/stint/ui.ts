import { wireDataMenu } from '../../lib/dataMenu';
import { downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import {
  APP_ID, PROJECT_COLORS, ROUNDING_INCREMENTS, createEntry, createProject, dayOf, dayOfEntry,
  durationMs, entriesForDay, entriesInRange, entriesToCsv, formatDuration, isRunning, parseDuration,
  recentDescriptions, roundMs, runningEntry, totalMs, totalsByDay, totalsByProject, weekDays,
  type Entry, type Project, type ProjectColor, type RoundingIncrement, type RoundingMode, type Settings,
} from './model';
import {
  applyImport, buildExport, clearAll, deleteEntry, deleteProject, loadSettings, loadView,
  loadWorkspace, saveEntry, saveProject, saveSettings, saveView, type ViewPrefs,
} from './store';

export async function mountStint(root: HTMLElement): Promise<void> {
  let projects: Project[] = [];
  let entries: Entry[] = [];
  let settings: Settings = loadSettings();
  let view: ViewPrefs = loadView();
  let ticker: number | undefined;

  const timerDisplay = root.querySelector<HTMLElement>('#st-timer')!;
  const timerButton = root.querySelector<HTMLButtonElement>('#st-toggle')!;
  const descriptionInput = root.querySelector<HTMLInputElement>('#st-description')!;
  const projectPicker = root.querySelector<HTMLSelectElement>('#st-project')!;
  const billableToggle = root.querySelector<HTMLInputElement>('#st-billable')!;
  const suggestions = root.querySelector<HTMLDataListElement>('#st-suggestions')!;

  const rangeTabs = root.querySelector<HTMLElement>('#st-range')!;
  const rangeLabel = root.querySelector<HTMLElement>('#st-range-label')!;
  const summary = root.querySelector<HTMLElement>('#st-summary')!;
  const entryList = root.querySelector<HTMLElement>('#st-entries')!;
  const entryEmpty = root.querySelector<HTMLElement>('#st-entries-empty')!;
  const projectTotals = root.querySelector<HTMLElement>('#st-project-totals')!;
  const dayBars = root.querySelector<HTMLElement>('#st-daybars')!;
  const projectList = root.querySelector<HTMLElement>('#st-projects')!;

  const anchorDate = (): Date => (view.anchor ? new Date(`${view.anchor}T12:00:00`) : new Date());
  const visibleDays = (): string[] => (view.range === 'week' ? weekDays(anchorDate(), settings.weekStart) : [dayOf(anchorDate())]);
  const visibleEntries = (): Entry[] => entriesInRange(entries, visibleDays());
  const projectById = (id: string | null) => projects.find((item) => item.id === id);

  // ------------------------------------------------------------------ timer
  function renderTimer(): void {
    const running = runningEntry(entries);
    if (running) {
      timerDisplay.textContent = formatDuration(durationMs(running));
      timerDisplay.dataset.running = 'true';
      timerButton.textContent = 'Stop';
      timerButton.classList.add('btn--danger');
      timerButton.classList.remove('btn--primary');
      if (document.activeElement !== descriptionInput) descriptionInput.value = running.description;
      projectPicker.value = running.projectId ?? '';
      billableToggle.checked = running.billable;
    } else {
      timerDisplay.textContent = '00:00:00';
      delete timerDisplay.dataset.running;
      timerButton.textContent = 'Start';
      timerButton.classList.add('btn--primary');
      timerButton.classList.remove('btn--danger');
    }
  }

  function startTicking(): void {
    window.clearInterval(ticker);
    ticker = window.setInterval(() => {
      if (runningEntry(entries)) { renderTimer(); renderSummary(); }
    }, 1000);
  }

  async function toggleTimer(): Promise<void> {
    const running = runningEntry(entries);
    if (running) {
      const stopped: Entry = { ...running, end: new Date().toISOString(), updatedAt: new Date().toISOString() };
      entries = entries.map((item) => (item.id === running.id ? stopped : item));
      await saveEntry(stopped);
      descriptionInput.value = '';
      toast(`Stopped after ${formatDuration(durationMs(stopped), 'compact')}.`, { kind: 'good' });
    } else {
      const entry = createEntry(projectPicker.value || null, descriptionInput.value.trim());
      entry.billable = billableToggle.checked;
      entries = [...entries, entry];
      await saveEntry(entry);
    }
    render();
  }

  // ------------------------------------------------------------------ rendering
  function renderProjectPicker(): void {
    const current = projectPicker.value;
    projectPicker.innerHTML = '<option value="">No project</option>';
    for (const project of projects.filter((item) => !item.archived)) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.client ? `${project.name} · ${project.client}` : project.name;
      projectPicker.appendChild(option);
    }
    projectPicker.value = current;

    suggestions.innerHTML = '';
    for (const text of recentDescriptions(entries)) {
      const option = document.createElement('option');
      option.value = text;
      suggestions.appendChild(option);
    }
  }

  function renderRange(): void {
    for (const button of rangeTabs.querySelectorAll<HTMLElement>('[data-range]')) {
      button.classList.toggle('is-active', button.dataset.range === view.range);
    }
    const days = visibleDays();
    const format = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    rangeLabel.textContent = view.range === 'week' ? `${format(days[0])} to ${format(days[6])}` : format(days[0]);
  }

  function renderSummary(): void {
    const list = visibleEntries();
    const raw = totalMs(list);
    const rounded = roundMs(raw, settings);
    const billable = totalMs(list.filter((entry) => entry.billable));
    const amount = totalsByProject(list, projects, settings).reduce((sum, total) => sum + total.amount, 0);

    const parts = [`${formatDuration(rounded, 'compact')} tracked`];
    if (settings.increment) parts.push(`${formatDuration(raw, 'compact')} actual`);
    if (billable !== raw) parts.push(`${formatDuration(roundMs(billable, settings), 'compact')} billable`);
    if (amount > 0) parts.push(`${settings.currency} ${amount.toFixed(2)}`);
    summary.textContent = parts.join(' · ');
  }

  function renderEntries(): void {
    const days = visibleDays();
    entryList.innerHTML = '';
    let shown = 0;

    for (const day of [...days].reverse()) {
      const forDay = entriesForDay(entries, day);
      if (!forDay.length) continue;
      shown += forDay.length;

      const header = document.createElement('div');
      header.className = 'st-dayhead';
      const label = document.createElement('span');
      label.textContent = new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const total = document.createElement('strong');
      total.textContent = formatDuration(roundMs(totalMs(forDay), settings), 'compact');
      header.append(label, total);
      entryList.appendChild(header);

      for (const entry of forDay) {
        const project = projectById(entry.projectId);
        const row = document.createElement('div');
        row.className = 'st-entry';
        if (isRunning(entry)) row.dataset.running = 'true';

        const swatch = document.createElement('span');
        swatch.className = 'st-swatch';
        swatch.style.background = PROJECT_COLORS.find((c) => c.id === project?.color)?.hex ?? 'var(--rule-strong)';

        const description = document.createElement('input');
        description.className = 'st-entry__desc';
        description.value = entry.description;
        description.placeholder = 'What were you doing?';
        description.dataset.editDescription = entry.id;

        const projectSelect = document.createElement('select');
        projectSelect.className = 'st-entry__project';
        projectSelect.dataset.editProject = entry.id;
        projectSelect.innerHTML = '<option value="">No project</option>';
        for (const item of projects) {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = item.name;
          option.selected = item.id === entry.projectId;
          projectSelect.appendChild(option);
        }

        const times = document.createElement('span');
        times.className = 'st-entry__times';
        const startTime = new Date(entry.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        times.textContent = entry.end
          ? `${startTime} to ${new Date(entry.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : `${startTime} to now`;

        const duration = document.createElement('button');
        duration.type = 'button';
        duration.className = 'st-entry__duration';
        duration.dataset.editDuration = entry.id;
        duration.textContent = formatDuration(roundMs(durationMs(entry), settings), 'compact');
        duration.title = 'Click to set the duration by hand';

        const billable = document.createElement('button');
        billable.type = 'button';
        billable.className = 'st-entry__billable';
        billable.dataset.toggleBillable = entry.id;
        billable.textContent = entry.billable ? '$' : '·';
        billable.title = entry.billable ? 'Billable' : 'Not billable';
        billable.setAttribute('aria-pressed', String(entry.billable));

        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'st-icon';
        resume.dataset.resume = entry.id;
        resume.textContent = '▶';
        resume.title = 'Start a new entry like this one';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'st-icon';
        remove.dataset.deleteEntry = entry.id;
        remove.textContent = '×';
        remove.title = 'Delete this entry';

        row.append(swatch, description, projectSelect, times, duration, billable, resume, remove);
        entryList.appendChild(row);
      }
    }

    entryEmpty.hidden = shown > 0;
  }

  function renderProjectTotals(): void {
    const totals = totalsByProject(visibleEntries(), projects, settings);
    projectTotals.innerHTML = '';
    if (!totals.length) return;

    const peak = Math.max(...totals.map((total) => total.roundedMs), 1);
    for (const total of totals) {
      const row = document.createElement('div');
      row.className = 'st-total';
      const name = document.createElement('span');
      name.className = 'st-total__name';
      name.textContent = total.name;
      const bar = document.createElement('div');
      bar.className = 'st-total__bar';
      const fill = document.createElement('span');
      fill.style.width = `${(total.roundedMs / peak) * 100}%`;
      fill.style.background = PROJECT_COLORS.find((c) => c.id === total.color)?.hex ?? 'var(--rule-strong)';
      bar.appendChild(fill);
      const value = document.createElement('span');
      value.className = 'st-total__value';
      value.textContent = total.amount > 0
        ? `${formatDuration(total.roundedMs, 'compact')} · ${settings.currency} ${total.amount.toFixed(2)}`
        : formatDuration(total.roundedMs, 'compact');
      row.append(name, bar, value);
      projectTotals.appendChild(row);
    }
  }

  function renderDayBars(): void {
    const days = view.range === 'week' ? visibleDays() : weekDays(anchorDate(), settings.weekStart);
    const totals = totalsByDay(entries, days);
    const peak = Math.max(...totals.map((total) => total.ms), 1);

    dayBars.innerHTML = '';
    for (const total of totals) {
      const column = document.createElement('button');
      column.type = 'button';
      column.className = 'st-daybar';
      column.dataset.jumpDay = total.day;
      if (total.day === dayOf(anchorDate()) && view.range === 'day') column.dataset.active = 'true';
      column.title = `${total.day}: ${formatDuration(total.ms, 'compact')}`;
      const bar = document.createElement('span');
      bar.style.height = `${Math.max(3, (total.ms / peak) * 100)}%`;
      if (!total.ms) bar.dataset.empty = 'true';
      const label = document.createElement('em');
      label.textContent = new Date(`${total.day}T12:00:00`).toLocaleDateString([], { weekday: 'narrow' });
      column.append(bar, label);
      dayBars.appendChild(column);
    }
  }

  function renderProjects(): void {
    projectList.innerHTML = '';
    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'st-project';
      if (project.archived) row.dataset.archived = 'true';

      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'st-swatch st-swatch--button';
      swatch.style.background = PROJECT_COLORS.find((c) => c.id === project.color)?.hex ?? '#64748b';
      swatch.dataset.cycleColor = project.id;
      swatch.title = 'Change colour';

      const name = document.createElement('input');
      name.className = 'st-project__name';
      name.value = project.name;
      name.dataset.editProjectName = project.id;

      const client = document.createElement('input');
      client.className = 'st-project__client';
      client.value = project.client;
      client.placeholder = 'Client';
      client.dataset.editProjectClient = project.id;

      const rate = document.createElement('input');
      rate.className = 'st-project__rate';
      rate.type = 'number';
      rate.min = '0';
      rate.step = '5';
      rate.value = String(project.rate);
      rate.dataset.editProjectRate = project.id;
      rate.title = `Hourly rate in ${settings.currency}`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'st-icon';
      remove.dataset.deleteProject = project.id;
      remove.textContent = '×';
      remove.title = 'Delete this project';

      row.append(swatch, name, client, rate, remove);
      projectList.appendChild(row);
    }
  }

  function render(): void {
    renderProjectPicker();
    renderRange();
    renderTimer();
    renderSummary();
    renderEntries();
    renderProjectTotals();
    renderDayBars();
    renderProjects();
  }

  // ------------------------------------------------------------------ events
  timerButton.addEventListener('click', () => void toggleTimer());

  descriptionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void toggleTimer(); }
  });

  descriptionInput.addEventListener('input', () => {
    const running = runningEntry(entries);
    if (!running) return;
    const updated = { ...running, description: descriptionInput.value, updatedAt: new Date().toISOString() };
    entries = entries.map((item) => (item.id === running.id ? updated : item));
    void saveEntry(updated);
  });

  projectPicker.addEventListener('change', () => {
    const running = runningEntry(entries);
    if (!running) return;
    const updated = { ...running, projectId: projectPicker.value || null, updatedAt: new Date().toISOString() };
    entries = entries.map((item) => (item.id === running.id ? updated : item));
    void saveEntry(updated);
    render();
  });

  rangeTabs.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-range]');
    if (!target?.dataset.range) return;
    view = { ...view, range: target.dataset.range as ViewPrefs['range'] };
    saveView(view);
    render();
  });

  root.querySelector('#st-prev')?.addEventListener('click', () => shiftRange(-1));
  root.querySelector('#st-next')?.addEventListener('click', () => shiftRange(1));
  root.querySelector('#st-today')?.addEventListener('click', () => { view = { ...view, anchor: null }; saveView(view); render(); });

  function shiftRange(direction: number): void {
    const step = view.range === 'week' ? 7 : 1;
    const current = anchorDate();
    const next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + direction * step);
    view = { ...view, anchor: dayOf(next) };
    saveView(view);
    render();
  }

  dayBars.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-jump-day]');
    if (!target?.dataset.jumpDay) return;
    view = { range: 'day', anchor: target.dataset.jumpDay };
    saveView(view);
    render();
  });

  entryList.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    const id = target.dataset.editDescription;
    if (!id) return;
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const updated = { ...entry, description: target.value, updatedAt: new Date().toISOString() };
    entries = entries.map((item) => (item.id === id ? updated : item));
    void saveEntry(updated);
  });

  entryList.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    const id = target.dataset.editProject;
    if (!id) return;
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const updated = { ...entry, projectId: target.value || null, updatedAt: new Date().toISOString() };
    entries = entries.map((item) => (item.id === id ? updated : item));
    void saveEntry(updated);
    render();
  });

  entryList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-edit-duration], [data-toggle-billable], [data-resume], [data-delete-entry]');
    if (!target) return;

    if (target.dataset.editDuration) {
      const entry = entries.find((item) => item.id === target.dataset.editDuration);
      if (!entry) return;
      if (isRunning(entry)) { toast('Stop the timer before setting a duration by hand.', { kind: 'error' }); return; }
      const answer = window.prompt('Duration, as 1:30 or 90m or 1.5h', formatDuration(durationMs(entry), 'compact'));
      if (answer === null) return;
      const ms = parseDuration(answer);
      if (ms === null || ms < 0) { toast('That is not a duration I can read.', { kind: 'error' }); return; }
      const updated = { ...entry, end: new Date(Date.parse(entry.start) + ms).toISOString(), updatedAt: new Date().toISOString() };
      entries = entries.map((item) => (item.id === entry.id ? updated : item));
      await saveEntry(updated);
      render();
      return;
    }

    if (target.dataset.toggleBillable) {
      const entry = entries.find((item) => item.id === target.dataset.toggleBillable);
      if (!entry) return;
      const updated = { ...entry, billable: !entry.billable, updatedAt: new Date().toISOString() };
      entries = entries.map((item) => (item.id === entry.id ? updated : item));
      await saveEntry(updated);
      render();
      return;
    }

    if (target.dataset.resume) {
      const entry = entries.find((item) => item.id === target.dataset.resume);
      if (!entry) return;
      const running = runningEntry(entries);
      if (running) {
        const stopped = { ...running, end: new Date().toISOString(), updatedAt: new Date().toISOString() };
        entries = entries.map((item) => (item.id === running.id ? stopped : item));
        await saveEntry(stopped);
      }
      const fresh = createEntry(entry.projectId, entry.description);
      fresh.billable = entry.billable;
      fresh.tags = [...entry.tags];
      entries = [...entries, fresh];
      await saveEntry(fresh);
      view = { ...view, anchor: null };
      saveView(view);
      render();
      return;
    }

    if (target.dataset.deleteEntry) {
      const entry = entries.find((item) => item.id === target.dataset.deleteEntry);
      if (!entry) return;
      await deleteEntry(entry.id);
      entries = entries.filter((item) => item.id !== entry.id);
      render();
      toast('Entry deleted.', {
        actionLabel: 'Undo',
        onAction: async () => { await saveEntry(entry); entries = [...entries, entry]; render(); },
      });
    }
  });

  projectList.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    const id = target.dataset.editProjectName ?? target.dataset.editProjectClient ?? target.dataset.editProjectRate;
    if (!id) return;
    const project = projects.find((item) => item.id === id);
    if (!project) return;

    const updated: Project = { ...project, updatedAt: new Date().toISOString() };
    if (target.dataset.editProjectName) updated.name = target.value;
    if (target.dataset.editProjectClient) updated.client = target.value;
    if (target.dataset.editProjectRate) updated.rate = Math.max(0, Number(target.value) || 0);

    projects = projects.map((item) => (item.id === id ? updated : item));
    void saveProject(updated);
    if (target.dataset.editProjectRate) { renderSummary(); renderProjectTotals(); }
  });

  projectList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cycle-color], [data-delete-project]');
    if (!target) return;

    if (target.dataset.cycleColor) {
      const project = projects.find((item) => item.id === target.dataset.cycleColor);
      if (!project) return;
      const index = PROJECT_COLORS.findIndex((color) => color.id === project.color);
      const updated = { ...project, color: PROJECT_COLORS[(index + 1) % PROJECT_COLORS.length].id as ProjectColor, updatedAt: new Date().toISOString() };
      projects = projects.map((item) => (item.id === project.id ? updated : item));
      await saveProject(updated);
      render();
      return;
    }

    if (target.dataset.deleteProject) {
      const project = projects.find((item) => item.id === target.dataset.deleteProject);
      if (!project) return;
      const owned = entries.filter((entry) => entry.projectId === project.id);
      if (!window.confirm(`Delete "${project.name}"? Its ${owned.length} entr${owned.length === 1 ? 'y' : 'ies'} will be kept but unassigned.`)) return;
      await deleteProject(project.id);
      projects = projects.filter((item) => item.id !== project.id);
      const freed = owned.map((entry) => ({ ...entry, projectId: null, updatedAt: new Date().toISOString() }));
      entries = entries.map((entry) => freed.find((item) => item.id === entry.id) ?? entry);
      for (const entry of freed) await saveEntry(entry);
      render();
    }
  });

  root.querySelector('#st-add-project')?.addEventListener('click', async () => {
    const project = createProject('New project', PROJECT_COLORS[projects.length % PROJECT_COLORS.length].id as ProjectColor);
    projects = [...projects, project];
    await saveProject(project);
    render();
    projectList.querySelector<HTMLInputElement>(`[data-edit-project-name="${project.id}"]`)?.select();
  });

  root.querySelector('#st-settings')?.addEventListener('click', () => {
    const answer = window.prompt(
      ['Rounding increment in minutes.', '', ROUNDING_INCREMENTS.map((value) => (value ? `${value}` : '0 for none')).join(', ')].join('\n'),
      String(settings.increment),
    );
    if (answer === null) return;
    const increment = Number(answer);
    if (!(ROUNDING_INCREMENTS as readonly number[]).includes(increment)) { toast('That is not one of the increments.', { kind: 'error' }); return; }

    const mode = window.prompt('Round nearest, up, or down?', settings.mode);
    const currency = window.prompt('Currency code', settings.currency);

    settings = {
      ...settings,
      increment: increment as RoundingIncrement,
      mode: (mode === 'up' || mode === 'down' ? mode : 'nearest') as RoundingMode,
      currency: currency?.trim().slice(0, 4).toUpperCase() || settings.currency,
    };
    saveSettings(settings);
    render();
    toast(increment ? `Rounding to the ${settings.mode} ${increment} minutes.` : 'Rounding off.', { kind: 'good' });
  });

  root.querySelector('#st-export-csv')?.addEventListener('click', () => {
    const list = visibleEntries();
    if (!list.length) { toast('Nothing tracked in this range.', { kind: 'error' }); return; }
    const days = visibleDays();
    downloadFile(`stint-${days[0]}${days.length > 1 ? `-to-${days[days.length - 1]}` : ''}.csv`, entriesToCsv(list, projects, settings), 'text/csv');
    toast('CSV saved.', { kind: 'good' });
  });

  root.querySelector('#st-add-entry')?.addEventListener('click', async () => {
    const day = visibleDays()[visibleDays().length - 1];
    const start = new Date(`${day}T09:00:00`);
    const entry = createEntry(projectPicker.value || null, '');
    entry.start = start.toISOString();
    entry.end = new Date(start.getTime() + 3_600_000).toISOString();
    entries = [...entries, entry];
    await saveEntry(entry);
    render();
    entryList.querySelector<HTMLInputElement>(`[data-edit-description="${entry.id}"]`)?.focus();
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const result = await applyImport(text, mode);
      return `Imported ${result.projects} project${result.projects === 1 ? '' : 's'} and ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}.`;
    },
    onImported: async () => {
      const workspace = await loadWorkspace();
      projects = workspace.projects;
      entries = workspace.entries;
      settings = loadSettings();
      render();
    },
    onClearAll: async () => { await clearAll(); },
    clearWarning: 'This deletes every project and time entry Stint has stored on this device. Export first if you want a copy. Continue?',
  });

  const workspace = await loadWorkspace();
  projects = workspace.projects;
  entries = workspace.entries;
  render();
  startTicking();
}
