export const APP_ID = 'quire';
export const APP_VERSION = 1;

/** One page in the working set, wherever it came from. */
export type Slot = {
  id: string;
  /** Index into the loaded document list. */
  documentIndex: number;
  pageIndex: number;
  rotate: number;
  selected: boolean;
};

/** Parses "1-3, 7, 12-" the way a print dialog would. */
export function parsePageRange(text: string, total: number): number[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return Array.from({ length: total }, (_, i) => i);

  const wanted = new Set<number>();
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (!piece) continue;

    const range = /^(\d*)\s*-\s*(\d*)$/.exec(piece);
    if (range) {
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : total;
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const [low, high] = from <= to ? [from, to] : [to, from];
      for (let page = low; page <= high; page += 1) {
        if (page >= 1 && page <= total) wanted.add(page - 1);
      }
      continue;
    }

    const single = Number(piece);
    if (Number.isFinite(single) && single >= 1 && single <= total) wanted.add(single - 1);
  }

  return [...wanted].sort((a, b) => a - b);
}

export function formatPageRange(indexes: number[]): string {
  if (!indexes.length) return '';
  const sorted = [...indexes].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (let i = 1; i <= sorted.length; i += 1) {
    const current = sorted[i];
    if (current === previous + 1) { previous = current; continue; }
    parts.push(start === previous ? String(start + 1) : `${start + 1}-${previous + 1}`);
    start = current;
    previous = current;
  }
  return parts.join(', ');
}

export function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

export function rotateBy(current: number, delta: number): number {
  return (((current + delta) % 360) + 360) % 360;
}

/** Splits a set of slots into chunks of a given size. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Names an output file after the first source, without doubling the extension. */
export function outputName(sourceName: string, suffix: string): string {
  const stem = sourceName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'document';
  return `${stem}${suffix}.pdf`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Page size in millimetres, for showing what a page actually is. */
export function describeSize(width: number, height: number): string {
  const mm = (points: number) => Math.round((points / 72) * 25.4);
  const known: [string, number, number][] = [
    ['A4', 210, 297], ['A3', 297, 420], ['A5', 148, 210],
    ['Letter', 216, 279], ['Legal', 216, 356], ['Tabloid', 279, 432],
  ];

  const w = mm(width);
  const h = mm(height);
  for (const [name, kw, kh] of known) {
    const matches = (a: number, b: number) => Math.abs(a - b) <= 2;
    if ((matches(w, kw) && matches(h, kh))) return name;
    if ((matches(w, kh) && matches(h, kw))) return `${name} landscape`;
  }
  return `${w} × ${h} mm`;
}
