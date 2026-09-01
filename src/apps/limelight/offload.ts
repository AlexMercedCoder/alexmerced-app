import { canDecodeSequentially } from './frames';
import { RenderError, type ExportResult, type Progress, type Project } from './render';
import type { ExportMessage } from './export.worker';

/**
 * Handing the export to a worker, and knowing when not to.
 *
 * The render was already worker-safe in almost every respect: it draws to an
 * OffscreenCanvas and encodes with WebCodecs, neither of which wants a
 * document. Two things do. The seeking fallback, for a recording no decoder
 * will read, needs a video element. So does a camera picture, which is a second
 * video playing alongside the first.
 *
 * Rather than refuse those, they run where they always did. The rule is worth
 * being explicit about: try the worker, and if it comes back saying it needed
 * an element, do it here. The file is the same either way; only the page's
 * responsiveness while it happens differs.
 */

/** Whether this project can be exported without a document. */
export function canExportInWorker(project: Project): boolean {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  // Without a decoder every frame would go down the seeking path, which is the
  // one thing a worker cannot do.
  if (!canDecodeSequentially()) return false;
  if (project.camera) return false;
  // An ImageBitmap can cross the boundary. An HTMLImageElement cannot.
  if (project.wallpaper && typeof ImageBitmap !== 'undefined'
    && !(project.wallpaper instanceof ImageBitmap)) return false;
  return true;
}

/**
 * Runs the export in a worker.
 *
 * Null back means the recording needed the seeking fallback, so the caller
 * should run it on the main thread instead. That is a return value rather than
 * an error because it is not a failure: nothing went wrong, the work simply
 * belongs somewhere else.
 */
export function renderInWorker(
  project: Project,
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<ExportResult | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });

    const finish = (settle: () => void) => {
      worker.terminate();
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => {
      // Asked politely first, so the render stops at its next frame rather than
      // being killed mid-encode with a half written file.
      worker.postMessage({ kind: 'cancel' });
      finish(() => reject(new RenderError('Cancelled.')));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    worker.addEventListener('message', (event: MessageEvent<ExportMessage>) => {
      const message = event.data;
      if (message.kind === 'progress') { onProgress(message.progress); return; }
      if (message.kind === 'done') { finish(() => resolve(message.result)); return; }
      if (message.kind === 'needs-element') { finish(() => resolve(null)); return; }
      finish(() => reject(new RenderError(message.message)));
    });
    worker.addEventListener('error', () => {
      // A worker that will not even start is a reason to do the work here, not
      // a reason to refuse the export.
      finish(() => resolve(null));
    });

    const { video: _video, camera: _camera, takes, ...rest } = project;
    worker.postMessage({
      kind: 'render',
      project: {
        ...rest,
        // Blobs cross a worker boundary; the elements beside them do not, and
        // are not needed once there is a decoder for each.
        takes: takes ? new Map([...takes].map(([id, take]) => [id, { blob: take.blob }])) : undefined,
      },
    });
  });
}
