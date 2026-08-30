export const APP_ID = 'loupe';
export const APP_VERSION = 1;

export type OutputFormat = 'image/png' | 'image/jpeg' | 'image/webp';

export const FORMATS: { id: OutputFormat; label: string; extension: string; lossy: boolean }[] = [
  { id: 'image/png', label: 'PNG', extension: 'png', lossy: false },
  { id: 'image/jpeg', label: 'JPEG', extension: 'jpg', lossy: true },
  { id: 'image/webp', label: 'WebP', extension: 'webp', lossy: true },
];

export type ResizeMode = 'none' | 'fit' | 'exact' | 'scale';

export type Recipe = {
  mode: ResizeMode;
  width: number;
  height: number;
  /** For scale mode, as a percentage. */
  percent: number;
  format: OutputFormat | 'keep';
  quality: number;
  rotate: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  flipVertical: boolean;
  /** Fills the background before drawing, which matters when going to JPEG. */
  background: string;
  suffix: string;
};

export const defaultRecipe: Recipe = {
  mode: 'fit',
  width: 1600,
  height: 1600,
  percent: 50,
  format: 'keep',
  quality: 0.85,
  rotate: 0,
  flipHorizontal: false,
  flipVertical: false,
  background: '#ffffff',
  suffix: '',
};

export type Size = { width: number; height: number };

/**
 * Works out the output size. Fit preserves the aspect ratio and never enlarges,
 * which is almost always what someone resizing a photo wants.
 */
export function targetSize(source: Size, recipe: Recipe): Size {
  const rotated = recipe.rotate === 90 || recipe.rotate === 270
    ? { width: source.height, height: source.width }
    : source;

  if (recipe.mode === 'none') return rotated;

  if (recipe.mode === 'scale') {
    const factor = Math.max(1, recipe.percent) / 100;
    return {
      width: Math.max(1, Math.round(rotated.width * factor)),
      height: Math.max(1, Math.round(rotated.height * factor)),
    };
  }

  if (recipe.mode === 'exact') {
    return {
      width: Math.max(1, Math.round(recipe.width)),
      height: Math.max(1, Math.round(recipe.height)),
    };
  }

  // Fit: scale down to sit inside the box, keeping the ratio.
  const scale = Math.min(recipe.width / rotated.width, recipe.height / rotated.height, 1);
  return {
    width: Math.max(1, Math.round(rotated.width * scale)),
    height: Math.max(1, Math.round(rotated.height * scale)),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function extensionFor(format: OutputFormat): string {
  return FORMATS.find((entry) => entry.id === format)?.extension ?? 'png';
}

export function isLossy(format: OutputFormat): boolean {
  return FORMATS.find((entry) => entry.id === format)?.lossy ?? false;
}

/** Builds the output filename, keeping the original stem. */
export function outputName(original: string, format: OutputFormat, suffix: string): string {
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const replaced = stem.replace(/[\\/:*?"<>|]/g, '-').trim();
  // A name made only of separators leaves nothing meaningful behind.
  const clean = /[a-zA-Z0-9]/.test(replaced) ? replaced : 'image';
  return `${clean}${suffix}.${extensionFor(format)}`;
}

export function resolveFormat(recipe: Recipe, sourceType: string): OutputFormat {
  if (recipe.format !== 'keep') return recipe.format;
  return FORMATS.some((entry) => entry.id === sourceType) ? (sourceType as OutputFormat) : 'image/png';
}

/** Percentage saved, or a negative number when the output grew. */
export function savings(before: number, after: number): number {
  if (!before) return 0;
  return Math.round(((before - after) / before) * 100);
}

export function reviveRecipe(value: unknown): Recipe {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Recipe>;
  const modes = new Set(['none', 'fit', 'exact', 'scale']);
  const formats = new Set<string>([...FORMATS.map((f) => f.id), 'keep']);
  const clamp = (n: unknown, min: number, max: number, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

  return {
    mode: modes.has(raw.mode as string) ? (raw.mode as ResizeMode) : defaultRecipe.mode,
    width: Math.round(clamp(raw.width, 1, 20000, defaultRecipe.width)),
    height: Math.round(clamp(raw.height, 1, 20000, defaultRecipe.height)),
    percent: Math.round(clamp(raw.percent, 1, 400, defaultRecipe.percent)),
    format: formats.has(raw.format as string) ? (raw.format as Recipe['format']) : 'keep',
    quality: clamp(raw.quality, 0.1, 1, defaultRecipe.quality),
    rotate: ([0, 90, 180, 270] as const).includes(raw.rotate as 0) ? (raw.rotate as 0) : 0,
    flipHorizontal: raw.flipHorizontal === true,
    flipVertical: raw.flipVertical === true,
    background: /^#[0-9a-fA-F]{6}$/.test(raw.background ?? '') ? raw.background! : defaultRecipe.background,
    suffix: typeof raw.suffix === 'string' ? raw.suffix.replace(/[\\/:*?"<>|]/g, '').slice(0, 24) : '',
  };
}
