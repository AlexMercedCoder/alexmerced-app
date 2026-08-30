import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob, downloadFile, pickTextFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { createId } from '../../lib/id';
import {
  APP_ID, BLOCK_TYPES, LAYOUTS, THEMES, createBlock, createDeck, createSlide, fromMarkdown,
  move, slideDimensions, slideLabel, toMarkdown, type Block, type BlockType, type Deck,
  type LayoutId, type Slide, type ThemeId,
} from './model';
import { renderSlide, toPdf, toStandaloneHtml } from './render';
import { registerTools } from '../../lib/webmcp';
import { rostrumTools } from './mcp';
import {
  applyImport, buildExport, clearAll, deleteDeck, loadDecks, loadImages, loadView,
  saveDeck, saveImage, saveView, type ViewPrefs,
} from './store';

/** Presenter view talks to the main window over this channel. */
const CHANNEL = 'rostrum-presenter';

export async function mountRostrum(root: HTMLElement): Promise<void> {
  let decks: Deck[] = [];
  let view: ViewPrefs = loadView();
  let imageUrls = new Map<string, string>();
  let imageBytes = new Map<string, Uint8Array>();
  let presenting = false;
  let presenterWindow: Window | null = null;
  let startedAt = 0;
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

  const deckPicker = root.querySelector<HTMLSelectElement>('#rs-deck')!;
  const slideList = root.querySelector<HTMLElement>('#rs-slides')!;
  const stage = root.querySelector<HTMLElement>('#rs-stage')!;
  const canvas = root.querySelector<HTMLElement>('#rs-canvas')!;
  const blockList = root.querySelector<HTMLElement>('#rs-blocks')!;
  const notesInput = root.querySelector<HTMLTextAreaElement>('#rs-notes')!;
  const layoutSelect = root.querySelector<HTMLSelectElement>('#rs-layout')!;
  const themeSelect = root.querySelector<HTMLSelectElement>('#rs-theme')!;
  const ratioSelect = root.querySelector<HTMLSelectElement>('#rs-ratio')!;
  const titleInput = root.querySelector<HTMLInputElement>('#rs-title')!;
  const imageInput = root.querySelector<HTMLInputElement>('#rs-image-file')!;
  const counter = root.querySelector<HTMLElement>('#rs-counter')!;

  const deck = (): Deck => decks.find((item) => item.id === view.deckId) ?? decks[0];
  const slide = (): Slide | undefined => deck()?.slides[view.slideIndex];

  async function loadImageUrls(): Promise<void> {
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls = new Map();
    imageBytes = new Map();
    for (const image of await loadImages()) {
      imageUrls.set(image.id, URL.createObjectURL(image.blob));
      imageBytes.set(image.id, new Uint8Array(await image.blob.arrayBuffer()));
    }
  }

  async function persist(next: Deck): Promise<void> {
    decks = decks.map((item) => (item.id === next.id ? next : item));
    await saveDeck(next);
  }

  function patchSlide(changes: Partial<Slide>): void {
    const current = deck();
    if (!current) return;
    const slides = current.slides.map((item, index) => (index === view.slideIndex ? { ...item, ...changes } : item));
    void persist({ ...current, slides });
  }

  // ------------------------------------------------------------------ render
  function renderDeckPicker(): void {
    deckPicker.innerHTML = '';
    for (const item of decks) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.title} (${item.slides.length})`;
      option.selected = item.id === deck()?.id;
      deckPicker.appendChild(option);
    }
    titleInput.value = deck()?.title ?? '';
    themeSelect.value = deck()?.theme ?? 'ink';
    ratioSelect.value = deck()?.ratio ?? '16:9';
  }

  function renderSlideList(): void {
    const current = deck();
    slideList.innerHTML = '';
    if (!current) return;

    current.slides.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rs-thumb';
      button.dataset.slideIndex = String(index);
      button.draggable = true;
      if (index === view.slideIndex) button.dataset.current = 'true';

      const number = document.createElement('span');
      number.className = 'rs-thumb__num';
      number.textContent = String(index + 1);
      const label = document.createElement('span');
      label.className = 'rs-thumb__label';
      label.textContent = slideLabel(item, index);
      const badge = document.createElement('em');
      badge.className = 'rs-thumb__layout';
      badge.textContent = item.layout;

      button.append(number, label, badge);
      slideList.appendChild(button);
    });

    counter.textContent = `${view.slideIndex + 1} of ${current.slides.length}`;
  }

  function renderStage(): void {
    const current = deck();
    const active = slide();
    if (!current || !active) return;

    const { width, height } = slideDimensions(current.ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    renderSlide(active, current, canvas, imageUrls);
    fitStage();
    layoutSelect.value = active.layout;
    if (document.activeElement !== notesInput) notesInput.value = active.notes;
  }

  function fitStage(): void {
    const current = deck();
    if (!current) return;
    const { width, height } = slideDimensions(current.ratio);
    const box = stage.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height, presenting ? 10 : 1.4);
    canvas.style.transform = `scale(${scale})`;
  }

  function renderBlocks(): void {
    const active = slide();
    blockList.innerHTML = '';
    if (!active) return;

    active.blocks.forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'rs-block';

      const type = document.createElement('select');
      type.className = 'rs-block__type';
      type.dataset.blockType = block.id;
      for (const option of BLOCK_TYPES) {
        const element = document.createElement('option');
        element.value = option.id;
        element.textContent = option.label;
        element.selected = option.id === block.type;
        type.appendChild(element);
      }

      const text = document.createElement('textarea');
      text.className = 'rs-block__text';
      text.rows = block.type === 'code' ? 4 : 1;
      text.value = block.text;
      text.dataset.blockText = block.id;
      text.placeholder = block.type === 'image' ? 'Description, for anyone who cannot see it' : 'Text';
      if (block.type === 'divider') { text.disabled = true; text.placeholder = 'A divider has no text'; }

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'rs-icon';
      up.dataset.moveBlockUp = String(index);
      up.textContent = '↑';
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'rs-icon';
      down.dataset.moveBlockDown = String(index);
      down.textContent = '↓';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'rs-icon';
      remove.dataset.deleteBlock = block.id;
      remove.textContent = '×';

      row.append(type, text, up, down, remove);
      blockList.appendChild(row);
    });
  }

  function render(): void {
    renderDeckPicker();
    renderSlideList();
    renderStage();
    renderBlocks();
    saveView(view);
    broadcast();
  }

  // ------------------------------------------------------------------ presenting
  function broadcast(): void {
    const current = deck();
    const active = slide();
    if (!channel || !current) return;
    channel.postMessage({
      title: current.title,
      index: view.slideIndex,
      total: current.slides.length,
      notes: active?.notes ?? '',
      current: active ? slideLabel(active, view.slideIndex) : '',
      next: current.slides[view.slideIndex + 1] ? slideLabel(current.slides[view.slideIndex + 1], view.slideIndex + 1) : null,
      startedAt,
    });
  }

  function go(delta: number): void {
    const current = deck();
    if (!current) return;
    view = { ...view, slideIndex: Math.max(0, Math.min(current.slides.length - 1, view.slideIndex + delta)) };
    render();
  }

  function setPresenting(on: boolean): void {
    presenting = on;
    root.dataset.presenting = String(on);
    if (on) {
      startedAt = Date.now();
      void stage.requestFullscreen?.().catch(() => undefined);
    } else if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
    }
    fitStage();
    broadcast();
  }

  function openPresenterView(): void {
    presenterWindow = window.open('', 'rostrum-presenter', 'width=900,height=640');
    if (!presenterWindow) { toast('The browser blocked the second window. Allow pop-ups for this site.', { kind: 'error' }); return; }

    presenterWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Presenter view</title>
<style>
  body { margin:0; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background:#14161c; color:#f5f6fa; padding:1.25rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .row { display:grid; grid-template-columns: 1fr 12rem; gap:1.25rem; }
  .now { font-size:1.6rem; font-weight:700; margin:0.5rem 0; }
  .next { color:#8892a8; font-size:1rem; }
  .notes { white-space:pre-wrap; background:#1e2129; border-radius:8px; padding:1rem; margin-top:1rem; min-height:10rem; font-size:1.05rem; }
  .timer { font: 700 2.4rem ui-monospace, monospace; }
  .count { color:#8892a8; font: 0.85rem ui-monospace, monospace; }
  .hint { color:#5c6478; font-size:0.8rem; margin-top:1rem; }
</style></head><body>
<div class="row">
  <div>
    <h1 id="title"></h1>
    <p class="count" id="count"></p>
    <p class="now" id="now"></p>
    <p class="next" id="next"></p>
    <div class="notes" id="notes"></div>
  </div>
  <div>
    <div class="timer" id="timer">00:00</div>
    <p class="count">since you started</p>
    <p class="hint">Keep this window on your own screen. Move slides in the main window, or with the arrow keys there.</p>
  </div>
</div>
<script>
  const channel = new BroadcastChannel('${CHANNEL}');
  let startedAt = Date.now();
  channel.onmessage = (event) => {
    const data = event.data;
    document.getElementById('title').textContent = data.title;
    document.getElementById('count').textContent = 'Slide ' + (data.index + 1) + ' of ' + data.total;
    document.getElementById('now').textContent = data.current;
    document.getElementById('next').textContent = data.next ? 'Next: ' + data.next : 'Last slide';
    document.getElementById('notes').textContent = data.notes || 'No notes on this slide.';
    if (data.startedAt) startedAt = data.startedAt;
  };
  setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    document.getElementById('timer').textContent = minutes + ':' + String(seconds % 60).padStart(2, '0');
  }, 500);
</script></body></html>`);
    presenterWindow.document.close();
    startedAt = Date.now();
    setTimeout(broadcast, 250);
  }

  // ------------------------------------------------------------------ events
  deckPicker.addEventListener('change', () => { view = { deckId: deckPicker.value, slideIndex: 0 }; render(); });
  titleInput.addEventListener('input', () => { const current = deck(); if (current) void persist({ ...current, title: titleInput.value }); });
  themeSelect.addEventListener('change', () => { const current = deck(); if (current) { void persist({ ...current, theme: themeSelect.value as ThemeId }); setTimeout(render, 10); } });
  ratioSelect.addEventListener('change', () => { const current = deck(); if (current) { void persist({ ...current, ratio: ratioSelect.value as Deck['ratio'] }); setTimeout(render, 10); } });
  layoutSelect.addEventListener('change', () => { patchSlide({ layout: layoutSelect.value as LayoutId }); setTimeout(render, 10); });
  notesInput.addEventListener('input', () => { patchSlide({ notes: notesInput.value }); broadcast(); });

  slideList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-slide-index]');
    if (!target?.dataset.slideIndex) return;
    view = { ...view, slideIndex: Number(target.dataset.slideIndex) };
    render();
  });

  let dragFrom: number | null = null;
  slideList.addEventListener('dragstart', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-slide-index]');
    dragFrom = target ? Number(target.dataset.slideIndex) : null;
  });
  slideList.addEventListener('dragover', (event) => { if (dragFrom !== null) event.preventDefault(); });
  slideList.addEventListener('drop', (event) => {
    if (dragFrom === null) return;
    event.preventDefault();
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-slide-index]');
    const to = target ? Number(target.dataset.slideIndex) : decks.length - 1;
    const current = deck();
    if (!current) return;
    void persist({ ...current, slides: move(current.slides, dragFrom, to) });
    view = { ...view, slideIndex: to };
    dragFrom = null;
    setTimeout(render, 10);
  });

  blockList.addEventListener('input', (event) => {
    const target = event.target as HTMLTextAreaElement;
    if (!target.dataset.blockText) return;
    const active = slide();
    if (!active) return;
    patchSlide({ blocks: active.blocks.map((block) => (block.id === target.dataset.blockText ? { ...block, text: target.value } : block)) });
    renderStage();
    renderSlideList();
  });

  blockList.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (!target.dataset.blockType) return;
    const active = slide();
    if (!active) return;
    patchSlide({ blocks: active.blocks.map((block) => (block.id === target.dataset.blockType ? { ...block, type: target.value as BlockType } : block)) });
    setTimeout(render, 10);
  });

  blockList.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-delete-block], [data-move-block-up], [data-move-block-down]');
    if (!target) return;
    const active = slide();
    if (!active) return;

    if (target.dataset.deleteBlock) {
      patchSlide({ blocks: active.blocks.filter((block) => block.id !== target.dataset.deleteBlock) });
    } else if (target.dataset.moveBlockUp) {
      const index = Number(target.dataset.moveBlockUp);
      patchSlide({ blocks: move(active.blocks, index, index - 1) });
    } else if (target.dataset.moveBlockDown) {
      const index = Number(target.dataset.moveBlockDown);
      patchSlide({ blocks: move(active.blocks, index, index + 1) });
    }
    setTimeout(render, 10);
  });

  root.querySelector('#rs-add-block')?.addEventListener('click', () => {
    const active = slide();
    if (!active) return;
    patchSlide({ blocks: [...active.blocks, createBlock('bullet', '')] });
    setTimeout(render, 10);
  });

  root.querySelector('#rs-add-image')?.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file) return;
    const active = slide();
    if (!active) return;

    const id = createId('img');
    await saveImage({ id, blob: file, name: file.name });
    await loadImageUrls();
    patchSlide({ blocks: [...active.blocks, { ...createBlock('image', file.name), imageId: id }] });
    setTimeout(render, 10);
    toast('Image stored with the deck on this device.', { kind: 'good' });
  });

  root.querySelector('#rs-add-slide')?.addEventListener('click', () => {
    const current = deck();
    if (!current) return;
    const slides = [...current.slides];
    slides.splice(view.slideIndex + 1, 0, createSlide('standard'));
    void persist({ ...current, slides });
    view = { ...view, slideIndex: view.slideIndex + 1 };
    setTimeout(render, 10);
  });

  root.querySelector('#rs-duplicate-slide')?.addEventListener('click', () => {
    const current = deck();
    const active = slide();
    if (!current || !active) return;
    const copy: Slide = { ...active, id: createId('slide'), blocks: active.blocks.map((block) => ({ ...block, id: createId('blk') })) };
    const slides = [...current.slides];
    slides.splice(view.slideIndex + 1, 0, copy);
    void persist({ ...current, slides });
    view = { ...view, slideIndex: view.slideIndex + 1 };
    setTimeout(render, 10);
  });

  root.querySelector('#rs-delete-slide')?.addEventListener('click', () => {
    const current = deck();
    if (!current || current.slides.length === 1) { toast('A deck needs at least one slide.', { kind: 'error' }); return; }
    const removed = current.slides[view.slideIndex];
    const slides = current.slides.filter((_, index) => index !== view.slideIndex);
    void persist({ ...current, slides });
    view = { ...view, slideIndex: Math.max(0, view.slideIndex - 1) };
    setTimeout(render, 10);
    toast('Slide deleted.', {
      actionLabel: 'Undo',
      onAction: () => {
        const restored = [...deck().slides];
        restored.splice(view.slideIndex, 0, removed);
        void persist({ ...deck(), slides: restored });
        setTimeout(render, 10);
      },
    });
  });

  root.querySelector('#rs-new-deck')?.addEventListener('click', async () => {
    const title = window.prompt('Deck title', 'New deck');
    if (!title?.trim()) return;
    const created = createDeck(title.trim());
    decks = [created, ...decks];
    await saveDeck(created);
    view = { deckId: created.id, slideIndex: 0 };
    render();
  });

  root.querySelector('#rs-delete-deck')?.addEventListener('click', async () => {
    if (decks.length === 1) { toast('This is your only deck.', { kind: 'error' }); return; }
    const current = deck();
    if (!window.confirm(`Delete "${current.title}" and its ${current.slides.length} slides? This cannot be undone.`)) return;
    await deleteDeck(current.id);
    decks = decks.filter((item) => item.id !== current.id);
    view = { deckId: decks[0]?.id ?? null, slideIndex: 0 };
    render();
  });

  root.querySelector('#rs-present')?.addEventListener('click', () => setPresenting(true));
  root.querySelector('#rs-presenter')?.addEventListener('click', () => openPresenterView());

  root.querySelector('#rs-import-md')?.addEventListener('click', async () => {
    const text = await pickTextFile('text/markdown,.md,text/plain');
    if (text === null) return;
    const imported = fromMarkdown(text, 'Imported deck');
    decks = [imported, ...decks];
    await saveDeck(imported);
    view = { deckId: imported.id, slideIndex: 0 };
    render();
    toast(`Imported ${imported.slides.length} slide${imported.slides.length === 1 ? '' : 's'}.`, { kind: 'good' });
  });

  root.querySelector('#rs-export-md')?.addEventListener('click', () => {
    const current = deck();
    if (!current) return;
    downloadFile(`${slugify(current.title)}.md`, toMarkdown(current), 'text/markdown');
    toast('Markdown saved.', { kind: 'good' });
  });

  root.querySelector('#rs-export-pdf')?.addEventListener('click', async () => {
    const current = deck();
    if (!current) return;
    try {
      const bytes = await toPdf(current, imageBytes);
      downloadBlob(`${slugify(current.title)}.pdf`, new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      toast('PDF saved, one page per slide.', { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The PDF could not be made.', { kind: 'error' });
    }
  });

  root.querySelector('#rs-export-html')?.addEventListener('click', async () => {
    const current = deck();
    if (!current) return;
    // Inline the images so the file works with no network and no other files.
    const inlined = new Map<string, string>();
    for (const image of await loadImages()) {
      inlined.set(image.id, await blobToDataUrl(image.blob));
    }
    downloadFile(`${slugify(current.title)}.html`, toStandaloneHtml(current, inlined), 'text/html');
    toast('One self-contained HTML file saved. It runs anywhere.', { kind: 'good' });
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName);
    if (typing && !presenting) return;

    if (['ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); go(1); return; }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); go(-1); return; }
    if (presenting && event.key === ' ') { event.preventDefault(); go(1); return; }
    if (event.key === 'Escape' && presenting) { setPresenting(false); return; }
    if (typing) return;
    if (event.key === 'f') { event.preventDefault(); setPresenting(!presenting); return; }
    if (event.key === 'p') { event.preventDefault(); openPresenterView(); }
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && presenting) setPresenting(false);
  });
  window.addEventListener('resize', fitStage);

  /**
   * Reloads everything from storage and redraws. Shared by the import
   * flow and by the agent tools, so a change an agent makes shows up on
   * the page rather than sitting invisibly in the database.
   */
  async function refreshFromStore(): Promise<void> {
    decks = await loadDecks();
    if (!decks.some((item) => item.id === view.deckId)) view = { deckId: decks[0]?.id ?? null, slideIndex: 0 };
    await loadImageUrls();
    render();
  }

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `Imported. You now have ${count} deck${count === 1 ? '' : 's'}. Images are stored separately and are not carried in the file.`;
    },
    onImported: refreshFromStore,
    onClearAll: async () => { await clearAll(); },
    clearWarning: 'This deletes every deck and stored image Rostrum holds on this device. Export first if you want a copy. Continue?',
  });

  decks = await loadDecks();
  if (!decks.some((item) => item.id === view.deckId)) view = { deckId: decks[0]?.id ?? null, slideIndex: 0 };
  if (view.slideIndex >= (deck()?.slides.length ?? 1)) view = { ...view, slideIndex: 0 };
  await loadImageUrls();
  render();

  // Everything this app can do, offered to an agent on this page.
  registerTools(rostrumTools(refreshFromStore));
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That image could not be read.'));
    reader.readAsDataURL(blob);
  });
}
