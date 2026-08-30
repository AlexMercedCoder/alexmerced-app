import { wireDataMenu } from '../../lib/dataMenu';
import { toast } from '../../lib/toast';
import { registerTools } from '../../lib/webmcp';
import { siftTools } from './mcp';
import {
  APP_ID,
  FLAGS,
  PATTERN_LIBRARY,
  createSavedPattern,
  explain,
  segment,
  toggleFlag,
  type FlagId,
  type MatchResult,
  type RunOutcome,
  type SavedPattern,
} from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deletePattern,
  loadPatterns,
  loadWorkbench,
  savePattern,
  saveWorkbench,
  type Workbench,
} from './store';

/** How long a pattern gets before we assume it is never coming back. */
const TIMEOUT_MS = 2000;

export async function mountSift(root: HTMLElement): Promise<void> {
  let workbench: Workbench = loadWorkbench();
  let library: SavedPattern[] = [];
  let worker: Worker | null = null;
  let requestId = 0;
  let pending: number | undefined;

  const patternInput = root.querySelector<HTMLInputElement>('#sf-pattern')!;
  const flagsBar = root.querySelector<HTMLElement>('#sf-flags')!;
  const sampleInput = root.querySelector<HTMLTextAreaElement>('#sf-sample')!;
  const replacementInput = root.querySelector<HTMLInputElement>('#sf-replacement')!;
  const status = root.querySelector<HTMLElement>('#sf-status')!;
  const tabsBar = root.querySelector<HTMLElement>('#sf-tabs')!;
  const highlight = root.querySelector<HTMLElement>('#sf-highlight')!;
  const groupsList = root.querySelector<HTMLElement>('#sf-groups')!;
  const replaceOut = root.querySelector<HTMLElement>('#sf-replace-out')!;
  const explainOut = root.querySelector<HTMLElement>('#sf-explain')!;
  const libraryList = root.querySelector<HTMLElement>('#sf-library')!;
  const savedList = root.querySelector<HTMLElement>('#sf-saved')!;
  const savedEmpty = root.querySelector<HTMLElement>('#sf-saved-empty')!;

  function makeWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }

  function ensureWorker(): Worker {
    if (!worker) {
      worker = makeWorker();
      worker.addEventListener('message', (event: MessageEvent) => {
        if (event.data.id !== requestId) return;
        window.clearTimeout(pending);
        show(event.data.outcome as RunOutcome, event.data.replaced as string | { error: string });
      });
    }
    return worker;
  }

  function run(): void {
    saveWorkbench(workbench);
    renderExplain();

    requestId += 1;
    const id = requestId;
    const active = ensureWorker();

    window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      // The pattern is still running, so the only way out is to kill it.
      active.terminate();
      worker = null;
      status.textContent = `That pattern took longer than ${TIMEOUT_MS / 1000} seconds and was stopped. It probably backtracks badly on this input.`;
      status.dataset.state = 'error';
      highlight.textContent = workbench.sample;
      groupsList.innerHTML = '';
    }, TIMEOUT_MS);

    active.postMessage({
      id,
      pattern: workbench.pattern,
      flags: workbench.flags,
      subject: workbench.sample,
      replacement: workbench.replacement,
    });
  }

  function show(outcome: RunOutcome, replaced: string | { error: string }): void {
    if (!outcome.ok) {
      status.textContent = outcome.error;
      status.dataset.state = workbench.pattern ? 'error' : 'idle';
      highlight.textContent = workbench.sample;
      groupsList.innerHTML = '';
      replaceOut.textContent = '';
      return;
    }

    const { matches, truncated, elapsedMs } = outcome;
    status.dataset.state = matches.length ? 'ok' : 'none';
    status.textContent = matches.length === 0
      ? 'No matches in this sample.'
      : `${matches.length}${truncated ? '+' : ''} match${matches.length === 1 ? '' : 'es'} in ${elapsedMs}ms`;

    renderHighlight(matches);
    renderGroups(matches);
    replaceOut.textContent = typeof replaced === 'string' ? replaced : replaced.error;
  }

  function renderHighlight(matches: MatchResult[]): void {
    highlight.innerHTML = '';
    for (const piece of segment(workbench.sample, matches)) {
      if (piece.matchIndex === null) {
        highlight.appendChild(document.createTextNode(piece.text));
      } else {
        const mark = document.createElement('mark');
        mark.className = 'sf-mark';
        mark.dataset.index = String(piece.matchIndex);
        mark.textContent = piece.text;
        highlight.appendChild(mark);
      }
    }
    if (!matches.length) highlight.textContent = workbench.sample;
  }

  function renderGroups(matches: MatchResult[]): void {
    groupsList.innerHTML = '';
    const withGroups = matches.filter((match) => match.groups.length > 0).slice(0, 40);
    if (!withGroups.length) {
      groupsList.innerHTML = matches.length
        ? '<p class="sf-note">This pattern has no capture groups. Wrap part of it in brackets to capture it.</p>'
        : '';
      return;
    }

    withGroups.forEach((match, index) => {
      const row = document.createElement('div');
      row.className = 'sf-group-row';

      const header = document.createElement('strong');
      header.textContent = `Match ${index + 1}: ${truncate(match.value)}`;
      row.appendChild(header);

      const table = document.createElement('dl');
      table.className = 'sf-group-table';
      for (const group of match.groups) {
        const label = document.createElement('dt');
        label.textContent = group.name ? `${group.index}. ${group.name}` : String(group.index);
        const value = document.createElement('dd');
        if (group.value === undefined) {
          value.textContent = 'did not participate';
          value.dataset.empty = 'true';
        } else {
          value.textContent = group.value || '(empty)';
        }
        table.append(label, value);
      }
      row.appendChild(table);
      groupsList.appendChild(row);
    });
  }

  function renderExplain(): void {
    explainOut.innerHTML = '';
    const parts = explain(workbench.pattern);
    if (!parts.length) {
      explainOut.innerHTML = '<p class="sf-note">Type a pattern and it will be broken down here, piece by piece.</p>';
      return;
    }
    for (const part of parts) {
      const row = document.createElement('div');
      row.className = 'sf-explain-row';
      const token = document.createElement('code');
      token.textContent = part.token;
      const meaning = document.createElement('span');
      meaning.textContent = part.meaning;
      row.append(token, meaning);
      explainOut.appendChild(row);
    }
  }

  function renderFlags(): void {
    flagsBar.innerHTML = '';
    for (const flag of FLAGS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sf-flag';
      button.dataset.flag = flag.id;
      const on = workbench.flags.includes(flag.id);
      button.setAttribute('aria-pressed', String(on));
      if (on) button.classList.add('is-active');
      button.title = flag.hint;
      button.innerHTML = `<code>${flag.id}</code><span>${flag.label}</span>`;
      flagsBar.appendChild(button);
    }
  }

  function renderTabs(): void {
    for (const button of tabsBar.querySelectorAll<HTMLElement>('[data-tab]')) {
      const active = button.dataset.tab === workbench.tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }
    for (const panel of root.querySelectorAll<HTMLElement>('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== workbench.tab;
    }
  }

  function renderLibrary(): void {
    libraryList.innerHTML = '';
    for (const entry of PATTERN_LIBRARY) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sf-preset';
      button.dataset.preset = entry.name;
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const note = document.createElement('span');
      note.textContent = entry.note;
      button.append(name, note);
      libraryList.appendChild(button);
    }
  }

  function renderSaved(): void {
    savedEmpty.hidden = library.length > 0;
    savedList.innerHTML = '';
    for (const saved of library) {
      const row = document.createElement('div');
      row.className = 'sf-saved-row';

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'sf-saved-open';
      open.dataset.loadSaved = saved.id;
      const name = document.createElement('strong');
      name.textContent = saved.name;
      const code = document.createElement('code');
      code.textContent = `/${saved.pattern}/${saved.flags}`;
      open.append(name, code);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sf-saved-remove';
      remove.dataset.deleteSaved = saved.id;
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Delete ${saved.name}`);

      row.append(open, remove);
      savedList.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ events
  patternInput.addEventListener('input', () => { workbench = { ...workbench, pattern: patternInput.value }; run(); });
  sampleInput.addEventListener('input', () => { workbench = { ...workbench, sample: sampleInput.value }; run(); });
  replacementInput.addEventListener('input', () => { workbench = { ...workbench, replacement: replacementInput.value }; run(); });

  flagsBar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-flag]');
    if (!target?.dataset.flag) return;
    workbench = { ...workbench, flags: toggleFlag(workbench.flags, target.dataset.flag as FlagId) };
    renderFlags();
    run();
  });

  tabsBar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!target?.dataset.tab) return;
    workbench = { ...workbench, tab: target.dataset.tab as Workbench['tab'] };
    saveWorkbench(workbench);
    renderTabs();
  });

  libraryList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-preset]');
    if (!target?.dataset.preset) return;
    const entry = PATTERN_LIBRARY.find((item) => item.name === target.dataset.preset);
    if (!entry) return;
    workbench = { ...workbench, pattern: entry.pattern, flags: entry.flags, sample: entry.sample };
    patternInput.value = entry.pattern;
    sampleInput.value = entry.sample;
    renderFlags();
    run();
  });

  savedList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-load-saved], [data-delete-saved]');
    if (!target) return;

    if (target.dataset.loadSaved) {
      const saved = library.find((item) => item.id === target.dataset.loadSaved);
      if (!saved) return;
      workbench = { ...workbench, pattern: saved.pattern, flags: saved.flags, sample: saved.sample, replacement: saved.replacement };
      patternInput.value = saved.pattern;
      sampleInput.value = saved.sample;
      replacementInput.value = saved.replacement;
      renderFlags();
      run();
      return;
    }

    if (target.dataset.deleteSaved) {
      const saved = library.find((item) => item.id === target.dataset.deleteSaved);
      if (!saved) return;
      await deletePattern(saved.id);
      library = await loadPatterns();
      renderSaved();
      toast(`Deleted "${saved.name}".`, {
        actionLabel: 'Undo',
        onAction: async () => { await savePattern(saved); library = await loadPatterns(); renderSaved(); },
      });
    }
  });

  root.querySelector('#sf-save')?.addEventListener('click', async () => {
    if (!workbench.pattern.trim()) { toast('There is no pattern to save.', { kind: 'error' }); return; }
    const name = window.prompt('Name this pattern', 'My pattern');
    if (!name?.trim()) return;
    await savePattern(createSavedPattern(name.trim(), workbench.pattern, workbench.flags, workbench.sample, workbench.replacement));
    library = await loadPatterns();
    renderSaved();
    toast('Saved to this device.', { kind: 'good' });
  });

  root.querySelector('#sf-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`/${workbench.pattern}/${workbench.flags}`);
      toast('Pattern copied.', { kind: 'good' });
    } catch {
      toast('The browser would not let us reach the clipboard.', { kind: 'error' });
    }
  });

  root.querySelector('#sf-copy-result')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(replaceOut.textContent ?? '');
      toast('Replacement result copied.', { kind: 'good' });
    } catch {
      toast('The browser would not let us reach the clipboard.', { kind: 'error' });
    }
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `Imported. You now have ${count} saved pattern${count === 1 ? '' : 's'}.`;
    },
    onImported: async () => {
      workbench = loadWorkbench();
      patternInput.value = workbench.pattern;
      sampleInput.value = workbench.sample;
      replacementInput.value = workbench.replacement;
      library = await loadPatterns();
      renderFlags();
      renderSaved();
      renderTabs();
      run();
    },
    onClearAll: async () => { await clearAll(); library = []; },
    clearWarning: 'This deletes every pattern Sift has saved on this device. Export first if you want a copy. Continue?',
  });

  patternInput.value = workbench.pattern;
  sampleInput.value = workbench.sample;
  replacementInput.value = workbench.replacement;
  library = await loadPatterns();

  renderFlags();
  renderTabs();
  renderLibrary();
  renderSaved();
  run();

  // Everything this app can do, offered to an agent on this page.
  registerTools(siftTools());
}

function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
