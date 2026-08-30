import type { ClickSample, PointerSample } from './attention';

/**
 * Getting the recording in.
 *
 * The screen is captured with MediaRecorder rather than frame by frame,
 * because capture has to keep up with real time and re-encoding does not.
 * The polish is applied later, from the recorded file.
 *
 * One limitation is worth being plain about, because it decides how the zoom
 * works. A browser cannot know where the pointer is while it records another
 * window: the operating system draws the cursor into the frames and never
 * reports the position. Pointer events only arrive for this page. So a real
 * pointer track exists when you record this tab, and not otherwise, and the
 * app says which it has rather than pretending.
 */

export class CaptureError extends Error {}

export type Source = 'screen' | 'tab';

export type Recording = {
  blob: Blob;
  duration: number;
  width: number;
  height: number;
  /** Present only when the recording was of this page. */
  pointer: PointerSample[];
  clicks: ClickSample[];
  /** A separate camera recording, when one was made. */
  camera: Blob | null;
  hasAudio: boolean;
};

export function canCapture(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getDisplayMedia
    && typeof MediaRecorder !== 'undefined';
}

/** The best container this browser will actually record. */
export function recordingMime(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export type CaptureOptions = {
  source: Source;
  microphone: boolean;
  systemAudio: boolean;
  camera: boolean;
  onTick: (seconds: number) => void;
};

/**
 * A recording in progress. Held as an object rather than a promise because it
 * has to be stoppable, and because the pointer track is gathered the whole
 * time it runs.
 */
export class Session {
  private recorder: MediaRecorder | null = null;
  private cameraRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private cameraChunks: Blob[] = [];
  private streams: MediaStream[] = [];
  private startedAt = 0;
  private timer = 0;
  private readonly pointer: PointerSample[] = [];
  private readonly clicks: ClickSample[] = [];
  private tracking = false;
  private width = 0;
  private height = 0;
  private audio = false;

  constructor(private readonly options: CaptureOptions) {}

  get running(): boolean {
    return this.recorder !== null;
  }

  async start(): Promise<void> {
    if (this.recorder) return;

    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30 },
          // Drawing the cursor in is the only way to see it at all when
          // capturing anything other than this page.
          ...({ cursor: 'always' } as Record<string, unknown>),
        },
        audio: this.options.systemAudio,
        ...(this.options.source === 'tab' ? ({ preferCurrentTab: true } as Record<string, unknown>) : {}),
      });
    } catch {
      throw new CaptureError('Nothing was shared. The browser asks before any recording can start.');
    }
    this.streams.push(display);

    const [videoTrack] = display.getVideoTracks();
    const settings = videoTrack?.getSettings() ?? {};
    this.width = settings.width ?? 1920;
    this.height = settings.height ?? 1080;

    // Stopping the share from the browser's own banner ends the recording.
    if (videoTrack) videoTrack.addEventListener('ended', () => { void this.stop(); });

    const tracks = [...display.getVideoTracks(), ...display.getAudioTracks()];

    if (this.options.microphone) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.streams.push(mic);
        tracks.push(...mic.getAudioTracks());
      } catch {
        // A refused microphone is not a reason to abandon the recording.
      }
    }
    this.audio = tracks.some((track) => track.kind === 'audio');

    const mime = recordingMime();
    const combined = new MediaStream(tracks);
    this.recorder = new MediaRecorder(combined, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };

    if (this.options.camera) {
      try {
        const camera = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
        this.streams.push(camera);
        this.cameraRecorder = new MediaRecorder(camera, mime ? { mimeType: mime } : undefined);
        this.cameraRecorder.ondataavailable = (event) => { if (event.data.size) this.cameraChunks.push(event.data); };
      } catch {
        this.cameraRecorder = null;
      }
    }

    // Only worth tracking when the recording is of this page. Anywhere else the
    // coordinates would be of this window, not of what is being recorded.
    this.tracking = this.options.source === 'tab';
    if (this.tracking) {
      window.addEventListener('pointermove', this.onPointerMove, { passive: true, capture: true });
      window.addEventListener('pointerdown', this.onPointerDown, { passive: true, capture: true });
    }

    this.startedAt = performance.now();
    this.recorder.start(1000);
    this.cameraRecorder?.start(1000);
    this.timer = window.setInterval(() => {
      this.options.onTick((performance.now() - this.startedAt) / 1000);
    }, 200);
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const time = (performance.now() - this.startedAt) / 1000;
    const last = this.pointer[this.pointer.length - 1];
    // Twenty samples a second is plenty for a path that will be smoothed.
    if (last && time - last.time < 0.05) return;
    this.pointer.push({ time, x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight });
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    this.clicks.push({
      time: (performance.now() - this.startedAt) / 1000,
      x: event.clientX / window.innerWidth,
      y: event.clientY / window.innerHeight,
    });
  };

  async stop(): Promise<Recording> {
    if (!this.recorder) throw new CaptureError('Nothing is being recorded.');
    const recorder = this.recorder;
    const cameraRecorder = this.cameraRecorder;

    const finished = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    const cameraFinished = cameraRecorder
      ? new Promise<void>((resolve) => { cameraRecorder.onstop = () => resolve(); })
      : Promise.resolve();

    recorder.stop();
    cameraRecorder?.stop();
    await Promise.all([finished, cameraFinished]);

    const duration = (performance.now() - this.startedAt) / 1000;
    this.cleanup();

    const mime = recorder.mimeType || 'video/webm';
    return {
      blob: new Blob(this.chunks, { type: mime }),
      duration,
      width: this.width,
      height: this.height,
      pointer: [...this.pointer],
      clicks: [...this.clicks],
      camera: this.cameraChunks.length ? new Blob(this.cameraChunks, { type: mime }) : null,
      hasAudio: this.audio,
    };
  }

  cancel(): void {
    try { this.recorder?.stop(); } catch { /* already stopped */ }
    try { this.cameraRecorder?.stop(); } catch { /* already stopped */ }
    this.cleanup();
  }

  private cleanup(): void {
    window.clearInterval(this.timer);
    if (this.tracking) {
      window.removeEventListener('pointermove', this.onPointerMove, { capture: true });
      window.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      this.tracking = false;
    }
    // Releasing the tracks is what turns the browser's recording indicator off
    // and stops the share banner hanging around.
    for (const stream of this.streams) {
      for (const track of stream.getTracks()) track.stop();
    }
    this.streams = [];
    this.recorder = null;
    this.cameraRecorder = null;
  }
}
