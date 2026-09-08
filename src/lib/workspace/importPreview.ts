import { parseEnvelope, type Envelope } from '../portable';
export function previewImport(text: string, app: string, current: unknown): { envelope: Envelope; lines: string[] } {
  const envelope = parseEnvelope<Record<string, unknown>>(text, app);
  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new Error('The export data must be an object.');
  const existing = (current as Envelope)?.data as Record<string, unknown> | undefined;
  const lines = [`Source: ${app}. Exported ${envelope.exportedAt || 'at an unknown time'}.`];
  for (const [key, value] of Object.entries(envelope.data)) {
    if (!Array.isArray(value)) continue;
    const ids = new Set<string>(); let matches = 0;
    const before = Array.isArray(existing?.[key]) ? existing![key] as any[] : [];
    for (const row of value) {
      if (row && typeof row === 'object' && 'id' in row) {
        if (typeof row.id !== 'string' || ids.has(row.id)) throw new Error(`${key} contains an invalid or duplicate ID.`);
        ids.add(row.id); if (before.some(b => b?.id === row.id)) matches++;
      }
    }
    lines.push(`${key}: ${value.length} incoming, ${matches} matching IDs, ${value.length - matches} new. Currently ${before.length}.`);
  }
  lines.push('Merge uses this tool’s import rules. Matching records may be kept or updated. Replace removes current records. Invalid fields may be normalized by the tool.');
  return { envelope, lines };
}
