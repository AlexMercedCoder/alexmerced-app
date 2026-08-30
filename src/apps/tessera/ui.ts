import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob, downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { CameraScanner, describePayload, fitToScan, type Reading } from './reader';
import { scanImage, ScanError, type ScanResult } from './scan';
import { PAYLOADS, buildPayload, payloadByKind, type PayloadKind } from './payloads';
import { QrError, capacityFor, drawToCanvas, encodeQr, toSvg, type EcLevel, type QrCode } from './qr';
import {
  APP_ID,
  applyImport,
  buildExport,
  clearAll,
  createSavedCode,
  deleteCode,
  loadCodes,
  loadStyle,
  saveCode,
  saveStyle,
  type SavedCode,
  type Style,
} from './store';

const EC_HELP: Record<EcLevel, string> = {
  L: 'Recovers about 7% damage. Smallest code.',
  M: 'Recovers about 15%. A good default.',
  Q: 'Recovers about 25%. Good for printed material.',
  H: 'Recovers about 30%. Use when the code will be small, dirty, or partly covered.',
};

export async function mountTessera(root: HTMLElement): Promise<void> {
  let kind: PayloadKind = 'url';
  let values: Record<string, string> = {};
  let style: Style = loadStyle();
  let code: QrCode | null = null;
  let payload = '';
  let library: SavedCode[] = [];

  const kindTabs = root.querySelector<HTMLElement>('#ts-kinds')!;
  const kindBlurb = root.querySelector<HTMLElement>('#ts-kind-blurb')!;
  const form = root.querySelector<HTMLFormElement>('#ts-form')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#ts-canvas')!;
  const preview = root.querySelector<HTMLElement>('#ts-preview')!;
  const problem = root.querySelector<HTMLElement>('#ts-problem')!;
  const facts = root.querySelector<HTMLElement>('#ts-facts')!;
  const payloadView = root.querySelector<HTMLElement>('#ts-payload')!;
  const libraryList = root.querySelector<HTMLElement>('#ts-library')!;
  const libraryEmpty = root.querySelector<HTMLElement>('#ts-library-empty')!;

  const ecSelect = root.querySelector<HTMLSelectElement>('#ts-ec')!;
  const ecHelp = root.querySelector<HTMLElement>('#ts-ec-help')!;
  const scaleInput = root.querySelector<HTMLInputElement>('#ts-scale')!;
  const scaleOut = root.querySelector<HTMLElement>('#ts-scale-out')!;
  const quietInput = root.querySelector<HTMLInputElement>('#ts-quiet')!;
  const quietOut = root.querySelector<HTMLElement>('#ts-quiet-out')!;
  const darkInput = root.querySelector<HTMLInputElement>('#ts-dark')!;
  const lightInput = root.querySelector<HTMLInputElement>('#ts-light')!;
  const transparentInput = root.querySelector<HTMLInputElement>('#ts-transparent')!;
  const versionInput = root.querySelector<HTMLInputElement>('#ts-version')!;
  const versionOut = root.querySelector<HTMLElement>('#ts-version-out')!;

  // ------------------------------------------------------------------ form
  function renderKinds(): void {
    kindTabs.innerHTML = '';
    for (const spec of PAYLOADS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ts-kind${spec.kind === kind ? ' is-active' : ''}`;
      button.dataset.kind = spec.kind;
      button.setAttribute('aria-pressed', String(spec.kind === kind));
      button.textContent = spec.label;
      kindTabs.appendChild(button);
    }
    kindBlurb.textContent = payloadByKind.get(kind)?.blurb ?? '';
  }

  function renderForm(): void {
    const spec = payloadByKind.get(kind);
    form.innerHTML = '';
    if (!spec) return;

    for (const field of spec.fields) {
      const wrapper = document.createElement('label');
      wrapper.className = field.type === 'checkbox' ? 'ts-field ts-field--check' : 'ts-field';

      if (field.type === 'checkbox') {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.field = field.name;
        input.checked = values[field.name] === 'true';
        const text = document.createElement('span');
        text.textContent = field.label;
        wrapper.append(input, text);
      } else {
        const label = document.createElement('span');
        label.className = 'ts-field__label';
        label.textContent = field.label + (field.required ? ' *' : '');
        wrapper.appendChild(label);

        let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (field.type === 'textarea') {
          input = document.createElement('textarea');
          (input as HTMLTextAreaElement).rows = 3;
        } else if (field.type === 'select') {
          input = document.createElement('select');
          for (const option of field.options ?? []) {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            element.selected = values[field.name] === option.value;
            (input as HTMLSelectElement).appendChild(element);
          }
        } else {
          input = document.createElement('input');
          (input as HTMLInputElement).type = field.type;
        }

        input.className = 'field';
        input.dataset.field = field.name;
        if ('placeholder' in input && field.placeholder) input.placeholder = field.placeholder;
        if (field.type !== 'select') (input as HTMLInputElement).value = values[field.name] ?? '';
        wrapper.appendChild(input);

        if (field.help) {
          const help = document.createElement('span');
          help.className = 'ts-field__help';
          help.textContent = field.help;
          wrapper.appendChild(help);
        }
      }

      form.appendChild(wrapper);
    }
  }

  // ------------------------------------------------------------------ render
  function renderStyleControls(): void {
    ecSelect.value = style.ec;
    ecHelp.textContent = EC_HELP[style.ec];
    scaleInput.value = String(style.scale);
    scaleOut.textContent = `${style.scale}px per module`;
    quietInput.value = String(style.quietZone);
    quietOut.textContent = style.quietZone === 0
      ? 'none, scanners may struggle'
      : `${style.quietZone} module${style.quietZone === 1 ? '' : 's'}`;
    darkInput.value = style.dark;
    lightInput.value = style.light;
    transparentInput.checked = style.transparent;
    lightInput.disabled = style.transparent;
    versionInput.value = String(style.minVersion);
    versionOut.textContent = style.minVersion === 1 ? 'smallest that fits' : `at least version ${style.minVersion}`;
  }

  function renderCode(): void {
    problem.hidden = true;
    try {
      payload = buildPayload(kind, values);
    } catch (error) {
      code = null;
      preview.dataset.state = 'empty';
      facts.textContent = '';
      payloadView.textContent = '';
      problem.hidden = false;
      problem.textContent = error instanceof Error ? error.message : 'Fill in the form to make a code.';
      return;
    }

    try {
      code = encodeQr(payload, { ec: style.ec, minVersion: style.minVersion });
    } catch (error) {
      code = null;
      preview.dataset.state = 'error';
      problem.hidden = false;
      problem.textContent = error instanceof QrError ? error.message : 'That could not be turned into a QR code.';
      return;
    }

    preview.dataset.state = 'ready';
    drawToCanvas(code, canvas, style);

    const spare = capacityFor(code.mode, code.version, code.ec) - payload.length;
    facts.innerHTML = '';
    const fact = (label: string, value: string, title?: string) => {
      const item = document.createElement('div');
      item.className = 'ts-fact';
      item.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
      if (title) item.title = title;
      facts.appendChild(item);
    };
    fact('Version', String(code.version), 'Higher versions hold more data and have more modules.');
    fact('Modules', `${code.size} × ${code.size}`);
    fact('Mode', code.mode, 'The most compact encoding your text allows.');
    fact('Correction', code.ec, EC_HELP[code.ec]);
    fact('Mask', String(code.mask), 'Chosen automatically by scoring all eight.');
    fact('Characters', `${payload.length}${spare >= 0 ? ` (${spare} spare)` : ''}`);

    payloadView.textContent = payload;
  }

  function render(): void {
    renderKinds();
    renderStyleControls();
    renderCode();
    renderLibrary();
  }

  // ------------------------------------------------------------------ library
  function renderLibrary(): void {
    libraryEmpty.hidden = library.length > 0;
    libraryList.innerHTML = '';

    for (const saved of library) {
      const row = document.createElement('article');
      row.className = 'ts-saved';

      const thumb = document.createElement('canvas');
      thumb.className = 'ts-saved__thumb';
      thumb.width = 64;
      thumb.height = 64;
      try {
        const thumbCode = encodeQr(saved.payload, { ec: saved.style.ec });
        drawToCanvas(thumbCode, thumb, { ...saved.style, scale: 2, quietZone: 2 });
      } catch {
        /* a saved payload that no longer encodes; the row still lists it */
      }

      const body = document.createElement('div');
      body.className = 'ts-saved__body';
      const name = document.createElement('strong');
      name.textContent = saved.name;
      const meta = document.createElement('span');
      meta.textContent = `${payloadByKind.get(saved.kind)?.label ?? saved.kind} · ${new Date(saved.updatedAt).toLocaleDateString()}`;
      const snippet = document.createElement('span');
      snippet.className = 'ts-saved__snippet';
      snippet.textContent = saved.payload.replace(/\n/g, ' ').slice(0, 70);
      body.append(name, meta, snippet);

      const actions = document.createElement('div');
      actions.className = 'ts-saved__actions';
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'btn btn--sm';
      load.dataset.loadCode = saved.id;
      load.textContent = 'Open';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--sm btn--danger';
      remove.dataset.deleteCode = saved.id;
      remove.textContent = 'Delete';
      actions.append(load, remove);

      row.append(thumb, body, actions);
      libraryList.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ events
  kindTabs.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-kind]');
    if (!target?.dataset.kind) return;
    kind = target.dataset.kind as PayloadKind;
    values = {};
    renderKinds();
    renderForm();
    renderCode();
  });

  form.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.dataset.field) return;
    values = {
      ...values,
      [target.dataset.field]: target.type === 'checkbox' ? String(target.checked) : target.value,
    };
    renderCode();
  });

  form.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (!target.dataset.field) return;
    values = { ...values, [target.dataset.field]: target.value };
    renderForm();
    renderCode();
  });

  function updateStyle(changes: Partial<Style>): void {
    style = { ...style, ...changes };
    saveStyle(style);
    renderStyleControls();
    renderCode();
  }

  ecSelect.addEventListener('change', () => updateStyle({ ec: ecSelect.value as EcLevel }));
  scaleInput.addEventListener('input', () => updateStyle({ scale: Number(scaleInput.value) }));
  quietInput.addEventListener('input', () => updateStyle({ quietZone: Number(quietInput.value) }));
  darkInput.addEventListener('input', () => updateStyle({ dark: darkInput.value }));
  lightInput.addEventListener('input', () => updateStyle({ light: lightInput.value }));
  transparentInput.addEventListener('change', () => updateStyle({ transparent: transparentInput.checked }));
  versionInput.addEventListener('input', () => updateStyle({ minVersion: Number(versionInput.value) }));

  root.querySelector('#ts-swap')?.addEventListener('click', () => {
    updateStyle({ dark: style.light, light: style.dark });
  });

  root.querySelector('#ts-reset-style')?.addEventListener('click', () => {
    updateStyle({ ec: 'M', scale: 8, quietZone: 4, dark: '#0d1020', light: '#ffffff', transparent: false, minVersion: 1 });
    toast('Style reset.');
  });

  root.querySelector('#ts-png')?.addEventListener('click', () => {
    if (!code) { toast('There is no code to download yet.', { kind: 'error' }); return; }
    canvas.toBlob((blob) => {
      if (!blob) { toast('The browser would not produce a PNG.', { kind: 'error' }); return; }
      downloadBlob(`${suggestName()}.png`, blob);
      toast('PNG saved.', { kind: 'good' });
    }, 'image/png');
  });

  root.querySelector('#ts-svg')?.addEventListener('click', () => {
    if (!code) { toast('There is no code to download yet.', { kind: 'error' }); return; }
    downloadFile(`${suggestName()}.svg`, toSvg(code, style), 'image/svg+xml');
    toast('SVG saved.', { kind: 'good' });
  });

  root.querySelector('#ts-copy')?.addEventListener('click', async () => {
    if (!payload) { toast('There is nothing to copy yet.', { kind: 'error' }); return; }
    try {
      await navigator.clipboard.writeText(payload);
      toast('Payload text copied.', { kind: 'good' });
    } catch {
      toast('The browser would not let us reach the clipboard.', { kind: 'error' });
    }
  });

  function suggestName(): string {
    const base = (values.name ?? values.ssid ?? values.summary ?? values.firstName ?? values.url ?? kind)
      .toString()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      .toLowerCase();
    return base || 'qr-code';
  }

  root.querySelector('#ts-save')?.addEventListener('click', async () => {
    if (!code || !payload) { toast('Fill in the form first.', { kind: 'error' }); return; }
    const name = window.prompt('Name this code', suggestName().replace(/-/g, ' '));
    if (!name?.trim()) return;
    const saved = createSavedCode(name.trim(), kind, values, payload, style);
    await saveCode(saved);
    library = await loadCodes();
    renderLibrary();
    toast('Saved to your library on this device.', { kind: 'good' });
  });

  libraryList.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-load-code], [data-delete-code]');
    if (!target) return;

    if (target.dataset.loadCode) {
      const saved = library.find((item) => item.id === target.dataset.loadCode);
      if (!saved) return;
      kind = saved.kind;
      values = { ...saved.values };
      style = { ...saved.style };
      saveStyle(style);
      renderKinds();
      renderForm();
      renderStyleControls();
      renderCode();
      root.querySelector('#ts-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (target.dataset.deleteCode) {
      const id = target.dataset.deleteCode;
      const saved = library.find((item) => item.id === id);
      if (!saved) return;
      await deleteCode(id);
      library = await loadCodes();
      renderLibrary();
      toast(`Deleted "${saved.name}".`, {
        actionLabel: 'Undo',
        onAction: async () => {
          await saveCode(saved);
          library = await loadCodes();
          renderLibrary();
        },
      });
    }
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: async (text, mode) => {
      const count = await applyImport(text, mode);
      return `Imported. Your library now holds ${count} ${count === 1 ? 'code' : 'codes'}.`;
    },
    onImported: async () => {
      style = loadStyle();
      library = await loadCodes();
      render();
    },
    onClearAll: async () => { await clearAll(); library = []; },
    clearWarning: 'This deletes every saved code Tessera holds on this device. Export first if you want a copy. Continue?',
  });

  // Bringing a scanned payload straight into the builder is the natural next
  // step after reading one, so the two halves are not separate tools.
  const setMode = mountReader(root, (text) => {
    kind = 'text';
    values = { text };
    setMode('make');
    renderKinds();
    renderForm();
    render();
  });

  library = await loadCodes();
  renderForm();
  render();
}

// --------------------------------------------------------------------- reading

/**
 * The read half. It is wired separately from the builder because the two share
 * nothing but the page: one turns text into modules, the other turns pixels
 * back into text.
 */
function mountReader(root: HTMLElement, onReuse: (text: string) => void): (mode: 'make' | 'read') => void {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`);

  const readPane = $<HTMLElement>('ts-read');
  const makePane = $<HTMLElement>('ts-make');
  const libraryPane = $<HTMLElement>('ts-library-wrap');
  const modes = $<HTMLDivElement>('ts-modes');
  const status = $<HTMLParagraphElement>('ts-status');
  const resultBox = $<HTMLDivElement>('ts-result');
  const readout = $<HTMLPreElement>('ts-readout');
  const facts = $<HTMLDListElement>('ts-read-facts');
  const safety = $<HTMLParagraphElement>('ts-safety');
  const openLink = $<HTMLAnchorElement>('ts-open');
  const stage = $<HTMLDivElement>('ts-stage');
  const video = $<HTMLVideoElement>('ts-video');
  const shot = $<HTMLCanvasElement>('ts-shot');
  const marks = $<HTMLCanvasElement>('ts-marks');
  const dropZone = $<HTMLDivElement>('ts-drop');
  const fileInput = $<HTMLInputElement>('ts-file');
  const cameraButton = $<HTMLButtonElement>('ts-camera');

  // The read pane is optional markup: if the page does not carry it, the
  // builder still works and the mode switch becomes a no-op.
  if (!readPane || !makePane || !modes || !status || !resultBox || !readout || !stage || !video || !shot || !marks) {
    return () => {};
  }
  // Hoisted function declarations do not keep the narrowing above, so each
  // element is bound to a local that is known to exist.
  const videoEl = video;
  const stageEl = stage;
  const shotEl = shot;
  const marksEl = marks;
  const readPaneEl = readPane;
  const makePaneEl = makePane;
  const modesEl = modes;
  const resultEl = resultBox;
  const readoutEl = readout;

  let lastText = '';

  const setStatus = (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => {
    status.textContent = message;
    status.dataset.state = state;
  };

  function drawMarks(corners: { x: number; y: number }[] | null, sourceWidth: number, sourceHeight: number): void {
    const context = marksEl.getContext('2d');
    if (!context) return;
    marksEl.width = marksEl.clientWidth || 1;
    marksEl.height = marksEl.clientHeight || 1;
    context.clearRect(0, 0, marksEl.width, marksEl.height);
    if (!corners || sourceWidth === 0 || sourceHeight === 0) return;

    // The stage letterboxes its contents, so the overlay has to match that fit.
    const scale = Math.min(marksEl.width / sourceWidth, marksEl.height / sourceHeight);
    const offsetX = (marksEl.width - sourceWidth * scale) / 2;
    const offsetY = (marksEl.height - sourceHeight * scale) / 2;

    context.strokeStyle = getComputedStyle(root).getPropertyValue('--accent').trim() || '#6b4bc4';
    context.lineWidth = 3;
    context.beginPath();
    corners.forEach((point, index) => {
      const x = offsetX + point.x * scale;
      const y = offsetY + point.y * scale;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.stroke();
  }

  function show(result: ScanResult, reading: Reading, sourceWidth: number, sourceHeight: number): void {
    lastText = result.text;
    resultEl.hidden = false;
    readoutEl.textContent = result.text;

    const rows: [string, string][] = [
      ['Contains', reading.kind],
      ['Version', `${result.version}, ${result.version * 4 + 17} modules across`],
      ['Error correction', result.ec],
      ['Mask', String(result.mask)],
      ['Encoding', result.mode],
      ['Characters', String([...result.text].length)],
    ];
    if (result.repaired > 0) rows.push(['Repaired', `${result.repaired} damaged codeword${result.repaired === 1 ? '' : 's'}`]);
    if (result.inverted) rows.push(['Polarity', 'Light on dark']);

    if (facts) {
      facts.innerHTML = rows
        .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join('');
    }

    if (safety) {
      safety.hidden = reading.caution === null;
      safety.textContent = reading.caution ?? '';
    }

    if (openLink) {
      openLink.hidden = reading.link === null;
      if (reading.link) openLink.href = reading.link;
    }

    setStatus(
      result.repaired > 0
        ? `Read it, and repaired ${result.repaired} damaged codeword${result.repaired === 1 ? '' : 's'}.`
        : 'Read it.',
      'good',
    );
    drawMarks(result.corners, sourceWidth, sourceHeight);
  }

  const camera = new CameraScanner(videoEl, {
    onResult: (result, reading) => {
      cameraButton?.replaceChildren('Use the camera');
      show(result, reading, videoEl.videoWidth, videoEl.videoHeight);
    },
    onStatus: setStatus,
    onFrame: (corners) => drawMarks(corners, videoEl.videoWidth, videoEl.videoHeight),
  });

  function readImageData(image: ImageData): void {
    setStatus('Looking for a code.', 'busy');
    try {
      const result = scanImage(image);
      show(result, describePayload(result.text), image.width, image.height);
    } catch (error) {
      resultEl.hidden = true;
      drawMarks(null, 0, 0);
      setStatus(error instanceof ScanError ? error.message : 'That picture could not be read.', 'bad');
    }
  }

  async function readFile(file: File): Promise<void> {
    camera.stop();
    try {
      const bitmap = await createImageBitmap(file);
      const size = fitToScan(bitmap.width, bitmap.height);

      shotEl.width = size.width;
      shotEl.height = size.height;
      const context = shotEl.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('no context');
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      bitmap.close();

      stageEl.hidden = false;
      shotEl.hidden = false;
      videoEl.hidden = true;
      readImageData(context.getImageData(0, 0, size.width, size.height));
    } catch {
      setStatus('That file could not be opened as an image.', 'bad');
    }
  }

  cameraButton?.addEventListener('click', async () => {
    if (camera.running) {
      camera.stop();
      cameraButton.textContent = 'Use the camera';
      setStatus('Camera closed.', 'idle');
      return;
    }
    stageEl.hidden = false;
    shotEl.hidden = true;
    videoEl.hidden = false;
    try {
      await camera.start();
      cameraButton.textContent = 'Stop the camera';
    } catch {
      setStatus('The camera was not made available. Check the permission for this site.', 'bad');
      stageEl.hidden = true;
    }
  });

  $<HTMLButtonElement>('ts-pick')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const [file] = Array.from(fileInput.files ?? []);
    if (file) await readFile(file);
    fileInput.value = '';
  });

  if (dropZone) {
    for (const type of ['dragenter', 'dragover']) {
      dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('is-over'); });
    }
    for (const type of ['dragleave', 'drop']) {
      dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('is-over'); });
    }
    dropZone.addEventListener('drop', async (event) => {
      const [file] = Array.from((event as DragEvent).dataTransfer?.files ?? []);
      if (file?.type.startsWith('image/')) await readFile(file);
    });
  }

  // Pasting a screenshot is how most codes on a screen get read.
  document.addEventListener('paste', async (event) => {
    if (readPaneEl.hidden) return;
    for (const item of Array.from((event as ClipboardEvent).clipboardData?.items ?? [])) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { event.preventDefault(); await readFile(file); return; }
      }
    }
  });

  $<HTMLButtonElement>('ts-copy-read')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastText);
      toast('Copied.', { kind: 'good' });
    } catch {
      toast('The browser would not let this page use the clipboard.', { kind: 'error' });
    }
  });

  $<HTMLButtonElement>('ts-reuse')?.addEventListener('click', () => {
    if (lastText) onReuse(lastText);
  });

  function setMode(mode: 'make' | 'read'): void {
    const reading = mode === 'read';
    readPaneEl.hidden = !reading;
    makePaneEl.hidden = reading;
    if (libraryPane) libraryPane.hidden = reading;
    for (const button of modesEl.querySelectorAll<HTMLButtonElement>('.ts-mode')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    if (!reading) camera.stop();
  }

  modes.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.ts-mode');
    if (button?.dataset.mode) setMode(button.dataset.mode as 'make' | 'read');
  });

  window.addEventListener('pagehide', () => camera.stop());
  window.addEventListener('resize', () => drawMarks(null, 0, 0));

  return setMode;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
