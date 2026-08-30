import { createEnvelope, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { APP_ID, APP_VERSION, defaultRecipe, reviveRecipe, type Recipe } from './model';

const RECIPE_KEY = 'loupe:recipe';
const PRESETS_KEY = 'loupe:presets';

export type Preset = { id: string; name: string; recipe: Recipe };

export function loadRecipe(): Recipe { return reviveRecipe(readPref(RECIPE_KEY, defaultRecipe)); }
export function saveRecipe(recipe: Recipe): void { writePref(RECIPE_KEY, recipe); }

export function loadPresets(): Preset[] {
  const raw = readPref<unknown[]>(PRESETS_KEY, []);
  if (!Array.isArray(raw)) return builtInPresets();
  const revived = raw
    .filter((item): item is Preset => typeof item === 'object' && item !== null && typeof (item as Preset).id === 'string')
    .map((preset) => ({ id: preset.id, name: String(preset.name ?? 'Preset'), recipe: reviveRecipe(preset.recipe) }));
  return revived.length ? revived : builtInPresets();
}

export function savePresets(presets: Preset[]): void { writePref(PRESETS_KEY, presets); }

/** Sizes people actually reach for, so the app is useful before any setup. */
export function builtInPresets(): Preset[] {
  return [
    { id: 'web', name: 'Web, 1600px', recipe: { ...defaultRecipe, mode: 'fit', width: 1600, height: 1600, format: 'image/jpeg', quality: 0.82, suffix: '-web' } },
    { id: 'thumb', name: 'Thumbnail, 400px', recipe: { ...defaultRecipe, mode: 'fit', width: 400, height: 400, format: 'image/jpeg', quality: 0.8, suffix: '-thumb' } },
    { id: 'og', name: 'Social card, 1200 by 630', recipe: { ...defaultRecipe, mode: 'exact', width: 1200, height: 630, format: 'image/jpeg', quality: 0.85, suffix: '-card' } },
    { id: 'webp', name: 'Convert to WebP', recipe: { ...defaultRecipe, mode: 'none', format: 'image/webp', quality: 0.85, suffix: '' } },
    { id: 'strip', name: 'Strip metadata only', recipe: { ...defaultRecipe, mode: 'none', format: 'keep', quality: 0.95, suffix: '-clean' } },
  ];
}

export type LoupeExport = { recipe: Recipe; presets: Preset[] };

export function buildExport(now: Date = new Date()) {
  const presets = loadPresets();
  return createEnvelope<LoupeExport>(APP_ID, APP_VERSION, { recipe: loadRecipe(), presets }, { presets: presets.length }, now);
}

export function applyImport(text: string, mode: ImportMode): number {
  const envelope = parseEnvelope<LoupeExport>(text, APP_ID);
  const incoming = Array.isArray(envelope.data.presets)
    ? envelope.data.presets
        .filter((preset): preset is Preset => typeof preset === 'object' && preset !== null && typeof preset.id === 'string')
        .map((preset) => ({ id: preset.id, name: String(preset.name ?? 'Preset'), recipe: reviveRecipe(preset.recipe) }))
    : [];

  if (!incoming.length) throw new Error('That export contains no readable presets.');

  if (mode === 'replace') {
    savePresets(incoming);
  } else {
    const byId = new Map(loadPresets().map((preset) => [preset.id, preset]));
    for (const preset of incoming) byId.set(preset.id, preset);
    savePresets([...byId.values()]);
  }

  if (envelope.data.recipe) saveRecipe(reviveRecipe(envelope.data.recipe));
  return loadPresets().length;
}

export function clearAll(): void {
  writePref(PRESETS_KEY, builtInPresets());
  writePref(RECIPE_KEY, defaultRecipe);
}
