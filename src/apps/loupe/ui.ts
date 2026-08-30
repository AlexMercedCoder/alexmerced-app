import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { zipBlob } from '../../lib/zip';
import { createId } from '../../lib/id';
import { describeExif, hasSensitiveTags, readExif, type ExifTags } from './exif';
import {
  APP_ID, FORMATS, formatBytes, isLossy, outputName, resolveFormat, savings, targetSize,
  type OutputFormat, type Recipe,
} from './model';
import { applyImport, buildExport, clearAll, loadPresets, loadRecipe, savePresets, saveRecipe, type Preset } from './store';
import { registerTools } from '../../lib/webmcp';
import { loupeTools } from './mcp';

type Item = {
  id: string;
  file: File;
  bitmap: ImageBitmap;
  exif: ExifTags;
  outputBlob: Blob | null;
  outputUrl: string | null;
  outputName: string;
};

export async function mountLoupe(root: HTMLElement): Promise<void> {
  let recipe: Recipe = loadRecipe();
  let presets: Preset[] = loadPresets();
  let items: Item[] = [];
  let processing = false;

  const dropZone = root.querySelector<HTMLElement>('#lp-drop')!;
  const fileInput = root.querySelector<HTMLInputElement>('#lp-file')!;
  const list = root.querySelector<HTMLElement>('#lp-list')!;
  const empty = root.querySelector<HTMLElement>('#lp-empty')!;
  const summary = root.querySelector<HTMLElement>('#lp-summary')!;
  const presetBar = root.querySelector<HTMLElement>('#lp-presets')!;

  const controls = {
    mode: root.querySelector<HTMLSelectElement>('#lp-mode')!,
    width: root.querySelector<HTMLInputElement>('#lp-width')!,
    height: root.querySelector<HTMLInputElement>('#lp-height')!,
    percent: root.querySelector<HTMLInputElement>('#lp-percent')!,
    format: root.querySelector<HTMLSelectElement>('#lp-format')!,
    quality: root.querySelector<HTMLInputElement>('#lp-quality')!,
    qualityOut: root.querySelector<HTMLElement>('#lp-quality-out')!,
    rotate: root.querySelector<HTMLSelectElement>('#lp-rotate')!,
    flipH: root.querySelector<HTMLInputElement>('#lp-fliph')!,
    flipV: root.querySelector<HTMLInputElement>('#lp-flipv')!,
    background: root.querySelector<HTMLInputElement>('#lp-background')!,
    suffix: root.querySelector<HTMLInputElement>('#lp-suffix')!,
  };

  function renderControls(): void {
    controls.mode.value = recipe.mode;
    controls.width.value = String(recipe.width);
    controls.height.value = String(recipe.height);
    controls.percent.value = String(recipe.percent);
    controls.format.value = recipe.format;
    controls.quality.value = String(Math.round(recipe.quality * 100));
    controls.rotate.value = String(recipe.rotate);
    controls.flipH.checked = recipe.flipHorizontal;
    controls.flipV.checked = recipe.flipVertical;
    controls.background.value = recipe.background;
    controls.suffix.value = recipe.suffix;

    const usesBox = recipe.mode === 'fit' || recipe.mode === 'exact';
    root.dataset.mode = recipe.mode;
    controls.qualityOut.textContent = `${Math.round(recipe.quality * 100)}%`;

    const lossy = recipe.format === 'keep'
      ? items.some((item) => isLossy(resolveFormat(recipe, item.file.type)))
      : isLossy(recipe.format);
    root.dataset.lossy = lossy ? 'true' : 'false';
    void usesBox;
  }

  function renderPresets(): void {
    presetBar.innerHTML = '';
    for (const preset of presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lp-preset';
      button.dataset.preset = preset.id;
      button.textContent = preset.name;
      presetBar.appendChild(button);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'lp-preset lp-preset--add';
    add.dataset.savePreset = 'true';
    add.textContent = '+ save these settings';
    presetBar.appendChild(add);
  }

  function renderList(): void {
    empty.hidden = items.length > 0;
    list.innerHTML = '';

    for (const item of items) {
      const row = document.createElement('article');
      row.className = 'lp-item';

      const preview = document.createElement('img');
      preview.className = 'lp-item__preview';
      preview.alt = '';
      preview.src = item.outputUrl ?? '';
      preview.loading = 'lazy';

      const body = document.createElement('div');
      body.className = 'lp-item__body';

      const name = document.createElement('strong');
      name.textContent = item.outputName;

      const sizes = document.createElement('span');
      sizes.className = 'lp-item__sizes';
      const target = targetSize({ width: item.bitmap.width, height: item.bitmap.height }, recipe);
      if (item.outputBlob) {
        const saved = savings(item.file.size, item.outputBlob.size);
        sizes.innerHTML = '';
        sizes.append(
          `${item.bitmap.width} × ${item.bitmap.height} → ${target.width} × ${target.height} · `,
          `${formatBytes(item.file.size)} → ${formatBytes(item.outputBlob.size)} `,
        );
        const badge = document.createElement('em');
        badge.className = 'lp-savings';
        badge.dataset.grew = String(saved < 0);
        badge.textContent = saved >= 0 ? `${saved}% smaller` : `${Math.abs(saved)}% larger`;
        sizes.appendChild(badge);
      } else {
        sizes.textContent = `${item.bitmap.width} × ${item.bitmap.height} · ${formatBytes(item.file.size)}`;
      }

      body.append(name, sizes);

      const exifRows = describeExif(item.exif);
      if (exifRows.length) {
        const details = document.createElement('details');
        details.className = 'lp-exif';
        const summaryEl = document.createElement('summary');
        summaryEl.textContent = hasSensitiveTags(item.exif)
          ? `${exifRows.length} metadata tags, including identifying ones`
          : `${exifRows.length} metadata tags`;
        if (hasSensitiveTags(item.exif)) summaryEl.dataset.warn = 'true';
        details.appendChild(summaryEl);

        const table = document.createElement('dl');
        for (const entry of exifRows) {
          const dt = document.createElement('dt');
          dt.textContent = entry.label;
          const dd = document.createElement('dd');
          dd.textContent = entry.value;
          if (entry.sensitive) dd.dataset.sensitive = 'true';
          table.append(dt, dd);
        }
        details.appendChild(table);

        const note = document.createElement('p');
        note.className = 'lp-exif__note';
        note.textContent = 'None of this survives processing. Re-encoding through a canvas keeps only the pixels.';
        details.appendChild(note);

        body.appendChild(details);
      } else {
        const none = document.createElement('span');
        none.className = 'lp-item__sizes';
        none.textContent = 'No metadata found in this file.';
        body.appendChild(none);
      }

      const actions = document.createElement('div');
      actions.className = 'lp-item__actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn--sm';
      save.dataset.saveItem = item.id;
      save.textContent = 'Save';
      save.disabled = !item.outputBlob;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--sm btn--ghost';
      remove.dataset.removeItem = item.id;
      remove.textContent = 'Remove';
      actions.append(save, remove);

      row.append(preview, body, actions);
      list.appendChild(row);
    }

    const totalBefore = items.reduce((sum, item) => sum + item.file.size, 0);
    const totalAfter = items.reduce((sum, item) => sum + (item.outputBlob?.size ?? 0), 0);
    summary.textContent = items.length
      ? `${items.length} image${items.length === 1 ? '' : 's'} · ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (${savings(totalBefore, totalAfter)}% smaller)`
      : '';
  }

  /** Draws through a canvas, which is also what discards the metadata. */
  async function processItem(item: Item): Promise<void> {
    const source = { width: item.bitmap.width, height: item.bitmap.height };
    const target = targetSize(source, recipe);
    const format = resolveFormat(recipe, item.file.type);

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser would not give us a canvas.');

    // JPEG has no alpha, so transparency has to land on something.
    if (isLossy(format)) {
      context.fillStyle = recipe.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((recipe.rotate * Math.PI) / 180);
    context.scale(recipe.flipHorizontal ? -1 : 1, recipe.flipVertical ? -1 : 1);

    // After rotating, the drawing box is the target with its axes swapped back.
    const quarter = recipe.rotate === 90 || recipe.rotate === 270;
    const drawWidth = quarter ? canvas.height : canvas.width;
    const drawHeight = quarter ? canvas.width : canvas.height;
    context.drawImage(item.bitmap, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    context.restore();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, format, isLossy(format) ? recipe.quality : undefined);
    });
    if (!blob) throw new Error('The browser would not encode that image.');

    if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    item.outputBlob = blob;
    item.outputUrl = URL.createObjectURL(blob);
    item.outputName = outputName(item.file.name, format, recipe.suffix);
  }

  async function processAll(): Promise<void> {
    if (processing || !items.length) return;
    processing = true;
    root.dataset.busy = 'true';
    try {
      for (const item of items) await processItem(item);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Something went wrong processing an image.', { kind: 'error' });
    } finally {
      processing = false;
      delete root.dataset.busy;
      renderList();
    }
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const accepted = [...files].filter((file) => file.type.startsWith('image/'));
    if (!accepted.length) {
      toast('Those files are not images.', { kind: 'error' });
      return;
    }

    for (const file of accepted) {
      try {
        const bytes = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
        const bitmap = await createImageBitmap(file);
        items.push({
          id: createId('img'),
          file,
          bitmap,
          exif: file.type === 'image/jpeg' ? readExif(bytes) : {},
          outputBlob: null,
          outputUrl: null,
          outputName: file.name,
        });
      } catch {
        toast(`${file.name} could not be opened as an image.`, { kind: 'error' });
      }
    }

    renderList();
    await processAll();
  }

  function updateRecipe(changes: Partial<Recipe>): void {
    recipe = { ...recipe, ...changes };
    saveRecipe(recipe);
    renderControls();
    void processAll();
  }

  // ------------------------------------------------------------------ events
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void addFiles(fileInput.files);
    fileInput.value = '';
  });

  for (const name of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.dataset.over = 'true'; });
  }
  for (const name of ['dragleave', 'drop'] as const) {
    dropZone.addEventListener(name, () => { delete dropZone.dataset.over; });
  }
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files);
  });

  controls.mode.addEventListener('change', () => updateRecipe({ mode: controls.mode.value as Recipe['mode'] }));
  controls.width.addEventListener('change', () => updateRecipe({ width: Math.max(1, Number(controls.width.value) || 1) }));
  controls.height.addEventListener('change', () => updateRecipe({ height: Math.max(1, Number(controls.height.value) || 1) }));
  controls.percent.addEventListener('change', () => updateRecipe({ percent: Math.max(1, Number(controls.percent.value) || 1) }));
  controls.format.addEventListener('change', () => updateRecipe({ format: controls.format.value as Recipe['format'] }));
  controls.quality.addEventListener('input', () => {
    controls.qualityOut.textContent = `${controls.quality.value}%`;
  });
  controls.quality.addEventListener('change', () => updateRecipe({ quality: Number(controls.quality.value) / 100 }));
  controls.rotate.addEventListener('change', () => updateRecipe({ rotate: Number(controls.rotate.value) as Recipe['rotate'] }));
  controls.flipH.addEventListener('change', () => updateRecipe({ flipHorizontal: controls.flipH.checked }));
  controls.flipV.addEventListener('change', () => updateRecipe({ flipVertical: controls.flipV.checked }));
  controls.background.addEventListener('change', () => updateRecipe({ background: controls.background.value }));
  controls.suffix.addEventListener('change', () => updateRecipe({ suffix: controls.suffix.value }));

  presetBar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-preset], [data-save-preset]');
    if (!target) return;

    if (target.dataset.savePreset) {
      const name = window.prompt('Name these settings', 'My preset');
      if (!name?.trim()) return;
      presets = [...presets, { id: createId('preset'), name: name.trim(), recipe: { ...recipe } }];
      savePresets(presets);
      renderPresets();
      toast('Preset saved.', { kind: 'good' });
      return;
    }

    const preset = presets.find((item) => item.id === target.dataset.preset);
    if (preset) updateRecipe(preset.recipe);
  });

  list.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-save-item], [data-remove-item]');
    if (!target) return;

    if (target.dataset.saveItem) {
      const item = items.find((entry) => entry.id === target.dataset.saveItem);
      if (item?.outputBlob) downloadBlob(item.outputName, item.outputBlob);
      return;
    }

    if (target.dataset.removeItem) {
      const item = items.find((entry) => entry.id === target.dataset.removeItem);
      if (item?.outputUrl) URL.revokeObjectURL(item.outputUrl);
      item?.bitmap.close();
      items = items.filter((entry) => entry.id !== target.dataset.removeItem);
      renderList();
    }
  });

  root.querySelector('#lp-save-all')?.addEventListener('click', () => {
    const ready = items.filter((item) => item.outputBlob);
    if (!ready.length) { toast('Nothing to save yet.', { kind: 'error' }); return; }
    if (ready.length === 1) { downloadBlob(ready[0].outputName, ready[0].outputBlob!); return; }
    void (async () => {
      const entries = await Promise.all(ready.map(async (item) => ({
        name: item.outputName,
        bytes: new Uint8Array(await item.outputBlob!.arrayBuffer()),
      })));
      downloadBlob(`loupe-${ready.length}-images.zip`, zipBlob(entries));
      toast(`${ready.length} images saved as a ZIP.`, { kind: 'good' });
    })();
  });

  root.querySelector('#lp-clear-images')?.addEventListener('click', () => {
    for (const item of items) {
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
      item.bitmap.close();
    }
    items = [];
    renderList();
  });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport: () => buildExport(),
    applyImport: (text, mode) => {
      const count = applyImport(text, mode);
      return `Imported. You now have ${count} preset${count === 1 ? '' : 's'}.`;
    },
    onImported: () => {
      recipe = loadRecipe();
      presets = loadPresets();
      renderControls();
      renderPresets();
      void processAll();
    },
    onClearAll: () => { clearAll(); recipe = loadRecipe(); presets = loadPresets(); },
    clearWarning: 'This resets Loupe back to its built-in presets. The images in the list are not stored anywhere and are unaffected. Continue?',
  });

  renderControls();
  renderPresets();
  renderList();

  // Everything this app can do, offered to an agent on this page.
  registerTools(loupeTools());
}
