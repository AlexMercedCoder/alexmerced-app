import { formatBytes } from '../../lib/bytes';
import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { registerTools } from '../../lib/webmcp';
import type { Interest } from './attention';
import { canCapture, CaptureError, Session, type Recording, type Source } from './capture';
import {
  cameraRect, defaultComposition, OUTPUT_SIZES, PRESETS, QUALITY,
  type CameraCorner, type Composition,
} from './layout';
import { limelightTools } from './mcp';
import {
  capabilities, drawFrame, findInterest, render, RenderError, type OutputFormat, type Project,
} from './render';
import {
  createProject, deleteProject, loadCurrentId, loadProject, loadProjects, loadSettings,
  saveCurrentId, saveProject, saveSettings, storedBytes, type Project as StoredProject,
  type Settings,
} from './store';
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
  let trim = { start: 0, end: 0 };
  let saveTimer = 0;

  const setStatus = (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => {
    statusEl.textContent = message;
    statusEl.dataset.state = state;
  };

  const remember = () => {
    saveSettings(settings);
    // The settings belong to the project too, so reopening it looks the same.
    if (stored) {
      stored.settings = settings;
      stored.start = trim.start;
      stored.end = trim.end;
      queueSave();
    }
  };

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
      composition: settings.composition,
      zoom: settings.zoom,
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
      onTick: (seconds) => { clockEl.textContent = formatClock(seconds); },
    });

    try {
      await session.start();
      recordButton.textContent = 'Stop';
      recordButton.classList.add('is-recording');
      setStatus(
        source === 'tab'
          ? 'Recording this tab. Pointer movement and clicks are being tracked, so the zoom will follow them exactly.'
          : 'Recording. The browser will not tell a page where the pointer is on another window, so the zoom will follow where the picture changes instead.',
        'busy',
      );
    } catch (error) {
      session = null;
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
    renderZooms();
    // A reopened project already has its zooms, so it does not analyse again.
    if (zooms.length === 0) await analyse();
    else sourceNote.hidden = true;
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

  // ------------------------------------------------------------------ zoom track

  const zoomTrackEl = $<HTMLDivElement>('ll-zoomtrack');

  function persistZooms(): void {
    if (!stored) return;
    // The blocks are what a person edits, so they are what is kept. The
    // keyframe track is derived and stored alongside so a reopened project
    // renders exactly as it did.
    stored.zooms = zooms;
    stored.keyframes = trackFromBlocks(zooms, recording?.duration ?? 0, settings.zoom);
    queueSave();
  }

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
    persistZooms();
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

  // ------------------------------------------------------------------ preview

  let drawing = false;
  async function drawPreview(): Promise<void> {
    const current = project();
    if (!current || !video || drawing) return;
    drawing = true;
    try {
      canvas.width = settings.composition.width;
      canvas.height = settings.composition.height;
      const context = canvas.getContext('2d');
      if (!context) return;

      await seekSafely(video, Math.min(current.duration - 1e-3, previewTime));
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
  ];
  for (const [id, apply] of sliders) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      apply(Number(input.value));
      remember();
      renderReadouts();
      void drawPreview();
    });
  }

  const toggles: [string, (value: boolean) => void, () => boolean][] = [
    ['ll-zoom-on', (value) => { settings.zoom.enabled = value; }, () => settings.zoom.enabled],
    ['ll-clicks', (value) => { settings.showClicks = value; }, () => settings.showClicks],
    ['ll-cursor', (value) => { settings.showCursor = value; }, () => settings.showCursor],
    ['ll-camera-on', (value) => { settings.composition.camera.enabled = value; }, () => settings.composition.camera.enabled],
    ['ll-camera-round', (value) => { settings.composition.camera.round = value; }, () => settings.composition.camera.round],
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
    ];
    for (const [id, text] of readouts) $<HTMLSpanElement>(id).textContent = text;
    $<HTMLSpanElement>('ll-bitrate-out').textContent = `${Math.round(suggestBitrate() / 1000)} kbps`;
    $<HTMLDivElement>('ll-camera-fields').hidden = !settings.composition.camera.enabled;
  }

  $<HTMLButtonElement>('ll-reanalyse').addEventListener('click', () => { void analyse().then(drawPreview); });

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

  registerTools(limelightTools(() => ({ recording, points, interestSource, settings })));
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
