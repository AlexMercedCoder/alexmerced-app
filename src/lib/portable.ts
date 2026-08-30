/**
 * Every app on alexmerced.app writes the same envelope when you export, and
 * accepts the same envelope when you import. The data belongs to whoever made
 * it, so getting it out has to be one click and the file has to be readable.
 */

export const ENVELOPE_FORMAT = 'alexmerced.app/export';
export const ENVELOPE_VERSION = 1;

export type Envelope<T = unknown> = {
  format: typeof ENVELOPE_FORMAT;
  version: number;
  app: string;
  appVersion: number;
  exportedAt: string;
  counts: Record<string, number>;
  data: T;
};

export type ImportMode = 'merge' | 'replace';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export function createEnvelope<T>(
  app: string,
  appVersion: number,
  data: T,
  counts: Record<string, number>,
  now: Date = new Date(),
): Envelope<T> {
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    app,
    appVersion,
    exportedAt: now.toISOString(),
    counts,
    data,
  };
}

/**
 * Validates a parsed file before an app is allowed to act on it. Throws an
 * ImportError with a message meant to be shown to a person, not logged.
 */
export function readEnvelope<T>(raw: unknown, expectedApp: string): Envelope<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ImportError('That file does not contain an export object.');
  }

  const candidate = raw as Partial<Envelope<T>>;

  if (candidate.format !== ENVELOPE_FORMAT) {
    throw new ImportError(
      'That file was not exported from alexmerced.app. Look for a file ending in .json that this site produced.',
    );
  }

  if (typeof candidate.version !== 'number' || candidate.version > ENVELOPE_VERSION) {
    throw new ImportError(
      `That file uses export format version ${String(candidate.version)}, which this version of the app cannot read yet.`,
    );
  }

  if (candidate.app !== expectedApp) {
    throw new ImportError(
      `That file came from ${candidate.app ? `"${candidate.app}"` : 'another app'}, not ${expectedApp}. Open it in the app that made it.`,
    );
  }

  if (candidate.data === undefined || candidate.data === null) {
    throw new ImportError('That export contains no data.');
  }

  return candidate as Envelope<T>;
}

export function parseEnvelope<T>(text: string, expectedApp: string): Envelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('That file is not valid JSON. It may have been edited or truncated.');
  }
  return readEnvelope<T>(parsed, expectedApp);
}

/** Merges two id-keyed record sets, letting the incoming file win on conflict. */
export function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()];
}

/** Merges but keeps whichever copy was updated most recently. */
export function mergeByNewest<T extends { id: string; updatedAt?: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const byId = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) {
    const current = byId.get(record.id);
    if (!current) { byId.set(record.id, record); continue; }
    const a = Date.parse(current.updatedAt ?? '') || 0;
    const b = Date.parse(record.updatedAt ?? '') || 0;
    byId.set(record.id, b >= a ? record : current);
  }
  return [...byId.values()];
}

export function exportFilename(app: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${app}-${stamp}.json`;
}

/** Hands a generated file to the browser's download machinery. */
export function downloadFile(filename: string, contents: string, mime = 'application/json'): void {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and resolves with the text of the chosen file. */
export function pickTextFile(accept = 'application/json,.json'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      try {
        finish(await file.text());
      } catch {
        finish(null);
      }
    });

    // Covers the case where the picker is dismissed without choosing anything.
    window.addEventListener('focus', () => setTimeout(() => finish(null), 500), { once: true });

    input.click();
  });
}
