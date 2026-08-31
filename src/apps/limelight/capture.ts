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

/** A key combination as it was pressed, ready to be drawn. */
export type KeySample = { time: number; label: string };

/** A moment somebody marked while recording, for chapters. */
export type MarkSample = { time: number; label: string };

/**
 * Turns a keyboard event into what should be shown on screen.
 *
 * Modifiers are named the way the platform names them, and a plain letter with
 * no modifier is left out by the caller: showing every character somebody types
 * would be both noisy and a good way to put a password in a video.
 */
export function keyLabel(event: KeyboardEvent): string {
  const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  const parts: string[] = [];
  if (event.ctrlKey) parts.push(apple ? '\u2303' : 'Ctrl');
  if (event.altKey) parts.push(apple ? '\u2325' : 'Alt');
  if (event.shiftKey) parts.push(apple ? '\u21e7' : 'Shift');
  if (event.metaKey) parts.push(apple ? '\u2318' : 'Meta');

  const named: Record<string, string> = {
    ' ': 'Space', ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
    Enter: '\u21b5', Backspace: '\u232b', Escape: 'Esc', Tab: '\u21e5', Delete: 'Del',
  };
  const key = named[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return parts.join(' ');
  parts.push(key);
  return parts.join(' ');
}

/**
 * Whether a keypress is worth showing.
 *
 * Plain typing is not: it is noise, and a recording that draws every character
 * somebody types is one password away from being unpublishable. Shortcuts are
 * the point, so anything with a modifier other than shift, or a named key,
 * counts.
 */
export function worthShowing(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return true;
  return event.key.length > 1 && event.key !== 'Shift' && event.key !== 'Unidentified';
}

export type Recording = {
  blob: Blob;
  duration: number;
  width: number;
  height: number;
  /** Present only when the recording was of this page. */
  pointer: PointerSample[];
  clicks: ClickSample[];
  /** Shortcuts pressed during the recording, for teaching videos. */
  keys: KeySample[];
  /** Moments marked while recording, which become chapters. */
  marks: MarkSample[];
  /** A separate camera recording, when one was made. */
  camera: Blob | null;
  hasAudio: boolean;
};

/**
 * Turns a chosen device id into a constraint.
 *
 * Deliberately not `exact`. An exact id that has gone away throws
 * OverconstrainedError and loses the whole recording, which is a bad trade for
 * a preference; asking nicely falls back to the default device instead.
 */
function deviceConstraint(id: string | undefined): MediaTrackConstraints | true {
  return id && id !== 'default' ? { deviceId: id } : true;
}

export type CaptureDevice = { id: string; label: string };

/**
 * The microphones and cameras this browser will admit to having.
 *
 * Labels are empty until the user has granted permission at least once, which
 * is a privacy measure rather than a bug, so unnamed devices are numbered
 * instead of shown blank. Callers re-run this after a recording, by which point
 * the real names are available.
 */
export async function listDevices(): Promise<{ microphones: CaptureDevice[]; cameras: CaptureDevice[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { microphones: [], cameras: [] };
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return { microphones: [], cameras: [] };
  }

  const pick = (kind: MediaDeviceKind, noun: string): CaptureDevice[] =>
    devices
      .filter((device) => device.kind === kind && device.deviceId)
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `${noun} ${index + 1}`,
      }));

  return { microphones: pick('audioinput', 'Microphone'), cameras: pick('videoinput', 'Camera') };
}

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
  /**
   * Which devices to record from, when a machine has more than one.
   *
   * Undefined or 'default' means "let the browser choose", which is what
   * happens on a laptop with one microphone and one camera. An id that no
   * longer resolves, because the device was unplugged between choosing and
   * recording, falls back to the default rather than failing the recording.
   */
  microphoneId?: string;
  cameraId?: string;
  /**
   * Ask the platform to blur behind the camera. Chrome hands this to the
   * operating system, which is the only place it can be done properly. When a
   * device cannot, the picture is simply not blurred and the app says so.
   */
  cameraBlur?: boolean;
  onTick: (seconds: number) => void;
  /**
   * Called with each chunk as it arrives, roughly once a second.
   *
   * This is how a recording gets written down before it is finished. Capture
   * stays unaware of where that is: it hands over the bytes and the caller
   * decides. Deliberately not awaited, because a slow write must never stall
   * the recorder or lose the chunk after it.
   */
  onChunk?: (kind: 'screen' | 'camera', seq: number, blob: Blob) => void;
  /** Called when a chapter is marked, so the page can acknowledge it. */
  onMark?: (count: number) => void;
  /**
   * Called once everything is acquired and before the first frame is kept.
   *
   * The countdown belongs here rather than before the share dialog: counting
   * down and then asking what to share would waste the count, and counting
   * down after recording has begun would put the numbers in the video.
   */
  onReady?: () => Promise<void> | void;
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
  private readonly keys: KeySample[] = [];
  private readonly marks: MarkSample[] = [];
  private tracking = false;
  private width = 0;
  private height = 0;
  private audio = false;
  private blurred = false;

  constructor(private readonly options: CaptureOptions) {}

  get running(): boolean {
    return this.recorder !== null;
  }

  /** Whether the platform actually blurred behind the camera when asked. */
  get cameraBlurred(): boolean {
    return this.blurred;
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
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: deviceConstraint(this.options.microphoneId),
        });
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
    this.recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      this.chunks.push(event.data);
      this.options.onChunk?.('screen', this.chunks.length - 1, event.data);
    };

    if (this.options.camera) {
      try {
        const wanted = deviceConstraint(this.options.cameraId);
        const camera = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            // A chosen camera wins over facingMode, which would otherwise pull
            // the browser back to the front-facing one on a phone.
            ...(typeof wanted === 'object' ? wanted : { facingMode: 'user' }),
          },
        });
        this.streams.push(camera);
        if (this.options.cameraBlur) this.blurred = await applyBackgroundBlur(camera);
        this.cameraRecorder = new MediaRecorder(camera, mime ? { mimeType: mime } : undefined);
        this.cameraRecorder.ondataavailable = (event) => {
          if (!event.data.size) return;
          this.cameraChunks.push(event.data);
          this.options.onChunk?.('camera', this.cameraChunks.length - 1, event.data);
        };
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
      window.addEventListener('keydown', this.onKeyDown, { capture: true });
    }
    // Marking works whatever is being recorded, because it is a key pressed in
    // this tab about the recording rather than a key pressed inside it.
    window.addEventListener('keydown', this.onMarkKey, { capture: true });

    // Nothing has been kept yet, so a countdown here costs the recording nothing.
    await this.options.onReady?.();
    if (!this.recorder) return;

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

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!worthShowing(event)) return;
    const label = keyLabel(event);
    if (!label) return;
    const time = (performance.now() - this.startedAt) / 1000;
    const last = this.keys[this.keys.length - 1];
    // A held key repeats; showing the same combination forty times is not
    // informative and looks broken.
    if (last && last.label === label && time - last.time < 0.4) return;
    this.keys.push({ time, label });
  };

  /** M marks a chapter. Ignored while typing, so it cannot eat a keystroke. */
  private readonly onMarkKey = (event: KeyboardEvent) => {
    if (event.key !== 'm' && event.key !== 'M') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (target?.isContentEditable) return;
    this.marks.push({
      time: (performance.now() - this.startedAt) / 1000,
      label: `Chapter ${this.marks.length + 1}`,
    });
    this.options.onMark?.(this.marks.length);
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
      keys: [...this.keys],
      marks: [...this.marks],
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
    // Registered whatever was being recorded, so removed unconditionally.
    window.removeEventListener('keydown', this.onMarkKey, { capture: true });
    if (this.tracking) {
      window.removeEventListener('pointermove', this.onPointerMove, { capture: true });
      window.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      window.removeEventListener('keydown', this.onKeyDown, { capture: true });
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

/**
 * Asks the platform to blur behind the camera.
 *
 * Doing this properly means separating a person from what is behind them, which
 * is a segmentation model, not something to reimplement in a canvas. Chrome
 * exposes the operating system's own version as a track constraint on hardware
 * that supports it. Anywhere else the ask is refused, and reporting that is
 * better than shipping a blur that smears the person along with the room.
 */
export async function applyBackgroundBlur(stream: MediaStream): Promise<boolean> {
  const [track] = stream.getVideoTracks();
  if (!track) return false;

  const supported = navigator.mediaDevices.getSupportedConstraints() as Record<string, unknown>;
  if (!supported.backgroundBlur) return false;

  try {
    await track.applyConstraints({ advanced: [{ backgroundBlur: true }] } as MediaTrackConstraints);
    return (track.getSettings() as { backgroundBlur?: boolean }).backgroundBlur === true;
  } catch {
    return false;
  }
}
