import { NeedsElementError, render, type Progress, type Project } from './render';

/**
 * The export, off the main thread.
 *
 * An export walks every frame of the finished video, decodes it, composes it
 * and encodes it. Doing that on the main thread froze the page for as long as
 * it took: no scrubbing, no responsive cancel, and a long enough render risked
 * the browser deciding the tab had stopped responding. The work itself was
 * never the problem; where it ran was.
 *
 * Almost all of it was already worker-safe. The composition draws to an
 * OffscreenCanvas and the encoders are WebCodecs, neither of which wants a
 * document. The one thing that does is the fallback for a recording no decoder
 * will read, which seeks a video element, and there is no element here. That
 * case says so, and the page runs it the old way instead.
 */

export type ExportRequest = {
  /** Everything but the elements, which cannot cross a worker boundary. */
  project: Omit<Project, 'video' | 'camera' | 'wallpaper' | 'takes'> & {
    takes?: Map<string, { blob: Blob }>;
    wallpaper?: ImageBitmap | null;
  };
};

export type ExportMessage =
  | { kind: 'progress'; progress: Progress }
  | { kind: 'done'; result: { blob: Blob; frames: number; hasAudio: boolean; extension: string; note: string | null } }
  | { kind: 'needs-element' }
  | { kind: 'failed'; message: string };

let controller: AbortController | null = null;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { kind: string } & ExportRequest;

  if (data.kind === 'cancel') {
    controller?.abort();
    return;
  }
  if (data.kind !== 'render') return;

  controller = new AbortController();
  void (async () => {
    try {
      // The elements are absent by construction, and the takes arrive as blobs
      // with no element beside them; the renderer opens a decoder per blob.
      const project = {
        ...data.project,
        video: null,
        camera: null,
        takes: data.project.takes
          ? new Map([...data.project.takes].map(([id, take]) => [
            id, { blob: take.blob, video: null as unknown as HTMLVideoElement },
          ]))
          : undefined,
      } as unknown as Project;

      const result = await render(
        project,
        [],
        (progress) => { post({ kind: 'progress', progress }); },
        controller!.signal,
      );
      post({ kind: 'done', result });
    } catch (error) {
      if (error instanceof NeedsElementError) {
        post({ kind: 'needs-element' });
        return;
      }
      post({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'The export failed.',
      });
    } finally {
      controller = null;
    }
  })();
});

function post(message: ExportMessage): void {
  (self as unknown as Worker).postMessage(message);
}
