import { wireDataMenu } from '../../lib/dataMenu';
import { downloadFile, pickTextFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import {
  APP_ID,
  GRADES,
  buildQueue,
  cardsToCsv,
  createCard,
  createDeck,
  deckStats,
  forecast,
  isUsable,
  parseCardCsv,
  schedule,
  stateOf,
  type Card,
  type Deck,
  type Grade,
} from './model';
import {
  applyImport,
  buildExport,
  clearAll,
  deleteCard,
  deleteDeck,
  loadView,
  loadWorkspace,
  saveCard,
  saveCards,
  saveDeck,
  saveView,
  type ViewPrefs,
} from './store';

export async function mountRote(root: HTMLElement): Promise<void> {
  let decks: Deck[] = [];
  let cards: Card[] = [];
  let view: ViewPrefs = loadView();
  let queue: Card[] = [];
  let queueIndex = 0;
  let revealed = false;
  let sessionGraded = 0;

  const deckPicker = root.querySelector<HTMLSelectElement>('#rt-deck')!;
  const statsBar = root.querySelector<HTMLElement>('#rt-stats')!;
  const browsePanel = root.querySelector<HTMLElement>('#rt-browse')!;
  const reviewPanel = root.querySelector<HTMLElement>('#rt-review')!;
  const cardList = root.querySelector<HTMLElement>('#rt-cards')!;
  const cardEmpty = root.querySelector<HTMLElement>('#rt-cards-empty')!;
  const forecastBar = root.querySelector<HTMLElement>('#rt-forecast')!;
  const modeToggle = root.querySelector<HTMLButtonElement>('#rt-mode')!;

  const reviewFront = root.querySelector<HTMLElement>('#rt-front')!;
  const reviewBack = root.querySelector<HTMLElement>('#rt-back')!;
  const reviewMeta = root.querySelector<HTMLElement>('#rt-review-meta')!;
  const revealButton = root.querySelector<HTMLButtonElement>('#rt-reveal')!;
  const gradeBar = root.querySelector<HTMLElement>('#rt-grades')!;
  const reviewDone = root.querySelector<HTMLElement>('#rt-done')!;
  const reviewCard = root.querySelector<HTMLElement>('#rt-card')!;

  const deck = (): Deck => decks.find((item) => item.id === view.deckId) ?? decks[0];
  const deckCards = (): Card[] => cards.filter((card) => card.deckId === deck()?.id);

  function renderDecks(): void {
    deckPicker.innerHTML = '';
    for (const item of decks) {
      const option = document.createElement('option');
      option.value = item.id;
      const stats = deckStats(cards, item.id);
      option.textContent = `${item.name} (${stats.due} due)`;
      option.selected = item.id === deck()?.id;
      deckPicker.appendChild(option);
    }
  }

  function renderStats(): void {
    const current = deck();
    if (!current) { statsBar.textContent = ''; return; }
    const stats = deckStats(cards, current.id);
    const parts = [
      `${stats.total} card${stats.total === 1 ? '' : 's'}`,
      `${stats.due} due`,
      `${stats.new} new`,
    ];
    if (stats.retention !== null) parts.push(`${stats.retention}% kept`);
    if (stats.averageEase !== null) parts.push(`ease ${stats.averageEase}`);
    if (stats.suspended) parts.push(`${stats.suspended} suspended`);
    statsBar.textContent = parts.join(' · ');
  }

  function renderForecast(): void {
    const current = deck();
    forecastBar.innerHTML = '';
    if (!current) return;
    const days = forecast(cards, current.id, 14);
    const peak = Math.max(1, ...days.map((day) => day.count));

    for (const day of days) {
      const column = document.createElement('div');
      column.className = 'rt-fc-col';
      column.title = `${day.day}: ${day.count} card${day.count === 1 ? '' : 's'}`;
      const bar = document.createElement('span');
      bar.style.height = `${Math.max(2, (day.count / peak) * 100)}%`;
      if (day.count === 0) bar.dataset.empty = 'true';
      column.appendChild(bar);
      forecastBar.appendChild(column);
    }
  }

  function renderCards(): void {
    const owned = deckCards();
    cardEmpty.hidden = owned.length > 0;
    cardList.innerHTML = '';

    for (const card of owned) {
      const row = document.createElement('div');
      row.className = 'rt-card-row';
      row.dataset.state = stateOf(card);

      const front = document.createElement('input');
      front.className = 'rt-card-input';
      front.value = card.front;
      front.placeholder = 'Front';
      front.dataset.editFront = card.id;

      const back = document.createElement('input');
      back.className = 'rt-card-input';
      back.value = card.back;
      back.placeholder = 'Back';
      back.dataset.editBack = card.id;

      const badge = document.createElement('span');
      badge.className = 'rt-badge';
      badge.textContent = card.due ? `${stateOf(card)} · ${card.due}` : 'new';

      const suspend = document.createElement('button');
      suspend.type = 'button';
      suspend.className = 'rt-icon';
      suspend.dataset.suspend = card.id;
      suspend.textContent = card.suspended ? '▶' : '❚❚';
      suspend.title = card.suspended ? 'Bring this card back' : 'Suspend this card';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'rt-icon';
      remove.dataset.deleteCard = card.id;
      remove.textContent = '×';
      remove.title = 'Delete this card';

      row.append(front, back, badge, suspend, remove);
      cardList.appendChild(row);
    }
  }

  function startReview(): void {
    const current = deck();
    if (!current) return;
    queue = buildQueue(cards, current);
    queueIndex = 0;
    revealed = false;
    sessionGraded = 0;
    renderReview();
  }

  function renderReview(): void {
    const card = queue[queueIndex];
    reviewDone.hidden = Boolean(card);
    reviewCard.hidden = !card;

    if (!card) {
      reviewDone.querySelector('[data-role="summary"]')!.textContent = sessionGraded
        ? `${sessionGraded} card${sessionGraded === 1 ? '' : 's'} reviewed. Come back tomorrow.`
        : 'Nothing is due in this deck right now.';
      return;
    }

    reviewFront.textContent = card.front;
    reviewBack.textContent = card.back;
    reviewBack.hidden = !revealed;
    revealButton.hidden = revealed;
    gradeBar.hidden = !revealed;
    reviewMeta.textContent = `${queueIndex + 1} of ${queue.length} · ${stateOf(card)}${card.due ? ` · was due ${card.due}` : ''}`;
  }

  async function grade(value: Grade): Promise<void> {
    const card = queue[queueIndex];
    if (!card) return;
    const updated = schedule(card, value);
    cards = cards.map((item) => (item.id === card.id ? updated : item));
    await saveCard(updated);
    sessionGraded += 1;
    queueIndex += 1;
    revealed = false;
    renderReview();
    renderStats();
    renderForecast();
    renderDecks();
  }

  function setMode(mode: ViewPrefs['mode']): void {
    view = { ...view, mode };
    saveView(view);
    browsePanel.hidden = mode !== 'browse';
    reviewPanel.hidden = mode !== 'review';
    modeToggle.textContent = mode === 'review' ? 'Browse cards' : 'Start reviewing';
    if (mode === 'review') startReview();
  }

  // ------------------------------------------------------------------ events
  deckPicker.addEventListener('change', () => {
    view = { ...view, deckId: deckPicker.value };
    saveView(view);
    renderStats();
    renderForecast();
    renderCards();
    if (view.mode === 'review') startReview();
  });

  modeToggle.addEventListener('click', () => setMode(view.mode === 'review' ? 'browse' : 'review'));
  revealButton.addEventListener('click', () => { revealed = true; renderReview(); });

  gradeBar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-grade]');
    if (target?.dataset.grade) void grade(Number(target.dataset.grade) as Grade);
  });

  document.addEventListener('keydown', (event) => {
    if (view.mode !== 'review' || reviewPanel.hidden) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName)) return;

    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (!revealed) { revealed = true; renderReview(); }
      return;
    }
    if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
      event.preventDefault();
      void grade(GRADES[Number(event.key) - 1].id as Grade);
    }
  });

  cardList.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    const id = target.dataset.editFront ?? target.dataset.editBack;
    if (!id) return;
    const field = target.dataset.editFront ? 'front' : 'back';
    const card = cards.find((item) => item.id === id);
    if (!card) return;
    const updated = { ...card, [field]: target.value, updatedAt: new Date().toISOString() };
    cards = cards.map((item) => (item.id === id ? updated : item));
    void saveCard(updated);
  });

  cardList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-suspend], [data-delete-card]');
    if (!target) return;

    if (target.dataset.suspend) {
      const card = cards.find((item) => item.id === target.dataset.suspend);
      if (!card) return;
      const updated = { ...card, suspended: !card.suspended, updatedAt: new Date().toISOString() };
      cards = cards.map((item) => (item.id === card.id ? updated : item));
      await saveCard(updated);
      renderCards();
      renderStats();
      return;
    }

    if (target.dataset.deleteCard) {
      const card = cards.find((item) => item.id === target.dataset.deleteCard);
      if (!card) return;
      await deleteCard(card.id);
      cards = cards.filter((item) => item.id !== card.id);
      renderCards();
      renderStats();
      renderForecast();
      toast('Card deleted.', {
        actionLabel: 'Undo',
        onAction: async () => { await saveCard(card); cards = [...cards, card]; renderCards(); renderStats(); },
      });
    }
  });

  root.querySelector('#rt-add-card')?.addEventListener('click', async () => {
    const current = deck();
    if (!current) return;
    const card = createCard(current.id);
    cards = [...cards, card];
    await saveCard(card);
    renderCards();
    cardList.querySelector<HTMLInputElement>(`[data-edit-front="${card.id}"]`)?.focus();
  });

  root.querySelector('#rt-new-deck')?.addEventListener('click', async () => {
    const name = window.prompt('Deck name', 'New deck');
    if (!name?.trim()) return;
    const created = createDeck(name.trim());
    decks = [...decks, created];
    await saveDeck(created);
    view = { ...view, deckId: created.id };
    saveView(view);
    render();
  });

  root.querySelector('#rt-deck-settings')?.addEventListener('click', async () => {
    const current = deck();
    if (!current) return;
    const answer = window.prompt(`New cards per day for "${current.name}"`, String(current.newPerDay));
    if (answer === null) return;
    const value = Math.max(0, Math.floor(Number(answer)));
    if (!Number.isFinite(value)) { toast('That is not a number.', { kind: 'error' }); return; }
    const updated = { ...current, newPerDay: value, updatedAt: new Date().toISOString() };
    decks = decks.map((item) => (item.id === current.id ? updated : item));
    await saveDeck(updated);
    renderStats();
    toast(`Introducing up to ${value} new card${value === 1 ? '' : 's'} a day.`, { kind: 'good' });
  });

  root.querySelector('#rt-delete-deck')?.addEventListener('click', async () => {
    if (decks.length === 1) { toast('This is your only deck, so it cannot be deleted.', { kind: 'error' }); return; }
    const current = deck();
    const owned = deckCards();
    if (!window.confirm(`Delete "${current.name}" and its ${owned.length} card${owned.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    await deleteDeck(current.id, owned);
    const ownedIds = new Set(owned.map((card) => card.id));
    decks = decks.filter((item) => item.id !== current.id);
    cards = cards.filter((card) => !ownedIds.has(card.id));
    view = { ...view, deckId: decks[0]?.id ?? null };
    saveView(view);
    render();
  });

  root.querySelector('#rt-import-csv')?.addEventListener('click', async () => {
    const current = deck();
    if (!current) return;
    const text = await pickTextFile('text/csv,.csv,text/plain');
    if (text === null) return;
    const result = parseCardCsv(text, current.id);
    if (!result.cards.length) { toast('No usable rows in that file. Each row needs a front and a back.', { kind: 'error' }); return; }
    cards = [...cards, ...result.cards];
    await saveCards(result.cards);
    render();
    toast(`Added ${result.cards.length} card${result.cards.length === 1 ? '' : 's'}${result.skipped ? `, skipped ${result.skipped} incomplete row${result.skipped === 1 ? '' : 's'}` : ''}.`, { kind: 'good' });
  });

  root.querySelector('#rt-export-csv')?.addEventListener('click', () => {
    const current = deck();
    const owned = deckCards().filter(isUsable);
    if (!owned.length) { toast('This deck has no complete cards to export.', { kind: 'error' }); return; }
    const name = current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';
    downloadFile(`${name}.csv`, cardsToCsv(owned), 'text/csv');
    toast('CSV saved.', { kind: 'good' });
  });

  function render(): void {
    renderDecks();
    renderStats();
    renderForecast();
    renderCards();
    setMode(view.mode);
  }

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const result = await applyImport(text, mode);
      return `Imported ${result.decks} deck${result.decks === 1 ? '' : 's'} and ${result.cards} card${result.cards === 1 ? '' : 's'}.`;
    },
    onImported: async () => {
      const workspace = await loadWorkspace();
      decks = workspace.decks;
      cards = workspace.cards;
      if (!decks.some((item) => item.id === view.deckId)) {
        view = { ...view, deckId: decks[0]?.id ?? null };
        saveView(view);
      }
      render();
    },
    onClearAll: async () => { await clearAll(); },
    clearWarning: 'This deletes every deck and card Rote has stored on this device, including your review history. Export first if you want a copy. Continue?',
  });

  const workspace = await loadWorkspace();
  decks = workspace.decks;
  cards = workspace.cards;
  if (!decks.some((item) => item.id === view.deckId)) {
    view = { ...view, deckId: decks[0]?.id ?? null };
    saveView(view);
  }
  render();
}
