import { wireDataMenu } from '../../lib/dataMenu';
import { toast } from '../../lib/toast';
import { createId } from '../../lib/id';
import {
  APP_ID,
  LABEL_COLORS,
  addColumn,
  archiveCard,
  archiveColumn,
  boardStats,
  cardsInColumn,
  checklistProgress,
  createBoard,
  createCard,
  createLabel,
  dueState,
  emptyCardFilters,
  liveCards,
  matchesFilters,
  moveCard,
  moveColumn,
  removeColumn,
  restoreCard,
  sortedColumns,
  stepCard,
  type Board,
  type Card,
  type CardFilters,
  type LabelColor,
} from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deleteBoard,
  deleteCard,
  loadView,
  loadWorkspace,
  saveBoard,
  saveCard,
  saveCards,
  saveView,
  type ViewPrefs,
} from './store';

export async function mountLaneway(root: HTMLElement): Promise<void> {
  let boards: Board[] = [];
  let cards: Card[] = [];
  let view: ViewPrefs = loadView();
  let filters: CardFilters = { ...emptyCardFilters };
  let selectedCardId: string | null = null;
  let openCardId: string | null = null;
  let dragCardId: string | null = null;

  const lanes = root.querySelector<HTMLElement>('#lw-lanes')!;
  const boardPicker = root.querySelector<HTMLSelectElement>('#lw-board-picker')!;
  const statsBar = root.querySelector<HTMLElement>('#lw-stats')!;
  const filterBar = root.querySelector<HTMLElement>('#lw-label-filters')!;
  const search = root.querySelector<HTMLInputElement>('#lw-search')!;
  const dueFilter = root.querySelector<HTMLSelectElement>('#lw-due-filter')!;
  const archivePanel = root.querySelector<HTMLElement>('#lw-archive')!;
  const archiveList = root.querySelector<HTMLElement>('#lw-archive-list')!;
  const archiveToggle = root.querySelector<HTMLButtonElement>('#lw-archive-toggle')!;

  const board = (): Board => boards.find((item) => item.id === view.boardId) ?? boards[0];
  const boardCards = (): Card[] => {
    const columnIds = new Set(board().columns.map((column) => column.id));
    return cards.filter((card) => columnIds.has(card.columnId));
  };
  const cardById = (id: string) => cards.find((card) => card.id === id);

  async function commitCards(next: Card[]): Promise<void> {
    const changed = next.filter((card) => {
      const previous = cards.find((item) => item.id === card.id);
      return !previous || previous !== card;
    });
    cards = next;
    if (changed.length) await saveCards(changed);
  }

  async function commitBoard(next: Board): Promise<void> {
    boards = boards.map((item) => (item.id === next.id ? next : item));
    await saveBoard(next);
  }

  // --------------------------------------------------------------- rendering
  function renderBoardPicker(): void {
    boardPicker.innerHTML = '';
    for (const item of boards) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      option.selected = item.id === board().id;
      boardPicker.appendChild(option);
    }
  }

  function renderStats(): void {
    const stats = boardStats(board(), boardCards());
    const parts = [`${stats.total} ${stats.total === 1 ? 'card' : 'cards'}`];
    if (stats.overdue) parts.push(`${stats.overdue} overdue`);
    if (stats.archived) parts.push(`${stats.archived} archived`);
    const breached = stats.perColumn.filter((column) => column.over);
    if (breached.length) parts.push(`${breached.length} over its limit`);
    statsBar.textContent = parts.join(' · ');
  }

  function renderFilters(): void {
    filterBar.innerHTML = '';
    for (const label of board().labels) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lw-label-chip';
      chip.dataset.filterLabel = label.id;
      const active = filters.labelIds.includes(label.id);
      chip.setAttribute('aria-pressed', String(active));
      if (active) chip.classList.add('is-active');
      chip.style.setProperty('--label-color', LABEL_COLORS.find((c) => c.id === label.color)?.hex ?? '#64748b');
      chip.textContent = label.name;
      filterBar.appendChild(chip);
    }

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'lw-label-chip lw-label-chip--manage';
    manage.dataset.action = 'manage-labels';
    manage.textContent = '+ label';
    filterBar.appendChild(manage);
  }

  function cardElement(card: Card): HTMLElement {
    const element = document.createElement('article');
    element.className = 'lw-card';
    element.dataset.cardId = card.id;
    element.tabIndex = 0;
    element.draggable = true;
    element.setAttribute('role', 'listitem');
    if (card.id === selectedCardId) element.dataset.selected = 'true';

    const labels = card.labelIds
      .map((id) => board().labels.find((label) => label.id === id))
      .filter((label): label is NonNullable<typeof label> => Boolean(label));

    if (labels.length) {
      const strip = document.createElement('div');
      strip.className = 'lw-card__labels';
      for (const label of labels) {
        const dot = document.createElement('span');
        dot.className = 'lw-card__label';
        dot.style.background = LABEL_COLORS.find((c) => c.id === label.color)?.hex ?? '#64748b';
        dot.title = label.name;
        strip.appendChild(dot);
      }
      element.appendChild(strip);
    }

    const title = document.createElement('p');
    title.className = 'lw-card__title';
    title.textContent = card.title;
    element.appendChild(title);

    const progress = checklistProgress(card);
    const meta = document.createElement('div');
    meta.className = 'lw-card__meta';

    if (card.due) {
      const due = document.createElement('span');
      due.className = 'lw-due';
      due.dataset.state = dueState(card);
      due.textContent = new Date(`${card.due}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
      meta.appendChild(due);
    }

    if (progress.total > 0) {
      const checklist = document.createElement('span');
      checklist.className = 'lw-card__checklist';
      if (progress.done === progress.total) checklist.dataset.complete = 'true';
      checklist.textContent = `${progress.done}/${progress.total}`;
      meta.appendChild(checklist);
    }

    if (card.notes.trim()) {
      const note = document.createElement('span');
      note.className = 'lw-card__hasnotes';
      note.textContent = '≡';
      note.title = 'This card has notes';
      meta.appendChild(note);
    }

    if (meta.childElementCount) element.appendChild(meta);

    return element;
  }

  function renderLanes(): void {
    const current = board();
    lanes.innerHTML = '';

    for (const column of sortedColumns(current)) {
      const all = cardsInColumn(cards, column.id);
      const visible = all.filter((card) => matchesFilters(card, filters));
      const over = column.wipLimit !== null && all.length > column.wipLimit;

      const lane = document.createElement('section');
      lane.className = 'lw-lane';
      lane.dataset.columnId = column.id;
      if (over) lane.dataset.over = 'true';

      const head = document.createElement('header');
      head.className = 'lw-lane__head';

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'lw-lane__name';
      name.dataset.renameColumn = column.id;
      name.textContent = column.title;
      name.title = 'Rename this column';

      const count = document.createElement('span');
      count.className = 'lw-lane__count';
      count.textContent = column.wipLimit === null ? String(all.length) : `${all.length}/${column.wipLimit}`;
      if (over) count.title = `This column is over its limit of ${column.wipLimit}`;

      const menu = document.createElement('button');
      menu.type = 'button';
      menu.className = 'lw-lane__menu';
      menu.dataset.columnMenu = column.id;
      menu.textContent = '⋯';
      menu.setAttribute('aria-label', `Options for ${column.title}`);

      head.append(name, count, menu);
      lane.appendChild(head);

      const list = document.createElement('div');
      list.className = 'lw-lane__cards';
      list.dataset.dropColumn = column.id;
      list.setAttribute('role', 'list');
      for (const card of visible) list.appendChild(cardElement(card));

      if (visible.length === 0) {
        const blank = document.createElement('p');
        blank.className = 'lw-lane__blank';
        blank.textContent = all.length ? 'Nothing here matches the filters' : 'Nothing here yet';
        list.appendChild(blank);
      }

      lane.appendChild(list);

      const add = document.createElement('form');
      add.className = 'lw-lane__add';
      add.dataset.addToColumn = column.id;
      add.innerHTML = `
        <input class="lw-lane__input" placeholder="Add a card" aria-label="Add a card to ${column.title}" autocomplete="off" />
      `;
      lane.appendChild(add);

      lanes.appendChild(lane);
    }

    const addLane = document.createElement('form');
    addLane.className = 'lw-lane lw-lane--new';
    addLane.id = 'lw-add-column';
    addLane.innerHTML = `
      <input class="lw-lane__input" placeholder="Add a column" aria-label="Add a column" autocomplete="off" />
    `;
    lanes.appendChild(addLane);
  }

  function renderArchive(): void {
    archivePanel.hidden = !view.showArchive;
    archiveToggle.setAttribute('aria-pressed', String(view.showArchive));
    archiveToggle.textContent = view.showArchive ? 'Hide archive' : 'Archive';
    if (!view.showArchive) return;

    const archived = boardCards().filter((card) => card.archivedAt !== null)
      .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

    archiveList.innerHTML = '';
    if (!archived.length) {
      const blank = document.createElement('p');
      blank.className = 'lw-archive__blank';
      blank.textContent = 'Nothing archived on this board yet. Archiving takes a finished card off the lanes without deleting it.';
      archiveList.appendChild(blank);
      return;
    }

    for (const card of archived) {
      const row = document.createElement('div');
      row.className = 'lw-archive__row';
      const title = document.createElement('span');
      title.textContent = card.title;
      const when = document.createElement('span');
      when.className = 'lw-archive__when';
      when.textContent = new Date(card.archivedAt!).toLocaleDateString();
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn--sm';
      restore.dataset.restoreCard = card.id;
      restore.textContent = 'Restore';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--sm btn--danger';
      remove.dataset.deleteCard = card.id;
      remove.textContent = 'Delete';
      row.append(title, when, restore, remove);
      archiveList.appendChild(row);
    }
  }

  function render(): void {
    renderBoardPicker();
    renderStats();
    renderFilters();
    renderLanes();
    renderArchive();
    root.dataset.compact = view.compact ? 'true' : 'false';
  }

  // --------------------------------------------------------------- card editor
  const editor = root.querySelector<HTMLDialogElement>('#lw-editor')!;
  const editorTitle = editor.querySelector<HTMLTextAreaElement>('#lw-editor-title')!;
  const editorNotes = editor.querySelector<HTMLTextAreaElement>('#lw-editor-notes')!;
  const editorDue = editor.querySelector<HTMLInputElement>('#lw-editor-due')!;
  const editorColumn = editor.querySelector<HTMLSelectElement>('#lw-editor-column')!;
  const editorLabels = editor.querySelector<HTMLElement>('#lw-editor-labels')!;
  const editorChecklist = editor.querySelector<HTMLElement>('#lw-editor-checklist')!;
  const editorProgress = editor.querySelector<HTMLElement>('#lw-editor-progress')!;

  function renderEditor(): void {
    const card = openCardId ? cardById(openCardId) : null;
    if (!card) return;

    editorTitle.value = card.title;
    editorNotes.value = card.notes;
    editorDue.value = card.due ?? '';

    editorColumn.innerHTML = '';
    for (const column of sortedColumns(board())) {
      const option = document.createElement('option');
      option.value = column.id;
      option.textContent = column.title;
      option.selected = column.id === card.columnId;
      editorColumn.appendChild(option);
    }

    editorLabels.innerHTML = '';
    for (const label of board().labels) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lw-label-chip';
      chip.dataset.toggleLabel = label.id;
      const on = card.labelIds.includes(label.id);
      chip.setAttribute('aria-pressed', String(on));
      if (on) chip.classList.add('is-active');
      chip.style.setProperty('--label-color', LABEL_COLORS.find((c) => c.id === label.color)?.hex ?? '#64748b');
      chip.textContent = label.name;
      editorLabels.appendChild(chip);
    }

    const progress = checklistProgress(card);
    editorProgress.hidden = progress.total === 0;
    if (progress.total) {
      editorProgress.innerHTML = `<div class="lw-progress"><span style="width:${Math.round((progress.done / progress.total) * 100)}%"></span></div><span>${progress.done} of ${progress.total} done</span>`;
    }

    editorChecklist.innerHTML = '';
    card.checklist.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'lw-check-row';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.dataset.checkItem = item.id;
      box.setAttribute('aria-label', item.text || 'Checklist item');

      const text = document.createElement('input');
      text.className = 'lw-check-row__text';
      text.value = item.text;
      text.placeholder = 'Step';
      text.dataset.checkText = item.id;
      if (item.done) text.classList.add('is-done');

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lw-check-row__remove';
      remove.dataset.dropCheck = item.id;
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove this step');

      row.append(box, text, remove);
      editorChecklist.appendChild(row);

      if (index === card.checklist.length - 1) {
        text.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); void addCheckRow(); }
        });
      }
    });
  }

  async function updateCard(id: string, changes: Partial<Card>, rerender = true): Promise<void> {
    const card = cardById(id);
    if (!card) return;
    const next: Card = { ...card, ...changes, updatedAt: new Date().toISOString() };
    cards = cards.map((item) => (item.id === id ? next : item));
    await saveCard(next);
    if (rerender) { render(); renderEditor(); }
  }

  async function addCheckRow(): Promise<void> {
    if (!openCardId) return;
    const card = cardById(openCardId);
    if (!card) return;
    await updateCard(card.id, { checklist: [...card.checklist, { id: createId('chk'), text: '', done: false }] });
    const inputs = editorChecklist.querySelectorAll<HTMLInputElement>('.lw-check-row__text');
    inputs[inputs.length - 1]?.focus();
  }

  function openCard(id: string): void {
    openCardId = id;
    renderEditor();
    editor.showModal();
    editorTitle.focus();
  }

  editor.addEventListener('close', () => { openCardId = null; render(); });
  editorTitle.addEventListener('input', () => { if (openCardId) void updateCard(openCardId, { title: editorTitle.value }, false); });
  editorNotes.addEventListener('input', () => { if (openCardId) void updateCard(openCardId, { notes: editorNotes.value }, false); });
  editorDue.addEventListener('change', () => { if (openCardId) void updateCard(openCardId, { due: editorDue.value || null }); });
  editorColumn.addEventListener('change', async () => {
    if (!openCardId) return;
    await commitCards(moveCard(cards, openCardId, { columnId: editorColumn.value, index: 0 }));
    render();
  });

  editor.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.checkText || !openCardId) return;
    const card = cardById(openCardId);
    if (!card) return;
    void updateCard(card.id, {
      checklist: card.checklist.map((item) => (item.id === target.dataset.checkText ? { ...item, text: target.value } : item)),
    }, false);
  });

  editor.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.checkItem || !openCardId) return;
    const card = cardById(openCardId);
    if (!card) return;
    void updateCard(card.id, {
      checklist: card.checklist.map((item) => (item.id === target.dataset.checkItem ? { ...item, done: target.checked } : item)),
    });
  });

  editor.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-toggle-label], [data-drop-check], [data-add-check], [data-editor-action]');
    if (!target || !openCardId) return;
    const card = cardById(openCardId);
    if (!card) return;

    if (target.dataset.toggleLabel) {
      const id = target.dataset.toggleLabel;
      const labelIds = card.labelIds.includes(id) ? card.labelIds.filter((item) => item !== id) : [...card.labelIds, id];
      await updateCard(card.id, { labelIds });
      return;
    }
    if (target.dataset.dropCheck) {
      await updateCard(card.id, { checklist: card.checklist.filter((item) => item.id !== target.dataset.dropCheck) });
      return;
    }
    if (target.dataset.addCheck !== undefined) { await addCheckRow(); return; }

    const action = target.dataset.editorAction;
    if (action === 'archive') {
      await commitCards(archiveCard(cards, card.id));
      editor.close();
      toast('Card archived.', { actionLabel: 'Undo', onAction: () => { void commitCards(restoreCard(cards, card.id)).then(render); } });
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('Delete this card for good? This cannot be undone.')) return;
      await deleteCard(card.id);
      cards = cards.filter((item) => item.id !== card.id);
      editor.close();
    }
  });

  // --------------------------------------------------------------- board events
  lanes.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id], [data-rename-column], [data-column-menu]');
    if (!target) return;

    if (target.dataset.renameColumn) {
      const column = board().columns.find((item) => item.id === target.dataset.renameColumn);
      if (!column) return;
      const name = window.prompt('Column name', column.title);
      if (name === null || !name.trim()) return;
      await commitBoard({
        ...board(),
        columns: board().columns.map((item) => (item.id === column.id ? { ...item, title: name.trim() } : item)),
      });
      render();
      return;
    }

    if (target.dataset.columnMenu) { await columnMenu(target.dataset.columnMenu); return; }

    if (target.dataset.cardId) {
      markSelected(target.dataset.cardId);
      openCard(target.dataset.cardId);
    }
  });

  function markSelected(cardId: string): void {
    selectedCardId = cardId;
    lanes.querySelectorAll('[data-selected]').forEach((element) => element.removeAttribute('data-selected'));
    const element = lanes.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
    if (element) element.dataset.selected = 'true';
  }

  for (const eventName of ['focusin', 'pointerdown'] as const) {
    lanes.addEventListener(eventName, (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
      if (card?.dataset.cardId) markSelected(card.dataset.cardId);
    });
  }

  async function columnMenu(columnId: string): Promise<void> {
    const current = board();
    const column = current.columns.find((item) => item.id === columnId);
    if (!column) return;

    const choice = window.prompt(
      [
        `"${column.title}"`,
        '',
        'Type a number:',
        '1  set or clear the work-in-progress limit',
        '2  move this column left',
        '3  move this column right',
        '4  archive every card in this column',
        '5  delete this column and its cards',
      ].join('\n'),
      '1',
    );

    if (choice === '1') {
      const answer = window.prompt('Work-in-progress limit (leave blank for none)', column.wipLimit === null ? '' : String(column.wipLimit));
      if (answer === null) return;
      const value = answer.trim() === '' ? null : Math.max(1, Math.floor(Number(answer)));
      if (value !== null && !Number.isFinite(value)) { toast('That is not a number.', { kind: 'error' }); return; }
      await commitBoard({ ...current, columns: current.columns.map((item) => (item.id === columnId ? { ...item, wipLimit: value } : item)) });
    } else if (choice === '2' || choice === '3') {
      await commitBoard(moveColumn(current, columnId, choice === '2' ? 'left' : 'right'));
    } else if (choice === '4') {
      const count = cardsInColumn(cards, columnId).length;
      if (!count) { toast('That column is already empty.'); return; }
      if (!window.confirm(`Archive ${count} card${count === 1 ? '' : 's'} from "${column.title}"?`)) return;
      await commitCards(archiveColumn(cards, columnId));
      toast(`Archived ${count} card${count === 1 ? '' : 's'}.`, { kind: 'good' });
    } else if (choice === '5') {
      if (current.columns.length <= 1) { toast('A board needs at least one column.', { kind: 'error' }); return; }
      const count = cardsInColumn(cards, columnId).length;
      if (!window.confirm(`Delete "${column.title}"${count ? ` and its ${count} card${count === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return;
      const result = removeColumn(current, cards, columnId);
      const removedIds = cards.filter((card) => card.columnId === columnId).map((card) => card.id);
      cards = result.cards;
      await Promise.all(removedIds.map((id) => deleteCard(id)));
      await commitBoard(result.board);
    } else {
      return;
    }
    render();
  }

  lanes.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const value = input.value.trim();
    if (!value) return;

    if (form.id === 'lw-add-column') {
      await commitBoard(addColumn(board(), value));
      input.value = '';
      render();
      return;
    }

    const columnId = form.dataset.addToColumn;
    if (!columnId) return;
    const existing = cardsInColumn(cards, columnId);
    const rank = existing.length ? existing[existing.length - 1].rank + 1 : 1;
    const card = createCard(columnId, value, rank);
    cards = [...cards, card];
    await saveCard(card);
    input.value = '';
    render();
    const lane = lanes.querySelector<HTMLElement>(`[data-add-to-column="${columnId}"] input`);
    lane?.focus();
  });

  // --------------------------------------------------------------- drag and drop
  lanes.addEventListener('dragstart', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
    if (!card?.dataset.cardId) return;
    dragCardId = card.dataset.cardId;
    card.dataset.dragging = 'true';
    event.dataTransfer?.setData('text/plain', dragCardId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });

  lanes.addEventListener('dragend', () => {
    lanes.querySelectorAll('[data-dragging]').forEach((element) => element.removeAttribute('data-dragging'));
    lanes.querySelectorAll('[data-dropping]').forEach((element) => element.removeAttribute('data-dropping'));
    dragCardId = null;
  });

  lanes.addEventListener('dragover', (event) => {
    const list = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-column]');
    if (!list || !dragCardId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    lanes.querySelectorAll('[data-dropping]').forEach((element) => element.removeAttribute('data-dropping'));
    list.dataset.dropping = 'true';
  });

  lanes.addEventListener('drop', async (event) => {
    const list = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-column]');
    const id = dragCardId ?? event.dataTransfer?.getData('text/plain') ?? null;
    if (!list?.dataset.dropColumn || !id) return;
    event.preventDefault();

    const siblings = [...list.querySelectorAll<HTMLElement>('[data-card-id]')].filter((element) => element.dataset.cardId !== id);
    let index = siblings.length;
    for (let i = 0; i < siblings.length; i += 1) {
      const box = siblings[i].getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) { index = i; break; }
    }

    await commitCards(moveCard(cards, id, { columnId: list.dataset.dropColumn, index }));
    dragCardId = null;
    render();
  });

  // --------------------------------------------------------------- keyboard
  root.addEventListener('keydown', async (event) => {
    if (editor.open) return;
    const focused = document.activeElement as HTMLElement | null;
    if (focused && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName)) return;

    const targetId = selectedCardId ?? focused?.closest<HTMLElement>('[data-card-id]')?.dataset.cardId ?? null;
    if (!targetId) return;

    if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const direction = event.key.replace('Arrow', '').toLowerCase() as 'left' | 'right' | 'up' | 'down';
      await commitCards(stepCard(board(), cards, targetId, direction));
      render();
      markSelected(targetId);
      lanes.querySelector<HTMLElement>(`[data-card-id="${targetId}"]`)?.focus();
      return;
    }

    if (event.key === 'Enter' && focused?.dataset.cardId) { event.preventDefault(); openCard(focused.dataset.cardId); return; }

    if (event.key === 'e') {
      event.preventDefault();
      await commitCards(archiveCard(cards, targetId));
      render();
      toast('Card archived.', { actionLabel: 'Undo', onAction: () => { void commitCards(restoreCard(cards, targetId)).then(render); } });
    }
  });

  // --------------------------------------------------------------- toolbar
  search.addEventListener('input', () => { filters = { ...filters, query: search.value }; render(); });
  dueFilter.addEventListener('change', () => { filters = { ...filters, due: dueFilter.value as CardFilters['due'] }; render(); });

  filterBar.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-filter-label], [data-action="manage-labels"]');
    if (!target) return;

    if (target.dataset.action === 'manage-labels') {
      const name = window.prompt('Label name');
      if (!name?.trim()) return;
      const colorNames = LABEL_COLORS.map((color, index) => `${index + 1} ${color.label}`).join(', ');
      const answer = window.prompt(`Colour: ${colorNames}`, '1');
      const index = Math.max(1, Math.min(LABEL_COLORS.length, Number(answer) || 1)) - 1;
      await commitBoard({ ...board(), labels: [...board().labels, createLabel(name.trim(), LABEL_COLORS[index].id as LabelColor)] });
      render();
      return;
    }

    const id = target.dataset.filterLabel!;
    filters = {
      ...filters,
      labelIds: filters.labelIds.includes(id) ? filters.labelIds.filter((item) => item !== id) : [...filters.labelIds, id],
    };
    render();
  });

  boardPicker.addEventListener('change', () => {
    view = { ...view, boardId: boardPicker.value };
    saveView(view);
    selectedCardId = null;
    filters = { ...emptyCardFilters };
    search.value = '';
    dueFilter.value = 'any';
    render();
  });

  root.querySelector('#lw-new-board')?.addEventListener('click', async () => {
    const name = window.prompt('Board name', 'New board');
    if (!name?.trim()) return;
    const created = createBoard(name.trim());
    boards = [...boards, created];
    await saveBoard(created);
    view = { ...view, boardId: created.id };
    saveView(view);
    render();
  });

  root.querySelector('#lw-rename-board')?.addEventListener('click', async () => {
    const name = window.prompt('Board name', board().name);
    if (!name?.trim()) return;
    await commitBoard({ ...board(), name: name.trim() });
    render();
  });

  root.querySelector('#lw-delete-board')?.addEventListener('click', async () => {
    if (boards.length === 1) { toast('This is your only board, so it cannot be deleted.', { kind: 'error' }); return; }
    const target = board();
    const owned = boardCards();
    if (!window.confirm(`Delete "${target.name}" and its ${owned.length} card${owned.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await deleteBoard(target.id, owned);
    const ownedIds = new Set(owned.map((card) => card.id));
    boards = boards.filter((item) => item.id !== target.id);
    cards = cards.filter((card) => !ownedIds.has(card.id));
    view = { ...view, boardId: boards[0]?.id ?? null };
    saveView(view);
    render();
  });

  archiveToggle.addEventListener('click', () => {
    view = { ...view, showArchive: !view.showArchive };
    saveView(view);
    render();
  });

  archiveList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-restore-card], [data-delete-card]');
    if (!target) return;
    if (target.dataset.restoreCard) {
      await commitCards(restoreCard(cards, target.dataset.restoreCard));
      render();
      return;
    }
    if (target.dataset.deleteCard) {
      if (!window.confirm('Delete this card for good?')) return;
      await deleteCard(target.dataset.deleteCard);
      cards = cards.filter((card) => card.id !== target.dataset.deleteCard);
      render();
    }
  });

  root.querySelector('#lw-compact')?.addEventListener('click', () => {
    view = { ...view, compact: !view.compact };
    saveView(view);
    render();
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const result = await applyImport(text, mode);
      return `Imported ${result.boards} board${result.boards === 1 ? '' : 's'} and ${result.cards} card${result.cards === 1 ? '' : 's'}.`;
    },
    onImported: async () => {
      const workspace = await loadWorkspace();
      boards = workspace.boards;
      cards = workspace.cards;
      if (!boards.some((item) => item.id === view.boardId)) {
        view = { ...view, boardId: boards[0]?.id ?? null };
        saveView(view);
      }
      render();
    },
    onClearAll: async () => { await clearAll(); },
    clearWarning: 'This deletes every board and card Laneway has stored on this device. Export first if you want a copy. Continue?',
  });

  const workspace = await loadWorkspace();
  boards = workspace.boards;
  cards = workspace.cards;
  if (!boards.some((item) => item.id === view.boardId)) {
    view = { ...view, boardId: boards[0]?.id ?? null };
    saveView(view);
  }
  render();
}
