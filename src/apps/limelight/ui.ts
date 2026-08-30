import { formatBytes } from '../../lib/bytes';
import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { registerTools } from '../../lib/webmcp';
import type { Interest } from './attention';
import { canCapture, CaptureError, Session, type Recording, type Source } from './capture';
import {
  CAMERA_SHAPES, cameraRect, CROP_ASPECTS, cropToAspect, defaultComposition, FULL_CROP, isFullCrop,
  MIN_CROP, normaliseCrop, OUTPUT_SIZES, PRESETS, QUALITY,
  type CameraCorner, type CameraShape, type Composition, type Crop,
} from './layout';
import { countdown } from './countdown';
import { History } from './history';
import { defaultTilt, MOTIONS, type Motion } from './plate';
import { limelightTools } from './mcp';
import {
  capabilities, drawFrame, findInterest, render, RenderError, type OutputFormat, type Project,
} from './render';
import {
  createProject, deleteProject, loadCurrentId, loadProject, loadProjects, loadSettings,
  saveCurrentId, saveProject, saveSettings, storedBytes, type Project as StoredProject,
  type Settings,
} from './store';
import {
  addText, constrainText, MIN_TEXT, removeText, updateText, type TextBlock,
} from './text';
import { defaultZoom, zoomAt, type ZoomSettings } from './zoom';
import {
  addBlock, blocksFromInterest, constrain, mergeBlocks, removeBlock, reviveBlocks,
  trackFromBlocks, type ZoomBlock,
} from './zooms';


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

  let settings = loadSettings();
  let session: Session | null = null;
  let recording: Recording | null = null;
  let video: HTMLVideoElement | null = null;
  let cameraVideo: HTMLVideoElement | null = null;
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
  /** Everything an undo has to put back. The recording itself never changes. */
  type EditorState = {
    settings: Settings;
    zooms: ZoomBlock[];
    texts: TextBlock[];
    crop: Crop;
    trim: { start: number; end: number };
    wallpaper: Uint8Array | null;
    wallpaperMime: string;
  };
  const history = new History<EditorState>({
    settings, zooms, texts, crop, trim, wallpaper: null, wallpaperMime: 'image/png',
  });
  /** Set while a state is being put back, so restoring does not record itself. */
  let restoring = false;
  let saveTimer = 0;

  const setStatus = (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => {
    statusEl.textContent = message;
    statusEl.dataset.state = state;
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
    saveSettings(settings);
    if (stored) {
      stored.settings = settings;
      stored.start = trim.start;
      stored.end = trim.end;
      stored.crop = crop;
      stored.zooms = zooms;
      stored.texts = texts;
      // Derived from the blocks, and stored alongside them so a reopened
      // project renders exactly as it did.
      stored.keyframes = trackFromBlocks(zooms, recording?.duration ?? 0, settings.zoom);
      queueSave();
    }
  };

  // ------------------------------------------------------------------ history

  function snapshot(): EditorState {
    return { settings, zooms, texts, crop, trim, wallpaper: wallpaperBytes, wallpaperMime };
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
    try {
      settings = state.settings;
      zooms = state.zooms;
      texts = state.texts;
      crop = state.crop;
      trim = { ...state.trim };
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
    renderHistory();
    await drawPreview();
  }

  function renderHistory(): void {
    $<HTMLButtonElement>('ll-undo').disabled = !history.canUndo;
    $<HTMLButtonElement>('ll-redo').disabled = !history.canRedo;
  }

  async function stepBack(): Promise<void> {
    const state = history.undo();
    if (state) await restore(state);
  }

  async function stepForward(): Promise<void> {
    const state = history.redo();
    if (state) await restore(state);
  }

  $<HTMLButtonElement>('ll-undo').addEventListener('click', () => { void stepBack(); });
  $<HTMLButtonElement>('ll-redo').addEventListener('click', () => { void stepForward(); });

  /** Writing tens of megabytes on every slider nudge would make this stutter. */
  function queueSave(): void {
    if (!stored) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { if (stored) void saveProject(stored); }, 600);
  }

  // ------------------------------------------------------------------ project

  function project(): Project | null {
    if (!video || !recording) return null;
    return {
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
      format: settings.format,
      gifColours: 128,
      keepAudio: settings.keepAudio && recording.hasAudio,
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

  recordButton.addEventListener('click', async () => {
    if (session?.running) {
      recordButton.disabled = true;
      try {
        const result = await session.stop();
        await load(result);
        await keep({
          ...result,
          duration: recording?.duration ?? result.duration,
          width: video?.videoWidth || result.width,
          height: video?.videoHeight || result.height,
        }, `Recording ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'The recording could not be finished.', 'bad');
      } finally {
        session = null;
        recordButton.disabled = false;
        recordButton.textContent = 'Record';
        recordButton.classList.remove('is-recording');
        clockEl.textContent = '';
      }
      return;
    }

    const source = ($<HTMLInputElement>('ll-source-tab').checked ? 'tab' : 'screen') as Source;
    session = new Session({
      source,
      microphone: $<HTMLInputElement>('ll-mic').checked,
      systemAudio: $<HTMLInputElement>('ll-system-audio').checked,
      camera: $<HTMLInputElement>('ll-camera').checked,
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
      settings,
    });
    stored = project;
    saveCurrentId(project.id);
    await saveProject(project);
    await renderProjects();
  }

  /** Reopens one that was stored earlier. */
  async function open(id: string): Promise<void> {
    const project = await loadProject(id);
    if (!project) return;
    stored = project;
    settings = project.settings;
    zooms = project.zooms;
    texts = project.texts;
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
      camera: project.cameraBytes ? new Blob([project.cameraBytes as unknown as BlobPart], { type: project.mime }) : null,
      hasAudio: project.hasAudio,
    }, { start: project.start, end: project.end });
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

    if (!stored) { crop = { ...FULL_CROP }; texts = []; dropWallpaper(); }

    trim = range && range.end > range.start
      ? { start: Math.max(0, range.start), end: Math.min(recording.duration, range.end) }
      : { start: 0, end: recording.duration };

    stageEl.hidden = false;
    editorEl.hidden = false;
    scrubber.max = String(Math.max(0.1, recording.duration));
    scrubber.value = String(trim.start);
    previewTime = trim.start;

    setStatus(
      `${video.videoWidth} by ${video.videoHeight}, ${formatClock(recording.duration)}, ${formatBytes(result.blob.size)}.`,
      'good',
    );

    renderControls();
    renderTrim();
    renderCrop();
    renderZooms();
    renderTexts();
    // A reopened project already has its zooms, so it does not analyse again.
    if (zooms.length === 0) await analyse();
    else sourceNote.hidden = true;

    // The history starts here, after any analysis. Finding the action is what
    // the app does on your behalf, not something you did, so undo should not
    // walk back into a recording that has never been zoomed.
    history.reset(snapshot());
    renderHistory();
    await drawPreview();
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
    $<HTMLSpanElement>('ll-storage').textContent = total > 0 ? `${formatBytes(total)} of recordings kept here` : '';
  }

  // ------------------------------------------------------------------ trim

  const trimEl = $<HTMLDivElement>('ll-trim');
  const trimRange = $<HTMLDivElement>('ll-trim-range');

  function renderTrim(): void {
    if (!recording) return;
    const duration = Math.max(0.001, recording.duration);
    trimRange.style.left = `${(trim.start / duration) * 100}%`;
    trimRange.style.width = `${((trim.end - trim.start) / duration) * 100}%`;
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
    trimEl.setPointerCapture(event.pointerId);
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

  // ------------------------------------------------------------------ zoom track

  const zoomTrackEl = $<HTMLDivElement>('ll-zoomtrack');

  function persistZooms(label = ''): void { remember(label); }

  function renderZooms(): void {
    if (!recording) return;
    const duration = Math.max(0.001, recording.duration);
    zoomTrackEl.innerHTML = '';

    for (const zoom of zooms) {
      const bar = document.createElement('div');
      bar.className = 'll-zoom';
      if (zoom.pinned) bar.classList.add('is-pinned');
      bar.style.left = `${(zoom.start / duration) * 100}%`;
      bar.style.width = `${((zoom.end - zoom.start) / duration) * 100}%`;
      bar.dataset.id = zoom.id;
      bar.title = `${zoom.scale.toFixed(1)}x, ${formatClock(zoom.start)} to ${formatClock(zoom.end)}`;

      const label = document.createElement('span');
      label.className = 'll-zoom__label';
      label.textContent = `${zoom.scale.toFixed(1)}x`;
      bar.append(label);

      for (const edge of ['start', 'end'] as const) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = `ll-zoom__grip ll-zoom__grip--${edge}`;
        handle.setAttribute('aria-label', `Move the ${edge} of this zoom`);
        handle.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
          beginZoomDrag(event, zoom.id, edge);
        });
        bar.append(handle);
      }

      bar.addEventListener('pointerdown', (event) => beginZoomDrag(event, zoom.id, 'move'));
      bar.addEventListener('dblclick', () => {
        zooms = removeBlock(zooms, zoom.id);
        renderZooms();
        persistZooms();
        void drawPreview();
      });

      zoomTrackEl.append(bar);
    }

    $<HTMLParagraphElement>('ll-zoom-hint').textContent = zooms.length
      ? 'Drag a zoom to move it, its edges to resize, and double click to delete. Select one to change how far it goes in.'
      : 'No zooms yet. Press Add a zoom to put one at the playhead.';
    renderSelected();
  }

  let dragging: { id: string; edge: 'start' | 'end' | 'move'; from: number; start: number; end: number } | null = null;
  let selected: string | null = null;

  function zoomTimeAt(event: PointerEvent): number {
    if (!recording) return 0;
    const box = zoomTrackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * recording.duration;
  }

  function beginZoomDrag(event: PointerEvent, id: string, edge: 'start' | 'end' | 'move'): void {
    const zoom = zooms.find((entry) => entry.id === id);
    if (!zoom) return;
    selected = id;
    selectedText = null;
    renderTextSelected();
    dragging = { id, edge, from: zoomTimeAt(event), start: zoom.start, end: zoom.end };
    zoomTrackEl.setPointerCapture(event.pointerId);
    renderSelected();
  }

  zoomTrackEl.addEventListener('pointermove', (event) => {
    if (!dragging || !recording) return;
    const shift = zoomTimeAt(event) - dragging.from;

    zooms = zooms.map((zoom) => {
      if (zoom.id !== dragging!.id) return zoom;
      if (dragging!.edge === 'move') {
        const width = dragging!.end - dragging!.start;
        return { ...zoom, start: dragging!.start + shift, end: dragging!.start + shift + width, pinned: true };
      }
      if (dragging!.edge === 'start') return { ...zoom, start: dragging!.start + shift, pinned: true };
      return { ...zoom, end: dragging!.end + shift, pinned: true };
    });

    zooms = constrain(zooms, dragging.id, recording.duration);
    renderZooms();
  });

  const endZoomDrag = () => {
    if (!dragging) return;
    dragging = null;
    persistZooms();
    void drawPreview();
  };
  zoomTrackEl.addEventListener('pointerup', endZoomDrag);
  zoomTrackEl.addEventListener('pointercancel', endZoomDrag);

  function renderSelected(): void {
    const panel = $<HTMLDivElement>('ll-zoom-selected');
    const zoom = zooms.find((entry) => entry.id === selected);
    panel.hidden = !zoom;
    if (!zoom) return;
    $<HTMLInputElement>('ll-zoom-amount').value = String(zoom.scale);
    $<HTMLSpanElement>('ll-zoom-amount-out').textContent = `${zoom.scale.toFixed(1)}x`;
    for (const bar of zoomTrackEl.querySelectorAll<HTMLDivElement>('.ll-zoom')) {
      bar.classList.toggle('is-selected', bar.dataset.id === selected);
    }
  }

  $<HTMLInputElement>('ll-zoom-amount').addEventListener('input', (event) => {
    if (!selected || !recording) return;
    const scale = Number((event.target as HTMLInputElement).value);
    zooms = zooms.map((zoom) => (zoom.id === selected ? { ...zoom, scale, pinned: true } : zoom));
    zooms = constrain(zooms, selected, recording.duration);
    renderZooms();
    persistZooms(`zoom-scale:${selected}`);
    void drawPreview();
  });

  $<HTMLButtonElement>('ll-zoom-add').addEventListener('click', () => {
    if (!recording) return;
    const before = zooms.length;
    zooms = addBlock(zooms, previewTime, recording.duration, settings.zoom);
    if (zooms.length === before) {
      setStatus('There is no room for a zoom there. Move the playhead into a gap.', 'bad');
      return;
    }
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
    renderZooms();
    persistZooms();
    void drawPreview();
  });

  // ------------------------------------------------------------------ text track

  const textTrackEl = $<HTMLDivElement>('ll-texttrack');
  let selectedText: string | null = null;

  function persistTexts(label = ''): void { remember(label); }

  function renderTexts(): void {
    if (!recording) return;
    const duration = Math.max(0.001, recording.duration);
    textTrackEl.innerHTML = '';

    for (const text of texts) {
      const bar = document.createElement('div');
      bar.className = 'll-zoom is-pinned';
      bar.style.left = `${(text.start / duration) * 100}%`;
      bar.style.width = `${((text.end - text.start) / duration) * 100}%`;
      bar.dataset.id = text.id;
      // The words themselves are the label, since that is what tells one
      // caption from another at a glance.
      const first = text.text.split('\n')[0];
      bar.title = `${first}, ${formatClock(text.start)} to ${formatClock(text.end)}`;

      const label = document.createElement('span');
      label.className = 'll-zoom__label';
      label.textContent = first || 'Text';
      bar.append(label);

      for (const edge of ['start', 'end'] as const) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = `ll-zoom__grip ll-zoom__grip--${edge}`;
        handle.setAttribute('aria-label', `Move the ${edge} of this text`);
        handle.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
          beginTextDrag(event, text.id, edge);
        });
        bar.append(handle);
      }

      bar.addEventListener('pointerdown', (event) => beginTextDrag(event, text.id, 'move'));
      bar.addEventListener('dblclick', () => {
        texts = removeText(texts, text.id);
        if (selectedText === text.id) selectedText = null;
        renderTexts();
        persistTexts();
        void drawPreview();
      });

      textTrackEl.append(bar);
    }
    renderTextSelected();
  }

  let textDrag: { id: string; edge: 'start' | 'end' | 'move'; from: number; start: number; end: number } | null = null;

  function textTimeAt(event: PointerEvent): number {
    if (!recording) return 0;
    const box = textTrackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * recording.duration;
  }

  function beginTextDrag(event: PointerEvent, id: string, edge: 'start' | 'end' | 'move'): void {
    const text = texts.find((entry) => entry.id === id);
    if (!text) return;
    selectedText = id;
    selected = null;
    renderSelected();
    textDrag = { id, edge, from: textTimeAt(event), start: text.start, end: text.end };
    try { textTrackEl.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
    renderTexts();
  }

  textTrackEl.addEventListener('pointermove', (event) => {
    if (!textDrag || !recording) return;
    const shift = textTimeAt(event) - textDrag.from;

    texts = texts.map((text) => {
      if (text.id !== textDrag!.id) return text;
      if (textDrag!.edge === 'move') {
        const width = textDrag!.end - textDrag!.start;
        return { ...text, start: textDrag!.start + shift, end: textDrag!.start + shift + width };
      }
      if (textDrag!.edge === 'start') {
        return { ...text, start: Math.min(textDrag!.start + shift, text.end - MIN_TEXT) };
      }
      return { ...text, end: Math.max(textDrag!.end + shift, text.start + MIN_TEXT) };
    });

    texts = constrainText(texts, textDrag.id, recording.duration);
    renderTexts();
  });

  const endTextDrag = () => {
    if (!textDrag) return;
    textDrag = null;
    persistTexts();
    void drawPreview();
  };
  textTrackEl.addEventListener('pointerup', endTextDrag);
  textTrackEl.addEventListener('pointercancel', endTextDrag);

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
    selected = null;
    renderSelected();
    renderTexts();
    persistTexts();
    void drawPreview();
  });

  // ------------------------------------------------------------------ preview

  let drawing = false;
  async function drawPreview(): Promise<void> {
    const current = project();
    if (!current || !video || drawing) return;
    drawing = true;
    try {
      // While cropping, the canvas takes the source's own shape so the
      // rectangle can be dragged in the recording's coordinates directly.
      const size = cropping
        ? { width: video.videoWidth || current.sourceWidth, height: video.videoHeight || current.sourceHeight }
        : settings.composition;
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) return;

      await seekSafely(video, Math.min(current.duration - 1e-3, previewTime));
      if (cropping) { drawCropEditor(context); return; }

      if (cameraVideo) await seekSafely(cameraVideo, Math.min(Math.max(0, cameraVideo.duration - 1e-3), previewTime));

      const track = trackFromBlocks(zooms, current.duration, settings.zoom);
      const cursor = current.pointer.length
        ? current.pointer.reduce((best, sample) =>
            Math.abs(sample.time - previewTime) < Math.abs(best.time - previewTime) ? sample : best, current.pointer[0])
        : null;

      drawFrame(context, current, previewTime, zoomAt(track, previewTime), cursor);
    } finally {
      drawing = false;
    }
  }

  scrubber.addEventListener('input', () => {
    previewTime = Number(scrubber.value);
    $<HTMLSpanElement>('ll-time').textContent = formatClock(previewTime);
    void drawPreview();
  });

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
  ];
  for (const [id, apply] of sliders) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      apply(Number(input.value));
      remember(`slider:${id}`);
      renderReadouts();
      void drawPreview();
    });
  }

  const toggles: [string, (value: boolean) => void, () => boolean][] = [
    ['ll-zoom-on', (value) => { settings.zoom.enabled = value; }, () => settings.zoom.enabled],
    ['ll-clicks', (value) => { settings.showClicks = value; }, () => settings.showClicks],
    ['ll-cursor', (value) => { settings.showCursor = value; }, () => settings.showCursor],
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
  root.addEventListener('keydown', (event) => {
    // Undo is the one shortcut that keeps its modifier, and the one that has
    // to work while a field has focus.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      void (event.shiftKey ? stepForward() : stepBack());
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      void stepForward();
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

    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        if (typing) return;
        event.preventDefault();
        seek(previewTime - step);
        break;
      case 'ArrowRight':
        if (typing) return;
        event.preventDefault();
        seek(previewTime + step);
        break;
      case 'Home':
        event.preventDefault();
        seek(trim.start);
        break;
      case 'End':
        event.preventDefault();
        seek(trim.end);
        break;
      case 'z': case 'Z':
        event.preventDefault();
        $<HTMLButtonElement>('ll-zoom-add').click();
        break;
      case 't': case 'T':
        event.preventDefault();
        $<HTMLButtonElement>('ll-text-add').click();
        break;
      case 'c': case 'C':
        event.preventDefault();
        cropButton.click();
        break;
      case 'i': case 'I':
        event.preventDefault();
        $<HTMLButtonElement>('ll-trim-start').click();
        break;
      case 'o': case 'O':
        event.preventDefault();
        $<HTMLButtonElement>('ll-trim-end').click();
        break;
      case 'Delete': case 'Backspace':
        // Whichever track was last touched is the one this removes from.
        if (selectedText) {
          event.preventDefault();
          texts = removeText(texts, selectedText);
          selectedText = null;
          renderTexts();
          persistTexts();
          void drawPreview();
          return;
        }
        if (!selected) return;
        event.preventDefault();
        zooms = removeBlock(zooms, selected);
        selected = null;
        renderZooms();
        persistZooms();
        void drawPreview();
        break;
      case 'Escape':
        if (cropping) { event.preventDefault(); cropButton.click(); }
        break;
      default:
    }
  });

  /**
   * Plays the preview by walking the scrubber forward in real time.
   *
   * Every frame is composed from a seek, so this cannot run at the recording's
   * own frame rate on a long clip. It runs as fast as the composing allows and
   * uses the wall clock for position, which keeps the timing honest even when
   * the picture cannot keep up.
   */
  let playing = 0;
  function togglePlay(): void {
    if (playing) {
      cancelAnimationFrame(playing);
      playing = 0;
      return;
    }
    if (!recording) return;
    if (previewTime >= trim.end - 1e-3) previewTime = trim.start;

    let last = performance.now();
    const tick = async () => {
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      last = now;
      previewTime = Math.min(trim.end, previewTime + elapsed);
      scrubber.value = String(previewTime);
      $<HTMLSpanElement>('ll-time').textContent = formatClock(previewTime);
      await drawPreview();
      if (!playing) return;
      if (previewTime >= trim.end - 1e-3) { playing = 0; return; }
      playing = requestAnimationFrame(() => { void tick(); });
    };
    playing = requestAnimationFrame(() => { void tick(); });
  }

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
      const result = await render({ ...current, keyframes: trackFromBlocks(zooms, current.duration, settings.zoom) }, points, onProgress, controller.signal);
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

  $<HTMLButtonElement>('ll-discard').addEventListener('click', () => {
    if (!confirm('Throw this recording away?')) return;
    release();
    recording = null;
    points = [];
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
        pointer: [], clicks: [], camera: null, hasAudio: true,
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

  renderControls();
  await describeFormat();
  await renderProjects();

  // Reopen whatever was last worked on, so a reload picks up where it left off.
  const last = loadCurrentId();
  if (last) await open(last).catch(() => {});

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
    }),
    (change) => {
      if (change.crop) { crop = change.crop; cropAspect = 'free'; }
      if (change.trim) trim = { ...change.trim };
      if (change.texts) { texts = change.texts; selectedText = null; }
      if (change.tilt) settings.tilt = change.tilt;
      if (change.motion) settings.motion = change.motion;
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
      renderControls();
      void drawPreview();
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
