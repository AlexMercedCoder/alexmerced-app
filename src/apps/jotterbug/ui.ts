import { wireDataMenu } from '../../lib/dataMenu';
import { toast } from '../../lib/toast';
import { registerTools } from '../../lib/webmcp';
import { jotterbugTools } from './mcp';
import {
  APP_ID,
  NOTE_COLORS,
  addLabel,
  allLabels,
  checklistProgress,
  countsByShelf,
  createChecklistItem,
  createNote,
  isBlank,
  removeLabel,
  selectNotes,
  switchMode,
  touch,
  type Filters,
  type Note,
  type NoteColor,
  type Shelf,
} from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deleteNote,
  deleteNotes,
  loadNotes,
  loadView,
  saveNote,
  saveView,
  type ViewPrefs,
} from './store';

const SHELF_LABEL: Record<Shelf, string> = { active: 'Notes', archived: 'Archive', trash: 'Trash' };

export async function mountJotterbug(root: HTMLElement): Promise<void> {
  let notes: Note[] = [];
  let view: ViewPrefs = loadView();
  let query = '';
  let openId: string | null = null;

  const board = root.querySelector<HTMLElement>('#jb-board')!;
  const empty = root.querySelector<HTMLElement>('#jb-empty')!;
  const emptyTitle = root.querySelector<HTMLElement>('#jb-empty-title')!;
  const emptyBody = root.querySelector<HTMLElement>('#jb-empty-body')!;
  const search = root.querySelector<HTMLInputElement>('#jb-search')!;
  const shelfTabs = root.querySelector<HTMLElement>('#jb-shelves')!;
  const labelBar = root.querySelector<HTMLElement>('#jb-labels')!;
  const colorBar = root.querySelector<HTMLElement>('#jb-colors')!;
  const layoutToggle = root.querySelector<HTMLButtonElement>('#jb-layout')!;
  const composerTitle = root.querySelector<HTMLInputElement>('#jb-new-title')!;
  const composerBody = root.querySelector<HTMLTextAreaElement>('#jb-new-body')!;
  const composer = root.querySelector<HTMLFormElement>('#jb-composer')!;
  const emptyTrash = root.querySelector<HTMLButtonElement>('#jb-empty-trash')!;

  const filters = (): Filters => ({ shelf: view.shelf, query, label: view.label, color: view.color });

  const byId = (id: string) => notes.find((note) => note.id === id);

  async function persist(note: Note): Promise<void> {
    const index = notes.findIndex((item) => item.id === note.id);
    if (index === -1) notes = [note, ...notes];
    else notes = notes.map((item) => (item.id === note.id ? note : item));
    await saveNote(note);
  }

  async function update(id: string, changes: Partial<Note>, rerender = true): Promise<Note | null> {
    const current = byId(id);
    if (!current) return null;
    const next = touch(current, changes);
    await persist(next);
    if (rerender) render();
    return next;
  }

  function colorStyle(color: NoteColor): string {
    const spec = NOTE_COLORS.find((entry) => entry.id === color) ?? NOTE_COLORS[0];
    return `--note-bg:${spec.swatch};--note-ink:${spec.ink}`;
  }

  function renderShelves(): void {
    const counts = countsByShelf(notes);
    shelfTabs.innerHTML = '';
    (['active', 'archived', 'trash'] as Shelf[]).forEach((shelf) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `jb-tab${view.shelf === shelf ? ' is-active' : ''}`;
      button.dataset.shelf = shelf;
      button.setAttribute('aria-pressed', String(view.shelf === shelf));
      button.innerHTML = `${SHELF_LABEL[shelf]} <span>${counts[shelf]}</span>`;
      shelfTabs.appendChild(button);
    });
    emptyTrash.hidden = view.shelf !== 'trash' || counts.trash === 0;
    composer.hidden = view.shelf !== 'active';
  }

  function renderFilterBars(): void {
    const labels = allLabels(notes);
    labelBar.hidden = labels.length === 0;
    labelBar.innerHTML = '';
    if (labels.length) {
      const heading = document.createElement('span');
      heading.className = 'jb-filter-label';
      heading.textContent = 'Labels';
      labelBar.appendChild(heading);
      for (const label of labels) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.filterLabel = label;
        chip.setAttribute('aria-pressed', String(view.label === label));
        chip.textContent = label;
        labelBar.appendChild(chip);
      }
    }

    colorBar.innerHTML = '';
    const heading = document.createElement('span');
    heading.className = 'jb-filter-label';
    heading.textContent = 'Colour';
    colorBar.appendChild(heading);
    for (const color of NOTE_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = `jb-swatch${view.color === color.id ? ' is-active' : ''}`;
      swatch.dataset.filterColor = color.id;
      swatch.style.background = color.swatch;
      swatch.title = `Show only ${color.label} notes`;
      swatch.setAttribute('aria-label', `Filter by ${color.label}`);
      swatch.setAttribute('aria-pressed', String(view.color === color.id));
      colorBar.appendChild(swatch);
    }
  }

  function noteCard(note: Note): HTMLElement {
    const card = document.createElement('article');
    card.className = 'jb-note';
    card.dataset.noteId = note.id;
    card.setAttribute('style', colorStyle(note.color));
    if (note.pinned) card.dataset.pinned = 'true';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'jb-note__open';
    open.dataset.openNote = note.id;
    open.setAttribute('aria-label', `Open ${note.title || 'untitled note'}`);
    card.appendChild(open);

    if (note.title.trim()) {
      const title = document.createElement('h3');
      title.className = 'jb-note__title';
      title.textContent = note.title;
      card.appendChild(title);
    }

    if (note.mode === 'checklist') {
      const progress = checklistProgress(note);
      const list = document.createElement('ul');
      list.className = 'jb-note__list';
      for (const item of note.items.filter((entry) => entry.text.trim()).slice(0, 8)) {
        const row = document.createElement('li');
        row.className = item.done ? 'is-done' : '';
        const box = document.createElement('button');
        box.type = 'button';
        box.className = 'jb-check';
        box.dataset.toggleItem = `${note.id}:${item.id}`;
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(item.done));
        box.textContent = item.done ? '✓' : '';
        const text = document.createElement('span');
        text.textContent = item.text;
        row.append(box, text);
        list.appendChild(row);
      }
      card.appendChild(list);

      if (progress.total > 0) {
        const bar = document.createElement('div');
        bar.className = 'jb-progress';
        bar.innerHTML = `<span style="width:${Math.round((progress.done / progress.total) * 100)}%"></span>`;
        const caption = document.createElement('span');
        caption.className = 'jb-note__count';
        caption.textContent = `${progress.done} of ${progress.total} done`;
        card.append(bar, caption);
      }

      const hidden = note.items.filter((entry) => entry.text.trim()).length - 8;
      if (hidden > 0) {
        const more = document.createElement('span');
        more.className = 'jb-note__count';
        more.textContent = `+${hidden} more`;
        card.appendChild(more);
      }
    } else if (note.body.trim()) {
      const body = document.createElement('p');
      body.className = 'jb-note__body';
      body.textContent = note.body;
      card.appendChild(body);
    }

    if (note.labels.length) {
      const labels = document.createElement('div');
      labels.className = 'jb-note__labels';
      for (const label of note.labels) {
        const chip = document.createElement('span');
        chip.className = 'jb-note__label';
        chip.textContent = label;
        labels.appendChild(chip);
      }
      card.appendChild(labels);
    }

    const actions = document.createElement('div');
    actions.className = 'jb-note__actions';

    const button = (label: string, title: string, dataset: Record<string, string>) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'jb-note__action';
      element.title = title;
      element.setAttribute('aria-label', title);
      element.textContent = label;
      for (const [key, value] of Object.entries(dataset)) element.dataset[key] = value;
      return element;
    };

    if (note.trashedAt) {
      actions.append(
        button('↩', 'Restore this note', { restoreNote: note.id }),
        button('✕', 'Delete this note forever', { purgeNote: note.id }),
      );
    } else {
      actions.append(
        button(note.pinned ? '★' : '☆', note.pinned ? 'Unpin this note' : 'Pin this note', { pinNote: note.id }),
        button('◑', 'Change colour', { colorNote: note.id }),
        button(note.archived ? '↥' : '↧', note.archived ? 'Move back to notes' : 'Archive this note', { archiveNote: note.id }),
        button('🗑', 'Move to trash', { trashNote: note.id }),
      );
    }

    card.appendChild(actions);
    return card;
  }

  function render(): void {
    renderShelves();
    renderFilterBars();

    const visible = selectNotes(notes, filters());
    board.dataset.layout = view.layout;
    board.innerHTML = '';

    const pinned = visible.filter((note) => note.pinned && view.shelf === 'active');
    const rest = visible.filter((note) => !(note.pinned && view.shelf === 'active'));

    const section = (heading: string, list: Note[]) => {
      if (!list.length) return;
      if (heading) {
        const title = document.createElement('h2');
        title.className = 'jb-section';
        title.textContent = heading;
        board.appendChild(title);
      }
      const grid = document.createElement('div');
      grid.className = 'jb-grid';
      for (const note of list) grid.appendChild(noteCard(note));
      board.appendChild(grid);
    };

    if (pinned.length) {
      section('Pinned', pinned);
      section(rest.length ? 'Everything else' : '', rest);
    } else {
      section('', rest);
    }

    empty.hidden = visible.length > 0;
    if (visible.length === 0) {
      if (query || view.label || view.color) {
        emptyTitle.textContent = 'Nothing matches';
        emptyBody.textContent = 'Try a shorter search, or clear the label and colour filters.';
      } else if (view.shelf === 'trash') {
        emptyTitle.textContent = 'The trash is empty';
        emptyBody.textContent = 'Notes you delete wait here for thirty days before they are removed for good.';
      } else if (view.shelf === 'archived') {
        emptyTitle.textContent = 'Nothing archived';
        emptyBody.textContent = 'Archiving takes a note off the main board without deleting it.';
      } else {
        emptyTitle.textContent = 'No notes yet';
        emptyBody.textContent = 'Write something in the box above. Notes are saved to this browser as you type, and nothing leaves your machine.';
      }
    }

    layoutToggle.textContent = view.layout === 'grid' ? 'List view' : 'Grid view';
  }

  // --------------------------------------------------------------- editor
  const editor = root.querySelector<HTMLDialogElement>('#jb-editor')!;
  const editorTitle = editor.querySelector<HTMLInputElement>('#jb-editor-title')!;
  const editorBody = editor.querySelector<HTMLTextAreaElement>('#jb-editor-body')!;
  const editorList = editor.querySelector<HTMLElement>('#jb-editor-list')!;
  const editorLabels = editor.querySelector<HTMLElement>('#jb-editor-labels')!;
  const editorLabelInput = editor.querySelector<HTMLInputElement>('#jb-editor-label-input')!;
  const editorColors = editor.querySelector<HTMLElement>('#jb-editor-colors')!;
  const editorMode = editor.querySelector<HTMLButtonElement>('#jb-editor-mode')!;
  const editorMeta = editor.querySelector<HTMLElement>('#jb-editor-meta')!;

  function renderEditor(): void {
    const note = openId ? byId(openId) : null;
    if (!note) return;

    editor.setAttribute('style', colorStyle(note.color));
    editorTitle.value = note.title;
    editorBody.value = note.body;
    editorBody.hidden = note.mode === 'checklist';
    editorList.hidden = note.mode !== 'checklist';
    editorMode.textContent = note.mode === 'checklist' ? 'Turn into text' : 'Turn into a checklist';

    editorMeta.textContent = `Edited ${new Date(note.updatedAt).toLocaleString()}`;

    editorColors.innerHTML = '';
    for (const color of NOTE_COLORS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = `jb-swatch${note.color === color.id ? ' is-active' : ''}`;
      swatch.style.background = color.swatch;
      swatch.dataset.setColor = color.id;
      swatch.title = color.label;
      swatch.setAttribute('aria-label', `Colour this note ${color.label}`);
      editorColors.appendChild(swatch);
    }

    editorLabels.innerHTML = '';
    for (const label of note.labels) {
      const chip = document.createElement('span');
      chip.className = 'jb-editor-label';
      chip.textContent = label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.dropLabel = label;
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove label ${label}`);
      chip.appendChild(remove);
      editorLabels.appendChild(chip);
    }

    if (note.mode === 'checklist') {
      editorList.innerHTML = '';
      note.items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'jb-editor-item';

        const box = document.createElement('button');
        box.type = 'button';
        box.className = 'jb-check';
        box.dataset.toggleItem = `${note.id}:${item.id}`;
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(item.done));
        box.textContent = item.done ? '✓' : '';

        const text = document.createElement('input');
        text.className = 'jb-editor-item__text';
        text.value = item.text;
        text.dataset.itemText = item.id;
        text.placeholder = 'List item';
        if (item.done) text.classList.add('is-done');

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'jb-editor-item__remove';
        remove.dataset.dropItem = item.id;
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove this row');

        row.append(box, text, remove);
        editorList.appendChild(row);

        if (index === note.items.length - 1) {
          text.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void addChecklistRow();
            }
          });
        }
      });
    }
  }

  async function addChecklistRow(): Promise<void> {
    if (!openId) return;
    const note = byId(openId);
    if (!note) return;
    const next = touch(note, { items: [...note.items, createChecklistItem('')] });
    await persist(next);
    renderEditor();
    const inputs = editorList.querySelectorAll<HTMLInputElement>('.jb-editor-item__text');
    inputs[inputs.length - 1]?.focus();
  }

  function openNote(id: string): void {
    openId = id;
    renderEditor();
    editor.showModal();
    editorTitle.focus();
  }

  editor.addEventListener('close', async () => {
    const note = openId ? byId(openId) : null;
    openId = null;
    if (note && isBlank(note) && !note.trashedAt) {
      await deleteNote(note.id);
      notes = notes.filter((item) => item.id !== note.id);
    }
    render();
  });

  editorTitle.addEventListener('input', () => { if (openId) void update(openId, { title: editorTitle.value }, false); });
  editorBody.addEventListener('input', () => { if (openId) void update(openId, { body: editorBody.value }, false); });

  editorMode.addEventListener('click', async () => {
    if (!openId) return;
    const note = byId(openId);
    if (!note) return;
    await persist(switchMode(note, note.mode === 'checklist' ? 'text' : 'checklist'));
    renderEditor();
  });

  editorLabelInput.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !openId) return;
    event.preventDefault();
    const note = byId(openId);
    if (!note) return;
    await persist(addLabel(note, editorLabelInput.value));
    editorLabelInput.value = '';
    renderEditor();
  });

  editor.addEventListener('input', async (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.itemText || !openId) return;
    const note = byId(openId);
    if (!note) return;
    const items = note.items.map((item) => (item.id === target.dataset.itemText ? { ...item, text: target.value } : item));
    await update(openId, { items }, false);
  });

  editor.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-set-color], [data-drop-label], [data-drop-item], [data-add-item], [data-toggle-item], [data-editor-action]');
    if (!target || !openId) return;
    const note = byId(openId);
    if (!note) return;

    if (target.dataset.setColor) { await persist(touch(note, { color: target.dataset.setColor as NoteColor })); renderEditor(); return; }
    if (target.dataset.dropLabel) { await persist(removeLabel(note, target.dataset.dropLabel)); renderEditor(); return; }
    if (target.dataset.dropItem) {
      await persist(touch(note, { items: note.items.filter((item) => item.id !== target.dataset.dropItem) }));
      renderEditor();
      return;
    }
    if (target.dataset.addItem !== undefined) { await addChecklistRow(); return; }
    if (target.dataset.toggleItem) {
      const [, itemId] = target.dataset.toggleItem.split(':');
      await persist(touch(note, { items: note.items.map((item) => (item.id === itemId ? { ...item, done: !item.done } : item)) }));
      renderEditor();
      return;
    }

    const action = target.dataset.editorAction;
    if (action === 'archive') { await persist(touch(note, { archived: !note.archived })); editor.close(); return; }
    if (action === 'trash') { await persist(touch(note, { trashedAt: new Date().toISOString(), pinned: false })); editor.close(); return; }
    if (action === 'copy') {
      const clone = createNote({ ...note, id: undefined as unknown as string, pinned: false });
      const copy = { ...clone, id: createNote().id, title: note.title, body: note.body, items: note.items.map((item) => ({ ...item })) };
      await persist(copy);
      toast('Copied.', { kind: 'good' });
      editor.close();
    }
  });

  // --------------------------------------------------------------- board events
  board.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-open-note], [data-pin-note], [data-archive-note], [data-trash-note], [data-restore-note], [data-purge-note], [data-color-note], [data-toggle-item]');
    if (!target) return;

    if (target.dataset.toggleItem) {
      const [noteId, itemId] = target.dataset.toggleItem.split(':');
      const note = byId(noteId);
      if (!note) return;
      await update(noteId, { items: note.items.map((item) => (item.id === itemId ? { ...item, done: !item.done } : item)) });
      return;
    }

    if (target.dataset.openNote) { openNote(target.dataset.openNote); return; }

    if (target.dataset.pinNote) {
      const note = byId(target.dataset.pinNote);
      if (note) await update(note.id, { pinned: !note.pinned });
      return;
    }

    if (target.dataset.colorNote) {
      const note = byId(target.dataset.colorNote);
      if (!note) return;
      const index = NOTE_COLORS.findIndex((color) => color.id === note.color);
      await update(note.id, { color: NOTE_COLORS[(index + 1) % NOTE_COLORS.length].id });
      return;
    }

    if (target.dataset.archiveNote) {
      const note = byId(target.dataset.archiveNote);
      if (!note) return;
      const wasArchived = note.archived;
      await update(note.id, { archived: !wasArchived, pinned: false });
      toast(wasArchived ? 'Moved back to your notes.' : 'Archived.', {
        actionLabel: 'Undo',
        onAction: () => { void update(note.id, { archived: wasArchived, pinned: note.pinned }); },
      });
      return;
    }

    if (target.dataset.trashNote) {
      const note = byId(target.dataset.trashNote);
      if (!note) return;
      await update(note.id, { trashedAt: new Date().toISOString(), pinned: false });
      toast('Moved to the trash.', {
        actionLabel: 'Undo',
        onAction: () => { void update(note.id, { trashedAt: null, pinned: note.pinned }); },
      });
      return;
    }

    if (target.dataset.restoreNote) {
      await update(target.dataset.restoreNote, { trashedAt: null });
      toast('Restored.', { kind: 'good' });
      return;
    }

    if (target.dataset.purgeNote) {
      const id = target.dataset.purgeNote;
      if (!window.confirm('Delete this note for good? This cannot be undone.')) return;
      await deleteNote(id);
      notes = notes.filter((item) => item.id !== id);
      render();
    }
  });

  // --------------------------------------------------------------- composer
  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const note = createNote({ title: composerTitle.value, body: composerBody.value });
    if (isBlank(note)) { composerTitle.value = ''; composerBody.value = ''; return; }
    await persist(note);
    composerTitle.value = '';
    composerBody.value = '';
    composerBody.style.height = '';
    render();
  });

  composerBody.addEventListener('input', () => {
    composerBody.style.height = 'auto';
    composerBody.style.height = `${Math.min(composerBody.scrollHeight, 260)}px`;
  });

  root.querySelector('#jb-new-checklist')?.addEventListener('click', async () => {
    const note = switchMode(createNote({ title: composerTitle.value, body: composerBody.value }), 'checklist');
    await persist(note);
    composerTitle.value = '';
    composerBody.value = '';
    render();
    openNote(note.id);
  });

  // --------------------------------------------------------------- filters
  search.addEventListener('input', () => { query = search.value; render(); });

  shelfTabs.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-shelf]');
    if (!target?.dataset.shelf) return;
    view = { ...view, shelf: target.dataset.shelf as Shelf };
    saveView(view);
    render();
  });

  labelBar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-filter-label]');
    if (!target?.dataset.filterLabel) return;
    view = { ...view, label: view.label === target.dataset.filterLabel ? null : target.dataset.filterLabel };
    saveView(view);
    render();
  });

  colorBar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-filter-color]');
    if (!target?.dataset.filterColor) return;
    const color = target.dataset.filterColor as NoteColor;
    view = { ...view, color: view.color === color ? null : color };
    saveView(view);
    render();
  });

  layoutToggle.addEventListener('click', () => {
    view = { ...view, layout: view.layout === 'grid' ? 'list' : 'grid' };
    saveView(view);
    render();
  });

  emptyTrash.addEventListener('click', async () => {
    const doomed = notes.filter((note) => note.trashedAt);
    if (!doomed.length) return;
    if (!window.confirm(`Delete ${doomed.length} note${doomed.length === 1 ? '' : 's'} for good? This cannot be undone.`)) return;
    await deleteNotes(doomed.map((note) => note.id));
    notes = notes.filter((note) => !note.trashedAt);
    render();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      event.preventDefault();
      search.focus();
    }
  });

  /**
   * Reloads everything from storage and redraws. Shared by the import
   * flow and by the agent tools, so a change an agent makes shows up on
   * the page rather than sitting invisibly in the database.
   */
  async function refreshFromStore(): Promise<void> { notes = await loadNotes(); render(); }

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `Imported. You now have ${count} ${count === 1 ? 'note' : 'notes'}.`;
    },
    onImported: refreshFromStore,
    onClearAll: async () => { await clearAll(); notes = []; },
    clearWarning: 'This deletes every note Jotterbug has stored on this device, including the archive and trash. Export first if you want a copy. Continue?',
  });

  notes = await loadNotes();
  render();

  // Everything this app can do, offered to an agent on this page.
  registerTools(jotterbugTools(refreshFromStore));
}
