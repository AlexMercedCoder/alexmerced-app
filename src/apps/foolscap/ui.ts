import { formatBytes } from '../../lib/bytes';
import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { zipBlob } from '../../lib/zip';
import { detectPage, finish, type Finish } from './detect';
import { clampPoint, fullFrame, orderCorners, scalePoints, targetSize, warp, type Point } from './geometry';
import {
  APP_ID, createPage, FINISH_LABELS, PAGE_SIZE_LABELS, type Page, type PageSize, type Settings,
} from './model';
import { toPdf } from './pdf';
import {
  applyImport, buildExport, clearAll, deletePage, loadPages, loadSettings, savePage, savePages,
  saveSettings, storedBytes,
} from './store';

/** The image currently being framed, before it becomes a page. */
type Pending = {
  full: ImageData;
  preview: ImageData;
  /** How much the preview was shrunk, so corners can be scaled back up. */
  scale: number;
  corners: Point[];
  detected: boolean;
};

const PREVIEW_MAX = 900;

export async function mountFoolscap(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const stageEl = $<HTMLDivElement>('fs-stage');
  const frameCanvas = $<HTMLCanvasElement>('fs-frame');
  const overlay = $<HTMLCanvasElement>('fs-overlay');
  const pagesEl = $<HTMLDivElement>('fs-pages');
  const emptyEl = $<HTMLDivElement>('fs-empty');
  const video = $<HTMLVideoElement>('fs-video');
  const cameraWrap = $<HTMLDivElement>('fs-camera');
  const hintEl = $<HTMLParagraphElement>('fs-hint');
  const storageEl = $<HTMLParagraphElement>('fs-storage');

  let pages: Page[] = [];
  let pending: Pending | null = null;
  let settings: Settings = loadSettings();
  let stream: MediaStream | null = null;

  // ------------------------------------------------------------------ framing

  function drawFrame(): void {
    if (!pending) return;
    const { preview } = pending;
    frameCanvas.width = preview.width;
    frameCanvas.height = preview.height;
    frameCanvas.getContext('2d')?.putImageData(preview, 0, 0);

    overlay.width = preview.width;
    overlay.height = preview.height;
    drawOverlay();
  }

  function drawOverlay(): void {
    if (!pending) return;
    const context = overlay.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, overlay.width, overlay.height);

    const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#6b7f2e';
    const [tl, tr, br, bl] = pending.corners;

    // Dim everything outside the quadrilateral so the crop is obvious.
    context.save();
    context.fillStyle = 'rgba(15, 18, 22, 0.55)';
    context.beginPath();
    context.rect(0, 0, overlay.width, overlay.height);
    context.moveTo(tl.x, tl.y);
    context.lineTo(bl.x, bl.y);
    context.lineTo(br.x, br.y);
    context.lineTo(tr.x, tr.y);
    context.closePath();
    context.fill('evenodd');
    context.restore();

    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(tl.x, tl.y);
    for (const point of [tr, br, bl]) context.lineTo(point.x, point.y);
    context.closePath();
    context.stroke();

    for (const point of pending.corners) {
      context.beginPath();
      context.arc(point.x, point.y, 9, 0, Math.PI * 2);
      context.fillStyle = '#fff';
      context.fill();
      context.lineWidth = 3;
      context.stroke();
    }
  }

  // Dragging a corner handle.
  let holding = -1;

  function pointerPosition(event: PointerEvent): Point {
    const box = overlay.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * overlay.width,
      y: ((event.clientY - box.top) / box.height) * overlay.height,
    };
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (!pending) return;
    const position = pointerPosition(event);
    let nearest = -1;
    let best = Infinity;
    pending.corners.forEach((corner, index) => {
      const gap = Math.hypot(corner.x - position.x, corner.y - position.y);
      if (gap < best) { best = gap; nearest = index; }
    });
    // Only grab a handle when the press is genuinely near one.
    if (best > Math.max(24, overlay.width * 0.06)) return;
    holding = nearest;
    overlay.setPointerCapture(event.pointerId);
  });

  overlay.addEventListener('pointermove', (event) => {
    if (!pending || holding < 0) return;
    pending.corners[holding] = clampPoint(pointerPosition(event), overlay.width, overlay.height);
    drawOverlay();
  });

  const release = () => {
    if (!pending || holding < 0) return;
    holding = -1;
    // Re-order after a drag, in case a corner was dragged past its neighbour.
    pending.corners = orderCorners(pending.corners);
    drawOverlay();
  };
  overlay.addEventListener('pointerup', release);
  overlay.addEventListener('pointercancel', release);

  // ------------------------------------------------------------------ loading images

  async function beginFraming(image: ImageData): Promise<void> {
    const scale = Math.min(1, PREVIEW_MAX / Math.max(image.width, image.height));
    const preview = scale < 1 ? await resizeImage(image, Math.round(image.width * scale), Math.round(image.height * scale)) : image;

    const detection = detectPage(preview);
    pending = {
      full: image,
      preview,
      scale: image.width / preview.width,
      corners: detection.corners,
      detected: detection.confident,
    };

    stageEl.hidden = false;
    hintEl.textContent = detection.confident
      ? 'Found the page. Drag any corner to correct it.'
      : 'No page edge was clear enough to find. Drag the corners onto it.';
    hintEl.dataset.state = detection.confident ? 'good' : 'warn';
    drawFrame();
    stopCamera();
  }

  async function addImageFile(file: File): Promise<void> {
    try {
      const bitmap = await createImageBitmap(file);
      const capped = Math.min(1, settings.maxEdge / Math.max(bitmap.width, bitmap.height));
      const image = await bitmapToImageData(
        bitmap,
        Math.max(1, Math.round(bitmap.width * capped)),
        Math.max(1, Math.round(bitmap.height * capped)),
      );
      bitmap.close();
      await beginFraming(image);
    } catch {
      toast(`${file.name} could not be read as an image.`, { kind: 'error' });
    }
  }

  const fileInput = $<HTMLInputElement>('fs-file');
  $<HTMLButtonElement>('fs-add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const [file] = Array.from(fileInput.files ?? []);
    if (file) await addImageFile(file);
    fileInput.value = '';
  });

  const dropZone = $<HTMLDivElement>('fs-drop');
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('is-over'); });
  }
  dropZone.addEventListener('drop', async (event) => {
    const [file] = Array.from((event as DragEvent).dataTransfer?.files ?? []);
    if (file?.type.startsWith('image/')) await addImageFile(file);
  });

  // ------------------------------------------------------------------ camera

  const cameraButton = $<HTMLButtonElement>('fs-camera-start');
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraButton.disabled = true;
    cameraButton.title = 'This browser does not offer camera access.';
  }

  function stopCamera(): void {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.srcObject = null;
    cameraWrap.hidden = true;
    cameraButton.textContent = 'Use the camera';
  }

  cameraButton.addEventListener('click', async () => {
    if (stream) { stopCamera(); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // The rear camera is the one pointed at the document.
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      });
    } catch {
      toast('The camera was not made available. Check the permission for this site.', { kind: 'error' });
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    cameraWrap.hidden = false;
    stageEl.hidden = true;
    cameraButton.textContent = 'Close the camera';
  });

  $<HTMLButtonElement>('fs-shutter').addEventListener('click', async () => {
    if (!stream || !video.videoWidth) return;
    const capped = Math.min(1, settings.maxEdge / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * capped);
    const height = Math.round(video.videoHeight * capped);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    await beginFraming(context.getImageData(0, 0, width, height));
  });

  // ------------------------------------------------------------------ finishing

  $<HTMLButtonElement>('fs-reset-corners').addEventListener('click', () => {
    if (!pending) return;
    pending.corners = fullFrame(pending.preview.width, pending.preview.height);
    drawOverlay();
  });

  $<HTMLButtonElement>('fs-redetect').addEventListener('click', () => {
    if (!pending) return;
    const detection = detectPage(pending.preview);
    pending.corners = detection.corners;
    hintEl.textContent = detection.confident
      ? 'Found the page. Drag any corner to correct it.'
      : 'Still no clear page edge. Drag the corners onto it.';
    hintEl.dataset.state = detection.confident ? 'good' : 'warn';
    drawOverlay();
  });

  $<HTMLButtonElement>('fs-discard').addEventListener('click', () => {
    pending = null;
    stageEl.hidden = true;
  });

  $<HTMLButtonElement>('fs-keep').addEventListener('click', async () => {
    if (!pending) return;
    try {
      const corners = scalePoints(pending.corners, pending.scale);
      const { width, height } = targetSize(corners);
      const straightened = warp(pending.full, corners, width, height);
      const finished = finish(straightened, settings.finish, settings.strength);

      const bytes = await toJpeg(finished, settings.quality);
      const page = createPage(bytes, finished.width, finished.height, settings.finish);
      await savePage(page);
      pages = [...pages, page];

      pending = null;
      stageEl.hidden = true;
      renderPages();
      void refreshStorage();
      toast(`Page ${pages.length} added.`, { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'That page could not be straightened.', { kind: 'error' });
    }
  });

  // ------------------------------------------------------------------ page list

  /**
   * Thumbnail object URLs, held so they can be released when the list is
   * rebuilt. Revoking on the image's load event would leak every lazy
   * thumbnail that was replaced before it ever scrolled into view.
   */
  let thumbnailUrls: string[] = [];

  function renderPages(): void {
    for (const url of thumbnailUrls) URL.revokeObjectURL(url);
    thumbnailUrls = [];
    pagesEl.innerHTML = '';
    pages.forEach((page, index) => {
      const card = document.createElement('div');
      card.className = 'fs-page';

      const image = document.createElement('img');
      image.alt = `Page ${index + 1}`;
      image.loading = 'lazy';
      const url = URL.createObjectURL(new Blob([page.bytes as unknown as BlobPart], { type: 'image/jpeg' }));
      thumbnailUrls.push(url);
      image.src = url;

      const bar = document.createElement('div');
      bar.className = 'fs-page__bar';
      bar.innerHTML = `<span>${index + 1}</span>`;

      const move = (delta: number, label: string) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = delta < 0 ? '↑' : '↓';
        button.title = label;
        button.setAttribute('aria-label', `${label} page ${index + 1}`);
        button.disabled = delta < 0 ? index === 0 : index === pages.length - 1;
        button.addEventListener('click', async () => {
          const target = index + delta;
          [pages[index], pages[target]] = [pages[target], pages[index]];
          // Reordering has to survive a reload, so the timestamps are rewritten
          // to match the new sequence.
          const base = Date.now();
          pages = pages.map((entry, position) => ({ ...entry, createdAt: new Date(base + position).toISOString() }));
          await savePages(pages);
          renderPages();
        });
        return button;
      };

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Remove this page';
      remove.setAttribute('aria-label', `Remove page ${index + 1}`);
      remove.addEventListener('click', async () => {
        await deletePage(page.id);
        pages = pages.filter((entry) => entry.id !== page.id);
        renderPages();
        void refreshStorage();
      });

      bar.append(move(-1, 'Move up'), move(1, 'Move down'), remove);
      card.append(image, bar);
      pagesEl.append(card);
    });

    emptyEl.hidden = pages.length > 0;
    for (const id of ['fs-pdf', 'fs-zip']) $<HTMLButtonElement>(id).disabled = pages.length === 0;
  }

  // ------------------------------------------------------------------ output

  $<HTMLButtonElement>('fs-pdf').addEventListener('click', async () => {
    if (!pages.length) return;
    try {
      const title = $<HTMLInputElement>('fs-title').value.trim() || 'Scan';
      const bytes = await toPdf(pages, settings.pageSize, title);
      downloadBlob(`${safeName(title)}.pdf`, new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }));
      toast(`PDF saved with ${pages.length} page${pages.length === 1 ? '' : 's'}.`, { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The PDF could not be built.', { kind: 'error' });
    }
  });

  $<HTMLButtonElement>('fs-zip').addEventListener('click', async () => {
    if (!pages.length) return;
    const title = $<HTMLInputElement>('fs-title').value.trim() || 'Scan';
    const blob = zipBlob(pages.map((page, index) => ({
      name: `${safeName(title)}-${String(index + 1).padStart(3, '0')}.jpg`,
      bytes: page.bytes,
    })));
    downloadBlob(`${safeName(title)}.zip`, blob);
    toast('Images saved as a ZIP.', { kind: 'good' });
  });

  // ------------------------------------------------------------------ settings

  const finishEl = $<HTMLSelectElement>('fs-finish');
  for (const entry of FINISH_LABELS) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.title = entry.note;
    finishEl.append(option);
  }
  finishEl.addEventListener('change', () => {
    settings = { ...settings, finish: finishEl.value as Finish };
    saveSettings(settings);
    $<HTMLParagraphElement>('fs-finish-note').textContent =
      FINISH_LABELS.find((entry) => entry.id === settings.finish)?.note ?? '';
  });

  const sizeEl = $<HTMLSelectElement>('fs-size');
  for (const entry of PAGE_SIZE_LABELS) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.title = entry.note;
    sizeEl.append(option);
  }
  sizeEl.addEventListener('change', () => {
    settings = { ...settings, pageSize: sizeEl.value as PageSize };
    saveSettings(settings);
  });

  const strengthEl = $<HTMLInputElement>('fs-strength');
  strengthEl.addEventListener('input', () => {
    settings = { ...settings, strength: Number(strengthEl.value) };
    saveSettings(settings);
  });

  const qualityEl = $<HTMLInputElement>('fs-quality');
  qualityEl.addEventListener('input', () => {
    settings = { ...settings, quality: Number(qualityEl.value) };
    saveSettings(settings);
  });

  const maxEdgeEl = $<HTMLSelectElement>('fs-maxedge');
  maxEdgeEl.addEventListener('change', () => {
    settings = { ...settings, maxEdge: Number(maxEdgeEl.value) };
    saveSettings(settings);
  });

  async function refreshStorage(): Promise<void> {
    const total = await storedBytes();
    storageEl.textContent = total > 0 ? `${formatBytes(total)} of scans stored in this browser` : '';
  }

  // ------------------------------------------------------------------ start

  window.addEventListener('pagehide', stopCamera);

  wireDataMenu(root, {
    app: APP_ID,
    buildExport,
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `${count} page${count === 1 ? '' : 's'} in place.`;
    },
    onImported: async () => {
      pages = await loadPages();
      settings = loadSettings();
      applySettingsToControls();
      renderPages();
      void refreshStorage();
    },
    onClearAll: async () => {
      await clearAll();
      pages = [];
      renderPages();
      void refreshStorage();
    },
    clearWarning: 'Every scanned page stored in this browser will be deleted.',
  });

  function applySettingsToControls(): void {
    finishEl.value = settings.finish;
    sizeEl.value = settings.pageSize;
    strengthEl.value = String(settings.strength);
    qualityEl.value = String(settings.quality);
    maxEdgeEl.value = String(settings.maxEdge);
    $<HTMLParagraphElement>('fs-finish-note').textContent =
      FINISH_LABELS.find((entry) => entry.id === settings.finish)?.note ?? '';
  }

  pages = await loadPages();
  applySettingsToControls();
  renderPages();
  void refreshStorage();
}

// ---------------------------------------------------------------------- helpers

function safeName(title: string): string {
  return title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'scan';
}

async function bitmapToImageData(bitmap: ImageBitmap, width: number, height: number): Promise<ImageData> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser would not give a drawing surface.');
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

async function resizeImage(image: ImageData, width: number, height: number): Promise<ImageData> {
  const source = new OffscreenCanvas(image.width, image.height);
  source.getContext('2d')?.putImageData(image, 0, 0);
  const bitmap = await createImageBitmap(source);
  const result = await bitmapToImageData(bitmap, width, height);
  bitmap.close();
  return result;
}

async function toJpeg(image: ImageData, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give a drawing surface.');
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}
