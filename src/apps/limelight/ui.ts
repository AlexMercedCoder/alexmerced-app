import { formatBytes } from '../../lib/bytes';
import { createId } from '../../lib/id';
import { readPref, writePref } from '../../lib/prefs';
import { downloadBlob, downloadFile } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { registerTools } from '../../lib/webmcp';
import type { Interest } from './attention';
import {
  canCapture, CaptureError, listDevices, recordingMime, Session,
  type CaptureDevice, type Recording, type Source,
} from './capture';
import {
  CAMERA_SHAPES, cameraRect, CROP_ASPECTS, cropRect, cropToAspect, defaultComposition, FULL_CROP,
  isFullCrop, MIN_CROP, normaliseCrop, OUTPUT_SIZES, PRESETS, QUALITY,
  type CameraCorner, type CameraShape, type Composition, type Crop,
} from './layout';
import { countdown } from './countdown';
import { History } from './history';
import { defaultTilt, MOTIONS, type Motion } from './plate';
import { limelightTools } from './mcp';
import {
  capabilities, drawFrame, findInterest, render, RenderError,
  type ExportResult, type OutputFormat, type Progress, type Project,
} from './render';
import { canExportInWorker, renderInWorker } from './offload';
import {
  applyLook, createProject, deleteLook, deleteProject, loadCurrentId, loadLooks, loadProject,
  loadProjects, loadSettings, lookFrom, oldestProjects, openScratch, saveCurrentId, saveLook,
  saveProject, saveSettings, storageRoom, StorageFullError, storedBytes,
  type Look, type Project as StoredProject, type ScratchSession, type Settings,
} from './store';
import {
  addText, constrainText, duplicateText, MIN_TEXT, removeText, splitText, updateText,
  type TextBlock,
} from './text';
import { defaultZoom, viewRect, zoomAt, type ZoomSettings } from './zoom';
import {
  analyseAudio, findSilences, joinWaves, keptDuration, mergeSpans,
  type Peak, type Span, type Wave,
} from './waveform';
import {
  addSpeed, clampSpeed, editedAt, editedDuration, removeSpeed, segmentsOf, sortSpeeds,
  type SpeedRegion,
} from './timeline';
import {
  addRedaction, rectAt, redactionsAt, removeRedaction, REDACT_STYLES, setPoint, sortRedactions,
  type RedactBlock, type RedactStyle,
} from './redact';
import {
  alignToEdit, parseCaptions, sortCues, spansOf, toSrt, toVtt, type Cue,
} from './captions';
import {
  addShape, removeShape, SHAPE_COLOURS, SHAPE_KINDS, sortShapes, updateShape,
  type Shape, type ShapeKind,
} from './shapes';
import { canTranscribe, transcribe, WHISPER_MODELS, type WhisperSize } from './transcribe';
import { mountBlockTrack } from './blockTrack';
import { mountSpeaker } from './announce';
import { mountHelp } from './helpSheet';
import { mountPopout } from './popout';
import { mountChapters } from './chapters';
import { mountFilmstrip } from './filmstrip';
import {
  applySidecar, readSidecar, sidecarFilename, sidecarLoses, sidecarMismatch, sidecarSize,
  sidecarTakes, sidecarVideo, writeSidecar,
} from './sidecar';
import { describeTidy, planTidy, tidyChangesAnything } from './tidy';
import {
  isPlainRecording, joins, layout, moveClip, moveClipTo, reelDuration, remapBlocks,
  removeClip, shiftAfter, singleClip, sourceOf, splice, splitAt, updateClip,
  type Clip, type Placed,
} from './reel';
import {
  GENERAL_HELP, SHORTCUT_GROUPS, SHORTCUTS, shortcutFor, TRACK_HELP, trackHelp,
  type ShortcutId, type TrackName,
} from './help';
import {
  addBlock, blocksFromInterest, constrain, duplicateBlock, mergeBlocks, MIN_BLOCK, removeBlock,
  reviveBlocks, splitBlock, trackFromBlocks, type ZoomBlock,
} from './zooms';


/**
 * requestVideoFrameCallback is not in the DOM lib everywhere yet, and Firefox
 * still does not ship it, so it is described here and treated as optional.
 */
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export async function mountLimelight(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const statusEl = $<HTMLParagraphElement>('ll-status');
  const barEl = $<HTMLDivElement>('ll-bar');
  const barFill = $<HTMLDivElement>('ll-bar-fill');
  const recordButton = $<HTMLButtonElement>('ll-record');
  const clockEl = $<HTMLSpanElement>('ll-clock');
  const stageEl = $<HTMLDivElement>('ll-stage');
  const canvas = $<HTMLCanvasElement>('ll-preview');
  const scrubber = $<HTMLInputElement>('ll-scrub');
  const editorEl = $<HTMLDivElement>('ll-editor');
  const sourceNote = $<HTMLParagraphElement>('ll-source-note');
  const playButton = $<HTMLButtonElement>('ll-play');
  const loopButton = $<HTMLButtonElement>('ll-loop');
  const muteButton = $<HTMLButtonElement>('ll-mute');
  const volInput = $<HTMLInputElement>('ll-vol');
  const volWrap = $<HTMLLabelElement>('ll-vol-wrap');
  const aimButton = $<HTMLButtonElement>('ll-zoom-aim');
  const aimNote = $<HTMLParagraphElement>('ll-aim-note');

  let settings = loadSettings();
  let session: Session | null = null;
  let recording: Recording | null = null;
  let video: HTMLVideoElement | null = null;
  let cameraVideo: HTMLVideoElement | null = null;
  /**
   * The reel, and an element for each recording on it.
   *
   * One clip is the ordinary case and everything behaves as it always did. More
   * than one and the seconds every other part of the editor works in belong to
   * the reel rather than to any one recording, so only the two places that
   * actually touch pixels or samples look inside.
   */
  let clips: Clip[] = [];
  /**
   * Where the take now being recorded is going.
   *
   * Null means it replaces everything, which is what Record has always done.
   * A span means it is a retake and lands in place of that stretch, which is
   * decided before recording starts because that is when the person said so.
   */
  let recordingInto: { start: number; end: number } | null = null;
  const takes = new Map<string, {
    blob: Blob; video: HTMLVideoElement; duration: number; hasAudio: boolean;
  }>();
  /** The id the first recording always has, so lookups need no special case. */
  const FIRST_TAKE = 'take-1';

  /** Whether clips still describe the untouched first recording. */
  function hasEditedReel(value: Clip[] = clips): boolean {
    const firstDuration = takes.get(FIRST_TAKE)?.duration ?? recording?.duration ?? 0;
    return !isPlainRecording(value, FIRST_TAKE, firstDuration);
  }

  /** Only recordings named by the current reel affect saving and sound. */
  function activeTakeIds(value: Clip[] = clips): Set<string> {
    return new Set(value.map((clip) => clip.source));
  }

  function reelHasAudio(value: Clip[] = clips): boolean {
    const active = activeTakeIds(value);
    return [...active].some((id) => takes.get(id)?.hasAudio === true);
  }
  let urls: string[] = [];
  let points: Interest[] = [];
  let interestSource: 'pointer' | 'motion' | 'none' = 'none';
  let controller: AbortController | null = null;
  let previewTime = 0;
  let stored: StoredProject | null = null;
  let zooms: ZoomBlock[] = [];
  let texts: TextBlock[] = [];
  let crop: Crop = { ...FULL_CROP };
  let trim = { start: 0, end: 0 };
  /** Playback state. The video element carries the position; these carry intent. */
  let playing = false;
  let looping = false;
  let muted = false;
  let frameHandle = 0;
  let rafHandle = 0;
  /** The zoom whose focal point is being shown on the canvas, if any. */
  let focusTarget: ZoomBlock | null = null;
  let draggingFocus = false;
  /** Stretches removed from the middle, and the decoded sound they came from. */
  let cuts: Span[] = [];
  /** The zoom being edited, if any. */
  let selected: string | null = null;
  /** Stretches that run at a different pace, and the one being edited. */
  let speeds: SpeedRegion[] = [];
  let selectedSpeed: string | null = null;
  /** Rectangles covered over, and the one being edited. */
  let redactions: RedactBlock[] = [];
  /** Subtitles, and which lines are selected for cutting. */
  let captions: Cue[] = [];
  /** Arrows, boxes and highlights, and the one being edited. */
  let shapes: Shape[] = [];
  let selectedShape: string | null = null;
  let draggingShape: { x: number; y: number } | null = null;
  const pickedCues = new Set<string>();
  let selectedRedaction: string | null = null;
  let draggingRedaction = false;
  let wave: { peaks: Peak[]; loudness: Float32Array; duration: number } | null = null;
  let selection: { start: number; end: number } | null = null;
  let selectingWave = false;
  /** Everything an undo has to put back. The recording itself never changes. */
  type EditorState = {
    settings: Settings;
    zooms: ZoomBlock[];
    texts: TextBlock[];
    cuts: Span[];
    speeds: SpeedRegion[];
    redactions: RedactBlock[];
    captions: Cue[];
    shapes: Shape[];
    crop: Crop;
    trim: { start: number; end: number };
    wallpaper: Uint8Array | null;
    wallpaperMime: string;
    /**
     * The reel, because adding a clip or taking one again is an edit.
     *
     * Leaving it out was worse than an undo that did nothing: the blocks moved
     * back to where they were before the splice while the timeline stayed the
     * new length, so everything landed in the wrong place.
     */
    clips: Clip[];
  };
  const history = new History<EditorState>({
    settings, zooms, texts, cuts: [], speeds: [], redactions: [], captions: [], shapes: [],
    crop, trim, wallpaper: null, wallpaperMime: 'image/png', clips: [],
  });
  /** Set while a state is being put back, so restoring does not record itself. */
  let restoring = false;
  let saveTimer = 0;

  /**
   * The live region, which is how any of this reaches somebody not watching.
   *
   * Progress goes through `progress` rather than `say` so a two minute export
   * is four sentences instead of four hundred.
   */
  const speaker = mountSpeaker($<HTMLParagraphElement>('ll-said'));

  const setStatus = (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => {
    statusEl.textContent = message;
    statusEl.dataset.state = state;
    // A busy message is a stage report and arrives many times a second. Those
    // are announced by the progress calls, at a quarter at a time.
    if (state !== 'busy') speaker.say(message);
  };

  /**
   * Records an edit and writes it down.
   *
   * Everything editable goes through here. Persisting a subset was the shape of
   * a real bug: a caption added through WebMCP updated the page and the state
   * and then quietly failed to survive a reload, because the code that wrote
   * captions was a different function that path did not call.
   */
  const remember = (label = '') => {
    record(label);
    invalidateTrack();
    saveSettings(settings);
    if (stored) {
      stored.settings = settings;
      stored.start = trim.start;
      stored.end = trim.end;
      stored.crop = crop;
      stored.zooms = zooms;
      stored.texts = texts;
      stored.cuts = cuts;
      stored.speeds = speeds;
      stored.redactions = redactions;
      stored.captions = captions;
      stored.shapes = shapes;
      // Derived from the blocks, and stored alongside them so a reopened
      // project renders exactly as it did.
      stored.keyframes = trackFromBlocks(zooms, recording?.duration ?? 0, settings.zoom);
      // The reel, and the recordings it names. A project of one take writes
      // neither, so nothing changes for the ordinary case or for a file written
      // before clips existed.
      // The clips are cheap and go now. The recordings they name are read from
      // their blobs by the save itself, which is already asynchronous.
      stored.clips = hasEditedReel() ? clips : [];
      queueSave();
    }
  };

  // ------------------------------------------------------------------ history

  function snapshot(): EditorState {
    return {
      settings, zooms, texts, cuts, speeds, redactions, captions, shapes,
      crop, trim, wallpaper: wallpaperBytes, wallpaperMime, clips,
    };
  }

  /**
   * Records the state after an edit.
   *
   * A label folds a run of edits into one step, which is what stops a slider
   * drag becoming four hundred things to undo.
   */
  function record(label = ''): void {
    if (restoring || !recording) return;
    history.push(snapshot(), label);
    renderHistory();
  }

  async function restore(state: EditorState): Promise<void> {
    restoring = true;
    // Set when an undo changes the length of the reel, which the waveform, the
    // filmstrip and the joins are all measured against.
    let reelChanged = false;
    try {
      settings = state.settings;
      zooms = state.zooms;
      texts = state.texts;
      cuts = state.cuts;
      speeds = state.speeds;
      redactions = state.redactions;
      captions = state.captions;
      shapes = state.shapes;
      crop = state.crop;
      trim = { ...state.trim };

      // The reel comes back with everything else. Its length is what the
      // scrubber, the trim bar and every track measure against, so restoring
      // the blocks without it puts them all in the wrong place.
      if (state.clips.length > 0 && recording) {
        const wasLength = recording.duration;
        clips = state.clips;
        recording.duration = reelDuration(clips);
        recording.hasAudio = reelHasAudio(clips);
        if (Math.abs(wasLength - recording.duration) > 0.001) {
          scrubber.max = String(Math.max(0.1, recording.duration));
          $<HTMLSpanElement>('ll-total').textContent = `/ ${formatClock(recording.duration)}`;
          previewTime = Math.min(previewTime, recording.duration);
          reelChanged = true;
        }
      }
      // The picture is held as bytes in the snapshot, so an undo across a
      // change of background has to decode it again rather than assume the
      // one already loaded is the right one.
      if (state.wallpaper !== wallpaperBytes) {
        if (state.wallpaper) await useWallpaper(state.wallpaper, state.wallpaperMime);
        else dropWallpaper();
      }
      if (settings.composition.background === 'image' && !wallpaper) {
        settings.composition.background = 'gradient';
      }
      if (selected && !zooms.some((zoom) => zoom.id === selected)) selected = null;
      if (selectedText && !texts.some((text) => text.id === selectedText)) selectedText = null;

      if (stored) {
        stored.wallpaper = state.wallpaper;
        stored.wallpaperMime = state.wallpaperMime;
      }
      // record() is inert while restoring, so this writes without recording
      // the restore as something new to undo.
      remember();
    } finally {
      restoring = false;
    }

    renderControls();
    renderTrim();
    renderCrop();
    renderZooms();
    renderTexts();
    renderCuts();
    renderSpeeds();
    renderRedactions();
    renderShapes();
    renderCues();
    renderClips();
    renderHistory();
    syncScrub();
    if (reelChanged) {
      await rebuildWave();
      drawStrip();
    }
    await drawPreview();
  }

  function renderHistory(): void {
    $<HTMLButtonElement>('ll-undo').disabled = !history.canUndo;
    $<HTMLButtonElement>('ll-redo').disabled = !history.canRedo;
  }

  async function undoEdit(): Promise<void> {
    const state = history.undo();
    // Saying nothing when there is nothing left to undo is the point: silence
    // after a key press reads as broken, so it says so.
    speaker.say(state ? 'Undone.' : 'Nothing left to undo.');
    if (state) await restore(state);
  }

  async function redoEdit(): Promise<void> {
    const state = history.redo();
    speaker.say(state ? 'Redone.' : 'Nothing left to redo.');
    if (state) await restore(state);
  }

  $<HTMLButtonElement>('ll-undo').addEventListener('click', () => { void undoEdit(); });
  $<HTMLButtonElement>('ll-redo').addEventListener('click', () => { void redoEdit(); });

  /** Writing tens of megabytes on every slider nudge would make this stutter. */
  /**
   * The further recordings as the database wants them.
   *
   * Read from their blobs at the moment of writing rather than held alongside
   * them, so a session with three retakes in it holds three recordings and not
   * six. The read is cheap next to the write it precedes.
   */
  async function takeRecords(): Promise<{ id: string; bytes: Uint8Array; mime: string }[]> {
    if (!hasEditedReel()) return [];
    const active = activeTakeIds();
    const out: { id: string; bytes: Uint8Array; mime: string }[] = [];
    for (const [id, take] of takes) {
      if (id === FIRST_TAKE || !active.has(id)) continue;
      const bytes = await take.blob.arrayBuffer().catch(() => null);
      // A take whose bytes cannot be read is left out rather than written as an
      // empty record the reel would point at and find nothing behind.
      if (bytes) out.push({ id, bytes: new Uint8Array(bytes), mime: take.blob.type || 'video/webm' });
    }
    return out;
  }

  function queueSave(): void {
    if (!stored) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void (async () => {
        if (!stored) return;
        // Filled in here rather than in `remember`, which is synchronous and
        // runs on every slider nudge.
        stored.takes = await takeRecords();
        if (stored) await saveProject(stored);
      })();
    }, 600);
  }

  // ------------------------------------------------------------------ project

  /** The reel, laid out. Empty for the ordinary one recording case. */
  function placedClips(): Placed[] {
    return hasEditedReel() ? layout(clips) : [];
  }

  /**
   * Which recording a moment on the reel belongs to, and the element for it.
   *
   * With one recording this is the identity: the same element, the same time.
   * That is what keeps the single case exactly as fast and exactly as tested as
   * it was.
   */
  function spotAt(time: number): { element: HTMLVideoElement; at: number; clip: Placed | null } {
    const placed = placedClips();
    if (placed.length === 0 || !video) {
      return { element: video!, at: time, clip: null };
    }
    const found = sourceOf(placed, time);
    const clip = placed.find((entry) => entry.id === found?.clip) ?? null;
    return {
      element: (found ? takes.get(found.source)?.video : null) ?? video,
      at: found?.time ?? time,
      clip,
    };
  }

  /** The takes as the renderer wants them: a blob and an element per recording. */
  function takesForRender(): Map<string, { blob: Blob; video: HTMLVideoElement }> {
    const out = new Map<string, { blob: Blob; video: HTMLVideoElement }>();
    const active = activeTakeIds();
    for (const [id, take] of takes) {
      if (active.has(id)) out.set(id, { blob: take.blob, video: take.video });
    }
    return out;
  }

  function project(): Project | null {
    if (!video || !recording) return null;
    return {
      clips: hasEditedReel() ? clips : undefined,
      takes: hasEditedReel() ? takesForRender() : undefined,
      video,
      camera: cameraVideo,
      source: recording.blob,
      duration: recording.duration,
      sourceWidth: video.videoWidth || recording.width,
      sourceHeight: video.videoHeight || recording.height,
      pointer: recording.pointer,
      clicks: recording.clicks,
      crop,
      texts,
      wallpaper,
      composition: settings.composition,
      zoom: settings.zoom,
      tilt: settings.tilt,
      motion: settings.motion,
      frameRate: settings.frameRate,
      bitrate: suggestBitrate(),
      showClicks: settings.showClicks,
      showCursor: settings.showCursor && recording.pointer.length > 0,
      cursorSize: settings.cursorSize,
      spotlight: recording.pointer.length > 0 ? settings.spotlight : 0,
      showKeys: settings.showKeys,
      keys: recording.keys,
      // Aligned to the finished video, since a cut moves every later line.
      captions: settings.burnCaptions ? alignedCaptions() : [],
      captionSize: settings.captionSize,
      shapes,
      voice: settings.voice,
      music: musicSamples,
      musicSettings: settings.music,
      format: settings.format,
      gifColours: 128,
      keepAudio: settings.keepAudio && recording.hasAudio,
      cuts,
      speeds,
      redactions,
      start: trim.start,
      end: trim.end > trim.start ? trim.end : recording.duration,
    };
  }

  function suggestBitrate(): number {
    const { width, height } = settings.composition;
    const factor = QUALITY.find((entry) => entry.id === settings.quality)?.factor ?? 1;
    const base = width * height * settings.frameRate * 0.09;
    return Math.max(800_000, Math.min(80_000_000, Math.round(base * factor)));
  }

  // ------------------------------------------------------------------ capture

  if (!canCapture()) {
    recordButton.disabled = true;
    setStatus('This browser cannot record the screen. Chrome, Edge and Firefox on a desktop can; phones cannot.', 'bad');
  }

  // ------------------------------------------------------------------ devices

  /**
   * Which microphone and camera to record from.
   *
   * A picker only appears when there is a choice to make: one microphone needs
   * no menu. Labels stay empty until permission has been granted at least once,
   * so the list is refreshed after every recording, by which point the names
   * have arrived and the numbered placeholders can be replaced.
   */
  let devices: { microphones: CaptureDevice[]; cameras: CaptureDevice[] } = { microphones: [], cameras: [] };

  function fillDevicePicker(
    select: HTMLSelectElement, wrap: HTMLElement, found: CaptureDevice[], chosen: string,
  ): void {
    // More than one is a choice. Exactly one is just a fact about the machine.
    wrap.hidden = found.length < 2;
    select.innerHTML = '';
    const options = [{ id: 'default', label: 'Whatever the browser picks' }, ...found];
    for (const device of options) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.label;
      select.append(option);
    }
    // A device that has gone away leaves a stored id pointing at nothing, so
    // the menu falls back to the default rather than showing an empty box.
    select.value = options.some((device) => device.id === chosen) ? chosen : 'default';
  }

  async function renderDevices(): Promise<void> {
    devices = await listDevices();
    fillDevicePicker(
      $<HTMLSelectElement>('ll-mic-device'), $<HTMLLabelElement>('ll-mic-pick'),
      devices.microphones, settings.microphoneId,
    );
    fillDevicePicker(
      $<HTMLSelectElement>('ll-camera-device'), $<HTMLLabelElement>('ll-camera-pick'),
      devices.cameras, settings.cameraId,
    );
    const anyPicker = devices.microphones.length > 1 || devices.cameras.length > 1;
    $<HTMLDivElement>('ll-devices').hidden = !anyPicker;
    // Only worth explaining the missing names while they are actually missing.
    $<HTMLParagraphElement>('ll-devices-note').hidden =
      !anyPicker || [...devices.microphones, ...devices.cameras].every((device) => device.label && !/^(Microphone|Camera) \d+$/.test(device.label));
  }

  $<HTMLSelectElement>('ll-mic-device').addEventListener('change', (event) => {
    settings.microphoneId = (event.target as HTMLSelectElement).value;
    remember();
  });
  $<HTMLSelectElement>('ll-camera-device').addEventListener('change', (event) => {
    settings.cameraId = (event.target as HTMLSelectElement).value;
    remember();
  });
  $<HTMLButtonElement>('ll-devices-refresh').addEventListener('click', () => { void renderDevices(); });

  // Plugging a headset in mid-session should be enough to make it offerable.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { void renderDevices(); });

  recordButton.addEventListener('click', async () => {
    if (session?.running) {
      recordButton.disabled = true;
      try {
        const result = await session.stop();
        if (recordingInto) {
          // A retake joins the recording that is already open rather than
          // replacing it, so nothing about the existing edit is lost.
          await spliceTake(result.blob, recordingInto);
        } else {
          await load(result);
          await keep({
            ...result,
            duration: recording?.duration ?? result.duration,
            width: video?.videoWidth || result.width,
            height: video?.videoHeight || result.height,
          }, `Recording ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'The recording could not be finished.', 'bad');
      } finally {
        session = null;
        recordingInto = null;
        recordButton.disabled = false;
        recordButton.textContent = 'Record';
        recordButton.classList.remove('is-recording');
        clockEl.textContent = '';
        // Kept properly now, so the safety net is no longer needed.
        void openScratch().then((net) => net.discardAll()).catch(() => {});
        // Permission has now been granted at least once, so the devices have
        // real names to show instead of "Microphone 1".
        void renderDevices();
      }
      return;
    }

    const source = ($<HTMLInputElement>('ll-source-tab').checked ? 'tab' : 'screen') as Source;
    // A fresh safety net for this recording. Anything left from a previous one
    // has either been kept or already offered back, so it goes now.
    const scratchId = createId('take');
    const net = await openScratch().catch(() => null);
    await net?.discardAll().catch(() => {});
    await net?.begin({
      id: scratchId,
      startedAt: new Date().toISOString(),
      mime: recordingMime() || 'video/webm',
    }).catch(() => {});

    session = new Session({
      source,
      onChunk: (kind, seq, blob) => {
        // Not awaited on purpose: the recorder must not wait for a disk write.
        void net?.append(scratchId, kind, seq, blob).catch(() => {});
      },
      microphone: $<HTMLInputElement>('ll-mic').checked,
      systemAudio: $<HTMLInputElement>('ll-system-audio').checked,
      camera: $<HTMLInputElement>('ll-camera').checked,
      microphoneId: settings.microphoneId,
      cameraId: settings.cameraId,
      cameraBlur: settings.cameraBlur,
      onTick: (seconds) => { clockEl.textContent = formatClock(seconds); },
      onReady: () => countdown({ seconds: settings.countdown, sound: settings.countdownSound }),
    });

    try {
      recordButton.textContent = 'Starting';
      await session.start();
      recordButton.textContent = 'Stop';
      recordButton.classList.add('is-recording');
      if (settings.cameraBlur && $<HTMLInputElement>('ll-camera').checked && !session.cameraBlurred) {
        toast('This device will not blur behind the camera, so it is being recorded as it is.');
      }
      setStatus(
        source === 'tab'
          ? 'Recording this tab. Pointer movement and clicks are being tracked, so the zoom will follow them exactly.'
          : 'Recording. The browser will not tell a page where the pointer is on another window, so the zoom will follow where the picture changes instead.',
        'busy',
      );
    } catch (error) {
      session = null;
      recordButton.textContent = 'Record';
      recordButton.classList.remove('is-recording');
      setStatus(error instanceof CaptureError ? error.message : 'The recording could not start.', 'bad');
    }
  });

  // ------------------------------------------------------------------ loading

  /** Stores a fresh recording so a reload cannot lose it. */
  async function keep(result: Recording, name: string): Promise<void> {
    const project = createProject(name, {
      bytes: new Uint8Array(await result.blob.arrayBuffer()),
      mime: result.blob.type || 'video/webm',
      cameraBytes: result.camera ? new Uint8Array(await result.camera.arrayBuffer()) : null,
      duration: result.duration,
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio,
      pointer: result.pointer,
      clicks: result.clicks,
      keys: result.keys,
      marks: result.marks,
      settings,
    });
    stored = project;
    saveCurrentId(project.id);
    await saveWithRoom(project);
    await renderProjects();
  }

  /**
   * Saves a project, and offers to make room when there is none.
   *
   * A refused write is a lost recording, so it is worth interrupting somebody
   * over. The offer names the oldest project rather than clearing everything,
   * because the alternative to losing this recording should not be losing all
   * of the previous ones.
   */
  async function saveWithRoom(project: StoredProject): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await saveProject(project);
        return;
      } catch (error) {
        if (!(error instanceof StorageFullError)) throw error;
        const candidates = (await oldestProjects()).filter((entry) => entry.id !== project.id);
        if (candidates.length === 0) {
          setStatus('There is no room left in this browser, and nothing older to remove.', 'bad');
          throw error;
        }
        const oldest = candidates[0];
        const size = oldest.bytes.length + (oldest.cameraBytes?.length ?? 0);
        const room = confirm(
          `There is no room left to keep this recording.\n\n`
          + `Remove the oldest one, "${oldest.name}" (${formatBytes(size)}), to make space?`,
        );
        if (!room) throw error;
        await deleteProject(oldest.id).catch(() => {});
        toast(`Removed ${oldest.name} to make room.`);
      }
    }
    throw new StorageFullError('There is still no room after clearing space.');
  }

  /** Reopens one that was stored earlier. */
  async function open(id: string): Promise<void> {
    const project = await loadProject(id);
    if (!project) return;
    stored = project;
    settings = project.settings;
    zooms = project.zooms;
    texts = project.texts;
    cuts = project.cuts;
    speeds = project.speeds;
    redactions = project.redactions;
    captions = project.captions;
    shapes = project.shapes;
    musicSamples = project.music ? await decodeMusic(project.music) : null;
    crop = project.crop;
    dropWallpaper();
    if (project.wallpaper) await useWallpaper(project.wallpaper, project.wallpaperMime);
    saveCurrentId(project.id);

    await renderProjects();
    await load({
      blob: new Blob([project.bytes as unknown as BlobPart], { type: project.mime }),
      duration: project.duration,
      width: project.width,
      height: project.height,
      pointer: project.pointer,
      clicks: project.clicks,
      keys: project.keys,
      marks: project.marks,
      camera: project.cameraBytes ? new Blob([project.cameraBytes as unknown as BlobPart], { type: project.mime }) : null,
      hasAudio: project.hasAudio,
    }, { start: project.start, end: project.end });

    // The reel is restored after the recording, because `load` resets it to the
    // single clip it always starts as.
    await restoreReel(project.takes ?? [], project.clips ?? [], {
      start: project.start, end: project.end,
    });
  }

  /**
   * Puts a saved reel back together.
   *
   * Every extra recording has to be readable again before the clips that name
   * it mean anything, so a take that will not load takes its clips with it
   * rather than leaving the reel pointing at a hole.
   */
  async function restoreReel(
    saved: { id: string; bytes: Uint8Array; mime: string }[],
    savedClips: Clip[],
    range: { start: number; end: number },
  ): Promise<void> {
    if (savedClips.length === 0 || !recording) return;

    const found = new Set<string>([FIRST_TAKE]);
    for (const take of saved) {
      const blob = new Blob([take.bytes as unknown as BlobPart], { type: take.mime });
      const element = document.createElement('video');
      element.muted = true;
      element.playsInline = true;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      element.src = url;
      try {
        await once(element, 'loadedmetadata');
      } catch {
        continue;
      }
      if (!Number.isFinite(element.duration) || element.duration === 0) {
        await seekSafely(element, 1e6);
        await seekSafely(element, 0);
      }
      const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
      if (duration <= 0) continue;
      takes.set(take.id, { blob, video: element, duration, hasAudio: true });
      found.add(take.id);
    }

    const usable = savedClips.filter((clip) => found.has(clip.source));
    if (usable.length === 0) return;

    clips = usable;
    recording.duration = reelDuration(clips);
    recording.hasAudio = reelHasAudio(clips);
    trim = {
      start: Math.max(0, Math.min(range.start, recording.duration)),
      end: range.end > range.start ? Math.min(range.end, recording.duration) : recording.duration,
    };
    scrubber.max = String(Math.max(0.1, recording.duration));
    $<HTMLSpanElement>('ll-total').textContent = `/ ${formatClock(recording.duration)}`;

    renderTrim();
    renderZooms();
    renderTexts();
    renderSpeeds();
    renderRedactions();
    renderShapes();
    renderCues();
    renderPicker();
    renderClips();
    await rebuildWave();
    await drawPreview();
    drawStrip();

    // `load` reset the history before the reel was put back, so its baseline
    // was a project of one recording. Left alone, the first undo of the session
    // would throw the whole reel away, which is not an edit anybody made.
    history.reset(snapshot());
    renderHistory();
  }

  async function load(result: Recording, range?: { start: number; end: number }): Promise<void> {
    release();
    recording = result;

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(result.blob);
    urls.push(url);
    video.src = url;
    await once(video, 'loadedmetadata');

    // A MediaRecorder file often reports no duration until it is seeked once.
    if (!Number.isFinite(video.duration) || video.duration === 0) {
      await seekSafely(video, 1e6);
      await seekSafely(video, 0);
    }
    recording.duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : result.duration;

    // Every project is a reel of one until something is added to it. Holding it
    // that way from the start means the reel code is exercised by the ordinary
    // case rather than only by the rare one.
    takes.clear();
    takes.set(FIRST_TAKE, {
      blob: result.blob,
      video,
      duration: recording.duration,
      hasAudio: result.hasAudio,
    });
    clips = [singleClip(FIRST_TAKE, recording.duration)];

    if (result.camera) {
      cameraVideo = document.createElement('video');
      cameraVideo.muted = true;
      cameraVideo.playsInline = true;
      const cameraUrl = URL.createObjectURL(result.camera);
      urls.push(cameraUrl);
      cameraVideo.src = cameraUrl;
      await once(cameraVideo, 'loadedmetadata').catch(() => {});
      settings.composition.camera.enabled = true;
      remember();
    }

    if (!stored) {
      crop = { ...FULL_CROP }; texts = []; cuts = []; speeds = []; redactions = []; captions = []; shapes = [];
      dropWallpaper();
    }

    trim = range && range.end > range.start
      ? { start: Math.max(0, range.start), end: Math.min(recording.duration, range.end) }
      : { start: 0, end: recording.duration };

    stageEl.hidden = false;
    editorEl.hidden = false;
    scrubber.max = String(Math.max(0.1, recording.duration));
    scrubber.value = String(trim.start);
    previewTime = trim.start;
    $<HTMLSpanElement>('ll-total').textContent = `/ ${formatClock(recording.duration)}`;
    renderTransport();

    setStatus(
      `${video.videoWidth} by ${video.videoHeight}, ${formatClock(recording.duration)}, ${formatBytes(result.blob.size)}.`,
      'good',
    );

    renderControls();
    renderTrim();
    renderCrop();
    renderZooms();
    renderTexts();
    renderSpeeds();
    renderRedactions();
    renderShapes();
    renderChapters();
    renderCues();
    renderClips();
    renderMusic();
    renderDestinations();
    renderPicker();
    showFirstTime(activeTrack);
    await loadWaveform();
    // A reopened project already has its zooms, so it does not analyse again.
    if (zooms.length === 0) await analyse();
    else sourceNote.hidden = true;

    // The history starts here, after any analysis. Finding the action is what
    // the app does on your behalf, not something you did, so undo should not
    // walk back into a recording that has never been zoomed.
    history.reset(snapshot());
    renderHistory();
    await drawPreview();
    // Last, and not awaited: the strip is worth having and worth nothing if it
    // delays the recording appearing.
    drawStrip();
  }

  async function analyse(): Promise<void> {
    const current = project();
    if (!current) return;

    controller = new AbortController();
    barEl.hidden = false;
    try {
      const found = await findInterest(current, onProgress, controller.signal);
      points = found.points;
      interestSource = found.source;
      // A re-analysis must not undo work: anything edited by hand is kept.
      zooms = mergeBlocks(zooms, blocksFromInterest(points, current.duration, settings.zoom));
      renderZooms();
      persistZooms();

      const clicks = recording?.clicks.length ?? 0;
      const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

      sourceNote.textContent =
        interestSource === 'pointer'
          ? `Following the pointer: ${plural(clicks, 'click', 'clicks')} and ${plural(points.length, 'place', 'places')} it settled.`
          : interestSource === 'motion'
            ? `No pointer track, because a browser is not told where the cursor is over another window. Following where the picture changed instead: ${plural(points.length, 'moment', 'moments')}.`
            : 'Nothing moved enough to zoom to. The whole frame will be shown throughout.';
      sourceNote.hidden = false;
    } catch (error) {
      if (!(error instanceof RenderError && error.message === 'Cancelled.')) {
        setStatus(error instanceof Error ? error.message : 'The recording could not be analysed.', 'bad');
      }
    } finally {
      controller = null;
      barEl.hidden = true;
    }
  }

  function onProgress(progress: { stage: string; done: number; total: number }): void {
    barFill.style.width = `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`;
    setStatus(`${progress.stage}: ${progress.done} of ${progress.total}.`, 'busy');
    speaker.progress(progress.stage, progress.total > 0 ? progress.done / progress.total : null);
  }

  // ------------------------------------------------------------------ projects

  async function renderProjects(): Promise<void> {
    const list = $<HTMLDivElement>('ll-projects');
    const projects = await loadProjects();
    list.innerHTML = '';

    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'll-project';
      if (stored && project.id === stored.id) row.setAttribute('aria-current', 'true');

      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'll-project__open';
      openButton.innerHTML = `<strong>${escapeHtml(project.name)}</strong>`
        + `<span>${formatClock(project.duration)} · ${project.width} by ${project.height}`
        + `${project.hasAudio ? ' · sound' : ''}</span>`;
      openButton.addEventListener('click', () => { void open(project.id); });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'll-project__remove';
      remove.innerHTML = '&times;';
      remove.title = `Delete ${project.name}`;
      remove.setAttribute('aria-label', `Delete ${project.name}`);
      remove.addEventListener('click', async () => {
        if (!confirm(`Delete "${project.name}"? The recording cannot be made again.`)) return;
        await deleteProject(project.id);
        if (stored?.id === project.id) {
          stored = null;
          saveCurrentId(null);
        }
        await renderProjects();
        void refreshStorage();
      });

      row.append(openButton, remove);
      list.append(row);
    }

    $<HTMLDivElement>('ll-projects-empty').hidden = projects.length > 0;
    void refreshStorage();
  }

  async function refreshStorage(): Promise<void> {
    const total = await storedBytes();
    const room = await storageRoom();
    const parts: string[] = [];
    if (total > 0) parts.push(`${formatBytes(total)} of recordings kept here`);
    // Only worth mentioning the headroom once it is small enough to matter. A
    // browser reporting tens of gigabytes free is noise.
    if (room) {
      const left = Math.max(0, room.quota - room.used);
      if (left < 2_000_000_000) parts.push(`${formatBytes(left)} of room left`);
    }
    $<HTMLSpanElement>('ll-storage').textContent = parts.join(', ');
  }

  // ------------------------------------------------------------------ trim

  const trimEl = $<HTMLDivElement>('ll-trim');
  const trimRange = $<HTMLDivElement>('ll-trim-range');

  /** Thumbnails behind the trim range. Decoration, so nothing waits on it. */
  const filmstrip = mountFilmstrip($<HTMLCanvasElement>('ll-strip'));

  /**
   * Redraws the strip, coalesced.
   *
   * A resize fires continuously and each draw walks the file, so the last one
   * wins after things have settled rather than starting a decode per pixel.
   */
  let stripTimer = 0;
  function drawStrip(delay = 0): void {
    window.clearTimeout(stripTimer);
    stripTimer = window.setTimeout(() => {
      if (!recording || !video) { filmstrip.clear(); return; }
      // One piece per clip, which for the ordinary single recording is a list
      // of one covering the whole thing.
      const pieces = clips.length > 0
        ? clips.flatMap((clip) => {
          const take = takes.get(clip.source);
          return take ? [{ blob: take.blob, video: take.video, in: clip.in, out: clip.out }] : [];
        })
        : [{ blob: recording.blob, video, in: 0, out: recording.duration }];
      void filmstrip.draw(pieces);
    }, delay);
  }

  window.addEventListener('resize', () => drawStrip(250));

  function renderTrim(): void {
    if (!recording) return;
    const duration = Math.max(0.001, recording.duration);
    trimRange.style.left = `${(trim.start / duration) * 100}%`;
    trimRange.style.width = `${((trim.end - trim.start) / duration) * 100}%`;

    // The joins. Without a mark there, a reel looks like one take that changes
    // shot for no reason, and a retake looks like a glitch.
    const joinsEl = $<HTMLDivElement>('ll-joins');
    joinsEl.innerHTML = '';
    for (const at of joins(placedClips())) {
      const mark = document.createElement('span');
      mark.style.left = `${(at / duration) * 100}%`;
      joinsEl.append(mark);
    }
    $<HTMLSpanElement>('ll-trim-label').textContent =
      `${formatClock(trim.start)} to ${formatClock(trim.end)}, ${formatClock(trim.end - trim.start)} long`;
  }

  let trimming: 'start' | 'end' | null = null;

  function trimTimeAt(event: PointerEvent): number {
    if (!recording) return 0;
    const box = trimEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * recording.duration;
  }

  trimEl.addEventListener('pointerdown', (event) => {
    if (!recording) return;
    const time = trimTimeAt(event);
    // Grab whichever handle is nearer, so a drag anywhere moves the closer end.
    trimming = Math.abs(time - trim.start) <= Math.abs(time - trim.end) ? 'start' : 'end';
    try { trimEl.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
    applyTrim(time);
  });

  trimEl.addEventListener('pointermove', (event) => {
    if (trimming) applyTrim(trimTimeAt(event));
  });

  const endTrim = () => {
    if (!trimming) return;
    trimming = null;
    remember();
    previewTime = trim.start;
    scrubber.value = String(previewTime);
    void drawPreview();
  };
  trimEl.addEventListener('pointerup', endTrim);
  trimEl.addEventListener('pointercancel', endTrim);

  function applyTrim(time: number): void {
    if (!recording || !trimming) return;
    if (trimming === 'start') trim.start = Math.min(time, trim.end - 0.1);
    else trim.end = Math.max(time, trim.start + 0.1);
    trim.start = Math.max(0, trim.start);
    trim.end = Math.min(recording.duration, trim.end);
    renderTrim();
  }

  $<HTMLButtonElement>('ll-trim-start').addEventListener('click', () => {
    if (!recording) return;
    trim.start = Math.min(previewTime, trim.end - 0.1);
    renderTrim();
    remember();
  });

  $<HTMLButtonElement>('ll-trim-end').addEventListener('click', () => {
    if (!recording) return;
    trim.end = Math.max(previewTime, trim.start + 0.1);
    renderTrim();
    remember();
  });

  /**
   * The whole first pass, as one press and one undo.
   *
   * Cuts and zooms are two separate edits everywhere else in the editor, and
   * doing them as two here would mean two presses of Ctrl+Z to get back to
   * where you were. So the state is set in one go and `remember` is called
   * once, which is the only thing that decides what an undo step is.
   */
  // ------------------------------------------------------------------ the reel

  /**
   * Takes a recording onto the reel and gives back what the clip needs.
   *
   * The element is made here and kept for as long as the take is: playback
   * hands over to it, the preview seeks it, and the filmstrip draws from it.
   */
  async function addTake(blob: Blob): Promise<{
    id: string; duration: number; hasAudio: boolean; width: number; height: number;
  } | null> {
    const id = createId('take');
    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    element.src = url;

    try {
      await once(element, 'loadedmetadata');
    } catch {
      return null;
    }
    // A MediaRecorder file often reports no duration until it is seeked once.
    if (!Number.isFinite(element.duration) || element.duration === 0) {
      await seekSafely(element, 1e6);
      await seekSafely(element, 0);
    }
    const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
    if (duration <= 0) return null;

    // Nothing reads a track list off a file reliably, so this is the practical
    // test: if the sound decodes, there is sound.
    const analysed = await analyseAudio(blob).catch(() => null);
    // The blob is the only copy kept. Reading it into an array as well was a
    // second full copy of every take resident for the whole session, which on a
    // hundred megabyte retake is a hundred megabytes for nothing: the bytes are
    // wanted twice, when the project is saved and when a file is written, and
    // both of those already wait for other things.
    takes.set(id, { blob, video: element, duration, hasAudio: !!analysed });
    takeWaves.set(id, analysed);
    return {
      id, duration, hasAudio: !!analysed,
      width: element.videoWidth, height: element.videoHeight,
    };
  }

  /** Every take analysed once, so the reel waveform can be rebuilt cheaply. */
  const takeWaves = new Map<string, Wave | null>();

  /** The sound track under the timeline, built across whatever is on the reel. */
  async function rebuildWave(): Promise<void> {
    if (!recording) return;
    if (!hasEditedReel()) { await loadWaveform(); return; }

    for (const id of activeTakeIds()) {
      const take = takes.get(id);
      if (!take) continue;
      if (!takeWaves.has(id)) takeWaves.set(id, await analyseAudio(take.blob).catch(() => null));
    }
    wave = joinWaves(clips.map((clip) => ({
      wave: takeWaves.get(clip.source) ?? null,
      in: clip.in,
      out: clip.out,
    })));
    selection = null;
    $<HTMLDivElement>('ll-cutrow').hidden = !wave;
    renderPicker();
    drawWave();
    renderCuts();
  }

  /**
   * Everything on the timeline moves with a splice.
   *
   * Zooms, captions, subtitles, cover ups, shapes, speed regions and cuts are
   * all written against the same line of seconds, so a retake that is longer or
   * shorter than what it replaced moves every one of them. Missing any single
   * list would leave that kind of block behind while the rest moved, which
   * looks exactly like the app having lost track of your edits.
   */
  function shiftEverything(from: number, by: number): void {
    if (by === 0) return;
    zooms = shiftAfter(zooms, from, by);
    texts = shiftAfter(texts, from, by);
    speeds = shiftAfter(speeds, from, by);
    redactions = shiftAfter(redactions, from, by);
    shapes = shiftAfter(shapes, from, by);
    captions = shiftAfter(captions, from, by);
    cuts = shiftAfter(cuts, from, by);
  }

  /** Applies a new reel: length, trim, tracks and the picture. */
  async function adoptReel(next: Clip[], said: string): Promise<void> {
    if (!recording) return;
    const wasWhole = Math.abs(trim.end - recording.duration) < 0.05 && trim.start < 0.05;
    clips = next;
    recording.duration = reelDuration(clips);
    recording.hasAudio = reelHasAudio(clips);

    // A trim nobody had touched follows the reel. One that was set by hand is
    // clamped instead, because moving it would throw away a deliberate choice.
    trim = wasWhole
      ? { start: 0, end: recording.duration }
      : {
        start: Math.min(trim.start, Math.max(0, recording.duration - 0.1)),
        end: Math.min(trim.end, recording.duration),
      };

    scrubber.max = String(Math.max(0.1, recording.duration));
    $<HTMLSpanElement>('ll-total').textContent = `/ ${formatClock(recording.duration)}`;
    previewTime = Math.min(previewTime, trim.end);

    // Structural edits are deliberate steps. Coalescing two quick operations
    // (for example split, then remove) makes Undo jump over both of them.
    remember();
    renderTrim();
    renderZooms();
    renderTexts();
    renderSpeeds();
    renderRedactions();
    renderShapes();
    renderCues();
    renderPicker();
    renderClips();
    renderTransport();
    syncScrub();
    await rebuildWave();
    await drawPreview();
    drawStrip();
    setStatus(said, 'good');
    toast(said, { kind: 'good', actionLabel: 'Undo', onAction: () => { void undoEdit(); } });
  }

  /**
   * The clips, as something to point at.
   *
   * Until now a clip could be added and a stretch retaken, and a clip added by
   * mistake could only be undone. Two takes recorded in the wrong order could
   * not be swapped at all. Both are edits people expect to be able to make
   * directly rather than by starting again.
   */
  function renderClips(): void {
    const holder = $<HTMLDivElement>('ll-clips');
    holder.innerHTML = '';
    holder.hidden = !hasEditedReel();
    if (holder.hidden) return;

    for (const [index, clip] of layout(clips).entries()) {
      const chip = document.createElement('div');
      chip.className = 'll-clip';
      chip.draggable = true;
      chip.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', clip.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        chip.classList.add('is-dragging');
      });
      chip.addEventListener('dragend', () => chip.classList.remove('is-dragging'));
      chip.addEventListener('dragover', (event) => { event.preventDefault(); });
      chip.addEventListener('drop', (event) => {
        event.preventDefault();
        const id = event.dataTransfer?.getData('text/plain');
        if (id) void reorderClipTo(id, index);
      });

      const take = takes.get(clip.source);
      if (take?.video.src) {
        const thumb = document.createElement('video');
        thumb.className = 'll-clip__thumb';
        thumb.src = take.video.src;
        thumb.currentTime = Math.min(clip.in, Math.max(0, take.duration - 0.05));
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.preload = 'metadata';
        thumb.setAttribute('aria-hidden', 'true');
        chip.append(thumb);
      }

      const body = document.createElement('div');
      body.className = 'll-clip__body';
      const head = document.createElement('div');
      head.className = 'll-clip__head';
      const name = document.createElement('input');
      name.className = 'll-clip__name';
      name.value = clip.name ?? `Clip ${index + 1}`;
      name.setAttribute('aria-label', `Name clip ${index + 1}`);
      name.addEventListener('change', () => updateClipDetails(clip.id, { name: name.value }, 'Renamed the clip.'));
      const length = document.createElement('span');
      length.textContent = formatClock(clip.length);
      head.append(name, length);
      body.append(head);

      const actions = document.createElement('div');
      actions.className = 'll-clip__actions';

      for (const [by, glyph, says] of [
        [-1, '\u2190', 'earlier'], [1, '\u2192', 'later'],
      ] as [-1 | 1, string, string][]) {
        const move = document.createElement('button');
        move.type = 'button';
        move.textContent = glyph;
        move.title = `Move clip ${index + 1} ${says}`;
        move.setAttribute('aria-label', move.title);
        move.disabled = by === -1 ? index === 0 : index === clips.length - 1;
        move.addEventListener('click', () => { void reorderClip(clip.id, by); });
        actions.append(move);
      }

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'll-clip__drop';
      drop.textContent = '\u00d7';
      drop.title = `Remove clip ${index + 1}`;
      drop.setAttribute('aria-label', drop.title);
      drop.addEventListener('click', () => { void dropClip(clip.id); });
      actions.append(drop);
      body.append(actions);

      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Trim and sound';
      details.append(summary);
      const controls = document.createElement('div');
      controls.className = 'll-clip__settings';
      const numeric = (
        label: string, value: number, min: number, max: number, step: number,
        change: (value: number) => void,
      ) => {
        const field = document.createElement('label');
        field.textContent = label;
        const input = document.createElement('input');
        input.type = 'number'; input.value = String(Number(value.toFixed(2)));
        input.min = String(min); input.max = String(max); input.step = String(step);
        input.addEventListener('change', () => change(Number(input.value)));
        field.append(input); controls.append(field);
      };
      const sourceDuration = take?.duration ?? clip.out;
      numeric('In', clip.in, 0, Math.max(0, sourceDuration - 0.05), 0.05,
        (value) => { void editClipWindow(clip.id, { in: value }); });
      numeric('Out', clip.out, 0.05, sourceDuration, 0.05,
        (value) => { void editClipWindow(clip.id, { out: value }); });
      numeric('Volume', clip.gain ?? 1, 0, 2, 0.05,
        (value) => updateClipDetails(clip.id, { gain: value }, 'Changed the clip volume.'));
      numeric('Fade in', clip.fadeIn ?? 0, 0, clip.length, 0.05,
        (value) => updateClipDetails(clip.id, { fadeIn: value }, 'Changed the clip fade.'));
      numeric('Fade out', clip.fadeOut ?? 0, 0, clip.length, 0.05,
        (value) => updateClipDetails(clip.id, { fadeOut: value }, 'Changed the clip fade.'));
      const mute = document.createElement('label');
      const muteInput = document.createElement('input');
      muteInput.type = 'checkbox'; muteInput.checked = clip.muted === true;
      muteInput.addEventListener('change', () =>
        updateClipDetails(clip.id, { muted: muteInput.checked }, muteInput.checked ? 'Muted the clip.' : 'Unmuted the clip.'));
      mute.append(muteInput, document.createTextNode(' Mute'));
      controls.append(mute);
      const normalise = document.createElement('button');
      normalise.type = 'button'; normalise.textContent = 'Normalise clip';
      normalise.addEventListener('click', () => { void normaliseClipAudio(clip.id); });
      controls.append(normalise);
      if (index < clips.length - 1) {
        const smooth = document.createElement('button');
        smooth.type = 'button'; smooth.textContent = 'Smooth next join';
        smooth.title = 'Fade this clip out while the next clip fades in';
        smooth.addEventListener('click', () => smoothClipJoin(clip.id));
        controls.append(smooth);
      }
      details.append(controls);
      body.append(details);
      chip.append(body);

      holder.append(chip);
    }
  }

  /**
   * Applies a reel whose clips have moved rather than grown.
   *
   * Removing and reordering are not a shift: a caption written over the third
   * take belongs to the third take and goes wherever it goes. `remapBlocks`
   * answers that for every list at once, and reports what it had to drop
   * because the clip it belonged to is gone.
   */
  async function adoptReorder(next: Clip[], said: string): Promise<void> {
    if (!recording) return;
    const before = layout(clips);
    const after = layout(next);

    let dropped = 0;
    const move = <T extends { start: number; end: number }>(list: T[]): T[] => {
      const out = remapBlocks(list, before, after, () => createId('block'));
      dropped += out.dropped;
      return out.blocks;
    };
    zooms = move(zooms);
    texts = move(texts);
    speeds = move(speeds);
    redactions = move(redactions);
    shapes = move(shapes);
    captions = move(captions);
    cuts = move(cuts);

    await adoptReel(next, dropped > 0
      ? `${said} ${dropped} ${dropped === 1 ? 'edit' : 'edits'} on it went too.`
      : said);
  }

  async function dropClip(id: string): Promise<void> {
    const next = removeClip(clips, id);
    if (next.length === clips.length) return;
    if (next.length === 0) {
      setStatus('That is the only clip left. Discard the recording instead.', 'bad');
      return;
    }
    const gone = clips.find((clip) => clip.id === id);
    await adoptReorder(next, `Removed a clip of ${formatClock(gone ? gone.out - gone.in : 0)}.`);
  }

  async function reorderClip(id: string, by: -1 | 1): Promise<void> {
    const next = moveClip(clips, id, by);
    if (next === clips) return;
    await adoptReorder(next, `Moved a clip ${by === -1 ? 'earlier' : 'later'}.`);
  }

  async function reorderClipTo(id: string, index: number): Promise<void> {
    const next = moveClipTo(clips, id, index);
    if (next === clips) return;
    await adoptReorder(next, 'Reordered the clips.');
  }

  async function editClipWindow(
    id: string, change: Partial<Pick<Clip, 'in' | 'out'>>,
  ): Promise<void> {
    const clip = clips.find((entry) => entry.id === id);
    if (!clip) return;
    const next = updateClip(clips, id, change, takes.get(clip.source)?.duration);
    await adoptReorder(next, 'Trimmed the clip.');
  }

  function updateClipDetails(
    id: string,
    change: Partial<Pick<Clip, 'name' | 'gain' | 'muted' | 'fadeIn' | 'fadeOut'>>,
    said: string,
  ): void {
    const clip = clips.find((entry) => entry.id === id);
    if (!clip) return;
    clips = updateClip(clips, id, change, takes.get(clip.source)?.duration);
    const field = Object.keys(change)[0] ?? 'detail';
    remember(`clip:${id}:${field}`);
    renderClips();
    renderTransport();
    void drawPreview();
    setStatus(said, 'good');
  }

  async function normaliseClipAudio(id: string): Promise<void> {
    const clip = clips.find((entry) => entry.id === id);
    const take = clip ? takes.get(clip.source) : null;
    if (!clip || !take) return;
    let analysed = takeWaves.get(clip.source);
    if (analysed === undefined) {
      analysed = await analyseAudio(take.blob).catch(() => null);
      takeWaves.set(clip.source, analysed);
    }
    if (!analysed || analysed.loudness.length === 0) {
      setStatus('That clip has no sound to normalise.', 'bad');
      return;
    }
    const from = Math.floor((clip.in / analysed.duration) * analysed.loudness.length);
    const to = Math.max(from + 1, Math.ceil((clip.out / analysed.duration) * analysed.loudness.length));
    let peak = 0;
    for (const value of analysed.loudness.subarray(from, to)) peak = Math.max(peak, value);
    if (peak <= 1e-4) { setStatus('That clip is silent.', 'bad'); return; }
    // RMS columns sit well below sample peaks. Bringing the loudest column to
    // 0.22 is a useful speech level while the two-times cap leaves headroom.
    updateClipDetails(id, { gain: Math.max(0.25, Math.min(2, 0.22 / peak)) }, 'Normalised the clip volume.');
  }

  function smoothClipJoin(id: string): void {
    const index = clips.findIndex((clip) => clip.id === id);
    const current = clips[index];
    const next = clips[index + 1];
    if (!current || !next) return;
    const duration = Math.min(0.25, (current.out - current.in) / 2, (next.out - next.in) / 2);
    clips = updateClip(clips, current.id, { fadeOut: duration }, takes.get(current.source)?.duration);
    clips = updateClip(clips, next.id, { fadeIn: duration }, takes.get(next.source)?.duration);
    remember(`clip:${current.id}:join`);
    renderClips();
    renderTransport();
    void drawPreview();
    setStatus(`Smoothed the next join over ${duration.toFixed(2)} seconds.`, 'good');
  }

  async function splitClipHere(): Promise<void> {
    if (!recording) return;
    const next = splitAt(clips, previewTime, () => createId('clip'));
    if (next.length === clips.length) {
      setStatus('Move the playhead inside a clip to split it.', 'bad');
      return;
    }
    await adoptReel(next, `Split the clip at ${formatClock(previewTime)}.`);
  }

  /** Puts a recording on the end of the reel. */
  async function appendClip(blob: Blob): Promise<void> {
    if (!recording) return;
    const take = await addTake(blob);
    if (!take) {
      setStatus('That file could not be read as a video.', 'bad');
      return;
    }
    warnIfDifferentShape(take);
    await adoptReel(
      [...clips, { id: createId('clip'), source: take.id, in: 0, out: take.duration }],
      `Added ${formatClock(take.duration)} to the end.`,
    );
  }

  /**
   * Puts a recording in place of a stretch of the reel.
   *
   * The stretch is whatever is selected on the sound track, and failing that
   * the moment the playhead is on, which inserts rather than replaces.
   */
  async function spliceTake(blob: Blob, span: { start: number; end: number }): Promise<void> {
    if (!recording) return;
    const take = await addTake(blob);
    if (!take) {
      setStatus('That recording could not be read.', 'bad');
      return;
    }
    warnIfDifferentShape(take);

    const out = splice(
      clips, span,
      { id: createId('clip'), source: take.id, in: 0, out: take.duration },
      () => createId('clip'),
    );
    shiftEverything(out.at, out.shift);
    const replaced = Math.abs(span.end - span.start);
    await adoptReel(out.clips, replaced > 0.05
      ? `Replaced ${formatClock(replaced)} with ${formatClock(take.duration)}.`
      : `Dropped ${formatClock(take.duration)} in at ${formatClock(out.at)}.`);
  }

  /**
   * A take of a different shape is not refused, only pointed out.
   *
   * The composition draws every recording into the same frame, so a take with
   * different proportions is stretched to fit. That is occasionally what
   * somebody wants and usually a mistake, and the only way to tell is to ask.
   */
  function warnIfDifferentShape(take: { width: number; height: number }): void {
    const first = takes.get(FIRST_TAKE);
    if (!first || take.width <= 0 || first.video.videoWidth <= 0) return;
    if (take.width === first.video.videoWidth && take.height === first.video.videoHeight) return;
    toast(
      `That take is ${take.width} by ${take.height} and the rest are `
      + `${first.video.videoWidth} by ${first.video.videoHeight}, so it will be stretched to fit.`,
    );
  }

  /**
   * Records a replacement for a stretch of the reel.
   *
   * The stretch is whatever is selected on the sound track. With nothing
   * selected the playhead is used, which is a stretch of no length, so the new
   * take is dropped in rather than replacing anything. That is the more
   * forgiving reading of an ambiguous press: adding is undoable in the obvious
   * way and losing a passage you did not mean to lose is not.
   */
  $<HTMLButtonElement>('ll-retake').addEventListener('click', () => {
    if (!recording || session?.running) return;
    const span = selection
      ? { start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end) }
      : { start: previewTime, end: previewTime };
    recordingInto = span;
    pause();
    toast(span.end - span.start > 0.05
      ? `Recording over ${formatClock(span.end - span.start)}. Press Stop when you are done.`
      : `Recording in at ${formatClock(span.start)}. Press Stop when you are done.`);
    recordButton.click();
  });

  const clipFileInput = $<HTMLInputElement>('ll-clip-file');
  $<HTMLButtonElement>('ll-add-clip').addEventListener('click', () => clipFileInput.click());
  $<HTMLButtonElement>('ll-split-clip').addEventListener('click', () => { void splitClipHere(); });
  clipFileInput.addEventListener('change', () => {
    const file = clipFileInput.files?.[0];
    clipFileInput.value = '';
    if (file) void appendClip(file);
  });

  async function tidyUp(): Promise<void> {
    if (!recording) return;
    const button = $<HTMLButtonElement>('ll-tidy');
    button.disabled = true;
    try {
      // The attention pass may never have run: a reopened project skips it,
      // and so does one that already had zooms.
      if (points.length === 0) {
        const current = project();
        if (current) {
          controller = new AbortController();
          barEl.hidden = false;
          try {
            const found = await findInterest(current, onProgress, controller.signal);
            points = found.points;
            interestSource = found.source;
          } catch { /* a failed search is a reason to do less, not to fail */ } finally {
            controller = null;
            barEl.hidden = true;
          }
        }
      }

      const plan = planTidy({
        silences: wave ? findSilences(wave.loudness, recording.duration) : [],
        cuts,
        trim,
        zooms,
        suggested: blocksFromInterest(points, recording.duration, settings.zoom),
      });

      if (!tidyChangesAnything(plan)) {
        setStatus(describeTidy(plan, formatClock), 'good');
        return;
      }

      cuts = plan.cuts;
      zooms = plan.zooms;
      selection = null;
      remember('tidy');

      renderCuts();
      renderTrim();
      renderZooms();
      renderPicker();
      if (previewTime > trim.end) { previewTime = trim.end; syncScrub(); }
      await drawPreview();

      const said = describeTidy(plan, formatClock);
      setStatus(said, 'good');
      toast(said, { kind: 'good', actionLabel: 'Undo', onAction: () => { void undoEdit(); } });
    } finally {
      button.disabled = false;
    }
  }

  $<HTMLButtonElement>('ll-tidy').addEventListener('click', () => { void tidyUp(); });

  $<HTMLButtonElement>('ll-trim-reset').addEventListener('click', () => {
    if (!recording) return;
    trim = { start: 0, end: recording.duration };
    renderTrim();
    remember();
  });

  // ------------------------------------------------------------------ crop

  const cropRow = $<HTMLDivElement>('ll-croprow');
  const cropLabel = $<HTMLSpanElement>('ll-crop-label');
  const cropButton = $<HTMLButtonElement>('ll-crop');

  /**
   * Cropping shows the recording as it was captured, not as it will look.
   *
   * The composed preview has a background, padding and a moving zoom over it,
   * and dragging a rectangle across all that would mean guessing what part of
   * the source you were actually choosing. So the picture goes plain while the
   * crop is being set, and comes back when it is done.
   */
  let cropping = false;
  let cropAspect = 'free';
  /** What a drag is moving: a corner, an edge, or the whole rectangle. */
  let cropGrab: { handle: string; startX: number; startY: number; from: Crop } | null = null;

  /** How close to an edge counts as grabbing it, in source fractions. */
  const GRIP = 0.03;

  function aspectRatio(): number | null {
    const entry = CROP_ASPECTS.find((item) => item.id === cropAspect);
    if (!entry || entry.ratio === null) return null;
    // "Match output" follows whatever output size is selected.
    if (entry.ratio === 0) return settings.composition.width / settings.composition.height;
    return entry.ratio;
  }

  function renderCrop(): void {
    cropRow.hidden = !cropping;
    cropButton.setAttribute('aria-pressed', String(cropping));
    cropButton.textContent = cropping ? 'Cropping' : isFullCrop(crop) ? 'Crop' : 'Cropped';
    canvas.classList.toggle('is-cropping', cropping);
    if (!cropping) canvas.style.cursor = '';

    for (const button of cropRow.querySelectorAll<HTMLButtonElement>('.ll-cropaspect')) {
      button.setAttribute('aria-pressed', String(button.dataset.aspect === cropAspect));
    }

    const width = Math.round((video?.videoWidth ?? recording?.width ?? 0) * crop.width);
    const height = Math.round((video?.videoHeight ?? recording?.height ?? 0) * crop.height);
    cropLabel.textContent = isFullCrop(crop)
      ? 'The whole picture'
      : `Keeping ${width} by ${height} of the recording`;
  }

  const aspectsEl = $<HTMLDivElement>('ll-crop-aspects');
  for (const entry of CROP_ASPECTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'll-cropaspect';
    button.dataset.aspect = entry.id;
    button.textContent = entry.label;
    button.addEventListener('click', () => {
      cropAspect = entry.id;
      const ratio = aspectRatio();
      if (ratio !== null && video) {
        crop = cropToAspect(crop, ratio, video.videoWidth, video.videoHeight);
        remember();
      }
      renderCrop();
      void drawPreview();
    });
    aspectsEl.append(button);
  }

  cropButton.addEventListener('click', () => {
    cropping = !cropping;
    renderCrop();
    void drawPreview();
  });

  $<HTMLButtonElement>('ll-crop-done').addEventListener('click', () => {
    cropping = false;
    renderCrop();
    void drawPreview();
  });

  $<HTMLButtonElement>('ll-crop-reset').addEventListener('click', () => {
    crop = { ...FULL_CROP };
    cropAspect = 'free';
    remember();
    renderCrop();
    void drawPreview();
  });

  /** Where a pointer is over the canvas, as a fraction of the source. */
  function cropPointAt(event: PointerEvent): { x: number; y: number } {
    const box = canvas.getBoundingClientRect();
    // The canvas is drawn at the source's own shape while cropping, but the
    // element is letterboxed inside its box by object-fit, so the drawn area
    // has to be worked out rather than assumed to fill it.
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    const drawnWidth = canvas.width * scale;
    const drawnHeight = canvas.height * scale;
    const left = box.left + (box.width - drawnWidth) / 2;
    const top = box.top + (box.height - drawnHeight) / 2;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - left) / drawnWidth)),
      y: Math.max(0, Math.min(1, (event.clientY - top) / drawnHeight)),
    };
  }

  /** Which part of the rectangle a point is on. */
  function cropHandleAt(point: { x: number; y: number }): string {
    const near = (value: number, edge: number) => Math.abs(value - edge) <= GRIP;
    const vertical = near(point.y, crop.y) ? 'n' : near(point.y, crop.y + crop.height) ? 's' : '';
    const horizontal = near(point.x, crop.x) ? 'w' : near(point.x, crop.x + crop.width) ? 'e' : '';

    const insideX = point.x >= crop.x - GRIP && point.x <= crop.x + crop.width + GRIP;
    const insideY = point.y >= crop.y - GRIP && point.y <= crop.y + crop.height + GRIP;
    if ((vertical || horizontal) && insideX && insideY) return vertical + horizontal;

    // When nothing has been cropped yet there is no rectangle to move and
    // every point is inside one, so a drag has to mean drawing a new one.
    if (isFullCrop(crop)) return 'new';

    const inside = point.x > crop.x && point.x < crop.x + crop.width
      && point.y > crop.y && point.y < crop.y + crop.height;
    return inside ? 'move' : 'new';
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!cropping || !video) return;
    event.preventDefault();
    const point = cropPointAt(event);
    const handle = cropHandleAt(point);

    if (handle === 'new') {
      // Dragging on the discarded area starts a fresh rectangle from that corner.
      crop = normaliseCrop({ x: point.x, y: point.y, width: MIN_CROP, height: MIN_CROP });
      cropGrab = { handle: 'se', startX: point.x, startY: point.y, from: { ...crop } };
    } else {
      cropGrab = { handle, startX: point.x, startY: point.y, from: { ...crop } };
    }
    try { canvas.setPointerCapture(event.pointerId); } catch { /* No capture, but the drag still tracks. */ }
    void drawPreview();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!cropping) return;
    if (!cropGrab) {
      canvas.style.cursor = cursorFor(cropHandleAt(cropPointAt(event)));
      return;
    }
    const point = cropPointAt(event);
    crop = dragCrop(cropGrab, point.x - cropGrab.startX, point.y - cropGrab.startY);
    renderCrop();
    void drawPreview();
  });

  const endCrop = () => {
    if (!cropGrab) return;
    cropGrab = null;
    remember();
    renderCrop();
    void drawPreview();
  };
  canvas.addEventListener('pointerup', endCrop);
  canvas.addEventListener('pointercancel', endCrop);

  function cursorFor(handle: string): string {
    if (handle === 'move') return 'move';
    if (handle === 'new') return 'crosshair';
    if (handle === 'n' || handle === 's') return 'ns-resize';
    if (handle === 'e' || handle === 'w') return 'ew-resize';
    if (handle === 'nw' || handle === 'se') return 'nwse-resize';
    return 'nesw-resize';
  }

  /**
   * Applies a drag to the rectangle.
   *
   * Moving is a plain offset. Resizing works on whichever edges the handle
   * names, and when a shape is locked the result is refitted to it around the
   * corner that was not being dragged, so that corner stays put.
   */
  function dragCrop(
    grab: { handle: string; from: Crop }, deltaX: number, deltaY: number,
  ): Crop {
    const from = grab.from;
    if (grab.handle === 'move') {
      return normaliseCrop({ ...from, x: from.x + deltaX, y: from.y + deltaY });
    }

    let { x, y, width, height } = from;
    if (grab.handle.includes('w')) {
      const right = from.x + from.width;
      x = Math.min(right - MIN_CROP, from.x + deltaX);
      width = right - x;
    }
    if (grab.handle.includes('e')) width = from.width + deltaX;
    if (grab.handle.includes('n')) {
      const bottom = from.y + from.height;
      y = Math.min(bottom - MIN_CROP, from.y + deltaY);
      height = bottom - y;
    }
    if (grab.handle.includes('s')) height = from.height + deltaY;

    const next = normaliseCrop({ x, y, width, height });
    const ratio = aspectRatio();
    if (ratio === null || !video) return next;

    const fitted = cropToAspect(next, ratio, video.videoWidth, video.videoHeight);
    // Anchor to the corner opposite the one being dragged, so the side you are
    // not touching does not creep.
    const anchorX = grab.handle.includes('w') ? next.x + next.width : next.x;
    const anchorY = grab.handle.includes('n') ? next.y + next.height : next.y;
    return normaliseCrop({
      ...fitted,
      x: grab.handle.includes('w') ? anchorX - fitted.width : anchorX,
      y: grab.handle.includes('n') ? anchorY - fitted.height : anchorY,
    });
  }

  /** Draws the source with everything outside the crop dimmed, plus the grips. */
  function drawCropEditor(context: CanvasRenderingContext2D): void {
    if (!video) return;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    context.drawImage(video, 0, 0, width, height);

    const box = {
      x: crop.x * width, y: crop.y * height,
      width: crop.width * width, height: crop.height * height,
    };

    // Dim what is being thrown away, using an even-odd fill so the kept part
    // stays untouched rather than being drawn over and lightened back.
    const shade = new Path2D();
    shade.rect(0, 0, width, height);
    shade.rect(box.x, box.y, box.width, box.height);
    context.fillStyle = 'rgba(0, 0, 0, 0.55)';
    context.fill(shade, 'evenodd');

    const line = Math.max(2, Math.min(width, height) * 0.004);
    context.strokeStyle = '#ffffff';
    context.lineWidth = line;
    context.strokeRect(box.x, box.y, box.width, box.height);

    // Thirds, which is what people actually compose against.
    context.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    context.lineWidth = line / 2;
    context.beginPath();
    for (let step = 1; step < 3; step += 1) {
      context.moveTo(box.x + (box.width * step) / 3, box.y);
      context.lineTo(box.x + (box.width * step) / 3, box.y + box.height);
      context.moveTo(box.x, box.y + (box.height * step) / 3);
      context.lineTo(box.x + box.width, box.y + (box.height * step) / 3);
    }
    context.stroke();

    const grip = Math.max(8, Math.min(width, height) * 0.018);
    context.fillStyle = '#ffffff';
    for (const cx of [box.x, box.x + box.width / 2, box.x + box.width]) {
      for (const cy of [box.y, box.y + box.height / 2, box.y + box.height]) {
        if (cx === box.x + box.width / 2 && cy === box.y + box.height / 2) continue;
        context.fillRect(cx - grip / 2, cy - grip / 2, grip, grip);
      }
    }
  }

  // ------------------------------------------------------------------ help

  /**
   * Everything the editor says about itself, built from the one list.
   *
   * The words, the keys and the track labels all come from help.ts, and the
   * markup for them is its own module because it needs nothing from the editor
   * but a place to put itself.
   */
  const help = mountHelp(root, $);
  const showFirstTime = (track: TrackName) => help.showFirstTime(track);
  $<HTMLButtonElement>('ll-firsttime-got')
    .addEventListener('click', () => help.dismissFirstTime(activeTrack));

  // ------------------------------------------------------------------ track picker

  /**
   * Which track is being worked on.
   *
   * Six of them open at once was the problem: the app grew from one confusing
   * feature into six competing for the same eye. Every track stays on screen as
   * a thin strip, so a redaction set ten minutes ago is never out of sight, but
   * only the chosen one is full height with its controls.
   */
  // Order and labels come from the help, so a track cannot be named one thing
  // on its tab and another in the sheet that explains it.
  const COUNTS: Record<TrackName, () => number> = {
    zoom: () => zooms.length,
    sound: () => cuts.length,
    speed: () => speeds.length,
    hide: () => redactions.length,
    shapes: () => shapes.length,
    text: () => texts.length,
  };
  const TRACKS = TRACK_HELP.map((entry) => ({ ...entry, count: COUNTS[entry.id] }));
  let activeTrack: TrackName = 'zoom';

  function showTrack(name: TrackName): void {
    activeTrack = name;
    // Selections in other tracks are dropped, because a panel you cannot see
    // should not still be taking the picture's pointer or the Delete key.
    if (name !== 'zoom') { selected = null; stopAiming(); }
    if (name !== 'hide') selectedRedaction = null;
    if (name !== 'shapes') selectedShape = null;
    if (name !== 'text') selectedText = null;
    if (name !== 'speed') selectedSpeed = null;
    renderPicker();
    showFirstTime(name);
    if (recording) {
      renderZooms();
      renderSpeeds();
      renderRedactions();
      renderShapes();
      renderTexts();
      renderCuts();
    }
    void drawPreview();
  }

  function renderPicker(): void {
    const picker = $<HTMLDivElement>('ll-picker');
    picker.innerHTML = '';
    for (const track of TRACKS) {
      // The sound track only means anything when there is sound.
      if (track.id === 'sound' && !recording?.hasAudio) continue;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'll-pick';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(activeTrack === track.id));
      // Says what the track is for before it has been opened, which the label
      // alone does not: "Speed" and "Cover up" mean nothing on their own.
      tab.title = track.what;
      tab.textContent = track.label;

      // The count is what stops an inactive track being forgotten entirely.
      const count = document.createElement('span');
      count.className = 'll-pick__count';
      const total = track.count();
      count.textContent = String(total);
      count.hidden = total === 0;
      tab.append(count);

      tab.addEventListener('click', () => showTrack(track.id));
      picker.append(tab);
    }

    for (const track of TRACKS) {
      const holder = root.querySelector<HTMLDivElement>(`#ll-track-${track.id}`);
      if (!holder) continue;
      holder.classList.toggle('is-active', activeTrack === track.id);
      // The label beside the timeline row comes from the same place as the tab,
      // so renaming a track renames it everywhere rather than in one of two.
      const label = holder.querySelector<HTMLElement>('.ll-tracklabel');
      if (label) {
        label.textContent = track.label;
        label.title = track.what;
      }
      if (track.id === 'sound') holder.hidden = !recording?.hasAudio;
    }
  }

  // ------------------------------------------------------------------ sound and cuts

  const waveWrap = $<HTMLDivElement>('ll-wavewrap');
  const waveCanvas = $<HTMLCanvasElement>('ll-wave');
  const cutBandsEl = $<HTMLDivElement>('ll-cutbands');
  const waveSelectEl = $<HTMLDivElement>('ll-waveselect');
  const waveHeadEl = $<HTMLDivElement>('ll-wavehead');

  /**
   * Decodes the recording's audio once and keeps what is needed from it.
   *
   * Peaks for drawing, loudness for finding silences. Decoding is much the most
   * expensive part, so it happens on load and never again; the drawing is done
   * from the peaks at whatever width the element happens to be.
   */
  async function loadWaveform(): Promise<void> {
    wave = null;
    selection = null;
    const hasSound = recording?.hasAudio ?? false;
    $<HTMLDivElement>('ll-cutrow').hidden = !hasSound;
    if (!hasSound || !recording) { renderPicker(); renderCuts(); return; }

    wave = await analyseAudio(recording.blob);
    // A recording whose audio the decoder will not read still edits perfectly
    // well, so the track simply goes away rather than showing an error.
    if (!wave) $<HTMLDivElement>('ll-cutrow').hidden = true;
    renderPicker();
    drawWave();
    renderCuts();
  }

  function drawWave(): void {
    if (!wave || !recording) return;
    const width = Math.max(1, Math.round(waveWrap.clientWidth));
    const height = Math.max(1, Math.round(waveWrap.clientHeight));
    if (waveCanvas.width !== width) waveCanvas.width = width;
    if (waveCanvas.height !== height) waveCanvas.height = height;

    const context = waveCanvas.getContext('2d');
    if (!context) return;
    const style = getComputedStyle(root);
    context.clearRect(0, 0, width, height);

    const middle = height / 2;
    context.fillStyle = style.getPropertyValue('--accent').trim() || '#b0842a';
    context.globalAlpha = 0.85;

    // One bar per pixel column, taken from the nearest peak. Peaks were reduced
    // to a fixed count at decode time, so this rescales rather than redecodes.
    const peaks = wave.peaks;
    for (let x = 0; x < width; x += 1) {
      const peak = peaks[Math.min(peaks.length - 1, Math.floor((x / width) * peaks.length))];
      const top = middle - Math.max(0, peak.max) * middle;
      const bottom = middle - Math.min(0, peak.min) * middle;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    context.globalAlpha = 1;
  }

  /** Draws the cut bands, the selection and the playhead over the waveform. */
  function renderCuts(): void {
    if (!recording) return;
    const duration = Math.max(0.001, recording.duration);
    const percent = (time: number) => `${Math.max(0, Math.min(100, (time / duration) * 100))}%`;

    cutBandsEl.innerHTML = '';
    for (const cut of cuts) {
      const band = document.createElement('div');
      band.className = 'll-cutband';
      band.style.left = percent(cut.start);
      band.style.width = `${Math.max(0, ((cut.end - cut.start) / duration) * 100)}%`;
      cutBandsEl.append(band);
    }

    waveSelectEl.hidden = !selection;
    if (selection) {
      const from = Math.min(selection.start, selection.end);
      const to = Math.max(selection.start, selection.end);
      waveSelectEl.style.left = percent(from);
      waveSelectEl.style.width = `${Math.max(0, ((to - from) / duration) * 100)}%`;
    }
    renderPlayhead();

    $<HTMLButtonElement>('ll-cut-selection').disabled = !selection
      || Math.abs(selection.end - selection.start) < 0.05;
    $<HTMLButtonElement>('ll-cut-clear').disabled = cuts.length === 0;

    renderPicker();
    const removed = trim.end - trim.start - keptDuration(cuts, trim.start, trim.end);
    $<HTMLSpanElement>('ll-cut-label').textContent = cuts.length
      ? `${cuts.length} cut${cuts.length === 1 ? '' : 's'}, ${formatClock(removed)} removed, ${formatClock(keptDuration(cuts, trim.start, trim.end))} left`
      : '';
  }

  /** Just the playhead, cheap enough to run on every frame of playback. */
  function renderPlayhead(): void {
    if (!recording) return;
    const duration = Math.max(0.001, recording.duration);
    waveHeadEl.style.left = `${Math.max(0, Math.min(100, (previewTime / duration) * 100))}%`;
  }

  function waveTimeAt(event: PointerEvent): number {
    if (!recording) return 0;
    const box = waveWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * recording.duration;
  }

  waveWrap.addEventListener('pointerdown', (event) => {
    if (!recording) return;
    event.preventDefault();
    if (playing) pause();
    const at = waveTimeAt(event);
    selection = { start: at, end: at };
    selectingWave = true;
    try { waveWrap.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
    // A click with no drag is a seek, which is what a waveform invites.
    previewTime = at;
    syncScrub();
    void drawPreview();
    renderCuts();
  });

  waveWrap.addEventListener('pointermove', (event) => {
    if (!selectingWave || !selection) return;
    selection = { start: selection.start, end: waveTimeAt(event) };
    renderCuts();
  });

  for (const done of ['pointerup', 'pointercancel'] as const) {
    waveWrap.addEventListener(done, () => {
      selectingWave = false;
      // A drag too short to be a range was a click, so the selection goes away
      // rather than leaving an invisible sliver armed for cutting.
      if (selection && Math.abs(selection.end - selection.start) < 0.05) selection = null;
      renderCuts();
    });
  }

  function applyCuts(next: Span[], label: string): void {
    cuts = mergeSpans(next);
    selection = null;
    remember(label);
    renderCuts();
    renderTrim();
    if (recording && previewTime > trim.end) { previewTime = trim.end; syncScrub(); }
    void drawPreview();
  }

  $<HTMLButtonElement>('ll-cut-selection').addEventListener('click', () => {
    if (!selection) return;
    const from = Math.min(selection.start, selection.end);
    const to = Math.max(selection.start, selection.end);
    applyCuts([...cuts, { start: from, end: to }], 'cut');
    toast(`Cut ${formatClock(to - from)}. Undo with Ctrl+Z.`);
  });

  $<HTMLButtonElement>('ll-cut-silences').addEventListener('click', () => {
    if (!wave || !recording) {
      setStatus('There is no sound in this recording to find silences in.', 'bad');
      return;
    }
    const found = findSilences(wave.loudness, recording.duration)
      // Only inside the trimmed range: cutting silence from a part that is
      // already being thrown away achieves nothing and reads as a bug.
      .map((span) => ({ start: Math.max(span.start, trim.start), end: Math.min(span.end, trim.end) }))
      .filter((span) => span.end - span.start > 0.05);

    if (found.length === 0) {
      setStatus('No silences long enough to be worth cutting.', 'good');
      return;
    }
    const before = keptDuration(cuts, trim.start, trim.end);
    applyCuts([...cuts, ...found], 'silences');
    const saved = before - keptDuration(cuts, trim.start, trim.end);
    toast(`Removed ${found.length} silence${found.length === 1 ? '' : 's'}, ${formatClock(saved)} shorter.`);
  });

  $<HTMLButtonElement>('ll-cut-clear').addEventListener('click', () => {
    if (!cuts.length) return;
    applyCuts([], 'cuts-cleared');
    toast('Every cut put back.');
  });

  // The waveform is drawn to the element's pixel width, so it has to be redrawn
  // when that changes or it stretches.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { drawWave(); renderCuts(); }).observe(waveWrap);
  }

  // ------------------------------------------------------------------ speed

  const speedTrackEl = $<HTMLDivElement>('ll-speedtrack');
  const speedPanel = $<HTMLLabelElement>('ll-speed-selected');

  const speedTrack = mountBlockTrack<SpeedRegion>({
    element: speedTrackEl,
    blocks: () => speeds,
    onChange: (next) => { speeds = sortSpeeds(next); },
    duration: () => recording?.duration ?? 0,
    selected: () => selectedSpeed,
    onSelect: (id, region) => {
      selectedSpeed = id;
      renderSpeeds();
      showBlock(region.start, region.end);
    },
    constrain: (next) => sortSpeeds(next),
    label: (region) => `${region.speed}x`,
    title: (region) => `${region.speed}x, ${formatClock(region.start)} to ${formatClock(region.end)}`,
    describe: (region) => `Speed change, ${region.speed} times, ${formatClock(region.start)} to ${formatClock(region.end)}`,
    barClass: () => 'is-pinned',
    onCommit: () => persistSpeeds(),
  });

  function renderSpeeds(): void {
    if (!recording) return;
    speedTrack.render();

    const region = speeds.find((entry) => entry.id === selectedSpeed);
    speedPanel.hidden = !region;
    $<HTMLButtonElement>('ll-speed-delete').hidden = !region;
    if (region) {
      $<HTMLInputElement>('ll-speed-amount').value = String(region.speed);
      $<HTMLSpanElement>('ll-speed-amount-out').textContent = `${region.speed}x`;
    }

    // What the edit has done to the length, which is the whole reason for it.
    const finished = editedDuration(segmentsOf(trim, cuts, speeds));
    const raw = trim.end - trim.start;
    // To a tenth, because whole seconds hide the difference between 2x and 4x
    // on a short recording and the readout then looks broken.
    const tenth = (value: number) => `${value.toFixed(1)}s`;
    $<HTMLSpanElement>('ll-speed-label').textContent =
      Math.abs(finished - raw) < 0.05 ? '' : `${tenth(raw)} becomes ${tenth(finished)}`;
    renderPicker();
  }

  function persistSpeeds(label = ''): void {
    remember(label);
    renderSpeeds();
    renderCuts();
    void drawPreview();
  }

  $<HTMLButtonElement>('ll-speed-add').addEventListener('click', () => {
    if (!recording) return;
    const before = speeds.length;
    speeds = addSpeed(speeds, previewTime, recording.duration, 2, createId('speed'));
    if (speeds.length === before) {
      setStatus('There is no room for a speed change there.', 'bad');
      return;
    }
    announceAdded('Speed change', previewTime);
    selectedSpeed = speeds.find((region) => region.start <= previewTime + 0.01 && region.end >= previewTime - 0.01)?.id ?? null;
    persistSpeeds();
  });

  $<HTMLInputElement>('ll-speed-amount').addEventListener('input', (event) => {
    if (!selectedSpeed) return;
    const speed = clampSpeed(Number((event.target as HTMLInputElement).value));
    speeds = speeds.map((region) => (region.id === selectedSpeed ? { ...region, speed } : region));
    persistSpeeds(`speed:${selectedSpeed}`);
  });

  $<HTMLButtonElement>('ll-speed-delete').addEventListener('click', () => {
    if (!selectedSpeed) return;
    speeds = removeSpeed(speeds, selectedSpeed);
    selectedSpeed = null;
    persistSpeeds();
    toast('Back to normal speed. Undo with Ctrl+Z.');
  });

  // ------------------------------------------------------------------ shapes

  const shapeTrackEl = $<HTMLDivElement>('ll-shapetrack');
  const shapePanel = $<HTMLDivElement>('ll-shape-selected');
  const shapeNote = $<HTMLParagraphElement>('ll-shape-note');

  for (const kind of SHAPE_KINDS) {
    const option = document.createElement('option');
    option.value = kind.id;
    option.textContent = kind.label;
    $<HTMLSelectElement>('ll-shape-kind').append(option);
  }

  const shapeTrack = mountBlockTrack<Shape>({
    element: shapeTrackEl,
    blocks: () => shapes,
    onChange: (next) => { shapes = sortShapes(next); },
    duration: () => recording?.duration ?? 0,
    selected: () => selectedShape,
    onSelect: (id, shape) => {
      selectedShape = id;
      selectedRedaction = null;
      renderShapes();
      renderRedactions();
      showBlock(shape.start, shape.end);
      void drawPreview();
    },
    constrain: (next) => sortShapes(next),
    label: (shape) => shape.kind,
    title: (shape) => `${shape.kind}, ${formatClock(shape.start)} to ${formatClock(shape.end)}`,
    describe: (shape) => `${shape.kind}, ${formatClock(shape.start)} to ${formatClock(shape.end)}`,
    barClass: () => 'is-pinned',
    onCommit: () => persistShapes(),
  });

  function renderShapes(): void {
    if (!recording) return;
    shapeTrack.render();

    const shape = shapes.find((entry) => entry.id === selectedShape);
    shapePanel.hidden = !shape;
    shapeNote.hidden = !shape;
    if (shape) {
      $<HTMLInputElement>('ll-shape-weight').value = String(shape.thickness);
      $<HTMLSpanElement>('ll-shape-weight-out').textContent = `${(shape.thickness * 1000).toFixed(0)}`;
      $<HTMLInputElement>('ll-shape-fade').value = String(shape.fade);
      $<HTMLSpanElement>('ll-shape-fade-out').textContent = `${shape.fade.toFixed(2)}s`;
    }
    renderSwatches(shape?.colour);
    $<HTMLSpanElement>('ll-shape-label').textContent = shapes.length ? `${shapes.length} on screen` : '';
    renderPicker();
  }

  function renderSwatches(current?: string): void {
    const holder = $<HTMLDivElement>('ll-shape-colours');
    holder.innerHTML = '';
    for (const colour of SHAPE_COLOURS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'll-swatch';
      swatch.style.background = colour;
      swatch.setAttribute('aria-label', `Use ${colour}`);
      swatch.setAttribute('aria-pressed', String(current === colour));
      swatch.addEventListener('click', () => {
        if (!selectedShape) return;
        shapes = updateShape(shapes, selectedShape, { colour });
        persistShapes('shape-colour');
      });
      holder.append(swatch);
    }
  }

  function persistShapes(label = ''): void {
    remember(label);
    renderShapes();
    void drawPreview();
  }

  $<HTMLButtonElement>('ll-shape-add').addEventListener('click', () => {
    if (!recording) return;
    const kind = $<HTMLSelectElement>('ll-shape-kind').value as ShapeKind;
    shapes = addShape(shapes, previewTime, recording.duration, kind, createId('shape'));
    announceAdded(kind, previewTime);
    selectedShape = shapes.find((shape) => shape.start <= previewTime + 0.01 && shape.end >= previewTime - 0.01)?.id ?? null;
    selectedRedaction = null;
    renderRedactions();
    persistShapes();
    toast('Drag on the picture to place it.');
  });

  $<HTMLInputElement>('ll-shape-weight').addEventListener('input', (event) => {
    if (!selectedShape) return;
    shapes = updateShape(shapes, selectedShape, { thickness: Number((event.target as HTMLInputElement).value) });
    persistShapes(`shape-weight:${selectedShape}`);
  });
  $<HTMLInputElement>('ll-shape-fade').addEventListener('input', (event) => {
    if (!selectedShape) return;
    shapes = updateShape(shapes, selectedShape, { fade: Number((event.target as HTMLInputElement).value) });
    persistShapes(`shape-fade:${selectedShape}`);
  });
  $<HTMLButtonElement>('ll-shape-delete').addEventListener('click', () => {
    if (!selectedShape) return;
    shapes = removeShape(shapes, selectedShape);
    selectedShape = null;
    persistShapes();
    toast('Shape removed. Undo with Ctrl+Z.');
  });

  // ------------------------------------------------------------------ redaction

  const redactTrackEl = $<HTMLDivElement>('ll-redacttrack');
  const redactPanel = $<HTMLDivElement>('ll-redact-selected');
  const redactNote = $<HTMLParagraphElement>('ll-redact-note');

  for (const style of REDACT_STYLES) {
    const option = document.createElement('option');
    option.value = style.id;
    option.textContent = style.label;
    $<HTMLSelectElement>('ll-redact-style').append(option);
  }

  const redactTrack = mountBlockTrack<RedactBlock>({
    element: redactTrackEl,
    blocks: () => redactions,
    onChange: (next) => { redactions = sortRedactions(next); },
    duration: () => recording?.duration ?? 0,
    selected: () => selectedRedaction,
    onSelect: (id, block) => {
      selectedRedaction = id;
      selectedShape = null;
      renderRedactions();
      renderShapes();
      showBlock(block.start, block.end);
      void drawPreview();
    },
    constrain: (next) => sortRedactions(next),
    // The number of following points, because a box that follows is the thing
    // people forget they set up.
    label: (block) => (block.points.length > 1 ? `${block.style} \u00d7${block.points.length}` : block.style),
    title: (block) => `${block.style}, ${formatClock(block.start)} to ${formatClock(block.end)}`,
    describe: (block) => `Cover up, ${block.style}, ${formatClock(block.start)} to ${formatClock(block.end)}`,
    barClass: () => 'is-pinned',
    onCommit: () => persistRedactions(),
  });

  function renderRedactions(): void {
    if (!recording) return;
    redactTrack.render();

    const block = redactions.find((entry) => entry.id === selectedRedaction);
    redactPanel.hidden = !block;
    redactNote.hidden = !block;
    if (block) {
      $<HTMLSelectElement>('ll-redact-style').value = block.style;
      $<HTMLInputElement>('ll-redact-w').value = String(block.width);
      $<HTMLSpanElement>('ll-redact-w-out').textContent = `${Math.round(block.width * 100)}%`;
      $<HTMLInputElement>('ll-redact-h').value = String(block.height);
      $<HTMLSpanElement>('ll-redact-h-out').textContent = `${Math.round(block.height * 100)}%`;
    }
    $<HTMLSpanElement>('ll-redact-label').textContent = redactions.length
      ? `${redactions.length} hidden`
      : '';
    renderPicker();
  }

  function persistRedactions(label = ''): void {
    remember(label);
    renderRedactions();
    void drawPreview();
  }

  $<HTMLButtonElement>('ll-redact-add').addEventListener('click', () => {
    if (!recording) return;
    const current = project();
    const at = current ? cursorAt(current, previewTime) : null;
    redactions = addRedaction(
      redactions, previewTime, recording.duration, createId('redact'),
      at ? { x: at.x, y: at.y } : { x: 0.5, y: 0.5 },
    );
    selectedRedaction = redactions.find((block) => block.start <= previewTime + 0.01 && block.end >= previewTime - 0.01)?.id ?? null;
    persistRedactions();
    toast('Drag on the picture to place what should be hidden.');
  });

  function editRedaction(change: Partial<RedactBlock>, label: string): void {
    if (!selectedRedaction) return;
    redactions = redactions.map((block) => (block.id === selectedRedaction ? { ...block, ...change } : block));
    persistRedactions(label);
  }

  $<HTMLSelectElement>('ll-redact-style').addEventListener('change', (event) => {
    editRedaction({ style: (event.target as HTMLSelectElement).value as RedactStyle }, 'redact-style');
  });
  $<HTMLInputElement>('ll-redact-w').addEventListener('input', (event) => {
    editRedaction({ width: Number((event.target as HTMLInputElement).value) }, `redact-w:${selectedRedaction}`);
  });
  $<HTMLInputElement>('ll-redact-h').addEventListener('input', (event) => {
    editRedaction({ height: Number((event.target as HTMLInputElement).value) }, `redact-h:${selectedRedaction}`);
  });

  $<HTMLButtonElement>('ll-redact-point').addEventListener('click', () => {
    const block = redactions.find((entry) => entry.id === selectedRedaction);
    if (!block) return;
    const here = rectAt(block, previewTime);
    redactions = redactions.map((entry) => (entry.id === block.id
      ? setPoint(entry, previewTime, here.x + here.width / 2, here.y + here.height / 2)
      : entry));
    persistRedactions('redact-point');
    toast('It will follow to wherever you drag it from here.');
  });

  $<HTMLButtonElement>('ll-redact-delete').addEventListener('click', () => {
    if (!selectedRedaction) return;
    redactions = removeRedaction(redactions, selectedRedaction);
    selectedRedaction = null;
    persistRedactions();
    toast('Redaction removed. Undo with Ctrl+Z.');
  });

  // ------------------------------------------------------------------ aiming a zoom

  /**
   * The region a zoom moves around inside, in source pixels.
   *
   * The renderer treats the crop as the recording, and the zoom pans within
   * that rather than the original frame, so aiming has to use the same region
   * or the rectangle drawn here would not match the picture produced.
   */
  function zoomRegion(): { x: number; y: number; width: number; height: number } | null {
    const current = project();
    if (!current) return null;
    return cropRect(crop, current.sourceWidth, current.sourceHeight);
  }

  /**
   * Aiming a zoom: the whole croppable frame, with the part the zoom will show
   * picked out of it.
   *
   * Shaped like the crop editor on purpose. Cropping already taught the gesture
   * of dragging a rectangle over the real picture, and a zoom target is the
   * same idea with the rectangle's size coming from the scale rather than the
   * pointer. The alternative, sliders alone, makes you guess.
   */
  function drawAimEditor(context: CanvasRenderingContext2D): void {
    const region = zoomRegion();
    if (!video || !focusTarget || !region) return;
    const { width, height } = canvas;

    context.clearRect(0, 0, width, height);
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, width, height);

    // viewRect is the renderer's own function, so the rectangle shown here and
    // the frame that comes out cannot drift apart, including at the edges where
    // the view is clamped back inside the picture.
    const view = viewRect({ time: 0, scale: focusTarget.scale, x: focusTarget.x, y: focusTarget.y }, width, height);

    const shade = new Path2D();
    shade.rect(0, 0, width, height);
    shade.rect(view.x, view.y, view.width, view.height);
    context.fillStyle = 'rgba(0, 0, 0, 0.58)';
    context.fill(shade, 'evenodd');

    const line = Math.max(2, Math.min(width, height) * 0.004);
    context.strokeStyle = '#ffffff';
    context.lineWidth = line;
    context.strokeRect(view.x, view.y, view.width, view.height);

    // The focal point itself, which is what the sliders and the drag move. It
    // is not always the centre of the rectangle: near an edge the view is
    // clamped and the two come apart, and seeing that is the point.
    const cx = focusTarget.x * width;
    const cy = focusTarget.y * height;
    const reach = Math.min(width, height) * 0.035;
    context.beginPath();
    context.moveTo(cx - reach, cy);
    context.lineTo(cx + reach, cy);
    context.moveTo(cx, cy - reach);
    context.lineTo(cx, cy + reach);
    context.stroke();
    context.beginPath();
    context.arc(cx, cy, reach * 0.5, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = 'rgba(255, 255, 255, 0.22)';
    context.fill();
  }

  /**
   * Outlines the selected redaction on the preview.
   *
   * The box itself is already burnt into the picture by the renderer, so this
   * only says which one is being edited and where its edges are. Drawn in the
   * composed frame's coordinates, which is close enough for placing by eye and
   * avoids inverting the zoom transform.
   */
  function drawRedactOutline(context: CanvasRenderingContext2D, time: number): void {
    const block = redactions.find((entry) => entry.id === selectedRedaction);
    if (!block || time < block.start || time > block.end) return;
    const box = rectAt(block, time);
    const { width, height } = canvas;
    context.save();
    context.strokeStyle = '#e0796f';
    context.lineWidth = Math.max(2, Math.min(width, height) * 0.004);
    context.setLineDash([Math.max(6, width * 0.01), Math.max(4, width * 0.006)]);
    context.strokeRect(box.x * width, box.y * height, box.width * width, box.height * height);
    context.restore();
  }

  /** Turns a pointer event on the canvas into a 0..1 point in the zoom region. */
  function aimPointAt(event: PointerEvent): { x: number; y: number } {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  }

  function moveFocus(point: { x: number; y: number }, label: string): void {
    if (!focusTarget || !recording) return;
    const id = focusTarget.id;
    zooms = zooms.map((zoom) => (zoom.id === id ? { ...zoom, x: point.x, y: point.y, pinned: true } : zoom));
    focusTarget = zooms.find((zoom) => zoom.id === id) ?? null;
    invalidateTrack();
    renderSelected();
    persistZooms(label);
    paint(previewTime);
  }

  function startAiming(id: string): void {
    const zoom = zooms.find((entry) => entry.id === id);
    if (!zoom || !recording) return;
    if (playing) pause();
    if (cropping) return;
    focusTarget = zoom;
    aimButton.setAttribute('aria-pressed', 'true');
    aimNote.hidden = false;
    // The picture has to be from inside the zoom or you would be aiming at a
    // frame that is not the one the zoom covers.
    previewTime = Math.min(Math.max(previewTime, zoom.start), zoom.end);
    syncScrub();
    void drawPreview();
  }

  function stopAiming(): void {
    if (!focusTarget) return;
    focusTarget = null;
    draggingFocus = false;
    aimButton.setAttribute('aria-pressed', 'false');
    aimNote.hidden = true;
    void drawPreview();
  }

  // ------------------------------------------------------------------ zoom track

  const zoomTrackEl = $<HTMLDivElement>('ll-zoomtrack');

  function persistZooms(label = ''): void { remember(label); }

  /** Says that a block has arrived, and where, since neither is visible. */
  function announceAdded(kind: string, at: number): void {
    speaker.say(`${kind} added at ${formatClock(at)}.`);
  }

  const zoomBlocks = mountBlockTrack<ZoomBlock>({
    element: zoomTrackEl,
    blocks: () => zooms,
    onChange: (next) => { zooms = next.map((zoom) => ({ ...zoom, pinned: true })); },
    duration: () => recording?.duration ?? 0,
    selected: () => selected,
    onSelect: (id, zoom) => {
      selected = id;
      selectedText = null;
      renderTextSelected();
      renderZooms();
      // Selecting a block puts the playhead inside it. Without this you can
      // edit a zoom at 0:40 while looking at 0:05 and see nothing change,
      // which reads as a broken control rather than a preview pointed
      // elsewhere.
      showBlock(zoom.start, zoom.end);
    },
    constrain: (next, id) => constrain(next, id, recording?.duration ?? 0),
    label: (zoom) => `${zoom.scale.toFixed(1)}x`,
    title: (zoom) => `${zoom.scale.toFixed(1)}x, ${formatClock(zoom.start)} to ${formatClock(zoom.end)}`,
    describe: (zoom) => `Zoom, ${zoom.scale.toFixed(1)} times, ${formatClock(zoom.start)} to ${formatClock(zoom.end)}`,
    barClass: (zoom) => (zoom.pinned ? 'is-pinned' : ''),
    // Opens the zoom for aiming. It used to delete it, which is the opposite
    // of what a double click means everywhere else.
    onOpen: (zoom) => { selected = zoom.id; renderSelected(); startAiming(zoom.id); },
    onContextMenu: (event, zoom) => { selected = zoom.id; zoomMenu(event, zoom.id); },
    onCommit: () => { invalidateTrack(); renderZooms(); persistZooms(); void drawPreview(); },
  });

  function renderZooms(): void {
    if (!recording) return;
    invalidateTrack();
    zoomBlocks.render();

    $<HTMLParagraphElement>('ll-zoom-hint').textContent = zooms.length
      ? 'Drag a zoom to move it, or its edges to resize. Click one to edit it, double click to aim it at something.'
      : 'No zooms yet. Press Add a zoom to put one at the playhead.';
    renderSelected();
    renderPicker();
  }

  function renderSelected(): void {
    const panel = $<HTMLDivElement>('ll-zoom-selected');
    const zoom = zooms.find((entry) => entry.id === selected);
    panel.hidden = !zoom;
    if (!zoom) { if (focusTarget) stopAiming(); return; }
    $<HTMLInputElement>('ll-zoom-amount').value = String(zoom.scale);
    $<HTMLSpanElement>('ll-zoom-amount-out').textContent = `${zoom.scale.toFixed(1)}x`;
    $<HTMLInputElement>('ll-zoom-x').value = String(zoom.x);
    $<HTMLSpanElement>('ll-zoom-x-out').textContent = `${Math.round(zoom.x * 100)}%`;
    $<HTMLInputElement>('ll-zoom-y').value = String(zoom.y);
    $<HTMLSpanElement>('ll-zoom-y-out').textContent = `${Math.round(zoom.y * 100)}%`;
    for (const bar of zoomTrackEl.querySelectorAll<HTMLDivElement>('.ll-zoom')) {
      bar.classList.toggle('is-selected', bar.dataset.id === selected);
    }
  }

  /** Applies a change to the selected zoom and keeps the aim view in step. */
  function editSelectedZoom(change: Partial<ZoomBlock>, label: string): void {
    if (!selected || !recording) return;
    const id = selected;
    zooms = zooms.map((zoom) => (zoom.id === id ? { ...zoom, ...change, pinned: true } : zoom));
    zooms = constrain(zooms, id, recording.duration);
    if (focusTarget) focusTarget = zooms.find((zoom) => zoom.id === id) ?? null;
    invalidateTrack();
    renderZooms();
    persistZooms(label);
    // Aiming paints straight from the current frame; anything else may need a
    // seek if the playhead has not been anywhere near this block.
    if (focusTarget) paint(previewTime);
    else void drawPreview();
  }

  $<HTMLInputElement>('ll-zoom-amount').addEventListener('input', (event) => {
    editSelectedZoom({ scale: Number((event.target as HTMLInputElement).value) }, `zoom-scale:${selected}`);
  });
  $<HTMLInputElement>('ll-zoom-x').addEventListener('input', (event) => {
    editSelectedZoom({ x: Number((event.target as HTMLInputElement).value) }, `zoom-x:${selected}`);
  });
  $<HTMLInputElement>('ll-zoom-y').addEventListener('input', (event) => {
    editSelectedZoom({ y: Number((event.target as HTMLInputElement).value) }, `zoom-y:${selected}`);
  });

  aimButton.addEventListener('click', () => {
    if (focusTarget) stopAiming();
    else if (selected) startAiming(selected);
  });

  $<HTMLButtonElement>('ll-zoom-delete').addEventListener('click', () => {
    if (!selected) return;
    deleteZoom(selected);
  });

  /** Removes a zoom and says so, because undo is not where the eye is. */
  function deleteZoom(id: string): void {
    if (focusTarget?.id === id) stopAiming();
    zooms = removeBlock(zooms, id);
    if (selected === id) selected = null;
    invalidateTrack();
    renderZooms();
    persistZooms();
    void drawPreview();
    toast('Zoom removed. Undo with Ctrl+Z.');
  }

  // Aiming happens on the picture itself. The crop editor owns the canvas while
  // it is open, so these only act when a zoom is being aimed instead.
  canvas.addEventListener('pointerdown', (event) => {
    if (cropping) return;
    // A selected redaction takes the picture, since placing what is hidden is
    // more urgent than aiming a zoom and the two are never wanted at once.
    if (selectedRedaction) {
      event.preventDefault();
      draggingRedaction = true;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
      placeRedaction(aimPointAt(event));
      return;
    }
    // A shape is drawn by dragging: an arrow runs from press to release, and a
    // box spans between them, which is the gesture people already know.
    if (selectedShape) {
      event.preventDefault();
      draggingShape = aimPointAt(event);
      try { canvas.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
      shapes = updateShape(shapes, selectedShape, {
        x: draggingShape.x, y: draggingShape.y, width: 0.001, height: 0.001,
      });
      renderShapes();
      paint(previewTime);
      return;
    }
    if (!focusTarget) return;
    event.preventDefault();
    draggingFocus = true;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
    moveFocus(aimPointAt(event), `zoom-aim:${focusTarget.id}`);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (draggingRedaction) { placeRedaction(aimPointAt(event)); return; }
    if (draggingShape && selectedShape) {
      const to = aimPointAt(event);
      shapes = updateShape(shapes, selectedShape, {
        width: to.x - draggingShape.x, height: to.y - draggingShape.y,
      });
      renderShapes();
      paint(previewTime);
      return;
    }
    if (!draggingFocus || !focusTarget) return;
    moveFocus(aimPointAt(event), `zoom-aim:${focusTarget.id}`);
  });
  for (const done of ['pointerup', 'pointercancel'] as const) {
    canvas.addEventListener(done, () => {
      if (draggingRedaction) { draggingRedaction = false; remember('redact-move'); }
      if (draggingShape) { draggingShape = null; remember('shape-draw'); }
      draggingFocus = false;
    });
  }

  /**
   * Puts the selected redaction where the pointer is.
   *
   * A block with one point is moved outright; one that already follows has the
   * point nearest the playhead moved instead, so adjusting a path does not
   * flatten it.
   */
  function placeRedaction(point: { x: number; y: number }): void {
    const block = redactions.find((entry) => entry.id === selectedRedaction);
    if (!block) return;
    redactions = redactions.map((entry) => (entry.id === block.id
      ? (entry.points.length <= 1
        ? { ...entry, points: [{ time: entry.start, x: point.x, y: point.y }] }
        : setPoint(entry, previewTime, point.x, point.y))
      : entry));
    renderRedactions();
    paint(previewTime);
  }

  $<HTMLButtonElement>('ll-zoom-add').addEventListener('click', () => {
    if (!recording) return;
    const before = zooms.length;
    const current = project();
    // Aim it where the pointer actually was at that moment. The recording
    // already carries that track, so a new zoom starts pointed at the thing you
    // were doing rather than at the middle of the screen.
    const at = current ? cursorAt(current, previewTime) : null;
    zooms = addBlock(
      zooms, previewTime, recording.duration, settings.zoom,
      at ? { x: at.x, y: at.y } : undefined,
    );
    if (zooms.length === before) {
      setStatus('There is no room for a zoom there. Move the playhead into a gap.', 'bad');
      return;
    }
    invalidateTrack();
    announceAdded('Zoom', previewTime);
    selected = zooms.find((zoom) => zoom.pinned && zoom.start <= previewTime + 0.01 && zoom.end >= previewTime - 0.01)?.id ?? selected;
    selectedText = null;
    renderTextSelected();
    renderZooms();
    persistZooms();
    void drawPreview();
  });

  $<HTMLButtonElement>('ll-zoom-clear').addEventListener('click', () => {
    if (!zooms.length || !confirm('Remove every zoom, including the ones you set by hand?')) return;
    zooms = [];
    selected = null;
    stopAiming();
    invalidateTrack();
    renderZooms();
    persistZooms();
    void drawPreview();
  });

  // ------------------------------------------------------------------ text track

  const textTrackEl = $<HTMLDivElement>('ll-texttrack');
  let selectedText: string | null = null;

  function persistTexts(label = ''): void { remember(label); }

  const textTrack = mountBlockTrack<TextBlock>({
    element: textTrackEl,
    blocks: () => texts,
    onChange: (next) => { texts = next; },
    duration: () => recording?.duration ?? 0,
    selected: () => selectedText,
    onSelect: (id, text) => {
      selectedText = id;
      selected = null;
      renderSelected();
      renderTexts();
      showBlock(text.start, text.end);
    },
    constrain: (next, id) => constrainText(next, id, recording?.duration ?? 0),
    // The words themselves are the label, since that is what tells one caption
    // from another at a glance.
    label: (text) => text.text.split('\n')[0] || 'Text',
    title: (text) => `${text.text.split('\n')[0]}, ${formatClock(text.start)} to ${formatClock(text.end)}`,
    describe: (text) => `Text, ${text.text.split('\n')[0] || 'empty'}, ${formatClock(text.start)} to ${formatClock(text.end)}`,
    barClass: () => 'is-pinned',
    // Opens the words for editing. Deleting on a double click was too easy to
    // do by accident and too quiet when it happened.
    onOpen: (text) => {
      selectedText = text.id;
      selected = null;
      renderSelected();
      renderTexts();
      showBlock(text.start, text.end);
      $<HTMLTextAreaElement>('ll-text-words').focus();
    },
    onContextMenu: (event, text) => { selectedText = text.id; textMenu(event, text.id); },
    onCommit: () => { renderTexts(); persistTexts(); void drawPreview(); },
  });

  function renderTexts(): void {
    if (!recording) return;
    textTrack.render();
    renderTextSelected();
    renderPicker();
  }

  function renderTextSelected(): void {
    const panel = $<HTMLDivElement>('ll-text-selected');
    const text = texts.find((entry) => entry.id === selectedText);
    panel.hidden = !text;
    for (const bar of textTrackEl.querySelectorAll<HTMLDivElement>('.ll-zoom')) {
      bar.classList.toggle('is-selected', bar.dataset.id === selectedText);
    }
    if (!text) return;

    $<HTMLTextAreaElement>('ll-text-words').value = text.text;
    $<HTMLSelectElement>('ll-text-align').value = text.align;
    $<HTMLInputElement>('ll-text-colour').value = text.colour;
    for (const [id, value] of [
      ['ll-text-size', text.size], ['ll-text-x', text.x], ['ll-text-y', text.y],
      ['ll-text-plate', text.plate], ['ll-text-fade', text.fade],
    ] as [string, number][]) {
      $<HTMLInputElement>(id).value = String(value);
    }
    $<HTMLSpanElement>('ll-text-size-out').textContent = `${Math.round(text.size * 100)}%`;
    $<HTMLSpanElement>('ll-text-x-out').textContent = `${Math.round(text.x * 100)}%`;
    $<HTMLSpanElement>('ll-text-y-out').textContent = `${Math.round(text.y * 100)}%`;
    $<HTMLSpanElement>('ll-text-plate-out').textContent = `${Math.round(text.plate * 100)}%`;
    $<HTMLSpanElement>('ll-text-fade-out').textContent = `${text.fade.toFixed(2)}s`;
  }

  /** Applies a change to the selected caption and records it as one step. */
  function editSelectedText(change: Partial<TextBlock>, label: string): void {
    if (!selectedText) return;
    texts = updateText(texts, selectedText, change);
    renderTexts();
    persistTexts(`${label}:${selectedText}`);
    void drawPreview();
  }

  $<HTMLTextAreaElement>('ll-text-words').addEventListener('input', (event) => {
    editSelectedText({ text: (event.target as HTMLTextAreaElement).value }, 'text-words');
  });

  $<HTMLSelectElement>('ll-text-align').addEventListener('change', (event) => {
    editSelectedText({ align: (event.target as HTMLSelectElement).value as TextBlock['align'] }, 'text-align');
  });

  $<HTMLInputElement>('ll-text-colour').addEventListener('input', (event) => {
    editSelectedText({ colour: (event.target as HTMLInputElement).value }, 'text-colour');
  });

  for (const [id, key] of [
    ['ll-text-size', 'size'], ['ll-text-x', 'x'], ['ll-text-y', 'y'],
    ['ll-text-plate', 'plate'], ['ll-text-fade', 'fade'],
  ] as [string, 'size' | 'x' | 'y' | 'plate' | 'fade'][]) {
    $<HTMLInputElement>(id).addEventListener('input', (event) => {
      editSelectedText({ [key]: Number((event.target as HTMLInputElement).value) }, `text-${key}`);
    });
  }

  $<HTMLButtonElement>('ll-text-add').addEventListener('click', () => {
    if (!recording) return;
    const before = new Set(texts.map((text) => text.id));
    texts = addText(texts, previewTime, recording.duration);
    // addText sorts, so the new caption is found by what was not there before
    // rather than by where it ended up.
    selectedText = texts.find((text) => !before.has(text.id))?.id ?? selectedText;
    announceAdded('Caption', previewTime);
    selected = null;
    renderSelected();
    renderTexts();
    persistTexts();
    void drawPreview();
  });

  // ------------------------------------------------------------------ preview

  /**
   * The zoom track, rebuilt only when the zooms change.
   *
   * Playback paints a frame at the recording's own rate, and rebuilding this
   * from every block on every frame was pure waste. Anything that edits a zoom
   * or the zoom settings clears it.
   */
  let trackCache: ReturnType<typeof trackFromBlocks> | null = null;
  function invalidateTrack(): void { trackCache = null; }
  function zoomTrack(): ReturnType<typeof trackFromBlocks> {
    if (!trackCache) trackCache = trackFromBlocks(zooms, recording?.duration ?? 0, settings.zoom);
    return trackCache;
  }

  /**
   * The recorded pointer position nearest a moment.
   *
   * Samples are in time order, so this is a binary search. It used to be a
   * linear scan of every sample, which is fine once but not sixty times a
   * second against a recording that may hold thousands of them.
   */
  function cursorAt(current: Project, time: number): Project['pointer'][number] | null {
    const points = current.pointer;
    if (points.length === 0) return null;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (points[mid].time < time) low = mid + 1;
      else high = mid;
    }
    const after = points[low];
    const before = points[low > 0 ? low - 1 : 0];
    return Math.abs(before.time - time) <= Math.abs(after.time - time) ? before : after;
  }

  /**
   * Composes one frame onto the preview canvas from whatever the media
   * elements are showing right now.
   *
   * This deliberately does not seek. During playback the video element is the
   * clock and its decoder is already handing over frames in order, which is the
   * whole reason playback can run at the recording's rate.
   */
  function paint(time: number): void {
    const current = project();
    if (!current || !video) return;

    // Cropping and aiming both work on the real picture rather than the
    // composed one, so the canvas takes their coordinates: the whole source for
    // a crop, the cropped region for a zoom target.
    const region = focusTarget ? zoomRegion() : null;
    const size = cropping
      ? { width: video.videoWidth || current.sourceWidth, height: video.videoHeight || current.sourceHeight }
      : region
        ? { width: Math.round(region.width), height: Math.round(region.height) }
        : settings.composition;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;

    const context = canvas.getContext('2d');
    if (!context) return;
    if (cropping) { drawCropEditor(context); return; }
    if (focusTarget) { drawAimEditor(context); return; }

    // The element goes with the moment. Everything else about the frame, the
    // zoom, the cursor, the overlays, is addressed in reel seconds and does not
    // care which recording it came off.
    const drawn = { ...current, video: spotAt(time).element };
    drawFrame(context, drawn, time, zoomAt(zoomTrack(), time), cursorAt(current, time));
    if (selectedRedaction) drawRedactOutline(context, time);
  }

  /**
   * Seeks to a moment and paints it, for scrubbing and for edits made paused.
   *
   * Requests coalesce to the most recent instead of being dropped. The previous
   * version returned early whenever a draw was already running and scheduled
   * nothing afterwards, so a fast scrub discarded almost every request
   * including, sometimes, the last one. The canvas was then left showing a
   * frame the playhead had already moved past.
   */
  let seeking = false;
  let pendingSeek: number | null = null;
  async function drawPreview(): Promise<void> {
    const current = project();
    if (!current || !video) return;
    if (seeking) { pendingSeek = previewTime; return; }

    seeking = true;
    try {
      let target = previewTime;
      for (;;) {
        // On a reel this is the recording the playhead is over, at that
        // recording's own time, rather than the first one at the reel's time.
        const spot = spotAt(target);
        const limit = Number.isFinite(spot.element.duration) && spot.element.duration > 0
          ? spot.element.duration
          : current.duration;
        await seekSafely(spot.element, Math.max(0, Math.min(limit - 1e-3, spot.at)));
        if (cameraVideo) {
          await seekSafely(cameraVideo, Math.min(Math.max(0, cameraVideo.duration - 1e-3), target)).catch(() => {});
        }
        paint(target);
        if (pendingSeek === null || pendingSeek === target) break;
        target = pendingSeek;
        pendingSeek = null;
      }
    } finally {
      seeking = false;
      pendingSeek = null;
    }
  }

  function syncScrub(): void {
    scrubber.value = String(previewTime);
    $<HTMLSpanElement>('ll-time').textContent = formatClock(previewTime);
    renderPlayhead();
  }

  scrubber.addEventListener('input', () => {
    // Dragging the scrubber during playback means "take me there", so playback
    // stops rather than fighting the pointer for the position.
    if (playing) pause();
    previewTime = Number(scrubber.value);
    $<HTMLSpanElement>('ll-time').textContent = formatClock(previewTime);
    void drawPreview();
  });

  // ------------------------------------------------------------------ block menu

  /**
   * The right-click menu on a timeline block.
   *
   * Built and thrown away each time rather than kept hidden, because the items
   * it offers depend on where the playhead is: a split is only possible when
   * the playhead is inside the block with room on both sides, and offering a
   * greyed-out item that is usually greyed out is worse than not offering it.
   */
  let menuEl: HTMLDivElement | null = null;

  function closeMenu(): void {
    menuEl?.remove();
    menuEl = null;
  }

  function openMenu(event: MouseEvent, items: { label: string; enabled: boolean; run: () => void }[]): void {
    closeMenu();
    event.preventDefault();

    const menu = document.createElement('div');
    menu.className = 'll-menu';
    menu.setAttribute('role', 'menu');

    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.disabled = !item.enabled;
      button.addEventListener('click', () => { closeMenu(); item.run(); });
      menu.append(button);
    }

    document.body.append(menu);
    // Placed after it is in the document, so its real size is known and it can
    // be nudged back inside the window rather than opening off the edge.
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(window.innerWidth - box.width - 4, event.clientX))}px`;
    menu.style.top = `${Math.max(4, Math.min(window.innerHeight - box.height - 4, event.clientY))}px`;
    menuEl = menu;

    const dismiss = (dismissal: Event) => {
      if (dismissal.target instanceof Node && menu.contains(dismissal.target)) return;
      closeMenu();
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('scroll', dismiss, true);
    };
    const onEscape = (key: KeyboardEvent) => { if (key.key === 'Escape') dismiss(key); };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('scroll', dismiss, true);
  }

  function zoomMenu(event: MouseEvent, id: string): void {
    if (!recording) return;
    const zoom = zooms.find((entry) => entry.id === id);
    if (!zoom) return;
    const canSplit = previewTime - zoom.start >= MIN_BLOCK && zoom.end - previewTime >= MIN_BLOCK;

    openMenu(event, [
      {
        label: 'Duplicate',
        enabled: duplicateBlock(zooms, id, recording.duration).length > zooms.length,
        run: () => {
          zooms = duplicateBlock(zooms, id, recording!.duration);
          renderZooms();
          persistZooms();
          void drawPreview();
        },
      },
      {
        label: 'Split at the playhead',
        enabled: canSplit,
        run: () => {
          zooms = splitBlock(zooms, id, previewTime);
          renderZooms();
          persistZooms();
          void drawPreview();
        },
      },
      {
        label: 'Remove',
        enabled: true,
        run: () => {
          zooms = removeBlock(zooms, id);
          if (selected === id) selected = null;
          renderZooms();
          persistZooms();
          void drawPreview();
        },
      },
    ]);
  }

  function textMenu(event: MouseEvent, id: string): void {
    if (!recording) return;
    const text = texts.find((entry) => entry.id === id);
    if (!text) return;
    const canSplit = previewTime - text.start >= MIN_TEXT && text.end - previewTime >= MIN_TEXT;

    openMenu(event, [
      {
        label: 'Duplicate',
        enabled: true,
        run: () => {
          texts = duplicateText(texts, id, recording!.duration);
          renderTexts();
          persistTexts();
          void drawPreview();
        },
      },
      {
        label: 'Split at the playhead',
        enabled: canSplit,
        run: () => {
          texts = splitText(texts, id, previewTime);
          renderTexts();
          persistTexts();
          void drawPreview();
        },
      },
      {
        label: 'Remove',
        enabled: true,
        run: () => {
          texts = removeText(texts, id);
          if (selectedText === id) selectedText = null;
          renderTexts();
          persistTexts();
          void drawPreview();
        },
      },
    ]);
  }

  // ------------------------------------------------------------------ pop out

  mountPopout($<HTMLButtonElement>('ll-popout'), canvas, drawPreview);

  // ------------------------------------------------------------------ controls

  const presetsEl = $<HTMLDivElement>('ll-presets');
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'll-preset';
    button.dataset.preset = preset.id;
    button.title = preset.label;
    button.setAttribute('aria-label', preset.label);
    button.style.background = preset.background === 'gradient'
      ? `linear-gradient(135deg, ${preset.colours[0]}, ${preset.colours[1]})`
      : preset.background === 'none' ? 'repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 12px 12px'
      : preset.colours[0];
    button.addEventListener('click', () => {
      settings.composition.background = preset.background;
      settings.composition.colours = [...preset.colours];
      remember();
      markPresets();
      void drawPreview();
    });
    presetsEl.append(button);
  }
  function markPresets(): void {
    for (const button of presetsEl.querySelectorAll<HTMLButtonElement>('.ll-preset')) {
      const preset = PRESETS.find((entry) => entry.id === button.dataset.preset)!;
      const active = preset.background === settings.composition.background
        && preset.colours[0] === settings.composition.colours[0];
      button.setAttribute('aria-pressed', String(active));
    }
  }

  const sizeEl = $<HTMLSelectElement>('ll-size');
  for (const size of OUTPUT_SIZES) {
    const option = document.createElement('option');
    option.value = size.id;
    option.textContent = size.label;
    sizeEl.append(option);
  }
  sizeEl.addEventListener('change', () => {
    const size = OUTPUT_SIZES.find((entry) => entry.id === sizeEl.value);
    if (!size) return;
    settings.composition.width = size.width;
    settings.composition.height = size.height;
    remember();
    void describeFormat();
    void drawPreview();
  });

  const sliders: [string, (value: number) => void, () => number][] = [
    ['ll-padding', (value) => { settings.composition.padding = value; }, () => settings.composition.padding],
    ['ll-radius', (value) => { settings.composition.radius = value; }, () => settings.composition.radius],
    ['ll-shadow', (value) => { settings.composition.shadow = value; }, () => settings.composition.shadow],
    ['ll-zoom-scale', (value) => { settings.zoom.scale = value; }, () => settings.zoom.scale],
    ['ll-zoom-hold', (value) => { settings.zoom.holdSeconds = value; }, () => settings.zoom.holdSeconds],
    ['ll-zoom-move', (value) => { settings.zoom.moveSeconds = value; }, () => settings.zoom.moveSeconds],
    ['ll-camera-size', (value) => { settings.composition.camera.size = value; }, () => settings.composition.camera.size],
    ['ll-tilt-x', (value) => { settings.tilt.x = value; }, () => settings.tilt.x],
    ['ll-tilt-y', (value) => { settings.tilt.y = value; }, () => settings.tilt.y],
    ['ll-tilt-rotate', (value) => { settings.tilt.rotate = value; }, () => settings.tilt.rotate],
    ['ll-tilt-depth', (value) => { settings.tilt.depth = value; }, () => settings.tilt.depth],
    ['ll-motion-seconds', (value) => { settings.motion.seconds = value; }, () => settings.motion.seconds],
    ['ll-cursor-size', (value) => { settings.cursorSize = value; }, () => settings.cursorSize],
    ['ll-voice-highpass', (value) => { settings.voice.highPass = value; }, () => settings.voice.highPass],
    ['ll-voice-gate', (value) => { settings.voice.gate = value; }, () => settings.voice.gate],
    ['ll-spotlight', (value) => { settings.spotlight = value; }, () => settings.spotlight],
  ];
  for (const [id, apply] of sliders) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      apply(Number(input.value));
      // The default scale used to write a value that only new blocks would ever
      // read, so after a recording the slider looked broken. It now carries the
      // blocks nobody has touched with it, which is what a default should mean.
      if (id === 'll-zoom-scale') applyDefaultScale();
      remember(`slider:${id}`);
      renderReadouts();
      void drawPreview();
    });
  }

  /** Retunes every zoom still on the automatic settings. Pinned ones are yours. */
  function applyDefaultScale(): void {
    if (!zooms.some((zoom) => !zoom.pinned)) return;
    zooms = zooms.map((zoom) => (zoom.pinned ? zoom : { ...zoom, scale: settings.zoom.scale }));
    invalidateTrack();
    renderZooms();
  }

  const toggles: [string, (value: boolean) => void, () => boolean][] = [
    ['ll-zoom-on', (value) => { settings.zoom.enabled = value; }, () => settings.zoom.enabled],
    ['ll-clicks', (value) => { settings.showClicks = value; }, () => settings.showClicks],
    ['ll-cursor', (value) => { settings.showCursor = value; }, () => settings.showCursor],
    ['ll-keys', (value) => { settings.showKeys = value; }, () => settings.showKeys],
    ['ll-voice-normalise', (value) => { settings.voice.normalise = value; }, () => settings.voice.normalise],
    ['ll-camera-on', (value) => { settings.composition.camera.enabled = value; }, () => settings.composition.camera.enabled],
    ['ll-audio', (value) => { settings.keepAudio = value; }, () => settings.keepAudio],
  ];
  for (const [id, apply] of toggles) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      apply(input.checked);
      remember();
      void drawPreview();
    });
  }

  for (const [id, key] of [['ll-motion-in', 'entrance'], ['ll-motion-out', 'exit']] as [string, 'entrance' | 'exit'][]) {
    const select = $<HTMLSelectElement>(id);
    for (const entry of MOTIONS) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      select.append(option);
    }
    select.addEventListener('change', () => {
      settings.motion[key] = select.value as Motion;
      remember();
      void drawPreview();
    });
  }

  $<HTMLButtonElement>('ll-tilt-reset').addEventListener('click', () => {
    settings.tilt = { ...defaultTilt };
    remember();
    renderControls();
    void drawPreview();
  });

  const shapeEl = $<HTMLSelectElement>('ll-camera-shape');
  for (const shape of CAMERA_SHAPES) {
    const option = document.createElement('option');
    option.value = shape.id;
    option.textContent = shape.label;
    shapeEl.append(option);
  }
  shapeEl.addEventListener('change', () => {
    settings.composition.camera.shape = shapeEl.value as CameraShape;
    remember();
    void drawPreview();
  });

  const cornerEl = $<HTMLSelectElement>('ll-camera-corner');
  cornerEl.addEventListener('change', () => {
    settings.composition.camera.corner = cornerEl.value as CameraCorner;
    remember();
    void drawPreview();
  });

  const formatEl = $<HTMLSelectElement>('ll-format');
  formatEl.addEventListener('change', async () => {
    settings.format = formatEl.value as OutputFormat;
    remember();
    await describeFormat();
  });

  const qualityEl = $<HTMLSelectElement>('ll-quality');
  for (const entry of QUALITY) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    qualityEl.append(option);
  }
  qualityEl.addEventListener('change', () => {
    settings.quality = qualityEl.value as Settings['quality'];
    remember();
    renderReadouts();
  });

  /** Says what this browser can write, and what each choice costs. */
  async function describeFormat(): Promise<void> {
    const note = $<HTMLParagraphElement>('ll-format-note');
    const { width, height } = settings.composition;
    const able = await capabilities(width, height);

    const mp4Option = formatEl.querySelector<HTMLOptionElement>('option[value="mp4"]');
    if (mp4Option) {
      mp4Option.disabled = !able.mp4;
      mp4Option.textContent = able.mp4 ? 'MP4' : 'MP4, not available here';
    }

    if (settings.format === 'mp4' && !able.mp4) {
      settings.format = 'webm';
      formatEl.value = 'webm';
      remember();
    }

    note.textContent =
      settings.format === 'gif'
        ? 'A GIF plays anywhere but has no sound and only 256 colours a frame. Keep it short and small.'
        : settings.format === 'mp4'
          ? able.aac
            ? 'MP4 with H.264. The most portable choice.'
            : 'MP4 with H.264. This browser cannot encode AAC, so the sound will be Opus, which Safari does not play. WebM keeps sound everywhere.'
          : 'WebM with VP9. Best quality for the size, and sound that plays in every current browser.';
  }

  const fpsEl = $<HTMLSelectElement>('ll-fps');
  fpsEl.addEventListener('change', () => {
    settings.frameRate = Number(fpsEl.value) || 30;
    remember();
    renderReadouts();
  });

  function renderControls(): void {
    for (const [id, , read] of sliders) $<HTMLInputElement>(id).value = String(read());
    for (const [id, , read] of toggles) $<HTMLInputElement>(id).checked = read();
    cornerEl.value = settings.composition.camera.corner;
    shapeEl.value = settings.composition.camera.shape;
    $<HTMLSelectElement>('ll-motion-in').value = settings.motion.entrance;
    $<HTMLSelectElement>('ll-motion-out').value = settings.motion.exit;
    countdownEl.value = String(settings.countdown);
    $<HTMLInputElement>('ll-countdown-sound').checked = settings.countdownSound;
    $<HTMLInputElement>('ll-camera-blur').checked = settings.cameraBlur;
    renderWallpaper();
    fpsEl.value = String(settings.frameRate);
    formatEl.value = settings.format;
    qualityEl.value = settings.quality;
    const size = OUTPUT_SIZES.find((entry) =>
      entry.width === settings.composition.width && entry.height === settings.composition.height);
    sizeEl.value = size?.id ?? OUTPUT_SIZES[0].id;
    markPresets();
    renderReadouts();
  }

  function renderReadouts(): void {
    const readouts: [string, string][] = [
      ['ll-padding-out', `${Math.round(settings.composition.padding * 100)}%`],
      ['ll-radius-out', `${Math.round(settings.composition.radius * 100)}%`],
      ['ll-shadow-out', `${Math.round(settings.composition.shadow * 100)}%`],
      ['ll-zoom-scale-out', `${settings.zoom.scale.toFixed(1)}x`],
      ['ll-zoom-hold-out', `${settings.zoom.holdSeconds.toFixed(1)}s`],
      ['ll-zoom-move-out', `${settings.zoom.moveSeconds.toFixed(2)}s`],
      ['ll-camera-size-out', `${Math.round(settings.composition.camera.size * 100)}%`],
      ['ll-tilt-x-out', `${Math.round(settings.tilt.x)}\u00b0`],
      ['ll-tilt-y-out', `${Math.round(settings.tilt.y)}\u00b0`],
      ['ll-tilt-rotate-out', `${Math.round(settings.tilt.rotate)}\u00b0`],
      ['ll-tilt-depth-out', `${Math.round(settings.tilt.depth * 100)}%`],
      ['ll-motion-seconds-out', `${settings.motion.seconds.toFixed(2)}s`],
      ['ll-cursor-size-out', `${settings.cursorSize.toFixed(1)}x`],
      ['ll-voice-highpass-out', settings.voice.highPass > 0 ? `${settings.voice.highPass} Hz` : 'off'],
      ['ll-voice-gate-out', settings.voice.gate > 0 ? `${Math.round(settings.voice.gate * 100)}%` : 'off'],
      ['ll-spotlight-out', settings.spotlight > 0 ? `${Math.round(settings.spotlight * 100)}%` : 'off'],
    ];
    for (const [id, text] of readouts) $<HTMLSpanElement>(id).textContent = text;
    $<HTMLSpanElement>('ll-bitrate-out').textContent = `${Math.round(suggestBitrate() / 1000)} kbps`;
    $<HTMLDivElement>('ll-camera-fields').hidden = !settings.composition.camera.enabled;
  }

  $<HTMLButtonElement>('ll-reanalyse').addEventListener('click', () => { void analyse().then(drawPreview); });

  // ------------------------------------------------------------------ wallpaper

  /** The chosen background picture, decoded once and kept ready to draw. */
  let wallpaper: ImageBitmap | HTMLImageElement | null = null;
  let wallpaperUrl: string | null = null;
  /** Kept alongside the decoded picture so an undo can put the right one back. */
  let wallpaperBytes: Uint8Array | null = null;
  let wallpaperMime = 'image/png';

  const wallpaperNote = $<HTMLParagraphElement>('ll-wallpaper-note');
  const wallpaperFile = $<HTMLInputElement>('ll-wallpaper-file');
  const wallpaperClear = $<HTMLButtonElement>('ll-wallpaper-clear');

  function renderWallpaper(): void {
    const has = wallpaper !== null;
    wallpaperClear.hidden = !has;
    wallpaperNote.hidden = !has;
    if (has && wallpaper) {
      wallpaperNote.textContent =
        `Using a picture ${wallpaper.width} by ${wallpaper.height}, cropped to fill the frame.`;
    }
  }

  /**
   * Decodes stored bytes into something drawable.
   *
   * createImageBitmap rather than an Image element, because an element decodes
   * on the main thread and a browser is free to defer that indefinitely while
   * the page is not being displayed. A background that only appeared once you
   * looked at the tab would be a very confusing bug to have.
   */
  async function useWallpaper(bytes: Uint8Array, mime: string): Promise<void> {
    dropWallpaper();
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    wallpaperBytes = bytes;
    wallpaperMime = mime;

    if (typeof createImageBitmap === 'function') {
      try {
        wallpaper = await createImageBitmap(blob);
        renderWallpaper();
        return;
      } catch {
        // Fall through to the element, which reads a few formats bitmaps do not.
      }
    }

    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error('unreadable')), { once: true });
        image.src = url;
      });
    } catch {
      URL.revokeObjectURL(url);
      wallpaperBytes = null;
      toast('That picture could not be read.');
      return;
    }
    wallpaper = image;
    wallpaperUrl = url;
    urls.push(url);
    renderWallpaper();
  }

  function dropWallpaper(): void {
    if (wallpaperUrl) {
      URL.revokeObjectURL(wallpaperUrl);
      urls = urls.filter((entry) => entry !== wallpaperUrl);
    }
    if (wallpaper instanceof ImageBitmap) wallpaper.close();
    wallpaper = null;
    wallpaperUrl = null;
    wallpaperBytes = null;
  }

  $<HTMLButtonElement>('ll-wallpaper-pick').addEventListener('click', () => wallpaperFile.click());

  wallpaperFile.addEventListener('change', async () => {
    const file = wallpaperFile.files?.[0];
    wallpaperFile.value = '';
    if (!file) return;

    const bytes = new Uint8Array(await file.arrayBuffer());
    await useWallpaper(bytes, file.type || 'image/png');
    if (!wallpaper) return;

    settings.composition.background = 'image';
    if (stored) {
      // The picture travels with the project, because a background that
      // disappeared on reopening would be worse than not offering one.
      stored.wallpaper = bytes;
      stored.wallpaperMime = wallpaperMime;
    }
    remember();
    markPresets();
    renderWallpaper();
    void drawPreview();
    void renderProjects();
  });

  wallpaperClear.addEventListener('click', () => {
    dropWallpaper();
    if (settings.composition.background === 'image') settings.composition.background = 'gradient';
    if (stored) stored.wallpaper = null;
    remember();
    markPresets();
    renderWallpaper();
    void drawPreview();
    void renderProjects();
  });

  // ------------------------------------------------------------------ transcript

  const cuesEl = $<HTMLOListElement>('ll-cues');
  const cueFile = $<HTMLInputElement>('ll-captions-file');

  function renderCues(): void {
    cuesEl.innerHTML = '';
    for (const cue of captions) {
      const row = document.createElement('li');
      row.className = 'll-cue';
      row.dataset.id = cue.id;
      if (pickedCues.has(cue.id)) row.classList.add('is-picked');
      if (previewTime >= cue.start && previewTime <= cue.end) row.classList.add('is-now');

      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.checked = pickedCues.has(cue.id);
      pick.setAttribute('aria-label', `Select the line at ${formatClock(cue.start)}`);
      pick.addEventListener('change', () => {
        if (pick.checked) pickedCues.add(cue.id);
        else pickedCues.delete(cue.id);
        renderCues();
      });

      const at = document.createElement('span');
      at.className = 'll-time';
      at.textContent = formatClock(cue.start);
      at.title = 'Go to this line';
      at.addEventListener('click', () => seekTo(cue.start));

      const words = document.createElement('textarea');
      words.className = 'field';
      words.rows = 1;
      words.value = cue.text;
      words.setAttribute('aria-label', `Words of the line at ${formatClock(cue.start)}`);
      words.addEventListener('input', () => {
        captions = captions.map((entry) => (entry.id === cue.id ? { ...entry, text: words.value } : entry));
        remember(`cue:${cue.id}`);
        void drawPreview();
      });

      row.append(pick, at, words);
      cuesEl.append(row);
    }

    const picked = captions.filter((cue) => pickedCues.has(cue.id));
    $<HTMLDivElement>('ll-cues-actions').hidden = picked.length === 0;
    const seconds = picked.reduce((total, cue) => total + (cue.end - cue.start), 0);
    $<HTMLSpanElement>('ll-cues-label').textContent = picked.length
      ? `${picked.length} line${picked.length === 1 ? '' : 's'}, ${seconds.toFixed(1)}s`
      : '';
    renderListen();
    $<HTMLInputElement>('ll-captions-burn').checked = settings.burnCaptions;
    $<HTMLInputElement>('ll-caption-size').value = String(settings.captionSize);
    $<HTMLSpanElement>('ll-caption-size-out').textContent = `${Math.round(settings.captionSize * 100)}%`;
  }

  // ---------------------------------------------------------------- listening

  const listenButton = $<HTMLButtonElement>('ll-listen');
  const listenSize = $<HTMLSelectElement>('ll-listen-size');
  const listenNote = $<HTMLSpanElement>('ll-listen-note');

  for (const model of WHISPER_MODELS) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.label}, ${model.note}`;
    listenSize.append(option);
  }

  let listening = false;

  function renderListen(): void {
    const possible = canTranscribe() && Boolean(recording?.hasAudio);
    listenButton.disabled = !possible || listening;
    listenSize.disabled = listening;
    if (!recording?.hasAudio) {
      listenNote.textContent = recording ? 'This recording has no sound.' : '';
      return;
    }
    if (!canTranscribe()) listenNote.textContent = 'This browser cannot run the model.';
    else if (!listening) listenNote.textContent = '';
  }

  listenButton.addEventListener('click', async () => {
    if (!recording?.hasAudio || listening) return;
    listening = true;
    renderListen();
    barEl.hidden = false;

    try {
      // Decoded here rather than inside the transcriber, because the recording
      // is already in hand and decoding it twice would be wasteful.
      const Context = window.AudioContext
        ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) throw new Error('This browser has no audio decoder.');
      const context = new Context();
      let buffer: AudioBuffer;
      try {
        buffer = await context.decodeAudioData(await recording.blob.arrayBuffer());
      } finally {
        await context.close().catch(() => {});
      }

      const found = await transcribe(
        buffer,
        listenSize.value as WhisperSize,
        (progress) => {
          const percent = progress.ratio === null ? null : Math.round(progress.ratio * 100);
          barFill.style.width = `${percent ?? 0}%`;
          const said = progress.stage === 'library'
            ? 'Fetching the model runtime'
            : progress.stage === 'model'
              ? `Fetching the model${percent === null ? '' : `, ${percent}%`}`
              : 'Listening to the recording';
          listenNote.textContent = said;
          setStatus(`${said}.`, 'busy');
          speaker.progress(
            progress.stage === 'model' ? 'Fetching the model' : said,
            progress.stage === 'model' ? progress.ratio : null,
          );
        },
      );

      if (found.length === 0) {
        setStatus('Nothing could be made out in the recording.', 'bad');
        return;
      }
      captions = sortCues(found.map((cue) => ({ ...cue, id: createId('cue') })));
      pickedCues.clear();
      remember('transcribed');
      renderCues();
      void drawPreview();
      setStatus(`Wrote out ${found.length} lines. Nothing left this browser.`, 'good');
      toast(`${found.length} lines. Select any of them and press Cut to remove them from the video.`);
    } catch (error) {
      // The model is a convenience, so a failure says what happened and leaves
      // the import and typing paths exactly as they were.
      setStatus(
        error instanceof Error && /fetch|network|Failed/i.test(error.message)
          ? 'The model could not be fetched. You can still open an SRT or VTT file instead.'
          : 'The recording could not be written out. You can still open an SRT or VTT file instead.',
        'bad',
      );
    } finally {
      listening = false;
      barEl.hidden = true;
      barFill.style.width = '0%';
      renderListen();
    }
  });

  $<HTMLButtonElement>('ll-captions-open').addEventListener('click', () => cueFile.click());
  cueFile.addEventListener('change', async () => {
    const [file] = Array.from(cueFile.files ?? []);
    cueFile.value = '';
    if (!file) return;
    const parsed = parseCaptions(await file.text(), () => createId('cue'));
    if (parsed.length === 0) {
      setStatus('No subtitles could be read out of that file.', 'bad');
      return;
    }
    captions = parsed;
    pickedCues.clear();
    remember('captions');
    renderCues();
    void drawPreview();
    toast(`Read ${parsed.length} lines.`);
  });

  $<HTMLButtonElement>('ll-captions-add').addEventListener('click', () => {
    if (!recording) return;
    const end = Math.min(recording.duration, previewTime + 2.5);
    if (end - previewTime < 0.2) return;
    captions = sortCues([...captions, { id: createId('cue'), start: previewTime, end, text: 'New line' }]);
    remember('cue-add');
    renderCues();
    void drawPreview();
  });

  $<HTMLButtonElement>('ll-captions-srt').addEventListener('click', () => {
    if (!captions.length) return;
    downloadBlob(`${projectName()}.srt`, new Blob([toSrt(alignedCaptions())], { type: 'text/plain' }));
  });
  $<HTMLButtonElement>('ll-captions-vtt').addEventListener('click', () => {
    if (!captions.length) return;
    downloadBlob(`${projectName()}.vtt`, new Blob([toVtt(alignedCaptions())], { type: 'text/vtt' }));
  });

  function projectName(): string {
    return (stored?.name ?? 'recording').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  }

  /**
   * The subtitles as they line up with the finished video.
   *
   * A transcript is written against the recording, but it is shown against the
   * export, and those stop agreeing the moment anything is cut or sped up.
   */
  function alignedCaptions(): Cue[] {
    if (!recording) return captions;
    const segments = segmentsOf(trim, cuts, speeds);
    return alignToEdit(
      captions,
      (source) => editedAt(segments, source),
      (source) => !segments.some((part) => source >= part.start && source < part.end),
    );
  }

  $<HTMLButtonElement>('ll-cues-cut').addEventListener('click', () => {
    const spans = spansOf(captions, [...pickedCues]);
    if (spans.length === 0) return;
    const removed = spans.reduce((total, span) => total + (span.end - span.start), 0);
    cuts = mergeSpans([...cuts, ...spans]);
    // The lines themselves go too: their seconds are no longer in the video, so
    // leaving them would put a subtitle on a moment that does not exist.
    captions = captions.filter((cue) => !pickedCues.has(cue.id));
    pickedCues.clear();
    remember('cut-transcript');
    renderCues();
    renderCuts();
    void drawPreview();
    toast(`Cut ${spans.length} line${spans.length === 1 ? '' : 's'}, ${removed.toFixed(1)}s shorter.`);
  });

  $<HTMLButtonElement>('ll-cues-clear').addEventListener('click', () => {
    pickedCues.clear();
    renderCues();
  });

  $<HTMLInputElement>('ll-captions-burn').addEventListener('change', (event) => {
    settings.burnCaptions = (event.target as HTMLInputElement).checked;
    remember();
    void drawPreview();
  });
  $<HTMLInputElement>('ll-caption-size').addEventListener('input', (event) => {
    settings.captionSize = Number((event.target as HTMLInputElement).value);
    remember('caption-size');
    renderCues();
    void drawPreview();
  });

  // ------------------------------------------------------------------ music

  /**
   * The bed, decoded once and kept at the encoder's rate.
   *
   * Decoding happens when the file is chosen rather than at export time, so a
   * file the browser cannot read is reported straight away instead of failing
   * halfway through a render somebody has waited for.
   */
  let musicSamples: Float32Array | null = null;
  const musicFile = $<HTMLInputElement>('ll-music-file');

  async function decodeMusic(bytes: Uint8Array): Promise<Float32Array | null> {
    const Context = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    let context: AudioContext | null = null;
    try {
      context = new Context({ sampleRate: 48000 });
      const buffer = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      // Mixed to mono: the bed is background, and a stereo image under a voice
      // recorded in mono is not worth the memory.
      const length = buffer.length;
      const out = new Float32Array(length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let at = 0; at < length; at += 1) out[at] += data[at] / buffer.numberOfChannels;
      }
      return out;
    } catch {
      return null;
    } finally {
      await context?.close().catch(() => {});
    }
  }

  function renderMusic(): void {
    const name = stored?.musicName ?? '';
    $<HTMLSpanElement>('ll-music-name').textContent = name;
    $<HTMLButtonElement>('ll-music-drop').hidden = !name;
    $<HTMLInputElement>('ll-music-level').value = String(settings.music.level);
    $<HTMLSpanElement>('ll-music-level-out').textContent = `${Math.round(settings.music.level * 100)}%`;
    $<HTMLInputElement>('ll-music-duck').value = String(settings.music.duck);
    $<HTMLSpanElement>('ll-music-duck-out').textContent = `${Math.round(settings.music.duck * 100)}%`;
  }

  $<HTMLButtonElement>('ll-music-open').addEventListener('click', () => musicFile.click());
  musicFile.addEventListener('change', async () => {
    const [file] = Array.from(musicFile.files ?? []);
    musicFile.value = '';
    if (!file || !stored) return;
    setStatus(`Reading ${file.name}.`, 'busy');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decoded = await decodeMusic(bytes);
    if (!decoded) {
      setStatus('That file could not be read as audio.', 'bad');
      return;
    }
    musicSamples = decoded;
    stored.music = bytes;
    stored.musicName = file.name;
    remember('music');
    renderMusic();
    setStatus(`${file.name} will play underneath.`, 'good');
  });

  $<HTMLButtonElement>('ll-music-drop').addEventListener('click', () => {
    if (!stored) return;
    musicSamples = null;
    stored.music = null;
    stored.musicName = '';
    remember('music-drop');
    renderMusic();
  });

  for (const [id, apply] of [
    ['ll-music-level', (value: number) => { settings.music.level = value; }],
    ['ll-music-duck', (value: number) => { settings.music.duck = value; }],
  ] as [string, (value: number) => void][]) {
    $<HTMLInputElement>(id).addEventListener('input', (event) => {
      apply(Number((event.target as HTMLInputElement).value));
      remember(`music:${id}`);
      renderMusic();
    });
  }

  // ------------------------------------------------------------------ chapters

  const chapters = mountChapters($, {
    marks: () => recording?.marks ?? [],
    onRename: (marks) => {
      if (!recording) return;
      recording.marks = marks;
      if (stored) { stored.marks = marks; queueSave(); }
    },
    goTo: (time) => seekTo(time),
    formatClock,
    onError: (message) => setStatus(message, 'bad'),
  });
  const renderChapters = () => chapters.render();

  // ------------------------------------------------------------------ destinations

  /**
   * Where the video is going, as one action.
   *
   * The crop, the output size and the safe area are three settings that always
   * move together for a given destination, and setting them separately is both
   * tedious and easy to get half right.
   */
  const DESTINATIONS: { id: string; label: string; aspect: string; width: number; height: number }[] = [
    { id: 'wide', label: 'Wide, 16:9', aspect: '16:9', width: 1920, height: 1080 },
    { id: 'tall', label: 'Tall, 9:16', aspect: '9:16', width: 1080, height: 1920 },
    { id: 'square', label: 'Square', aspect: '1:1', width: 1080, height: 1080 },
  ];

  function renderDestinations(): void {
    const holder = $<HTMLDivElement>('ll-destinations');
    holder.innerHTML = '';
    for (const destination of DESTINATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--sm ll-preset';
      button.textContent = destination.label;
      const active = settings.composition.width === destination.width
        && settings.composition.height === destination.height;
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => {
        if (!recording) return;
        settings.composition.width = destination.width;
        settings.composition.height = destination.height;
        const ratio = CROP_ASPECTS.find((entry) => entry.id === destination.aspect);
        if (ratio?.ratio) {
          crop = cropToAspect(crop, ratio.ratio, video?.videoWidth || 1, video?.videoHeight || 1);
        }
        remember(`destination:${destination.id}`);
        renderControls();
        renderCrop();
        renderDestinations();
        void describeFormat();
        void drawPreview();
        toast(`Set up for ${destination.label.toLowerCase()}.`);
      });
      holder.append(button);
    }
  }

  // ------------------------------------------------------------------ looks

  /**
   * Saved looks: the presentation, without the recording.
   *
   * Somebody who makes a second video wants it to match the first, and until
   * now that meant setting the padding, shadow, tilt and background again by
   * hand every time. Trim, crop, zooms and captions belong to one recording and
   * are deliberately not part of this.
   */
  const looksEl = $<HTMLDivElement>('ll-looks');
  const lookNameEl = $<HTMLInputElement>('ll-look-name');
  /** Kept alongside the chips so an agent can name a look without reading the DOM. */
  let knownLooks: Look[] = [];

  async function renderLooks(): Promise<void> {
    const saved = await loadLooks().catch(() => []);
    knownLooks = saved;
    looksEl.innerHTML = '';
    for (const look of saved) {
      const chip = document.createElement('span');
      chip.className = 'll-look';

      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'll-look__use';
      use.textContent = look.name;
      use.title = `Apply ${look.name}`;
      use.addEventListener('click', () => { void applySavedLook(look); });

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'll-look__drop';
      drop.textContent = '×';
      drop.setAttribute('aria-label', `Delete the look ${look.name}`);
      drop.addEventListener('click', async () => {
        await deleteLook(look.id).catch(() => {});
        await renderLooks();
        toast(`Deleted the look ${look.name}.`);
      });

      chip.append(use, drop);
      looksEl.append(chip);
    }
  }

  async function applySavedLook(look: Look): Promise<void> {
    settings = applyLook(settings, look);
    // The background picture travels with the look, so a look that had one
    // brings it and a look that had none takes it away. Otherwise applying a
    // plain look over a recording with a wallpaper would leave the wallpaper
    // showing and the look would not be what was saved.
    if (look.wallpaper) await useWallpaper(look.wallpaper, look.wallpaperMime);
    else dropWallpaper();
    if (settings.composition.background === 'image' && !wallpaper) {
      settings.composition.background = 'gradient';
    }
    remember(`look:${look.id}`);
    renderControls();
    renderZooms();
    void drawPreview();
    toast(`Applied ${look.name}.`);
  }

  $<HTMLButtonElement>('ll-look-save').addEventListener('click', async () => {
    const name = lookNameEl.value.trim();
    if (!name) {
      setStatus('Give the look a name first.', 'bad');
      lookNameEl.focus();
      return;
    }
    await saveLook(lookFrom(name, settings, wallpaperBytes, wallpaperMime)).catch(() => {});
    lookNameEl.value = '';
    await renderLooks();
    toast(`Saved the look ${name}.`);
  });

  lookNameEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $<HTMLButtonElement>('ll-look-save').click(); }
  });

  // ------------------------------------------------------------------ countdown

  const countdownEl = $<HTMLSelectElement>('ll-countdown');
  countdownEl.addEventListener('change', () => {
    settings.countdown = Number(countdownEl.value);
    remember();
  });

  for (const [id, apply] of [
    ['ll-countdown-sound', (value: boolean) => { settings.countdownSound = value; }],
    ['ll-camera-blur', (value: boolean) => { settings.cameraBlur = value; }],
  ] as [string, (value: boolean) => void][]) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => { apply(input.checked); remember(); });
  }

  // ------------------------------------------------------------------ shortcuts

  /**
   * The keys an editor is expected to have.
   *
   * Nothing fires while a field has focus, because a person typing a project
   * name should get the letter rather than a zoom. Space is the exception worth
   * naming: it would otherwise scroll the page.
   */
  /**
   * The shortcuts, listened for on the window rather than the app's own div.
   *
   * A keydown listener on an element only hears the key when focus is already
   * inside it, and nothing inside takes focus on load. So on a freshly opened
   * page every shortcut did nothing until you had clicked something, which is
   * the worst possible moment for them to be silent: it is exactly when the
   * key strip on screen has just told you they work. The guards below are what
   * make listening this widely safe.
   */
  window.addEventListener('keydown', (event) => {
    // A sheet or menu that is open owns the keyboard, and Escape especially:
    // preventing it here would stop a dialog closing.
    if (root.querySelector('dialog[open]')) return;

    // Undo is the one shortcut that keeps its modifier, and the one that has
    // to work while a field has focus.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      void (event.shiftKey ? redoEdit() : undoEdit());
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      void redoEdit();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target?.isContentEditable === true;
    // A range is a control, not a field, so the arrow keys still belong to it.
    if (typing && !(target instanceof HTMLInputElement && target.type === 'range')) return;
    if (!recording || stageEl.hidden) return;

    const step = event.shiftKey ? 1 : 1 / Math.max(1, settings.frameRate);
    const seek = (to: number) => {
      previewTime = Math.max(0, Math.min(recording!.duration, to));
      scrubber.value = String(previewTime);
      $<HTMLSpanElement>('ll-time').textContent = formatClock(previewTime);
      void drawPreview();
    };

    const shortcut = shortcutFor(event.key);
    if (!shortcut) return;
    // The arrow keys belong to a focused range control, which is a control
    // rather than a field and so was let through the typing guard above.
    if (typing && (shortcut.id === 'stepBack' || shortcut.id === 'stepForward')) return;

    const actions: Record<ShortcutId, () => void> = {
      play: () => togglePlay(),
      stepBack: () => seek(previewTime - step),
      stepForward: () => seek(previewTime + step),
      toStart: () => seek(trim.start),
      toEnd: () => seek(trim.end),
      crop: () => cropButton.click(),
      trimStart: () => $<HTMLButtonElement>('ll-trim-start').click(),
      trimEnd: () => $<HTMLButtonElement>('ll-trim-end').click(),
      // Switch to the track first, or the block lands somewhere the person
      // cannot see and reads as nothing having happened.
      // Adding from the keyboard puts the keyboard on what was added, so the
      // arrow keys go straight to placing it.
      addZoom: () => {
        showTrack('zoom');
        $<HTMLButtonElement>('ll-zoom-add').click();
        if (selected) zoomBlocks.focus(selected);
      },
      addText: () => {
        showTrack('text');
        $<HTMLButtonElement>('ll-text-add').click();
        if (selectedText) textTrack.focus(selectedText);
      },
      cancel: () => { if (cropping) cropButton.click(); else if (focusTarget) stopAiming(); },
      remove: () => removeSelected(),
      // Both are handled before the modifier guard, so they never reach here.
      undo: () => {},
      redo: () => {},
    };

    event.preventDefault();
    actions[shortcut.id]();
  });

  /**
   * Removes whatever is selected on the visible track.
   *
   * Selections in other tracks are cleared when the track changes, so at most
   * one is ever live and the order below is a formality rather than a guess.
   */
  function removeSelected(): void {
    // Deleting is the edit most worth hearing: it is the one where nothing
    // arrives to look at, only something leaving.
    const kind = selectedText ? 'Caption'
      : selectedRedaction ? 'Cover up'
        : selectedShape ? 'Shape'
          : selectedSpeed ? 'Speed change'
            : selected ? 'Zoom' : null;
    if (kind) speaker.say(`${kind} removed.`);

    if (selectedText) {
      texts = removeText(texts, selectedText);
      selectedText = null;
      renderTexts();
      persistTexts();
      void drawPreview();
      return;
    }
    if (selectedRedaction) {
      redactions = removeRedaction(redactions, selectedRedaction);
      selectedRedaction = null;
      persistRedactions();
      return;
    }
    if (selectedShape) {
      shapes = removeShape(shapes, selectedShape);
      selectedShape = null;
      persistShapes();
      return;
    }
    if (selectedSpeed) {
      speeds = removeSpeed(speeds, selectedSpeed);
      selectedSpeed = null;
      persistSpeeds();
      return;
    }
    if (selected) deleteZoom(selected);
  }

  /**
   * Playback, driven by the video element rather than by seeking it.
   *
   * The previous version walked a wall clock and seeked to each position, which
   * meant a full decoder seek per frame and no sound at all. Now the element
   * plays, its own currentTime is the clock, and each decoded frame is
   * composed as it arrives. requestVideoFrameCallback fires once per frame with
   * the decoder's timing; browsers without it fall back to animation frames,
   * which is close enough because the element is still the clock.
   */
  /**
   * The element currently driving playback, and the clip it is playing.
   *
   * On a reel of one this is always the recording's own element and the clip is
   * null, which is the path everything took before clips existed. On a longer
   * reel the element changes at every join, and the clock has to be read
   * through the clip: an element three seconds into its own recording may be
   * twenty seconds into the finished video.
   */
  let stage: HTMLVideoElement | null = null;
  let stageClip: Placed | null = null;

  function driver(): HTMLVideoElement | null {
    return stage ?? video;
  }

  /** Element time to reel time. The identity when there is one recording. */
  function reelTime(): number {
    const element = driver();
    if (!element) return previewTime;
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
      ? takes.get(clip.source)?.hasAudio ?? recording?.hasAudio ?? false
      : recording?.hasAudio ?? false;
    const level = clipAudioLevel(clip, element.currentTime);
    element.muted = muted || !hasSound || level <= 0;
    element.volume = Math.max(0, Math.min(1, Number(volInput.value) * level));
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
    if (!element || !playing) return;
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

    const arriving = takes.get(to.source)?.video ?? video;
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
    if (!playing || !element || !recording) return;

    // A clip that has played to its own end hands over rather than running on
    // into whatever else happens to be in that recording after the window.
    if (stageClip && element.currentTime >= stageClip.out - 1e-3) {
      const placed = placedClips();
      const next = placed[placed.findIndex((entry) => entry.id === stageClip!.id) + 1];
      if (next) { void handOver(next); return; }
    }

    const time = reelTime();
    applyPlaybackVolume(element, stageClip);

    if (time >= trim.end - 1e-3) {
      if (looping) { void restart(); return; }
      pause();
      previewTime = trim.end;
      syncScrub();
      paint(previewTime);
      return;
    }

    // Skip anything cut out, so the preview is the finished video rather than
    // the raw recording with some bands drawn on it.
    const inCut = cuts.find((cut) => time >= cut.start && time < cut.end - 1e-3);
    if (inCut) {
      if (inCut.end >= trim.end - 1e-3) {
        if (looping) { void restart(); return; }
        pause();
        previewTime = trim.end;
        syncScrub();
        paint(previewTime);
        return;
      }
      // The cut is in reel seconds. On a reel the far side of it may be in a
      // different recording, in which case the handover does the seeking.
      const landing = spotAt(inCut.end);
      if (stageClip && landing.clip && landing.clip.id !== stageClip.id) {
        void handOver(landing.clip).then(() => {
          const arriving = driver();
          if (arriving) arriving.currentTime = landing.at;
        });
        return;
      }
      element.currentTime = landing.at;
      if (cameraVideo) cameraVideo.currentTime = inCut.end;
      queueFrame();
      return;
    }

    previewTime = time;
    syncScrub();
    paint(time);
    queueFrame();
  }

  async function restart(): Promise<void> {
    if (!video) return;
    const spot = spotAt(trim.start);
    if (spot.clip && spot.clip.id !== stageClip?.id) {
      previewTime = trim.start;
      await handOver(spot.clip);
      const arriving = driver();
      if (arriving) arriving.currentTime = spot.at;
      syncScrub();
      return;
    }
    await seekSafely(spot.element, spot.at);
    if (cameraVideo) await seekSafely(cameraVideo, trim.start).catch(() => {});
    previewTime = trim.start;
    syncScrub();
    queueFrame();
  }

  async function play(): Promise<void> {
    if (!video || !recording || playing || cropping) return;
    if (previewTime >= trim.end - 1e-3 || previewTime < trim.start) previewTime = trim.start;

    // Playback begins on whichever recording the playhead is over, which on a
    // reel of one is the only one there is.
    const spot = spotAt(previewTime);
    stage = spot.element;
    stageClip = spot.clip;

    const limit = Number.isFinite(spot.element.duration) && spot.element.duration > 0
      ? spot.element.duration
      : recording.duration;
    await seekSafely(spot.element, Math.max(0, Math.min(limit - 1e-3, spot.at)));
    if (cameraVideo) {
      await seekSafely(cameraVideo, Math.min(Math.max(0, cameraVideo.duration - 1e-3), previewTime)).catch(() => {});
    }

    // Muted for scrubbing, unmuted to play. Without this you cannot hear your
    // own narration while editing, which is most of what there is to check.
    applyPlaybackVolume(spot.element, spot.clip);

    playing = true;
    renderTransport();
    try {
      await spot.element.play();
      if (cameraVideo) await cameraVideo.play().catch(() => {});
    } catch {
      playing = false;
      renderTransport();
      setStatus('The browser would not start playback.', 'bad');
      return;
    }
    queueFrame();
  }

  function pause(): void {
    if (!playing) return;
    playing = false;
    stopFrames();
    // Every element, not only the one driving: a handover leaves the previous
    // one paused, and muting all of them keeps scrubbing silent.
    for (const take of takes.values()) { take.video.pause(); take.video.muted = true; }
    video?.pause();
    cameraVideo?.pause();
    if (video) video.muted = true;
    renderTransport();
  }

  function togglePlay(): void {
    if (playing) pause();
    else void play();
  }

  /** Reflects playback state onto the transport. */
  function renderTransport(): void {
    playButton.textContent = playing ? '⏸' : '▶';
    playButton.title = playing ? 'Pause (Space)' : 'Play (Space)';
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playButton.dataset.playing = String(playing);
    playButton.disabled = !recording || cropping;
    loopButton.setAttribute('aria-pressed', String(looping));
    muteButton.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
    muteButton.title = muted ? 'Unmute' : 'Mute';
    muteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteButton.setAttribute('aria-pressed', String(muted));
    // Nothing to hear on a silent recording, so the control does not appear.
    volWrap.hidden = !recording?.hasAudio;
    for (const id of ['ll-to-start', 'll-step-back', 'll-step-fwd', 'll-to-end']) {
      $<HTMLButtonElement>(id).disabled = !recording;
    }
  }

  /**
   * Moves the playhead into a block so its edits are visible in the preview.
   *
   * Editing a zoom at 0:40 while looking at 0:05 showed nothing changing, and
   * read as a broken control rather than a preview pointed elsewhere.
   */
  function showBlock(start: number, end: number): void {
    if (!recording) return;
    if (previewTime >= start && previewTime <= end) return;
    if (playing) pause();
    previewTime = Math.min(Math.max((start + end) / 2, 0), recording.duration);
    syncScrub();
    void drawPreview();
  }

  /** Moves the playhead, stopping playback first, and repaints. */
  function seekTo(time: number): void {
    if (!recording) return;
    if (playing) pause();
    previewTime = Math.max(0, Math.min(recording.duration, time));
    syncScrub();
    void drawPreview();
  }

  playButton.addEventListener('click', togglePlay);
  $<HTMLButtonElement>('ll-to-start').addEventListener('click', () => seekTo(trim.start));
  $<HTMLButtonElement>('ll-to-end').addEventListener('click', () => seekTo(trim.end));
  $<HTMLButtonElement>('ll-step-back').addEventListener('click', () => {
    seekTo(previewTime - 1 / Math.max(1, settings.frameRate));
  });
  $<HTMLButtonElement>('ll-step-fwd').addEventListener('click', () => {
    seekTo(previewTime + 1 / Math.max(1, settings.frameRate));
  });

  loopButton.addEventListener('click', () => {
    looping = !looping;
    renderTransport();
  });

  muteButton.addEventListener('click', () => {
    muted = !muted;
    if (video && playing) video.muted = muted;
    renderTransport();
  });

  volInput.addEventListener('input', () => {
    const level = Number(volInput.value);
    if (video) video.volume = level;
    // Reaching for the volume when muted plainly means "let me hear it".
    if (level > 0 && muted) {
      muted = false;
      if (video && playing) video.muted = false;
      renderTransport();
    }
  });

  // ------------------------------------------------------------------ export

  $<HTMLButtonElement>('ll-export').addEventListener('click', async () => {
    const current = project();
    if (!current) return;
    if (controller) { controller.abort(); return; }

    controller = new AbortController();
    const button = $<HTMLButtonElement>('ll-export');
    button.textContent = 'Cancel';
    barEl.hidden = false;
    const started = performance.now();

    try {
      const ready = { ...current, keyframes: trackFromBlocks(zooms, current.duration, settings.zoom) };
      // The worker first, so the page stays usable. Anything it cannot finish
      // comes back here rather than failing.
      const offloaded = canExportInWorker(ready)
        ? await renderInWorker(ready, onProgress, controller.signal)
        : null;
      const result = offloaded
        ?? await render(ready, points, onProgress, controller.signal);
      const stem = (stored?.name ?? 'limelight').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'limelight';
      downloadBlob(`${stem}.${result.extension}`, result.blob);
      setStatus(
        `Saved ${formatBytes(result.blob.size)} from ${result.frames} frames`
        + `${result.hasAudio ? ', with sound' : ', silent'}`
        + `, in ${((performance.now() - started) / 1000).toFixed(1)} seconds.`
        + `${result.note ? ` ${result.note}` : ''}`,
        'good',
      );
      toast('Saved to your downloads folder.', { kind: 'good' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The export failed.';
      setStatus(message === 'Cancelled.' ? 'Cancelled.' : message, message === 'Cancelled.' ? 'idle' : 'bad');
    } finally {
      controller = null;
      button.textContent = 'Export';
      barEl.hidden = true;
      barFill.style.width = '0%';
      await drawPreview();
    }
  });

  $<HTMLButtonElement>('ll-save-raw').addEventListener('click', () => {
    if (!recording) return;
    downloadBlob('recording.webm', recording.blob);
    toast('The untouched recording was saved.', { kind: 'good' });
  });

  // ------------------------------------------------------------------ projects out and in

  /**
   * The project as the database would hold it, whether or not it is in there.
   *
   * A recording opened from a file has never been saved, and its edits are
   * exactly as worth carrying off this machine as a recorded one's.
   */
  async function forExport(): Promise<StoredProject | null> {
    if (!recording) return null;
    const now = new Date().toISOString();
    return {
      id: stored?.id ?? 'unsaved',
      name: stored?.name ?? 'Recording',
      bytes: stored?.bytes ?? new Uint8Array(),
      mime: stored?.mime ?? recording.blob.type ?? 'video/webm',
      cameraBytes: stored?.cameraBytes ?? null,
      duration: recording.duration,
      width: video?.videoWidth ?? recording.width,
      height: video?.videoHeight ?? recording.height,
      hasAudio: recording.hasAudio,
      pointer: recording.pointer,
      clicks: recording.clicks,
      keys: recording.keys,
      marks: recording.marks,
      start: trim.start,
      end: trim.end,
      crop,
      wallpaper: stored?.wallpaper ?? null,
      wallpaperMime: stored?.wallpaperMime ?? 'image/png',
      zooms,
      texts,
      cuts,
      speeds,
      redactions,
      captions,
      shapes,
      music: stored?.music ?? null,
      musicName: stored?.musicName ?? '',
      clips: hasEditedReel() ? clips : [],
      takes: await takeRecords(),
      keyframes: trackFromBlocks(zooms, recording.duration, settings.zoom),
      settings,
      createdAt: stored?.createdAt ?? now,
      updatedAt: now,
    };
  }

  async function saveProjectFile(withVideo: boolean): Promise<void> {
    const current = await forExport();
    if (!current) return;

    // The bytes live in the database, and a recording opened from a file has
    // never been in it. Reading them back from the blob is the only way to
    // carry the video for that case.
    const carrying = withVideo && current.bytes.byteLength === 0
      ? { ...current, bytes: new Uint8Array(await recording!.blob.arrayBuffer()) }
      : current;

    if (withVideo && carrying.bytes.byteLength === 0) {
      setStatus('There is nothing to carry: the recording could not be read.', 'bad');
      return;
    }

    // A reel written without its recordings is a file whose edits describe a
    // timeline nothing in it can reconstruct, so it is worth interrupting over.
    const losing = sidecarLoses(carrying, withVideo);
    if (losing && !confirm(`${losing}\n\nSave the edits anyway?`)) return;

    const text = writeSidecar(carrying, withVideo);
    downloadFile(sidecarFilename(carrying.name, withVideo), text);
    toast(
      withVideo
        ? `Saved everything, about ${formatBytes(sidecarSize(carrying, true))}.`
        : 'Saved the edits. Open the video, then Open a project to put them back.',
      { kind: 'good' },
    );
  }

  $<HTMLButtonElement>('ll-save-edits')
    .addEventListener('click', () => { void saveProjectFile(false); });
  $<HTMLButtonElement>('ll-save-all')
    .addEventListener('click', () => { void saveProjectFile(true); });

  const projectFileInput = $<HTMLInputElement>('ll-project-file');
  $<HTMLButtonElement>('ll-project-open').addEventListener('click', () => projectFileInput.click());

  projectFileInput.addEventListener('change', () => {
    const file = projectFileInput.files?.[0];
    projectFileInput.value = '';
    if (file) void openProjectFile(file);
  });

  async function openProjectFile(file: File): Promise<void> {
    let envelope;
    try {
      envelope = readSidecar(await file.text());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That file could not be read.', 'bad');
      return;
    }

    const sidecar = envelope.data;
    const carried = (() => {
      try { return sidecarVideo(sidecar); } catch { return null; }
    })();

    // A file with the recording in it stands on its own. One with only edits
    // has to land on something, and landing on the wrong recording is worse
    // than refusing, because nothing fails and everything is subtly wrong.
    if (carried) {
      const blob = new Blob([carried.bytes as unknown as BlobPart], { type: carried.mime });
      stored = null;
      await load({
        blob,
        duration: sidecar.source.duration,
        width: sidecar.source.width,
        height: sidecar.source.height,
        pointer: [], clicks: [], keys: [], marks: [],
        camera: null,
        hasAudio: true,
      });
    } else if (!recording) {
      setStatus('That file holds edits only. Open the video first, then open the project again.', 'bad');
      return;
    } else {
      const wrong = sidecarMismatch(sidecar, {
        duration: recording.duration,
        width: video?.videoWidth ?? recording.width,
        height: video?.videoHeight ?? recording.height,
      });
      if (wrong && !confirm(`${wrong}\n\nUse them anyway?`)) return;
    }

    // Any further recordings the file carried, before the clips that name them
    // mean anything.
    const carriedTakes = sidecarTakes(sidecar);
    if (sidecar.clips) {
      await restoreReel(carriedTakes, sidecar.clips, {
        start: sidecar.start,
        end: sidecar.end > sidecar.start ? sidecar.end : sidecar.source.duration,
      });
    }

    const onto = await forExport();
    if (!onto) return;
    const merged = applySidecar(onto, sidecar);

    settings = merged.settings;
    crop = merged.crop;
    zooms = merged.zooms;
    texts = merged.texts;
    cuts = merged.cuts;
    speeds = merged.speeds;
    redactions = merged.redactions;
    captions = merged.captions;
    shapes = merged.shapes;
    trim = { start: merged.start, end: merged.end };
    selected = null; selectedText = null; selectedShape = null;
    selectedRedaction = null; selectedSpeed = null;

    renderControls();
    renderTrim();
    renderCrop();
    renderZooms();
    renderTexts();
    renderSpeeds();
    renderRedactions();
    renderShapes();
    renderCues();
    renderPicker();
    remember('import');
    await drawPreview();
    drawStrip();

    const counts = envelope.counts ?? {};
    const parts = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}`);
    toast(parts.length ? `Opened: ${parts.join(', ')}.` : 'Opened the project.', { kind: 'good' });
  }

  $<HTMLButtonElement>('ll-discard').addEventListener('click', () => {
    if (!confirm('Throw this recording away?')) return;
    release();
    recording = null;
    points = [];
    filmstrip.clear();
    stageEl.hidden = true;
    editorEl.hidden = true;
    sourceNote.hidden = true;
    setStatus('Nothing recorded yet.', 'idle');
  });

  // ------------------------------------------------------------------ files

  const fileInput = $<HTMLInputElement>('ll-file');
  $<HTMLButtonElement>('ll-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const [file] = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (!file) return;
    setStatus(`Reading ${file.name}.`, 'busy');
    try {
      const opened: Recording = {
        blob: file, duration: 0, width: 0, height: 0,
        pointer: [], clicks: [], keys: [], marks: [], camera: null, hasAudio: true,
      };
      await load(opened);
      // The size and length are only known once the browser has read the file,
      // so the project is stored from what load worked out, not from the guess.
      await keep({
        ...opened,
        duration: recording?.duration ?? 0,
        width: video?.videoWidth ?? 0,
        height: video?.videoHeight ?? 0,
      }, file.name.replace(/\.[a-z0-9]+$/i, ''));
    } catch {
      setStatus(`${file.name} could not be opened as a video.`, 'bad');
    }
  });

  // ------------------------------------------------------------------ start

  function release(): void {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    video?.removeAttribute('src');
    video?.load();
    cameraVideo?.removeAttribute('src');
    cameraVideo?.load();
    video = null;
    cameraVideo = null;
  }

  window.addEventListener('pagehide', () => { session?.cancel(); release(); });

  /**
   * Offers back a recording that was interrupted.
   *
   * A session with chunks written but never finished means the tab went away
   * mid-recording. The chunks are a valid file: MediaRecorder writes a
   * container that plays even when it was never closed properly, which is the
   * whole reason writing them down as they arrive is worth doing.
   */
  async function offerRecovery(): Promise<void> {
    const net = await openScratch().catch(() => null);
    if (!net) return;
    const orphans = await net.unfinished().catch((): ScratchSession[] => []);
    if (orphans.length === 0) return;

    const orphan = orphans[0];
    const size = await net.bytes().catch(() => 0);
    if (size === 0) { await net.discardAll().catch(() => {}); return; }

    const when = new Date(orphan.startedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const wanted = confirm(
      `A recording from ${when} was interrupted before it was saved. `
      + `${formatBytes(size)} of it survived. Recover it?`,
    );
    if (!wanted) { await net.discardAll().catch(() => {}); return; }

    const blob = await net.assemble(orphan.id, 'screen', orphan.mime).catch(() => null);
    if (!blob) { await net.discardAll().catch(() => {}); return; }
    const camera = await net.assemble(orphan.id, 'camera', orphan.mime).catch(() => null);

    try {
      // The duration is unknown, because the recording never ended cleanly.
      // load() reads it back off the file itself, which it already does for any
      // MediaRecorder output, since those often report no duration either.
      const recovered: Recording = {
        blob, camera, duration: 0, width: 0, height: 0,
        pointer: [], clicks: [], keys: [], marks: [], hasAudio: true,
      };
      stored = null;
      await load(recovered);
      await keep({
        ...recovered,
        duration: recording?.duration ?? 0,
        width: video?.videoWidth ?? 0,
        height: video?.videoHeight ?? 0,
        hasAudio: recording?.hasAudio ?? false,
      }, `Recovered ${when}`);
      await net.discardAll().catch(() => {});
      setStatus('Recovered the interrupted recording.', 'good');
    } catch {
      setStatus('The interrupted recording could not be read back.', 'bad');
    }
  }

  renderControls();
  renderTransport();
  renderDestinations();
  await describeFormat();
  await renderProjects();
  await renderDevices();
  await renderLooks();

  // Reopen whatever was last worked on, so a reload picks up where it left off.
  const last = loadCurrentId();
  if (last) await open(last).catch(() => {});

  await offerRecovery();

  registerTools(limelightTools(
    () => ({
      recording,
      points,
      interestSource,
      settings,
      track: trackFromBlocks(zooms, recording?.duration ?? 0, settings.zoom),
      crop,
      trim,
      texts,
      zooms,
      cuts,
      loudness: wave?.loudness ?? null,
      looks: knownLooks,
      previewTime,
      playing,
      clips,
      sourceDurations: Object.fromEntries([...takes].map(([id, take]) => [id, take.duration])),
    }),
    (change) => {
      // Tidying is a whole pass rather than a value to set, and it renders and
      // records itself, so it returns rather than falling through to the
      // single `remember` below and recording a second, empty step.
      if (change.tidy) { void tidyUp(); return; }
      if (change.reel) {
        if (change.reel.preserveTimeline) void adoptReel(change.reel.clips, change.reel.message);
        else void adoptReorder(change.reel.clips, change.reel.message);
        return;
      }
      if (change.crop) { crop = change.crop; cropAspect = 'free'; }
      if (change.trim) trim = { ...change.trim };
      if (change.texts) { texts = change.texts; selectedText = null; }
      if (change.tilt) settings.tilt = change.tilt;
      if (change.motion) settings.motion = change.motion;
      if (change.zooms) {
        zooms = change.zooms;
        if (selected && !zooms.some((zoom) => zoom.id === selected)) selected = null;
        if (focusTarget) focusTarget = zooms.find((zoom) => zoom.id === focusTarget!.id) ?? null;
        if (!focusTarget) stopAiming();
        invalidateTrack();
      }
      if (change.cuts) { cuts = change.cuts; selection = null; }
      if (change.seek !== undefined) {
        if (playing) pause();
        previewTime = change.seek;
        syncScrub();
      }
      if (change.applyLook) {
        const look = knownLooks.find((entry) => entry.id === change.applyLook);
        // Applying a look reaches for the wallpaper, which is asynchronous, so
        // this hands off rather than blocking the tool call on it.
        if (look) void applySavedLook(look);
      }
      if (change.composition) {
        settings.composition = { ...settings.composition, ...change.composition };
        // A background chosen by name is no longer a picture, so the stored one
        // would otherwise sit there unused and unmentioned.
        if (change.composition.background && change.composition.background !== 'image') dropWallpaper();
      }
      remember();
      renderTrim();
      renderCrop();
      renderTexts();
      renderZooms();
      renderCuts();
      renderControls();
      // Playback is asked for last, so it starts from whatever the rest of the
      // change left behind rather than racing it.
      if (change.play === true && !playing) void play();
      else if (change.play === false && playing) pause();
      else void drawPreview();
    },
  ));
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, () => resolve(), { once: true });
    target.addEventListener('error', () => reject(new Error('That file could not be read as a video.')), { once: true });
  });
}

function seekSafely(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { window.clearTimeout(timer); resolve(); };
    const timer = window.setTimeout(done, 4000);
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = time;
  });
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
