import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { zipBlob } from '../../lib/zip';
import { createId } from '../../lib/id';
import { PdfFile, PdfReadError, assemble } from '../../lib/pdf/parse';
import { PdfDocument, jpegImage, rawRgbImage } from '../../lib/pdf/write';
import { chunk, describeSize, formatBytes, formatPageRange, move, outputName, parsePageRange, rotateBy, type Slot } from './model';

type Loaded = { name: string; size: number; file: PdfFile };

export async function mountQuire(root: HTMLElement): Promise<void> {
  let documents: Loaded[] = [];
  let slots: Slot[] = [];
  let previewUrl: string | null = null;
  let dragIndex: number | null = null;

  const dropZone = root.querySelector<HTMLElement>('#qr-drop')!;
  const fileInput = root.querySelector<HTMLInputElement>('#qr-file')!;
  const imageInput = root.querySelector<HTMLInputElement>('#qr-image-file')!;
  const grid = root.querySelector<HTMLElement>('#qr-grid')!;
  const empty = root.querySelector<HTMLElement>('#qr-empty')!;
  const summary = root.querySelector<HTMLElement>('#qr-summary')!;
  const rangeInput = root.querySelector<HTMLInputElement>('#qr-range')!;
  const preview = root.querySelector<HTMLIFrameElement>('#qr-preview')!;
  const previewWrap = root.querySelector<HTMLElement>('#qr-preview-wrap')!;
  const sourceList = root.querySelector<HTMLElement>('#qr-sources')!;

  const selected = () => slots.filter((slot) => slot.selected);

  function render(): void {
    empty.hidden = slots.length > 0;
    grid.innerHTML = '';

    slots.forEach((slot, index) => {
      const source = documents[slot.documentIndex];
      const page = source?.file.pages[slot.pageIndex];
      if (!page) return;

      const card = document.createElement('article');
      card.className = 'qr-page';
      card.dataset.slot = slot.id;
      card.draggable = true;
      if (slot.selected) card.dataset.selected = 'true';

      const thumb = document.createElement('div');
      thumb.className = 'qr-page__thumb';
      // The proportions of the real page, turned by whatever rotation applies.
      const quarter = slot.rotate === 90 || slot.rotate === 270;
      const width = quarter ? page.height : page.width;
      const height = quarter ? page.width : page.height;
      thumb.style.aspectRatio = `${width} / ${height}`;
      const number = document.createElement('span');
      number.className = 'qr-page__number';
      number.textContent = String(index + 1);
      thumb.appendChild(number);
      if (slot.rotate) {
        const badge = document.createElement('em');
        badge.className = 'qr-page__rot';
        badge.textContent = `${slot.rotate}°`;
        thumb.appendChild(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'qr-page__meta';
      meta.textContent = `${source.name} · p${slot.pageIndex + 1} · ${describeSize(page.width, page.height)}`;
      meta.title = meta.textContent;

      const actions = document.createElement('div');
      actions.className = 'qr-page__actions';
      const button = (label: string, title: string, dataset: Record<string, string>) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'qr-page__btn';
        element.textContent = label;
        element.title = title;
        element.setAttribute('aria-label', title);
        for (const [key, value] of Object.entries(dataset)) element.dataset[key] = value;
        return element;
      };
      actions.append(
        button('↺', 'Rotate left', { rotateLeft: slot.id }),
        button('↻', 'Rotate right', { rotateRight: slot.id }),
        button('×', 'Remove this page', { removeSlot: slot.id }),
      );

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'qr-page__select';
      toggle.dataset.toggleSlot = slot.id;
      toggle.setAttribute('aria-pressed', String(slot.selected));
      toggle.setAttribute('aria-label', `Select page ${index + 1}`);

      card.append(toggle, thumb, meta, actions);
      grid.appendChild(card);
    });

    const chosen = selected();
    summary.textContent = slots.length
      ? `${slots.length} page${slots.length === 1 ? '' : 's'} from ${documents.length} file${documents.length === 1 ? '' : 's'} · ${chosen.length} selected`
      : '';
    rangeInput.value = formatPageRange(chosen.map((slot) => slots.indexOf(slot)));

    sourceList.innerHTML = '';
    documents.forEach((document_, index) => {
      const row = document.createElement('div');
      row.className = 'qr-source';
      const name = document.createElement('span');
      name.textContent = document_.name;
      const meta = document.createElement('em');
      meta.textContent = `${document_.file.pageCount} pages · ${formatBytes(document_.size)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'qr-page__btn';
      remove.dataset.removeSource = String(index);
      remove.textContent = '×';
      remove.title = `Remove ${document_.name}`;
      row.append(name, meta, remove);
      sourceList.appendChild(row);
    });
  }

  async function addPdfFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = await PdfFile.open(bytes);
        const documentIndex = documents.length;
        documents.push({ name: file.name, size: file.size, file: parsed });
        for (let page = 0; page < parsed.pageCount; page += 1) {
          slots.push({ id: createId('slot'), documentIndex, pageIndex: page, rotate: parsed.pages[page].rotation, selected: true });
        }
      } catch (error) {
        toast(
          error instanceof PdfReadError ? `${file.name}: ${error.message}` : `${file.name} could not be read as a PDF.`,
          { kind: 'error', duration: 8000 },
        );
      }
    }
    render();
    await refreshPreview();
  }

  /** Turns images into a PDF, one image per page, sized to the image. */
  async function addImages(files: File[]): Promise<void> {
    const doc = new PdfDocument({ title: 'Images' });
    let added = 0;

    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let resource;

        if (file.type === 'image/jpeg') {
          resource = jpegImage(bytes);
        } else {
          // Anything else gets decoded through a canvas into raw pixels.
          const bitmap = await createImageBitmap(file);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no canvas');
          context.drawImage(bitmap, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const rgbBytes = new Uint8Array(canvas.width * canvas.height * 3);
          for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
            rgbBytes[j] = data[i];
            rgbBytes[j + 1] = data[i + 1];
            rgbBytes[j + 2] = data[i + 2];
          }
          resource = await rawRgbImage(rgbBytes, canvas.width, canvas.height);
          bitmap.close();
        }

        // A page the same shape as the image, at 72 points per inch.
        const page = doc.addPage(resource.width, resource.height);
        page.image(resource, 0, 0, resource.width, resource.height);
        added += 1;
      } catch {
        toast(`${file.name} could not be added.`, { kind: 'error' });
      }
    }

    if (!added) return;
    const bytes = await doc.build();
    const parsed = await PdfFile.open(bytes);
    const documentIndex = documents.length;
    documents.push({ name: `${added} image${added === 1 ? '' : 's'}`, size: bytes.length, file: parsed });
    for (let page = 0; page < parsed.pageCount; page += 1) {
      slots.push({ id: createId('slot'), documentIndex, pageIndex: page, rotate: 0, selected: true });
    }
    render();
    await refreshPreview();
    toast(`${added} image${added === 1 ? '' : 's'} added as pages.`, { kind: 'good' });
  }

  async function buildSelected(): Promise<Uint8Array> {
    const chosen = selected();
    if (!chosen.length) throw new PdfReadError('No pages are selected.');
    return assemble(chosen.map((slot) => ({
      file: documents[slot.documentIndex].file,
      pageIndex: slot.pageIndex,
      rotate: slot.rotate,
    })));
  }

  /** Preview uses the browser's own PDF viewer, which costs nothing to use. */
  async function refreshPreview(): Promise<void> {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (!selected().length) { preview.removeAttribute('src'); previewWrap.hidden = true; return; }

    try {
      const bytes = await buildSelected();
      previewUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      preview.src = previewUrl;
      previewWrap.hidden = false;
    } catch {
      previewWrap.hidden = true;
    }
  }

  // ------------------------------------------------------------------ events
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void addPdfFiles([...fileInput.files]);
    fileInput.value = '';
  });

  imageInput.addEventListener('change', () => {
    if (imageInput.files?.length) void addImages([...imageInput.files]);
    imageInput.value = '';
  });

  root.querySelector('#qr-add-images')?.addEventListener('click', () => imageInput.click());

  for (const name of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.dataset.over = 'true'; });
  }
  for (const name of ['dragleave', 'drop'] as const) {
    dropZone.addEventListener(name, () => { delete dropZone.dataset.over; });
  }
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    const pdfs = files.filter((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (pdfs.length) void addPdfFiles(pdfs);
    if (images.length) void addImages(images);
    if (!pdfs.length && !images.length) toast('Drop PDF files, or images to turn into pages.', { kind: 'error' });
  });

  grid.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-toggle-slot], [data-rotate-left], [data-rotate-right], [data-remove-slot]');
    if (!target) return;

    const patch = (id: string, changes: Partial<Slot>) => {
      slots = slots.map((slot) => (slot.id === id ? { ...slot, ...changes } : slot));
    };

    if (target.dataset.toggleSlot) {
      const slot = slots.find((item) => item.id === target.dataset.toggleSlot);
      if (slot) patch(slot.id, { selected: !slot.selected });
    } else if (target.dataset.rotateLeft) {
      const slot = slots.find((item) => item.id === target.dataset.rotateLeft);
      if (slot) patch(slot.id, { rotate: rotateBy(slot.rotate, -90) });
    } else if (target.dataset.rotateRight) {
      const slot = slots.find((item) => item.id === target.dataset.rotateRight);
      if (slot) patch(slot.id, { rotate: rotateBy(slot.rotate, 90) });
    } else if (target.dataset.removeSlot) {
      slots = slots.filter((item) => item.id !== target.dataset.removeSlot);
    }

    render();
    await refreshPreview();
  });

  grid.addEventListener('dragstart', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-slot]');
    if (!card) return;
    dragIndex = slots.findIndex((slot) => slot.id === card.dataset.slot);
    card.dataset.dragging = 'true';
  });

  grid.addEventListener('dragend', () => {
    grid.querySelectorAll('[data-dragging]').forEach((element) => element.removeAttribute('data-dragging'));
    dragIndex = null;
  });

  grid.addEventListener('dragover', (event) => { if (dragIndex !== null) event.preventDefault(); });

  grid.addEventListener('drop', async (event) => {
    if (dragIndex === null) return;
    event.preventDefault();
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-slot]');
    const to = card ? slots.findIndex((slot) => slot.id === card.dataset.slot) : slots.length - 1;
    slots = move(slots, dragIndex, to);
    dragIndex = null;
    render();
    await refreshPreview();
  });

  sourceList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-source]');
    if (!target?.dataset.removeSource) return;
    const index = Number(target.dataset.removeSource);
    slots = slots.filter((slot) => slot.documentIndex !== index)
      .map((slot) => ({ ...slot, documentIndex: slot.documentIndex > index ? slot.documentIndex - 1 : slot.documentIndex }));
    documents = documents.filter((_, position) => position !== index);
    render();
    await refreshPreview();
  });

  rangeInput.addEventListener('change', async () => {
    const wanted = new Set(parsePageRange(rangeInput.value, slots.length));
    slots = slots.map((slot, index) => ({ ...slot, selected: wanted.has(index) }));
    render();
    await refreshPreview();
  });

  root.querySelector('#qr-select-all')?.addEventListener('click', async () => {
    const allSelected = slots.every((slot) => slot.selected);
    slots = slots.map((slot) => ({ ...slot, selected: !allSelected }));
    render();
    await refreshPreview();
  });

  root.querySelector('#qr-reverse')?.addEventListener('click', async () => {
    slots = [...slots].reverse();
    render();
    await refreshPreview();
  });

  root.querySelector('#qr-rotate-all')?.addEventListener('click', async () => {
    slots = slots.map((slot) => (slot.selected ? { ...slot, rotate: rotateBy(slot.rotate, 90) } : slot));
    render();
    await refreshPreview();
  });

  root.querySelector('#qr-save')?.addEventListener('click', async () => {
    try {
      const bytes = await buildSelected();
      const name = outputName(documents[0]?.name ?? 'document', documents.length > 1 ? '-merged' : '-edited');
      downloadBlob(name, new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      toast(`Saved ${selected().length} page${selected().length === 1 ? '' : 's'}.`, { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That could not be saved.', { kind: 'error' });
    }
  });

  root.querySelector('#qr-split')?.addEventListener('click', async () => {
    const chosen = selected();
    if (!chosen.length) { toast('No pages are selected.', { kind: 'error' }); return; }

    const answer = window.prompt('Split into files of how many pages?', '1');
    if (answer === null) return;
    const size = Math.max(1, Math.floor(Number(answer) || 1));

    try {
      const groups = chunk(chosen, size);
      const entries = await Promise.all(groups.map(async (group, index) => ({
        name: outputName(documents[0]?.name ?? 'document', `-${String(index + 1).padStart(2, '0')}`),
        bytes: await assemble(group.map((slot) => ({
          file: documents[slot.documentIndex].file,
          pageIndex: slot.pageIndex,
          rotate: slot.rotate,
        }))),
      })));

      if (entries.length === 1) {
        downloadBlob(entries[0].name, new Blob([entries[0].bytes as BlobPart], { type: 'application/pdf' }));
      } else {
        downloadBlob('quire-split.zip', zipBlob(entries));
      }
      toast(`Split into ${entries.length} file${entries.length === 1 ? '' : 's'}.`, { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That could not be split.', { kind: 'error' });
    }
  });

  root.querySelector('#qr-clear')?.addEventListener('click', async () => {
    documents = [];
    slots = [];
    render();
    await refreshPreview();
  });

  render();
}
