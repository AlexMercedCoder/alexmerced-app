import type { EditorState } from './editorState';
import { trackFromBlocks } from './zooms';

/** One projection shared by UI changes, agent edits, and undo/redo. */
export function projectEdits(state: EditorState, duration: number, editedReel: boolean) {
  const { settings, zooms, texts, cuts, speeds, redactions, captions, shapes, crop, trim, clips } = state;
  return {
    settings, zooms, texts, cuts, speeds, redactions, captions, shapes, crop,
    start: trim.start, end: trim.end,
    keyframes: trackFromBlocks(zooms, duration, settings.zoom),
    clips: editedReel ? clips : [],
  };
}

export async function readTakeRecords(
  takes: ReadonlyMap<string, { blob: Blob }>, active: ReadonlySet<string>, first: string, edited: boolean,
): Promise<{ id: string; bytes: Uint8Array; mime: string }[]> {
  if (!edited) return [];
  const records = [];
  for (const [id, take] of takes) {
    if (id === first || !active.has(id)) continue;
    // Refuse to save an incomplete reel instead of silently losing a take.
    const bytes = new Uint8Array(await take.blob.arrayBuffer());
    records.push({ id, bytes, mime: take.blob.type || 'video/webm' });
  }
  return records;
}

/** Debounce per project, serialize writes, and surface failures to the editor. */
export function createAutosave<T>(write: (value: T) => Promise<void>, onError: (error: unknown) => void, delay = 600) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; read: () => Promise<T> }>();
  let tail = Promise.resolve();
  function commit(key: string) {
    const job = pending.get(key);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(key);
    tail = tail.then(async () => { await write(await job.read()); }).catch(onError);
  }
  return {
    queue(key: string, read: () => Promise<T>) {
      const previous = pending.get(key);
      if (previous) clearTimeout(previous.timer);
      pending.set(key, { timer: setTimeout(() => commit(key), delay), read });
    },
    async cancel(key: string) {
      const job = pending.get(key);
      if (job) clearTimeout(job.timer);
      pending.delete(key);
      // An already-running write must finish before a caller deletes its row.
      await tail;
    },
    async flush() {
      for (const key of pending.keys()) commit(key);
      await tail;
    },
  };
}
