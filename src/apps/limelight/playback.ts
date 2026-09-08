import type { Recording } from './capture';
import type { Placed } from './reel';
import type { Settings } from './store';
import { seekSafely } from './videoEvents';
import type { Span } from './waveform';
type VideoWithFrameCallback = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number; cancelVideoFrameCallback?: (handle: number) => void };

interface Context {
  video: HTMLVideoElement | null;
  previewTime: number;
  takes: Map<string, { video: HTMLVideoElement; hasAudio: boolean }>;
  recording: Recording | null;
  playing: boolean;
  cameraVideo: HTMLVideoElement | null;
  cropping: boolean;
  settings: Settings;
  trim: { start: number; end: number };
  cuts: Span[];
  volInput: HTMLInputElement;
  playButton: HTMLButtonElement;
  loopButton: HTMLButtonElement;
  muteButton: HTMLButtonElement;
  volWrap: HTMLLabelElement;
  $: <T extends HTMLElement>(id: string) => T;
  placedClips: () => Placed[];
  spotAt: (time: number) => { element: HTMLVideoElement; at: number; clip: Placed | null };
  syncScrub: () => void;
  paint: (time: number) => void;
  drawPreview: () => Promise<void>;
  setStatus: (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => void;
}

/** Owns playback behavior; live accessors keep edits and restored state in sync. */
export function mountPlayback(c: Context) {
  let looping = false;
  let muted = false;
  let frameHandle = 0;
  let rafHandle = 0;
  let stage: HTMLVideoElement | null = null;
  let stageClip: Placed | null = null;

  function driver(): HTMLVideoElement | null {
    return stage ?? c.video;
  }

  /** Element time to reel time. The identity when there is one recording. */
  function reelTime(): number {
    const element = driver();
    if (!element) return c.previewTime;
    if (!stageClip) return element.currentTime;
    return stageClip.at + Math.max(0, element.currentTime - stageClip.in);
  }

  function clipAudioLevel(clip: Placed | null, sourceTime: number): number {
    if (!clip) return 1;
    if (clip.muted) return 0;
    const local = Math.max(0, sourceTime - clip.in);
    const enter = clip.fadeIn ? Math.min(1, local / clip.fadeIn) : 1;
    const leave = clip.fadeOut ? Math.min(1, Math.max(0, clip.length - local) / clip.fadeOut) : 1;
    return Math.max(0, Math.min(2, clip.gain ?? 1)) * Math.min(enter, leave);
  }

  function applyPlaybackVolume(element: HTMLVideoElement, clip: Placed | null): void {
    const hasSound = clip
      ? c.takes.get(clip.source)?.hasAudio ?? c.recording?.hasAudio ?? false
      : c.recording?.hasAudio ?? false;
    const level = clipAudioLevel(clip, element.currentTime);
    element.muted = muted || !hasSound || level <= 0;
    element.volume = Math.max(0, Math.min(1, Number(c.volInput.value) * level));
  }

  function stopFrames(): void {
    const element = driver();
    if (frameHandle && element) {
      const cancel = (element as VideoWithFrameCallback).cancelVideoFrameCallback;
      if (typeof cancel === 'function') cancel.call(element, frameHandle);
    }
    if (rafHandle) cancelAnimationFrame(rafHandle);
    frameHandle = 0;
    rafHandle = 0;
  }

  function queueFrame(): void {
    const element = driver();
    if (!element || !c.playing) return;
    const request = (element as VideoWithFrameCallback).requestVideoFrameCallback;
    if (typeof request === 'function') frameHandle = request.call(element, () => step());
    else rafHandle = requestAnimationFrame(() => step());
  }

  /**
   * Hands playback from one clip to the next.
   *
   * Two elements are never playing at once: the one that has finished is
   * stopped before the next is started, or a join would play both recordings
   * over each other for as long as the handover took.
   */
  async function handOver(to: Placed): Promise<void> {
    const leaving = driver();
    if (leaving) { leaving.pause(); leaving.muted = true; }
    stopFrames();

    const arriving = c.takes.get(to.source)?.video ?? c.video;
    if (!arriving) { pause(); return; }
    stage = arriving;
    stageClip = to;

    await seekSafely(arriving, to.in).catch(() => {});
    applyPlaybackVolume(arriving, to);
    try {
      await arriving.play();
    } catch {
      pause();
      return;
    }
    queueFrame();
  }

  function step(): void {
    const element = driver();
    if (!c.playing || !element || !c.recording) return;

    // A clip that has played to its own end hands over rather than running on
    // into whatever else happens to be in that recording after the window.
    if (stageClip && element.currentTime >= stageClip.out - 1e-3) {
      const placed = c.placedClips();
      const next = placed[placed.findIndex((entry) => entry.id === stageClip!.id) + 1];
      if (next) { void handOver(next); return; }
    }

    const time = reelTime();
    applyPlaybackVolume(element, stageClip);

    if (time >= c.trim.end - 1e-3) {
      if (looping) { void restart(); return; }
      pause();
      c.previewTime = c.trim.end;
      c.syncScrub();
      c.paint(c.previewTime);
      return;
    }

    // Skip anything cut out, so the preview is the finished video rather than
    // the raw recording with some bands drawn on it.
    const inCut = c.cuts.find((cut) => time >= cut.start && time < cut.end - 1e-3);
    if (inCut) {
      if (inCut.end >= c.trim.end - 1e-3) {
        if (looping) { void restart(); return; }
        pause();
        c.previewTime = c.trim.end;
        c.syncScrub();
        c.paint(c.previewTime);
        return;
      }
      // The cut is in reel seconds. On a reel the far side of it may be in a
      // different recording, in which case the handover does the seeking.
      const landing = c.spotAt(inCut.end);
      if (stageClip && landing.clip && landing.clip.id !== stageClip.id) {
        void handOver(landing.clip).then(() => {
          const arriving = driver();
          if (arriving) arriving.currentTime = landing.at;
        });
        return;
      }
      element.currentTime = landing.at;
      if (c.cameraVideo) c.cameraVideo.currentTime = inCut.end;
      queueFrame();
      return;
    }

    c.previewTime = time;
    c.syncScrub();
    c.paint(time);
    queueFrame();
  }

  async function restart(): Promise<void> {
    if (!c.video) return;
    const spot = c.spotAt(c.trim.start);
    if (spot.clip && spot.clip.id !== stageClip?.id) {
      c.previewTime = c.trim.start;
      await handOver(spot.clip);
      const arriving = driver();
      if (arriving) arriving.currentTime = spot.at;
      c.syncScrub();
      return;
    }
    await seekSafely(spot.element, spot.at);
    if (c.cameraVideo) await seekSafely(c.cameraVideo, c.trim.start).catch(() => {});
    c.previewTime = c.trim.start;
    c.syncScrub();
    queueFrame();
  }

  async function play(): Promise<void> {
    if (!c.video || !c.recording || c.playing || c.cropping) return;
    if (c.previewTime >= c.trim.end - 1e-3 || c.previewTime < c.trim.start) c.previewTime = c.trim.start;

    // Playback begins on whichever recording the playhead is over, which on a
    // reel of one is the only one there is.
    const spot = c.spotAt(c.previewTime);
    stage = spot.element;
    stageClip = spot.clip;

    const limit = Number.isFinite(spot.element.duration) && spot.element.duration > 0
      ? spot.element.duration
      : c.recording.duration;
    await seekSafely(spot.element, Math.max(0, Math.min(limit - 1e-3, spot.at)));
    if (c.cameraVideo) {
      await seekSafely(c.cameraVideo, Math.min(Math.max(0, c.cameraVideo.duration - 1e-3), c.previewTime)).catch(() => {});
    }

    // Muted for scrubbing, unmuted to play. Without this you cannot hear your
    // own narration while editing, which is most of what there is to check.
    applyPlaybackVolume(spot.element, spot.clip);

    c.playing = true;
    renderTransport();
    try {
      await spot.element.play();
      if (c.cameraVideo) await c.cameraVideo.play().catch(() => {});
    } catch {
      c.playing = false;
      renderTransport();
      c.setStatus('The browser would not start playback.', 'bad');
      return;
    }
    queueFrame();
  }

  function pause(): void {
    if (!c.playing) return;
    c.playing = false;
    stopFrames();
    // Every element, not only the one driving: a handover leaves the previous
    // one paused, and muting all of them keeps scrubbing silent.
    for (const take of c.takes.values()) { take.video.pause(); take.video.muted = true; }
    c.video?.pause();
    c.cameraVideo?.pause();
    if (c.video) c.video.muted = true;
    renderTransport();
  }

  function togglePlay(): void {
    if (c.playing) pause();
    else void play();
  }

  /** Reflects playback state onto the transport. */
  function renderTransport(): void {
    c.playButton.textContent = c.playing ? '⏸' : '▶';
    c.playButton.title = c.playing ? 'Pause (Space)' : 'Play (Space)';
    c.playButton.setAttribute('aria-label', c.playing ? 'Pause' : 'Play');
    c.playButton.dataset.playing = String(c.playing);
    c.playButton.disabled = !c.recording || c.cropping;
    c.loopButton.setAttribute('aria-pressed', String(looping));
    c.muteButton.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
    c.muteButton.title = muted ? 'Unmute' : 'Mute';
    c.muteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    c.muteButton.setAttribute('aria-pressed', String(muted));
    // Nothing to hear on a silent recording, so the control does not appear.
    c.volWrap.hidden = !c.recording?.hasAudio;
    for (const id of ['ll-to-start', 'll-step-back', 'll-step-fwd', 'll-to-end']) {
      c.$<HTMLButtonElement>(id).disabled = !c.recording;
    }
  }

  /**
   * Moves the playhead into a block so its edits are visible in the preview.
   *
   * Editing a zoom at 0:40 while looking at 0:05 showed nothing changing, and
   * read as a broken control rather than a preview pointed elsewhere.
   */
  function showBlock(start: number, end: number): void {
    if (!c.recording) return;
    if (c.previewTime >= start && c.previewTime <= end) return;
    if (c.playing) pause();
    c.previewTime = Math.min(Math.max((start + end) / 2, 0), c.recording.duration);
    c.syncScrub();
    void c.drawPreview();
  }

  /** Moves the playhead, stopping playback first, and repaints. */
  function seekTo(time: number): void {
    if (!c.recording) return;
    if (c.playing) pause();
    c.previewTime = Math.max(0, Math.min(c.recording.duration, time));
    c.syncScrub();
    void c.drawPreview();
  }

  c.playButton.addEventListener('click', togglePlay);
  c.$<HTMLButtonElement>('ll-to-start').addEventListener('click', () => seekTo(c.trim.start));
  c.$<HTMLButtonElement>('ll-to-end').addEventListener('click', () => seekTo(c.trim.end));
  c.$<HTMLButtonElement>('ll-step-back').addEventListener('click', () => {
    seekTo(c.previewTime - 1 / Math.max(1, c.settings.frameRate));
  });
  c.$<HTMLButtonElement>('ll-step-fwd').addEventListener('click', () => {
    seekTo(c.previewTime + 1 / Math.max(1, c.settings.frameRate));
  });

  c.loopButton.addEventListener('click', () => {
    looping = !looping;
    renderTransport();
  });

  c.muteButton.addEventListener('click', () => {
    muted = !muted;
    if (c.video && c.playing) c.video.muted = muted;
    renderTransport();
  });

  c.volInput.addEventListener('input', () => {
    const level = Number(c.volInput.value);
    if (c.video) c.video.volume = level;
    // Reaching for the volume when muted plainly means "let me hear it".
    if (level > 0 && muted) {
      muted = false;
      if (c.video && c.playing) c.video.muted = false;
      renderTransport();
    }
  });


  return { renderTransport, pause, showBlock, seekTo, togglePlay, play };
}
