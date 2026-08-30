import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob, downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
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

  library = await loadCodes();
  renderForm();
  render();
}
