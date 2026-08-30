/** Sortable, collision-resistant ids that do not need a server. */
export function createId(prefix = ''): string {
  const time = Date.now().toString(36);
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${prefix ? '_' : ''}${time}${random}`;
}

/** Fractional ranks, so reordering one item never rewrites its neighbours. */
export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

export function nextRank(existing: { rank: number }[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing.map((item) => item.rank)) + 1;
}
