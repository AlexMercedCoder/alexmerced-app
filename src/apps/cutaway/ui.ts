import { formatBytes } from '../../lib/bytes';
import { downloadBlob } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import { toast } from '../../lib/toast';
import {
  clampJob, concerns, defaultJob, estimateBytes, evenly, fitWithin, formatDuration, FORMATS,
  frameCount, outputDuration, outputName, suggestBitrate, type Job, type OutputFormat, type SourceInfo,
} from './model';
import { codecSupported, inspect, PipelineError, run, seekTo, type Progress } from './pipeline';
import { registerTools } from '../../lib/webmcp';
import { cutawayTools } from './mcp';

const SETTINGS_KEY = 'cutaway:job';

export async function mountCutaway(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const dropZone = $<HTMLDivElement>('cw-drop');
  const fileInput = $<HTMLInputElement>('cw-file');
  const stage = $<HTMLDivElement>('cw-stage');
  const preview = $<HTMLDivElement>('cw-preview');
  const controls = $<HTMLDivElement>('cw-controls');
  const statusEl = $<HTMLParagraphElement>('cw-status');
  const barEl = $<HTMLDivElement>('cw-bar');
  const noticesEl = $<HTMLUListElement>('cw-notices');
  const formatEl = $<HTMLSelectElement>('cw-format');
  const timeline = $<HTMLDivElement>('cw-timeline');
  const rangeEl = $<HTMLDivElement>('cw-range');
  const playheadEl = $<HTMLDivElement>('cw-playhead');

  let source: { video: HTMLVideoElement; url: string; info: SourceInfo; file: File } | null = null;
  let job: Job | null = null;
  let controller: AbortController | null = null;
  let raf = 0;

  const setStatus = (message: string, state: 'idle' | 'busy' | 'good' | 'bad') => {
    statusEl.textContent = message;
    statusEl.dataset.state = state;
  };

  // ------------------------------------------------------------------ loading

  async function loadFile(file: File): Promise<void> {
    clearSource();
    setStatus(`Reading ${file.name}.`, 'busy');
    try {
      const loaded = await inspect(file);
      source = { ...loaded, file };
      job = clampJob({ ...defaultJob(loaded.info), ...remembered(loaded.info) }, loaded.info);

      preview.innerHTML = '';
      loaded.video.controls = false;
      loaded.video.className = 'cw-video';
      preview.append(loaded.video);

      stage.hidden = false;
      controls.hidden = false;
      dropZone.classList.add('is-loaded');
      renderControls();
      renderTimeline();
      setStatus(
        `${loaded.info.width} by ${loaded.info.height}, ${formatDuration(loaded.info.duration)}, ${formatBytes(loaded.info.bytes)}${loaded.info.hasAudio ? ', with audio' : ', no audio'}.`,
        'idle',
      );
      await seekTo(loaded.video, 0).catch(() => {});
    } catch (error) {
      setStatus(error instanceof PipelineError ? error.message : `${file.name} could not be opened.`, 'bad');
    }
  }

  function clearSource(): void {
    if (!source) return;
    cancelAnimationFrame(raf);
    source.video.pause();
    source.video.removeAttribute('src');
    source.video.load();
    URL.revokeObjectURL(source.url);
    source = null;
  }

  /** Settings worth carrying between files, without the ones tied to this clip. */
  function remembered(info: SourceInfo): Partial<Job> {
    const stored = readPref<Partial<Job>>(SETTINGS_KEY, {});
    const keep: Partial<Job> = {};
    if (typeof stored.format === 'string' && FORMATS.some((entry) => entry.id === stored.format)) keep.format = stored.format;
    if (typeof stored.frameRate === 'number') keep.frameRate = stored.frameRate;
    if (typeof stored.gifColours === 'number') keep.gifColours = stored.gifColours;
    if (typeof stored.gifDither === 'boolean') keep.gifDither = stored.gifDither;
    void info;
    return keep;
  }

  function remember(): void {
    if (!job) return;
    writePref(SETTINGS_KEY, {
      format: job.format,
      frameRate: job.frameRate,
      gifColours: job.gifColours,
      gifDither: job.gifDither,
    });
  }

  $<HTMLButtonElement>('cw-add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const [file] = Array.from(fileInput.files ?? []);
    if (file) await loadFile(file);
    fileInput.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('is-over'); });
  }
  dropZone.addEventListener('drop', async (event) => {
    const [file] = Array.from((event as DragEvent).dataTransfer?.files ?? []);
    if (file) await loadFile(file);
  });

  // ------------------------------------------------------------------ timeline

  function renderTimeline(): void {
    if (!source || !job) return;
    const duration = Math.max(0.001, source.info.duration);
    rangeEl.style.left = `${(job.start / duration) * 100}%`;
    rangeEl.style.width = `${((job.end - job.start) / duration) * 100}%`;
    $<HTMLSpanElement>('cw-range-label').textContent =
      `${formatDuration(job.start)} to ${formatDuration(job.end)}, ${formatDuration(job.end - job.start)} long`;
  }

  function timeAt(event: PointerEvent): number {
    if (!source) return 0;
    const box = timeline.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    return position * source.info.duration;
  }

  let dragging: 'start' | 'end' | null = null;

  timeline.addEventListener('pointerdown', async (event) => {
    if (!source || !job) return;
    const time = timeAt(event);
    // Grab whichever handle is nearer, so a drag anywhere adjusts the closer end.
    dragging = Math.abs(time - job.start) <= Math.abs(time - job.end) ? 'start' : 'end';
    timeline.setPointerCapture(event.pointerId);
    applyHandle(time);
    await seekTo(source.video, time).catch(() => {});
  });

  timeline.addEventListener('pointermove', (event) => {
    if (!dragging || !job) return;
    applyHandle(timeAt(event));
  });

  const endDrag = async () => {
    if (!dragging || !source || !job) return;
    dragging = null;
    // Show where the range now begins.
    await seekTo(source.video, job.start).catch(() => {});
  };
  timeline.addEventListener('pointerup', endDrag);
  timeline.addEventListener('pointercancel', endDrag);

  function applyHandle(time: number): void {
    if (!job || !source || !dragging) return;
    if (dragging === 'start') job.start = Math.min(time, job.end - 0.05);
    else job.end = Math.max(time, job.start + 0.05);
    job = clampJob(job, source.info);
    renderTimeline();
    renderSummary();
  }

  $<HTMLButtonElement>('cw-set-start').addEventListener('click', () => {
    if (!source || !job) return;
    job.start = Math.min(source.video.currentTime, job.end - 0.05);
    job = clampJob(job, source.info);
    renderTimeline();
    renderSummary();
  });

  $<HTMLButtonElement>('cw-set-end').addEventListener('click', () => {
    if (!source || !job) return;
    job.end = Math.max(source.video.currentTime, job.start + 0.05);
    job = clampJob(job, source.info);
    renderTimeline();
    renderSummary();
  });

  $<HTMLButtonElement>('cw-play').addEventListener('click', async () => {
    if (!source || !job) return;
    const video = source.video;
    if (!video.paused) { video.pause(); return; }
    if (video.currentTime < job.start || video.currentTime >= job.end) await seekTo(video, job.start).catch(() => {});
    void video.play();

    const tick = () => {
      if (!source || !job) return;
      const duration = Math.max(0.001, source.info.duration);
      playheadEl.style.left = `${(source.video.currentTime / duration) * 100}%`;
      // Stop at the out point rather than running on through the rest.
      if (source.video.currentTime >= job.end) source.video.pause();
      if (!source.video.paused) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  // ------------------------------------------------------------------ controls

  for (const entry of FORMATS) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.title = entry.note;
    formatEl.append(option);
  }

  formatEl.addEventListener('change', async () => {
    if (!job || !source) return;
    job.format = formatEl.value as OutputFormat;
    // GIF at a high frame rate is wasted, so nudge it down on the first switch.
    if (job.format === 'gif' && job.frameRate > 20) job.frameRate = 15;
    job = clampJob(job, source.info);
    remember();
    renderControls();
    await checkCodec();
  });

  const numberFields: [string, keyof Job, (value: number) => void][] = [
    ['cw-width', 'width', (value) => {
      if (!job || !source) return;
      // Keep the shape unless the height is set on purpose.
      const ratio = source.info.height / source.info.width;
      job.width = evenly(value);
      job.height = evenly(value * ratio);
      job.bitrate = suggestBitrate(job.width, job.height, job.frameRate);
    }],
    ['cw-height', 'height', (value) => { if (job) job.height = evenly(value); }],
    ['cw-fps', 'frameRate', (value) => {
      if (!job) return;
      job.frameRate = value;
      job.bitrate = suggestBitrate(job.width, job.height, job.frameRate);
    }],
    ['cw-bitrate', 'bitrate', (value) => { if (job) job.bitrate = value * 1000; }],
    ['cw-speed', 'speed', (value) => { if (job) job.speed = value; }],
    ['cw-colours', 'gifColours', (value) => { if (job) job.gifColours = value; }],
  ];

  for (const [id, , apply] of numberFields) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      if (!job || !source) return;
      const value = Number(input.value);
      if (Number.isFinite(value)) apply(value);
      job = clampJob(job, source.info);
      remember();
      renderControls();
    });
  }

  const checkboxes: [string, keyof Job][] = [['cw-audio', 'keepAudio'], ['cw-dither', 'gifDither']];
  for (const [id, key] of checkboxes) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      if (!job) return;
      (job[key] as boolean) = input.checked;
      remember();
      renderSummary();
    });
  }

  const presets: [string, number][] = [['cw-p-360', 360], ['cw-p-480', 480], ['cw-p-720', 720], ['cw-p-1080', 1080]];
  for (const [id, height] of presets) {
    $<HTMLButtonElement>(id).addEventListener('click', () => {
      if (!job || !source) return;
      const fitted = fitWithin(source.info.width, source.info.height, 99999, height);
      job.width = fitted.width;
      job.height = fitted.height;
      job.bitrate = suggestBitrate(job.width, job.height, job.frameRate);
      job = clampJob(job, source.info);
      renderControls();
    });
  }

  function renderControls(): void {
    if (!job) return;
    formatEl.value = job.format;
    $<HTMLInputElement>('cw-width').value = String(job.width);
    $<HTMLInputElement>('cw-height').value = String(job.height);
    $<HTMLInputElement>('cw-fps').value = String(job.frameRate);
    $<HTMLInputElement>('cw-bitrate').value = String(Math.round(job.bitrate / 1000));
    $<HTMLInputElement>('cw-speed').value = String(job.speed);
    $<HTMLInputElement>('cw-colours').value = String(job.gifColours);
    $<HTMLInputElement>('cw-audio').checked = job.keepAudio;
    $<HTMLInputElement>('cw-dither').checked = job.gifDither;

    const isGif = job.format === 'gif';
    const isVideo = job.format !== 'gif' && job.format !== 'frames';
    $<HTMLDivElement>('cw-gif-only').hidden = !isGif;
    $<HTMLDivElement>('cw-video-only').hidden = !isVideo;
    $<HTMLParagraphElement>('cw-format-note').textContent =
      FORMATS.find((entry) => entry.id === job!.format)?.note ?? '';

    renderSummary();
  }

  function renderSummary(): void {
    if (!job || !source) return;
    const rows: [string, string][] = [
      ['Length', formatDuration(outputDuration(job))],
      ['Frames', frameCount(job).toLocaleString('en-US')],
      ['Size', `${job.width} by ${job.height}`],
      ['Roughly', formatBytes(estimateBytes(job))],
    ];
    $<HTMLDivElement>('cw-summary').innerHTML = rows
      .map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
      .join('');

    const notes = concerns(job, source.info);
    noticesEl.innerHTML = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
    noticesEl.hidden = notes.length === 0;
    renderTimeline();
  }

  async function checkCodec(): Promise<void> {
    if (!job) return;
    const button = $<HTMLButtonElement>('cw-export');
    const supported = await codecSupported(job.format, job.width, job.height);
    button.disabled = !supported;
    if (!supported) {
      setStatus(
        `This browser cannot encode ${FORMATS.find((entry) => entry.id === job!.format)?.label}. Try another format.`,
        'bad',
      );
    }
  }

  // ------------------------------------------------------------------ export

  $<HTMLButtonElement>('cw-export').addEventListener('click', async () => {
    if (!source || !job) return;
    if (controller) { controller.abort(); return; }

    controller = new AbortController();
    const button = $<HTMLButtonElement>('cw-export');
    button.textContent = 'Cancel';
    barEl.hidden = false;
    source.video.pause();

    const started = performance.now();
    try {
      const result = await run({
        video: source.video,
        file: source.file,
        job,
        signal: controller.signal,
        onProgress: (progress: Progress) => {
          const percent = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
          $<HTMLDivElement>('cw-bar-fill').style.width = `${percent}%`;
          setStatus(`${progress.stage}: ${progress.done} of ${progress.total}.`, 'busy');
        },
      });

      downloadBlob(outputName(source.info.name, job.format), result.blob);
      setStatus(
        `Saved ${formatBytes(result.blob.size)} from ${result.frames} frames, in ${((performance.now() - started) / 1000).toFixed(1)} seconds.`,
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
      $<HTMLDivElement>('cw-bar-fill').style.width = '0%';
      // Put the preview back where the range starts.
      if (source) await seekTo(source.video, job.start).catch(() => {});
    }
  });

  // ------------------------------------------------------------------ start

  window.addEventListener('pagehide', clearSource);

  if (typeof VideoEncoder === 'undefined') {
    setStatus(
      'This browser does not offer WebCodecs, so video cannot be re-encoded here. Chrome, Edge and Safari can; Firefox is catching up. GIF and still frames still work.',
      'bad',
    );
  }

  // Everything this app can do, offered to an agent on this page.
  registerTools(cutawayTools());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
