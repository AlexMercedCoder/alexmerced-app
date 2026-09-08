import { canExportInWorker, renderInWorker } from './offload';
import { render, type Project, type Progress } from './render';

export type FrozenExport = { project: Project; camera: Blob | null; wallpaper: ImageBitmap | null };
export async function freezeExport(project: Project, camera: Blob | null): Promise<FrozenExport> {
  const { video: _video, camera: _camera, takes, wallpaper, ...data } = project;
  const frozen = structuredClone(data);
  // Copies are independent of object URLs and of subsequent edits or project switches.
  const media = takes
    ? new Map(
        [...takes].map(([id, take]) => [
          id,
          { blob: take.blob, video: null as unknown as HTMLVideoElement },
        ]),
      )
    : undefined;
  const picture = wallpaper ? await createImageBitmap(wallpaper as ImageBitmapSource) : null;
  return { project: { ...frozen, takes: media, wallpaper: picture }, camera, wallpaper: picture };
}
export async function renderFrozen(
  item: FrozenExport,
  progress: (p: Progress) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const elements: HTMLVideoElement[] = [],
    urls: string[] = [];
  async function element(blob: Blob) {
    signal.throwIfAborted();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const url = URL.createObjectURL(blob);
    urls.push(url);
    elements.push(video);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
      };
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('The queued source could not be decoded.'));
      };
      const aborted = () => {
        cleanup();
        reject(new DOMException('Cancelled.', 'AbortError'));
      };
      const timer = setTimeout(failed, 30000);
      video.addEventListener('loadeddata', loaded, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      video.src = url;
    });
    signal.throwIfAborted();
    return video;
  }
  try {
    const current = { ...item.project };
    if (item.camera) current.camera = await element(item.camera);
    if (canExportInWorker(current)) {
      const result = await renderInWorker(current, progress, signal);
      if (result) return result;
    }
    if (current.source) current.video = await element(current.source);
    if (current.takes) {
      current.takes = new Map();
      for (const [id, take] of item.project.takes!)
        current.takes.set(id, { blob: take.blob, video: await element(take.blob) });
    }
    return await render(current, [], progress, signal);
  } finally {
    for (const video of elements) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    for (const url of urls) URL.revokeObjectURL(url);
  }
}
