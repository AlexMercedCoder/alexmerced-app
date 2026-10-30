import { runJob } from '../../lib/workspace/jobs';
import { formatBytes } from '../../lib/bytes';
import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { audioContext, canRecord, decode, DecodeError, pickRecordingMime, toAudioBuffer } from './audio';
import {
  changeSpeed, cut, fadeIn, fadeOut, findBounds, formatTime, gain, gainToDecibels, join, mixTracks,
  normalisePeak, normaliseRms, peak, replaceRegion, resample, reverse, rms, toMono, toStereo, trim, trimSilence,
  waveformPeaks,
} from './dsp';
import {
  APP_ID, createClip, EXPORT_FORMATS, fileStem, nameFromFile, uniqueName, type Clip, type Settings,
} from './model';
import {
  applyImport, buildExport, clearAll, deleteClip, loadClips, loadSettings, saveClip, saveSettings, storedBytes,
} from './store';
import { duration as sampleDuration, encodeWav, frameCount, type Samples } from './wav';
import { registerTools } from '../../lib/webmcp';
import { cadenceTools } from './mcp';
import { canEncodeAudio, encodeOpus } from '../../lib/opus';
import { muxWebm } from '../../lib/webm';
import { canTranscribe, transcribe } from '../limelight/transcribe';
import { defaultEffects, processEffects, reviveEffects, voiceEffects, type Effects } from './effects';
import { readPref, writePref } from '../../lib/prefs';
import { appliedSettings, captureConstraints, defaultRecordingSettings, measureLevel, presetSettings, reviveRecordingSettings, SilenceStopDetector, type RecordingSettings } from './recording';
import { appendRecordingChunk, discardRecordingSession, loadRecordingSessions, recordingBlob, startRecordingSession, updateRecordingSession, type RecordingSession } from './store';

type Loaded = { clip: Clip; samples: Samples };

const MAX_UNDO = 12;

export async function mountCadence(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const listEl = $<HTMLDivElement>('cd-list');
  const emptyEl = $<HTMLDivElement>('cd-empty');
  const workEl = $<HTMLDivElement>('cd-work');
  const canvas = $<HTMLCanvasElement>('cd-wave');
  const zoomEl = $<HTMLInputElement>('cd-zoom');
  const scrollEl = $<HTMLInputElement>('cd-scroll');
  const spectrumCanvas = $<HTMLCanvasElement>('cd-spectrum');
  const playheadEl = $<HTMLDivElement>('cd-playhead');
  const selectionEl = $<HTMLDivElement>('cd-selection');
  const statsEl = $<HTMLDivElement>('cd-stats');
  const recordButton = $<HTMLButtonElement>('cd-record');
  const recordTimeEl = $<HTMLSpanElement>('cd-record-time');
  const playButton = $<HTMLButtonElement>('cd-play');
  const storageEl = $<HTMLSpanElement>('cd-storage');

  let clips: Clip[] = [];
  let current: Loaded | null = null;
  let settings: Settings = loadSettings();

  /** Selection in seconds. A null start means the whole clip. */
  let selection: { start: number; end: number } | null = null;
  const undoStack: Samples[] = [];
  const redoStack: Samples[] = [];
  let editBusy = false;

  // ------------------------------------------------------------------ playback

  let source: AudioBufferSourceNode | null = null;
  let playStartedAt = 0;
  let playOffset = 0;
  let raf = 0;
  let playbackGeneration = 0;
  let spectrumAnalyser: AnalyserNode | null = null;
  const spectrumContext = spectrumCanvas.getContext('2d');
  function drawSpectrum(): void {
    if (!spectrumAnalyser || !spectrumContext) return;
    const bins = new Uint8Array(spectrumAnalyser.frequencyBinCount);
    spectrumAnalyser.getByteFrequencyData(bins);
    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    spectrumContext.drawImage(spectrumCanvas, -1, 0);
    for (let y = 0; y < height; y += 1) {
      const index = Math.min(bins.length - 1, Math.round(((height - y) / height) ** 2 * (bins.length - 1)));
      const strength = bins[index] / 255;
      spectrumContext.fillStyle = `rgb(${Math.round(35 + strength * 210)},${Math.round(28 + strength * 120)},${Math.round(65 + strength * 45)})`;
      spectrumContext.fillRect(width - 1, y, 1, 1);
    }
  }

  function stopPlayback(): void {
    playbackGeneration += 1;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      source.disconnect();
      source = null;
    }
    cancelAnimationFrame(raf);
    spectrumAnalyser?.disconnect();
    spectrumAnalyser = null;
    playButton.textContent = 'Play';
    playheadEl.style.opacity = '0';
  }

  async function play(from: number, to: number, mixPreview?: Samples): Promise<void> {
    if (!current) return;
    stopPlayback();
    const generation = playbackGeneration;
    const ctx = audioContext();
    void ctx.resume();
    let prepared: Samples;
    try { prepared = mixPreview ?? await processEffects(current.samples, reviveEffects(current.clip.effects)); }
    catch (error) { toast(error instanceof Error ? error.message : 'Audio effects failed.', { kind: 'error' }); return; }
    if (generation !== playbackGeneration) return;
    const buffer = toAudioBuffer(prepared, ctx);
    source = ctx.createBufferSource();
    source.buffer = buffer;
    spectrumAnalyser = ctx.createAnalyser();
    spectrumAnalyser.fftSize = 2048;
    source.connect(spectrumAnalyser).connect(ctx.destination);

    playOffset = from;
    playStartedAt = ctx.currentTime;
    source.start(0, from, Math.max(0.01, to - from));
    source.onended = () => { stopPlayback(); };
    playButton.textContent = 'Stop';
    playheadEl.style.opacity = mixPreview ? '0' : '1';

    const tick = () => {
      if (!source || !current) return;
      const elapsed = audioContext().currentTime - playStartedAt + playOffset;
      if (!mixPreview) {
        const view = viewWindow();
        playheadEl.style.left = `${Math.min(100, Math.max(0, (elapsed - view.start) / Math.max(view.end - view.start, 0.001) * 100))}%`;
        playheadEl.style.opacity = elapsed >= view.start && elapsed <= view.end ? '1' : '0';
      }
      drawSpectrum();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  playButton.addEventListener('click', () => {
    if (!current) return;
    if (source) { stopPlayback(); return; }
    const total = sampleDuration(current.samples);
    void play(selection?.start ?? 0, selection?.end ?? total);
  });

  // ------------------------------------------------------------------ waveform

  function viewWindow(): { start: number; end: number } {
    const total = current ? sampleDuration(current.samples) : 0;
    const visible = total / Number(zoomEl.value);
    const start = (total - visible) * Number(scrollEl.value) / 100;
    return { start, end: start + visible };
  }
  for (const element of [zoomEl, scrollEl]) element.addEventListener('input', drawWave);

  function drawWave(): void {
    if (!current) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 160;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    const style = getComputedStyle(root);
    const accent = style.getPropertyValue('--accent').trim() || '#3b6ea5';
    const rule = style.getPropertyValue('--rule').trim() || '#d8d8d8';

    const middle = height / 2;
    context.strokeStyle = rule;
    context.beginPath();
    context.moveTo(0, middle);
    context.lineTo(width, middle);
    context.stroke();

    const view = viewWindow();
    const peaks = waveformPeaks(current.samples, Math.round(width), view.start, view.end);
    context.fillStyle = accent;
    for (let column = 0; column < peaks.max.length; column += 1) {
      const top = middle - peaks.max[column] * middle * 0.94;
      const bottom = middle - peaks.min[column] * middle * 0.94;
      // A flat column still needs a visible line, hence the minimum height.
      context.fillRect(column, top, 1, Math.max(1, bottom - top));
    }

    context.strokeStyle = '#b45309';
    context.fillStyle = '#b45309';
    context.font = '11px sans-serif';
    for (const [index, marker] of (current.clip.markers ?? []).entries()) {
      if (marker.time < view.start || marker.time > view.end) continue;
      const x = ((marker.time - view.start) / Math.max(0.001, view.end - view.start)) * width;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
      context.fillText(String(index + 1), Math.min(width - 12, x + 2), 12);
    }

    updateSelectionOverlay();
  }

  function updateSelectionOverlay(): void {
    if (!current || !selection) {
      selectionEl.hidden = true;
      return;
    }
    const view = viewWindow();
    const total = view.end - view.start || 1;
    selectionEl.hidden = false;
    selectionEl.style.left = `${Math.max(0, (selection.start - view.start) / total * 100)}%`;
    selectionEl.style.width = `${Math.max(0, (Math.min(selection.end, view.end) - Math.max(selection.start, view.start)) / total * 100)}%`;
    if (selection.end <= view.start || selection.start >= view.end) selectionEl.hidden = true;
  }

  // Dragging across the waveform picks a region to work on.
  let dragging = false;
  let dragFrom = 0;

  function timeAt(event: PointerEvent): number {
    if (!current) return 0;
    const box = canvas.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const view = viewWindow();
    return view.start + position * (view.end - view.start);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!current) return;
    canvas.setPointerCapture(event.pointerId);
    dragging = true;
    dragFrom = timeAt(event);
    selection = null;
    updateSelectionOverlay();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || !current) return;
    const to = timeAt(event);
    const start = Math.min(dragFrom, to);
    const end = Math.max(dragFrom, to);
    // A stray click should not leave a zero-width selection behind.
    selection = end - start < 0.01 ? null : { start, end };
    updateSelectionOverlay();
    renderStats();
  });

  const endDrag = () => {
    dragging = false;
    renderStats();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  $<HTMLButtonElement>('cd-select-all').addEventListener('click', () => {
    selection = null;
    updateSelectionOverlay();
    renderStats();
  });

  // ------------------------------------------------------------------ editing

  function region(): { start: number; end: number } {
    if (!current) return { start: 0, end: 0 };
    return selection ?? { start: 0, end: sampleDuration(current.samples) };
  }

  async function apply(label: string, transform: (samples: Samples) => Samples): Promise<void> {
    if (!current || editBusy) return;
    editBusy = true;
    try {
    stopPlayback();
    const before = current.samples;
    const clipId = current.clip.id;
    let next: Samples;
    try {
      next = transform(before);
    } catch (error) {
      toast(error instanceof Error ? error.message : `${label} failed.`, { kind: 'error' });
      return;
    }

    if (frameCount(next) === 0) {
      toast('That would leave nothing behind, so it was not applied.', { kind: 'error' });
      return;
    }

    undoStack.push(before);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    if (!current.clip.originalBytes) {
      current.clip.originalBytes = current.clip.bytes;
      current.clip.originalMime = current.clip.mime;
    }
    current.samples = next;

    // The stored bytes are rewritten as WAV, because the edit no longer matches
    // whatever the source file contained.
    try { await persistCurrent(); }
    catch (error) {
      if (current?.clip.id === clipId) { current.samples = before; undoStack.pop(); }
      toast(error instanceof Error ? error.message : 'Edit could not be saved.', { kind: 'error' });
      return;
    }
    selection = null;
    drawWave();
    renderStats();
    renderList();
    toast(label, { kind: 'good' });
    } finally { editBusy = false; }
  }

  async function persistCurrent(): Promise<void> {
    if (!current) return;
    const depth = EXPORT_FORMATS.find((entry) => entry.id === settings.format)?.depth ?? 16;
    const bytes = encodeWav(current.samples, depth);
    const nextClip: Clip = {
      ...current.clip,
      bytes,
      mime: 'audio/wav',
      duration: sampleDuration(current.samples),
      sampleRate: current.samples.sampleRate,
      channelCount: current.samples.channels.length,
      updatedAt: new Date().toISOString(),
    };
    await saveClip(nextClip);
    if (current?.clip.id === nextClip.id) current.clip = nextClip;
    clips = clips.map((clip) => (clip.id === nextClip.id ? nextClip : clip));
    void refreshStorage();
  }

  const actions: [string, string, () => void][] = [
    ['cd-trim', 'Trimmed to the selection', () => {
      const { start, end } = region();
      void apply('Trimmed to the selection', (samples) => trim(samples, start, end));
    }],
    ['cd-cut', 'Removed the selection', () => {
      if (!selection) { toast('Drag across the waveform to choose what to remove.', { kind: 'error' }); return; }
      const { start, end } = selection;
      void apply('Removed the selection', (samples) => cut(samples, start, end));
    }],
    ['cd-fade-in', 'Faded in', () => {
      void apply('Faded in', (samples) => fadeIn(samples, settings.fadeSeconds));
    }],
    ['cd-fade-out', 'Faded out', () => {
      void apply('Faded out', (samples) => fadeOut(samples, settings.fadeSeconds));
    }],
    ['cd-normalise', 'Normalised to the peak target', () => {
      void apply('Normalised', (samples) => normalisePeak(samples, settings.normaliseTargetDb));
    }],
    ['cd-normalise-rms', 'Matched the average level', () => {
      void apply('Levelled', (samples) => normaliseRms(samples, -18));
    }],
    ['cd-reverse', 'Reversed', () => { void apply('Reversed', reverse); }],
    ['cd-mono', 'Mixed down to mono', () => { void apply('Mixed to mono', toMono); }],
    ['cd-stereo', 'Spread to stereo', () => { void apply('Spread to stereo', toStereo); }],
    ['cd-trim-silence', 'Trimmed the silence at both ends', () => {
      void apply('Trimmed silence', (samples) => trimSilence(samples, settings.silenceThresholdDb, 0.05));
    }],
  ];
  for (const [id, , handler] of actions) $<HTMLButtonElement>(id).addEventListener('click', handler);

  $<HTMLButtonElement>('cd-gain').addEventListener('click', () => {
    const raw = prompt('Change the level by how many decibels? Negative makes it quieter.', '3');
    if (raw === null) return;
    const db = Number(raw);
    if (!Number.isFinite(db)) { toast('That is not a number of decibels.', { kind: 'error' }); return; }
    void apply(`Level changed by ${db} dB`, (samples) => gain(samples, 10 ** (db / 20)));
  });

  $<HTMLButtonElement>('cd-speed').addEventListener('click', () => {
    const raw = prompt('Play at what speed? 2 is twice as fast. The pitch moves with it.', '1.5');
    if (raw === null) return;
    const factor = Number(raw);
    if (!Number.isFinite(factor) || factor <= 0) { toast('That is not a usable speed.', { kind: 'error' }); return; }
    void apply(`Speed set to ${factor}x`, (samples) => changeSpeed(samples, factor));
  });

  $<HTMLButtonElement>('cd-resample').addEventListener('click', () => {
    const raw = prompt('Resample to what rate, in hertz?', '44100');
    if (raw === null) return;
    const rate = Math.round(Number(raw));
    if (!Number.isFinite(rate) || rate < 4000 || rate > 384000) {
      toast('Pick a rate between 4000 and 384000.', { kind: 'error' });
      return;
    }
    void apply(`Resampled to ${rate} Hz`, (samples) => resample(samples, rate));
  });

  $<HTMLButtonElement>('cd-undo').addEventListener('click', async () => {
    if (!current || undoStack.length === 0 || editBusy) return;
    editBusy = true;
    try {
    stopPlayback();
    const before = current.samples;
    const restored = undoStack.pop()!;
    redoStack.push(before);
    current.samples = restored;
    try { await persistCurrent(); }
    catch (error) { current.samples = before; redoStack.pop(); undoStack.push(restored); toast(error instanceof Error ? error.message : 'Undo could not be saved.', { kind: 'error' }); return; }
    selection = null;
    drawWave();
    renderStats();
    renderList();
    } finally { editBusy = false; }
  });
  $<HTMLButtonElement>('cd-redo').addEventListener('click', async () => {
    if (!current || redoStack.length === 0 || editBusy) return;
    editBusy = true;
    try {
    stopPlayback();
    const before = current.samples;
    const restored = redoStack.pop()!;
    undoStack.push(before);
    current.samples = restored;
    try { await persistCurrent(); }
    catch (error) { current.samples = before; undoStack.pop(); redoStack.push(restored); toast(error instanceof Error ? error.message : 'Redo could not be saved.', { kind: 'error' }); return; }
    selection = null;
    drawWave(); renderStats(); renderList();
    } finally { editBusy = false; }
  });
  $<HTMLButtonElement>('cd-reset').addEventListener('click', async () => {
    if (!current?.clip.originalBytes || editBusy) return;
    editBusy = true;
    try {
    stopPlayback();
    const before = current.samples;
    let pushed = false;
    try {
      const restored = await decode(current.clip.originalBytes, current.clip.originalMime);
      undoStack.push(before);
      pushed = true;
      redoStack.length = 0;
      current.samples = restored;
      await persistCurrent();
      selection = null;
      drawWave(); renderStats(); renderList();
    } catch (error) { if (current) current.samples = before; if (pushed) undoStack.pop(); toast(error instanceof Error ? error.message : 'The original could not be restored.', { kind: 'error' }); }
    } finally { editBusy = false; }
  });

  // ------------------------------------------------------------------ stats

  function renderStats(): void {
    if (!current) return;
    const { samples } = current;
    const window = selection ? trim(samples, selection.start, selection.end) : samples;
    const highest = peak(window);
    const average = rms(window);

    const fields: [string, string][] = [
      ['Length', formatTime(sampleDuration(samples))],
      ['Rate', `${samples.sampleRate.toLocaleString('en-US')} Hz`],
      ['Channels', samples.channels.length === 1 ? 'Mono' : samples.channels.length === 2 ? 'Stereo' : String(samples.channels.length)],
      ['Peak', highest > 0 ? `${gainToDecibels(highest).toFixed(1)} dBFS` : 'silent'],
      ['Average', average > 0 ? `${gainToDecibels(average).toFixed(1)} dBFS` : 'silent'],
      ['Selection', selection ? `${formatTime(selection.start)} to ${formatTime(selection.end)}` : 'whole clip'],
    ];

    statsEl.innerHTML = fields
      .map(([label, value]) => `<div class="cd-stat"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`)
      .join('');

    $<HTMLButtonElement>('cd-undo').disabled = undoStack.length === 0;
    $<HTMLButtonElement>('cd-redo').disabled = redoStack.length === 0;
    $<HTMLButtonElement>('cd-reset').disabled = !current.clip.originalBytes;
    $<HTMLDivElement>('cd-markers').textContent = current.clip.markers?.length
      ? `Markers: ${current.clip.markers.map((marker) => `${formatTime(marker.time)} ${marker.label}`).join(' · ')}`
      : 'No markers yet. Add one while recording or at the selection start.';
  }

  // ------------------------------------------------------------------ clip list

  function renderList(): void {
    for (const id of ['cd-download', 'cd-download-source']) $<HTMLButtonElement>(id).disabled = !current || clips.length === 0;
    listEl.innerHTML = '';
    for (const clip of clips) {
      const row = document.createElement('div');
      row.className = 'cd-row';
      if (current && clip.id === current.clip.id) row.setAttribute('aria-current', 'true');

      const pick = document.createElement('label');
      pick.className = 'cd-row__pick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.id = clip.id;
      box.setAttribute('aria-label', `Include ${clip.name} when joining`);
      pick.append(box);

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'cd-row__open';
      open.innerHTML = `<strong>${escapeHtml(clip.name)}</strong><span>${formatTime(clip.duration)} · ${formatBytes(clip.bytes.length)}</span>`;
      open.addEventListener('click', () => void select(clip.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cd-row__remove';
      remove.innerHTML = '&times;';
      remove.title = `Delete ${clip.name}`;
      remove.setAttribute('aria-label', `Delete ${clip.name}`);
      remove.addEventListener('click', async () => {
        if (!confirm(`Delete "${clip.name}"? This cannot be undone.`)) return;
        await deleteClip(clip.id);
        clips = clips.filter((entry) => entry.id !== clip.id);
        if (current?.clip.id === clip.id) {
          stopPlayback();
          current = null;
        }
        await showFirstOrEmpty();
      });

      const track = document.createElement('details');
      track.className = 'cd-row__track';
      const summary = document.createElement('summary');
      summary.textContent = 'Track controls';
      track.append(summary);
      const controls = document.createElement('div');
      controls.className = 'cd-row__track';
      const level = document.createElement('input');
      level.type = 'range'; level.min = '0'; level.max = '2'; level.step = '0.05'; level.value = String(clip.volume ?? 1);
      level.setAttribute('aria-label', `${clip.name} volume`);
      level.addEventListener('change', () => { clip.volume = Number(level.value); void saveClip(clip); });
      const offset = document.createElement('input');
      offset.type = 'number'; offset.min = '0'; offset.step = '0.1'; offset.value = String(clip.offsetSeconds ?? 0);
      offset.setAttribute('aria-label', `${clip.name} start offset in seconds`);
      offset.addEventListener('change', () => { clip.offsetSeconds = Math.max(0, Number(offset.value) || 0); void saveClip(clip); });
      const mute = document.createElement('label');
      const muteBox = document.createElement('input');
      muteBox.type = 'checkbox'; muteBox.checked = clip.muted ?? false;
      muteBox.addEventListener('change', () => { clip.muted = muteBox.checked; void saveClip(clip); });
      mute.append(muteBox, ' Mute');
      const solo = document.createElement('label');
      const soloBox = document.createElement('input');
      soloBox.type = 'checkbox'; soloBox.checked = clip.solo ?? false;
      soloBox.addEventListener('change', () => { clip.solo = soloBox.checked; void saveClip(clip); });
      solo.append(soloBox, ' Solo');
      controls.append('Level', level, 'Start (s)', offset, mute, solo);
      track.append(controls);
      row.append(pick, open, remove, track);
      listEl.append(row);
    }

    emptyEl.hidden = clips.length > 0;
    $<HTMLButtonElement>('cd-join').disabled = clips.length < 2;
    $<HTMLButtonElement>('cd-mix').disabled = clips.length < 2;
    $<HTMLButtonElement>('cd-play-mix').disabled = clips.length < 2;
  }

  async function select(id: string): Promise<void> {
    const clip = clips.find((entry) => entry.id === id);
    if (!clip) return;
    stopPlayback();
    try {
      const samples = await decode(clip.bytes, clip.mime);
      current = { clip, samples };
      $<HTMLTextAreaElement>('cd-transcript').value = '';
      $<HTMLButtonElement>('cd-transcript-save').disabled = true;
      $<HTMLElement>('cd-transcript-status').textContent = '';
      undoStack.length = 0;
      redoStack.length = 0;
      selection = null;
      workEl.hidden = false;
      $<HTMLInputElement>('cd-name').value = clip.name;
      showEffects();
      drawWave();
      renderStats();
      renderList();
    } catch (error) {
      toast(error instanceof DecodeError ? error.message : 'That clip could not be decoded.', { kind: 'error' });
    }
  }

  async function showFirstOrEmpty(): Promise<void> {
    renderList();
    if (clips.length === 0) {
      workEl.hidden = true;
      current = null;
      return;
    }
    if (!current) await select(clips[0].id);
  }

  $<HTMLInputElement>('cd-name').addEventListener('input', async (event) => {
    if (!current) return;
    current.clip = { ...current.clip, name: (event.target as HTMLInputElement).value, updatedAt: new Date().toISOString() };
    clips = clips.map((clip) => (clip.id === current!.clip.id ? current!.clip : clip));
    await saveClip(current.clip);
    renderList();
  });

  // ------------------------------------------------------------------ adding audio

  async function addFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const samples = await decode(bytes, file.type);
      const clip = createClip(
        uniqueName(nameFromFile(file.name), clips.map((entry) => entry.name)),
        bytes,
        file.type || 'audio/wav',
        { duration: sampleDuration(samples), sampleRate: samples.sampleRate, channelCount: samples.channels.length },
      );
      await saveClip(clip);
      clips = [...clips, clip];
      await select(clip.id);
      void refreshStorage();
    } catch (error) {
      toast(error instanceof DecodeError ? error.message : `${file.name} could not be read.`, { kind: 'error' });
    }
  }

  const fileInput = $<HTMLInputElement>('cd-file');
  $<HTMLButtonElement>('cd-add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const file of Array.from(fileInput.files ?? [])) await addFile(file);
    fileInput.value = '';
  });

  const dropZone = $<HTMLDivElement>('cd-drop');
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove('is-over');
    });
  }
  dropZone.addEventListener('drop', async (event) => {
    for (const file of Array.from((event as DragEvent).dataTransfer?.files ?? [])) {
      if (file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|opus|webm|flac)$/i.test(file.name)) {
        await addFile(file);
      }
    }
  });

  // ------------------------------------------------------------------ recording

  let recorder: MediaRecorder | null = null;
  let recordTimer = 0;
  let meterFrame = 0;
  let inputContext: AudioContext | null = null;
  let inputStream: MediaStream | null = null;
  let levelAnalyser: AnalyserNode | null = null;
  let stereoAnalysers: [AnalyserNode, AnalyserNode] | null = null;
  let inputGain: GainNode | null = null;
  let monitorGain: GainNode | null = null;
  let monitorAudio: HTMLAudioElement | null = null;
  let activeSession: RecordingSession | null = null;
  let pendingPunch: { clipId: string; start: number; end: number } | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  let testBlob: Blob | null = null;
  let testTimer = 0;
  let testUrl = '';
  let testAudio: HTMLAudioElement | null = null;
  let settingsRecording = reviveRecordingSettings(readPref('cadence:recording', defaultRecordingSettings));
  const statusEl = $<HTMLElement>('cd-record-status');
  const meterEl = $<HTMLMeterElement>('cd-input-meter');
  const meterRightEl = $<HTMLMeterElement>('cd-input-meter-r');
  const liveWaveCanvas = $<HTMLCanvasElement>('cd-live-wave');
  const liveWaveContext = liveWaveCanvas.getContext('2d');
  const dbEl = $<HTMLElement>('cd-input-db');
  const appliedEl = $<HTMLElement>('cd-applied');
  const pauseButton = $<HTMLButtonElement>('cd-pause');
  const testButton = $<HTMLButtonElement>('cd-test');
  const previewButton = $<HTMLButtonElement>('cd-preview');
  const testPlayButton = $<HTMLButtonElement>('cd-test-play');
  const testDiscardButton = $<HTMLButtonElement>('cd-test-discard');
  const micEl = $<HTMLSelectElement>('cd-mic');
  const captureSourceEl = $<HTMLSelectElement>('cd-capture-source');
  const presetEl = $<HTMLSelectElement>('cd-preset');
  const sampleRateEl = $<HTMLSelectElement>('cd-sample-rate');
  const channelsEl = $<HTMLSelectElement>('cd-channels');
  const inputGainEl = $<HTMLInputElement>('cd-input-gain');
  const countdownEl = $<HTMLSelectElement>('cd-countdown');
  const noiseEl = $<HTMLInputElement>('cd-noise');
  const echoEl = $<HTMLInputElement>('cd-echo');
  const agcEl = $<HTMLInputElement>('cd-agc');
  const storedPresets = readPref('cadence:namedPresets', [] as { name: string; settings: RecordingSettings }[]);
  const namedPresets = (Array.isArray(storedPresets) ? storedPresets : [])
    .filter((entry) => typeof entry?.name === 'string' && entry.name.trim() && entry.settings)
    .map((entry) => ({ name: entry.name.slice(0, 40), settings: reviveRecordingSettings(entry.settings) }));
  let activeNamedPreset: string | null = null;
  let editablePresetIndex = -1;
  function renderNamedPresets(): void {
    presetEl.querySelectorAll('option[data-named]').forEach((option) => option.remove());
    namedPresets.forEach((preset, index) => {
      const option = new Option(preset.name, `user:${index}`);
      option.dataset.named = 'true';
      presetEl.add(option);
    });
  }
  renderNamedPresets();
  const silenceStopEl = $<HTMLInputElement>('cd-silence-stop');
  const silenceDbEl = $<HTMLInputElement>('cd-silence-db');
  const silenceSecondsEl = $<HTMLInputElement>('cd-silence-seconds');
  const monitorEl = $<HTMLInputElement>('cd-monitor');
  const monitorVolumeEl = $<HTMLInputElement>('cd-monitor-volume');
  const monitorOutputEl = $<HTMLSelectElement>('cd-monitor-output');
  const silenceDetector = new SilenceStopDetector();

  function showRecordingSettings(): void {
    micEl.value = settingsRecording.deviceId;
    captureSourceEl.value = settingsRecording.source;
    micEl.disabled = settingsRecording.source === 'system';
    presetEl.value = activeNamedPreset ?? settingsRecording.preset;
    $<HTMLButtonElement>('cd-update-preset').disabled = editablePresetIndex < 0;
    sampleRateEl.value = String(settingsRecording.sampleRate);
    channelsEl.value = String(settingsRecording.channels);
    inputGainEl.value = String(settingsRecording.gainDb);
    $<HTMLOutputElement>('cd-gain-value').value = `${settingsRecording.gainDb} dB`;
    countdownEl.value = String(settingsRecording.countdown);
    noiseEl.checked = settingsRecording.noiseSuppression;
    echoEl.checked = settingsRecording.echoCancellation;
    agcEl.checked = settingsRecording.autoGainControl;
    silenceStopEl.checked = settingsRecording.silenceStop;
    silenceDbEl.value = String(settingsRecording.silenceThresholdDb);
    silenceSecondsEl.value = String(settingsRecording.silenceDurationSeconds);
  }
  function saveRecordingSettings(): void {
    writePref('cadence:recording', settingsRecording);
    showRecordingSettings();
    if (inputGain) inputGain.gain.value = 10 ** (settingsRecording.gainDb / 20);
  }
  showRecordingSettings();
  presetEl.addEventListener('change', () => {
    if (presetEl.value.startsWith('user:')) {
      const named = namedPresets[Number(presetEl.value.slice(5))];
      if (!named) return;
      activeNamedPreset = presetEl.value;
      editablePresetIndex = Number(presetEl.value.slice(5));
      settingsRecording = { ...named.settings, preset: 'custom' };
      saveRecordingSettings();
      return;
    }
    activeNamedPreset = null;
    editablePresetIndex = -1;
    const preset = presetEl.value as RecordingSettings['preset'];
    settingsRecording = preset === 'custom' ? { ...settingsRecording, preset } : { ...settingsRecording, ...presetSettings[preset], preset };
    saveRecordingSettings();
  });
  micEl.addEventListener('change', () => { activeNamedPreset = null; settingsRecording.deviceId = micEl.value; settingsRecording.preset = 'custom'; saveRecordingSettings(); });
  $<HTMLButtonElement>('cd-save-preset').addEventListener('click', () => {
    const name = prompt('Name this recording preset:', 'My preset')?.trim();
    if (!name) return;
    namedPresets.push({ name: uniqueName(name.slice(0, 40), namedPresets.map((preset) => preset.name)), settings: { ...settingsRecording, preset: 'custom' } });
    writePref('cadence:namedPresets', namedPresets);
    renderNamedPresets();
    activeNamedPreset = `user:${namedPresets.length - 1}`;
    editablePresetIndex = namedPresets.length - 1;
    showRecordingSettings();
  });
  $<HTMLButtonElement>('cd-update-preset').addEventListener('click', () => {
    if (editablePresetIndex < 0 || !namedPresets[editablePresetIndex]) return;
    namedPresets[editablePresetIndex].settings = { ...settingsRecording, preset: 'custom' };
    writePref('cadence:namedPresets', namedPresets);
    activeNamedPreset = `user:${editablePresetIndex}`;
    showRecordingSettings();
    statusEl.textContent = `Preset ${namedPresets[editablePresetIndex].name} updated`;
  });
  captureSourceEl.addEventListener('change', () => { activeNamedPreset = null; settingsRecording.source = captureSourceEl.value === 'system' ? 'system' : 'microphone'; settingsRecording.preset = 'custom'; saveRecordingSettings(); });
  for (const element of [sampleRateEl, channelsEl, inputGainEl, countdownEl, noiseEl, echoEl, agcEl, silenceStopEl, silenceDbEl, silenceSecondsEl]) {
    element.addEventListener('change', () => {
      activeNamedPreset = null;
      settingsRecording = {
        ...settingsRecording,
        preset: 'custom',
        sampleRate: Number(sampleRateEl.value) as RecordingSettings['sampleRate'],
        channels: Number(channelsEl.value) as RecordingSettings['channels'],
        gainDb: Number(inputGainEl.value),
        countdown: Number(countdownEl.value) as RecordingSettings['countdown'],
        noiseSuppression: noiseEl.checked,
        echoCancellation: echoEl.checked,
        autoGainControl: agcEl.checked,
        silenceStop: silenceStopEl.checked,
        silenceThresholdDb: Number(silenceDbEl.value),
        silenceDurationSeconds: Number(silenceSecondsEl.value),
      };
      settingsRecording = reviveRecordingSettings(settingsRecording);
      saveRecordingSettings();
    });
  }

  async function listMicrophones(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      micEl.disabled = true;
      return;
    }
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'audioinput');
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'audiooutput');
      const outputSelected = monitorOutputEl.value;
      monitorOutputEl.replaceChildren(new Option('Default speakers', ''));
      outputs.forEach((device, index) => monitorOutputEl.add(new Option(device.label || `Output ${index + 1}`, device.deviceId)));
      if (outputs.some((device) => device.deviceId === outputSelected)) monitorOutputEl.value = outputSelected;
      const wasSelected = settingsRecording.deviceId;
      micEl.replaceChildren(new Option('Default microphone', ''));
      devices.forEach((device, index) => micEl.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
      if (wasSelected && !devices.some((device) => device.deviceId === wasSelected)) {
        settingsRecording.deviceId = '';
        saveRecordingSettings();
        statusEl.textContent = 'Selected microphone disconnected. Default microphone selected.';
      } else micEl.value = wasSelected;
    } catch { micEl.disabled = true; }
  }
  void listMicrophones();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void listMicrophones());

  async function setMonitor(): Promise<void> {
    monitorAudio?.pause();
    monitorAudio?.removeAttribute('src');
    monitorAudio = null;
    if (monitorGain) inputGain?.disconnect(monitorGain);
    monitorGain?.disconnect();
    monitorGain = null;
    if (!monitorEl.checked || !inputContext || !inputGain) return;
    monitorGain = inputContext.createGain();
    monitorGain.gain.value = Number(monitorVolumeEl.value);
    const destination = inputContext.createMediaStreamDestination();
    inputGain.connect(monitorGain).connect(destination);
    monitorAudio = new Audio();
    monitorAudio.srcObject = destination.stream;
    try {
      if (monitorOutputEl.value) {
        if (!monitorAudio.setSinkId) throw new Error('Output selection is unavailable in this browser.');
        await monitorAudio.setSinkId(monitorOutputEl.value);
      }
      await monitorAudio.play();
    } catch { statusEl.textContent = 'Monitoring could not start. Check playback permission or output device.'; }
  }
  monitorEl.addEventListener('change', () => void setMonitor());
  monitorVolumeEl.addEventListener('input', () => { if (monitorGain) monitorGain.gain.value = Number(monitorVolumeEl.value); });
  monitorOutputEl.addEventListener('change', () => void setMonitor());

  function closeInput(): void {
    previewButton.textContent = 'Preview input';
    monitorAudio?.pause();
    if (monitorAudio) monitorAudio.srcObject = null;
    monitorAudio = null;
    if (monitorGain) inputGain?.disconnect(monitorGain);
    monitorGain?.disconnect();
    monitorGain = null;
    cancelAnimationFrame(meterFrame);
    inputStream?.getTracks().forEach((track) => track.stop());
    inputStream = null;
    void inputContext?.close().catch(() => {});
    inputContext = null;
    levelAnalyser = null;
    stereoAnalysers = null;
    inputGain = null;
    meterEl.value = 0;
    meterRightEl.value = 0;
    meterRightEl.hidden = true;
    dbEl.textContent = 'Input idle';
  }

  async function openInput(): Promise<void> {
    closeInput();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser.');
    const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    let stream: MediaStream;
    try {
      if (settingsRecording.source === 'system') {
        if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Tab or system audio capture is unavailable in this browser.');
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } else stream = await navigator.mediaDevices.getUserMedia(captureConstraints(settingsRecording, supported));
    } catch (error) {
      if (settingsRecording.source === 'microphone' && settingsRecording.deviceId && error instanceof DOMException && error.name === 'OverconstrainedError') {
        settingsRecording.deviceId = '';
        saveRecordingSettings();
        stream = await navigator.mediaDevices.getUserMedia(captureConstraints(settingsRecording, supported));
        statusEl.textContent = 'Selected microphone unavailable. Using the default microphone.';
      } else throw error;
    }
    inputStream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track) { closeInput(); throw new Error('No audio track was provided.'); }
    if (settingsRecording.source === 'microphone' && settingsRecording.deviceId && track.getSettings?.().deviceId && track.getSettings().deviceId !== settingsRecording.deviceId) {
      statusEl.textContent = 'Preferred microphone unavailable. The browser selected another input.';
    }
    track.addEventListener('ended', () => {
      statusEl.textContent = 'Microphone disconnected.';
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else closeInput();
    });
    for (const videoTrack of stream.getVideoTracks()) videoTrack.addEventListener('ended', () => {
      statusEl.textContent = 'Shared tab or screen ended.';
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else closeInput();
    });
    appliedEl.textContent = `Requested ${settingsRecording.sampleRate.toLocaleString()} Hz, ${settingsRecording.channels} channel${settingsRecording.channels === 1 ? '' : 's'}. Browser-reported input: ${appliedSettings(track)}. Software gain and recording graph use the browser audio context.`;
    void listMicrophones();
    try {
      inputContext = new AudioContext();
      await inputContext.resume();
      appliedEl.textContent += ` Recording graph: ${inputContext.sampleRate.toLocaleString()} Hz.`;
      const sourceNode = inputContext.createMediaStreamSource(stream);
      inputGain = inputContext.createGain();
      inputGain.gain.value = 10 ** (settingsRecording.gainDb / 20);
      levelAnalyser = inputContext.createAnalyser();
      levelAnalyser.fftSize = 1024;
      sourceNode.connect(inputGain).connect(levelAnalyser);
      if ((track.getSettings?.().channelCount ?? 1) >= 2) {
        const splitter = inputContext.createChannelSplitter(2);
        const left = inputContext.createAnalyser();
        const right = inputContext.createAnalyser();
        left.fftSize = right.fftSize = 1024;
        inputGain.connect(splitter);
        splitter.connect(left, 0);
        splitter.connect(right, 1);
        stereoAnalysers = [left, right];
        meterRightEl.hidden = false;
      }
      void setMonitor();
      const values = new Float32Array(levelAnalyser.fftSize);
      const leftValues = new Float32Array(1024);
      const rightValues = new Float32Array(1024);
      const tick = () => {
        if (!levelAnalyser) return;
        levelAnalyser.getFloatTimeDomainData(values);
        const level = measureLevel(values);
        meterEl.value = Math.min(1, level.peak);
        let clipping = level.clipping;
        let signalDb = level.db;
        if (stereoAnalysers) {
          stereoAnalysers[0].getFloatTimeDomainData(leftValues);
          stereoAnalysers[1].getFloatTimeDomainData(rightValues);
          const left = measureLevel(leftValues);
          const right = measureLevel(rightValues);
          meterEl.value = Math.min(1, left.peak);
          meterRightEl.value = Math.min(1, right.peak);
          clipping = left.clipping || right.clipping;
          signalDb = Math.max(left.db, right.db);
          dbEl.textContent = `L ${left.db.toFixed(1)} dBFS · R ${right.db.toFixed(1)} dBFS${clipping ? ' · CLIPPING' : ''}`;
        } else dbEl.textContent = level.rms < 0.0001 ? 'Silence' : `${level.db.toFixed(1)} dBFS${clipping ? ' · CLIPPING' : ''}`;
        if (liveWaveContext) {
          const width = liveWaveCanvas.width;
          const height = liveWaveCanvas.height;
          liveWaveContext.clearRect(0, 0, width, height);
          liveWaveContext.strokeStyle = level.clipping ? '#b91c1c' : '#3b6ea5';
          liveWaveContext.beginPath();
          for (let x = 0; x < width; x += 1) {
            const y = height / 2 - values[Math.floor(x * values.length / width)] * height * 0.45;
            if (x === 0) liveWaveContext.moveTo(x, y); else liveWaveContext.lineTo(x, y);
          }
          liveWaveContext.stroke();
        }
        if (clipping) dbEl.style.color = '#b91c1c'; else dbEl.style.color = '';
        if (settingsRecording.silenceStop && recorder?.state === 'recording' && activeSession) {
          const silence = silenceDetector.update(signalDb, performance.now(), settingsRecording.silenceThresholdDb, settingsRecording.silenceDurationSeconds);
          if (silence.quietSeconds > 0) statusEl.textContent = `Silence ${silence.quietSeconds.toFixed(1)} / ${settingsRecording.silenceDurationSeconds} s`;
          if (silence.shouldStop) {
            statusEl.textContent = 'Stopped after sustained silence';
            recorder.stop();
          }
        }
        meterFrame = requestAnimationFrame(tick);
      };
      tick();
      return;
    } catch (error) {
      closeInput();
      throw error;
    }
  }

  // The recorder receives the processed stream; the original microphone stream
  // remains connected only to the analyser. No monitoring path is connected.
  async function recordingStream(): Promise<MediaStream> {
    await openInput();
    const destination = inputContext!.createMediaStreamDestination();
    levelAnalyser!.connect(destination);
    return destination.stream;
  }

  previewButton.addEventListener('click', async () => {
    if (recorder && recorder.state !== 'inactive') return;
    if (inputStream) { closeInput(); statusEl.textContent = 'Input preview stopped'; return; }
    try { await openInput(); previewButton.textContent = 'Stop preview'; statusEl.textContent = 'Input preview on'; }
    catch (error) { closeInput(); statusEl.textContent = error instanceof Error ? error.message : 'Input preview unavailable.'; }
  });

  function discardTest(): void {
    window.clearTimeout(testTimer);
    testAudio?.pause();
    testAudio = null;
    if (testUrl) URL.revokeObjectURL(testUrl);
    testUrl = '';
    testBlob = null;
    testPlayButton.disabled = true;
    testDiscardButton.disabled = true;
  }
  testDiscardButton.addEventListener('click', discardTest);
  testPlayButton.addEventListener('click', () => {
    if (!testBlob) return;
    testAudio?.pause();
    if (testUrl) URL.revokeObjectURL(testUrl);
    testUrl = URL.createObjectURL(testBlob);
    testAudio = new Audio(testUrl);
    void testAudio.play().catch(() => toast('Test playback was blocked.', { kind: 'error' }));
    const url = testUrl;
    testAudio.onended = () => { URL.revokeObjectURL(url); if (testUrl === url) testUrl = ''; };
  });
  testButton.addEventListener('click', async () => {
    if (recorder && recorder.state !== 'inactive') {
      if (testButton.textContent === 'Stop test') recorder.stop();
      return;
    }
    discardTest();
    try {
      const stream = await recordingStream();
      const mime = pickRecordingMime();
      const chunks: Blob[] = [];
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        window.clearTimeout(testTimer);
        testBlob = new Blob(chunks, { type: recorder?.mimeType || mime || 'audio/webm' });
        recorder = null;
        closeInput();
        testButton.textContent = 'Test microphone';
        testPlayButton.disabled = !testBlob.size;
        testDiscardButton.disabled = !testBlob.size;
        statusEl.textContent = testBlob.size ? 'Test ready to play. It is not in your project.' : 'The test was empty.';
      };
      recorder.start(1000);
      testTimer = window.setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 15000);
      testButton.textContent = 'Stop test';
      statusEl.textContent = 'Recording a test clip';
    } catch (error) {
      closeInput();
      statusEl.textContent = error instanceof Error ? error.message : 'Microphone unavailable.';
    }
  });

  if (!canRecord()) {
    recordButton.disabled = true;
    recordButton.title = 'This browser does not offer microphone recording.';
    testButton.disabled = true;
  }

  let startedAt = 0;
  let pausedAt = 0;
  let pausedMs = 0;
  let countdownPending = false;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!recorder || recorder.state === 'inactive') return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('pagehide', () => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    closeInput();
    discardTest();
  });

  pauseButton.addEventListener('click', () => {
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      pausedAt = performance.now();
      pauseButton.textContent = 'Resume';
      statusEl.textContent = 'Recording paused';
      if (activeSession) { activeSession.state = 'paused'; void updateRecordingSession(activeSession); }
    } else if (recorder.state === 'paused') {
      recorder.resume();
      pausedMs += performance.now() - pausedAt;
      pauseButton.textContent = 'Pause';
      statusEl.textContent = 'Recording';
      if (activeSession) { activeSession.state = 'recording'; void updateRecordingSession(activeSession); }
    }
  });
  $<HTMLButtonElement>('cd-punch').addEventListener('click', () => {
    if (!current || !selection) { toast('Select a timeline region to replace first.', { kind: 'error' }); return; }
    if (recorder) return;
    pendingPunch = { clipId: current.clip.id, ...selection };
    statusEl.textContent = 'Punch in: record replacement audio, then stop.';
    recordButton.click();
  });
  $<HTMLButtonElement>('cd-marker').addEventListener('click', () => {
    if (activeSession && recorder?.state === 'recording') {
      const time = (performance.now() - startedAt - pausedMs) / 1000;
      activeSession.markers ??= [];
      activeSession.markers.push({ time, label: `Marker ${activeSession.markers.length + 1}` });
      void updateRecordingSession(activeSession);
      statusEl.textContent = `Marker at ${formatTime(time)}`;
    } else if (current) {
      const time = selection?.start ?? 0;
      current.clip.markers ??= [];
      current.clip.markers.push({ time, label: `Marker ${current.clip.markers.length + 1}` });
      void saveClip(current.clip);
      drawWave();
      renderStats();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    const target = event.target as HTMLElement;
    if (target.matches('input, textarea, select, [contenteditable]')) return;
    const key = event.key.toLowerCase();
    if (key === 'r') { event.preventDefault(); recordButton.click(); }
    if (key === 'p') { event.preventDefault(); pauseButton.click(); }
    if (key === 'm') { event.preventDefault(); $<HTMLButtonElement>('cd-marker').click(); }
  });

  recordButton.addEventListener('click', async () => {
    if (countdownPending) return;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await recordingStream();
    } catch (error) {
      pendingPunch = null;
      statusEl.textContent = error instanceof Error ? error.message : 'Microphone unavailable.';
      toast('The microphone was not made available. Check this site’s permission.', { kind: 'error' });
      return;
    }
    if (settingsRecording.countdown) {
      countdownPending = true;
      recordButton.disabled = true;
      for (let remaining = settingsRecording.countdown; remaining > 0; remaining -= 1) {
        statusEl.textContent = `Recording starts in ${remaining}`;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      countdownPending = false;
      recordButton.disabled = false;
    }
    const mime = pickRecordingMime();
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (error) { closeInput(); pendingPunch = null; statusEl.textContent = error instanceof Error ? error.message : 'Recorder unavailable.'; return; }
    const punch = pendingPunch;
    const session: RecordingSession = { id: crypto.randomUUID(), name: uniqueName(punch ? 'Punch take' : 'Recording', clips.map((entry) => entry.name)), mime: recorder.mimeType || mime || 'audio/webm', startedAt: new Date().toISOString(), state: 'recording', chunkCount: 0, bytes: 0 };
    activeSession = session;
    try { await startRecordingSession(session); }
    catch { closeInput(); recorder = null; pendingPunch = null; statusEl.textContent = 'Local storage is unavailable. Recording did not start.'; return; }
    writeQueue = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      writeQueue = writeQueue.then(async () => {
        await appendRecordingChunk(session, new Uint8Array(await event.data.arrayBuffer()));
      }).catch((error) => {
        statusEl.textContent = 'Local storage is full or unavailable. Recording stopped; saved chunks may be recoverable.';
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        throw error;
      });
    };
    recorder.onstop = async () => {
      window.clearInterval(recordTimer);
      recordTimeEl.textContent = '';
      recordButton.textContent = 'Record';
      recordButton.classList.remove('is-recording');
      pauseButton.disabled = true;
      pauseButton.textContent = 'Pause';
      closeInput();
      recorder = null;
      try {
        await writeQueue;
        session.state = 'stopped';
        await updateRecordingSession(session);
        const blob = await recordingBlob(session);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!bytes.length) throw new Error('Nothing was recorded.');
        const samples = await decode(bytes, blob.type);
        const clip = createClip(
          session.name,
          bytes, blob.type,
          { duration: sampleDuration(samples), sampleRate: samples.sampleRate, channelCount: samples.channels.length },
        );
        clip.markers = session.markers ?? [];
        await saveClip(clip);
        await discardRecordingSession(session.id);
        clips = [...clips, clip];
        if (punch && clips.some((entry) => entry.id === punch.clipId)) {
          await select(punch.clipId);
          await apply('Punch take inserted', (source) => replaceRegion(source, samples, punch.start, punch.end));
        } else await select(clip.id);
        void refreshStorage();
        statusEl.textContent = 'Recording saved';
        toast(`Recorded ${formatTime(sampleDuration(samples))}.`, { kind: 'good' });
      } catch (error) {
        statusEl.textContent = 'Recording needs recovery. Saved chunks remain on this device.';
        toast(error instanceof Error ? error.message : 'Recording could not be saved.', { kind: 'error' });
        await renderRecovery();
      }
      activeSession = null;
      pendingPunch = null;
    };

    try { recorder.start(1000); }
    catch { await discardRecordingSession(session.id); closeInput(); recorder = null; pendingPunch = null; statusEl.textContent = 'Recording could not start.'; return; }
    startedAt = performance.now();
    pausedMs = 0;
    silenceDetector.reset();
    recordButton.textContent = 'Stop';
    recordButton.classList.add('is-recording');
    pauseButton.disabled = false;
    statusEl.textContent = 'Recording';
    recordTimer = window.setInterval(() => {
      const elapsed = (recorder?.state === 'paused' ? pausedAt : performance.now()) - startedAt - pausedMs;
      recordTimeEl.textContent = `${formatTime(elapsed / 1000)} · ${formatBytes(session.bytes)} saved`;
    }, 100);
  });

  async function renderRecovery(): Promise<void> {
    const sessions = await loadRecordingSessions();
    const panel = $<HTMLDivElement>('cd-recovery');
    const list = $<HTMLDivElement>('cd-recovery-list');
    panel.hidden = sessions.length === 0;
    list.replaceChildren();
    for (const session of sessions) {
      const row = document.createElement('div');
      row.className = 'cd-actions';
      const title = document.createElement('span');
      title.textContent = `${session.name} · ${formatBytes(session.bytes)} saved`;
      const recover = document.createElement('button');
      recover.className = 'btn btn--sm';
      recover.textContent = 'Recover';
      recover.addEventListener('click', async () => {
        try {
          const blob = await recordingBlob(session);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const samples = await decode(bytes, blob.type);
          const clip = createClip(session.name, bytes, blob.type, { duration: sampleDuration(samples), sampleRate: samples.sampleRate, channelCount: samples.channels.length });
          clip.markers = session.markers ?? [];
          await saveClip(clip);
          await discardRecordingSession(session.id);
          clips.push(clip);
          await select(clip.id);
          await renderRecovery();
          toast('Recording recovered.', { kind: 'good' });
        } catch (error) { toast(error instanceof Error ? error.message : 'Recording could not be decoded. You can still save the raw chunks.', { kind: 'error' }); }
      });
      const raw = document.createElement('button');
      raw.className = 'btn btn--sm';
      raw.textContent = 'Save raw';
      raw.addEventListener('click', async () => {
        try { downloadBlob(`${fileStem(session.name)}.${session.mime.includes('mp4') ? 'm4a' : session.mime.includes('ogg') ? 'ogg' : 'webm'}`, await recordingBlob(session)); }
        catch (error) { toast(error instanceof Error ? error.message : 'Saved chunks are incomplete.', { kind: 'error' }); }
      });
      const discard = document.createElement('button');
      discard.className = 'btn btn--sm';
      discard.textContent = 'Discard';
      discard.addEventListener('click', async () => { if (confirm(`Discard saved chunks for ${session.name}?`)) { await discardRecordingSession(session.id); await renderRecovery(); } });
      row.append(title, recover, raw, discard);
      list.append(row);
    }
  }

  // ------------------------------------------------------------------ joining

  $<HTMLButtonElement>('cd-join').addEventListener('click', async () => {
    const chosen = [...listEl.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((box) => box.dataset.id);
    const picked = chosen.length >= 2
      ? clips.filter((clip) => chosen.includes(clip.id))
      : clips;

    if (picked.length < 2) {
      toast('Tick at least two clips to join.', { kind: 'error' });
      return;
    }

    try {
      const decoded: Samples[] = [];
      for (const clip of picked) decoded.push(await decode(clip.bytes, clip.mime));
      const joined = join(decoded, settings.crossfadeSeconds);
      const depth = EXPORT_FORMATS.find((entry) => entry.id === settings.format)?.depth ?? 16;
      const clip = createClip(
        uniqueName('Joined', clips.map((entry) => entry.name)),
        encodeWav(joined, depth), 'audio/wav',
        { duration: sampleDuration(joined), sampleRate: joined.sampleRate, channelCount: joined.channels.length },
      );
      await saveClip(clip);
      clips = [...clips, clip];
      await select(clip.id);
      void refreshStorage();
      toast(`Joined ${picked.length} clips into one.`, { kind: 'good' });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The clips could not be joined.', { kind: 'error' });
    }
  });

  $<HTMLButtonElement>('cd-mix').addEventListener('click', async () => {
    const chosen = [...listEl.querySelectorAll<HTMLInputElement>('.cd-row__pick input:checked')].map((box) => box.dataset.id);
    const picked = chosen.length >= 2 ? clips.filter((clip) => chosen.includes(clip.id)) : clips;
    const soloed = picked.some((clip) => clip.solo);
    const audible = picked.filter((clip) => !clip.muted && (!soloed || clip.solo));
    if (!audible.length) { toast('No audible tracks are selected.', { kind: 'error' }); return; }
    try {
      const tracks = [];
      for (const clip of audible) tracks.push({ samples: await processEffects(await decode(clip.bytes, clip.mime), reviveEffects(clip.effects)), offsetSeconds: clip.offsetSeconds ?? 0, volume: clip.volume ?? 1 });
      const mixed = mixTracks(tracks);
      const depth = EXPORT_FORMATS.find((entry) => entry.id === settings.format)?.depth ?? 16;
      const clip = createClip(uniqueName('Mix', clips.map((entry) => entry.name)), encodeWav(mixed, depth), 'audio/wav', { duration: sampleDuration(mixed), sampleRate: mixed.sampleRate, channelCount: mixed.channels.length });
      await saveClip(clip);
      clips.push(clip);
      await select(clip.id);
      void refreshStorage();
      toast('Mix saved as a new clip. Original tracks remain available.', { kind: 'good' });
    } catch (error) { toast(error instanceof Error ? error.message : 'Mix failed.', { kind: 'error' }); }
  });
  $<HTMLButtonElement>('cd-play-mix').addEventListener('click', async () => {
    if (source) { stopPlayback(); return; }
    const chosen = [...listEl.querySelectorAll<HTMLInputElement>('.cd-row__pick input:checked')].map((box) => box.dataset.id);
    const picked = chosen.length >= 2 ? clips.filter((clip) => chosen.includes(clip.id)) : clips;
    const soloed = picked.some((clip) => clip.solo);
    const audible = picked.filter((clip) => !clip.muted && (!soloed || clip.solo));
    if (!audible.length) { toast('No audible tracks are selected.', { kind: 'error' }); return; }
    try {
      const tracks = [];
      for (const clip of audible) tracks.push({ samples: await processEffects(await decode(clip.bytes, clip.mime), reviveEffects(clip.effects)), offsetSeconds: clip.offsetSeconds ?? 0, volume: clip.volume ?? 1 });
      const mixed = mixTracks(tracks);
      await play(0, sampleDuration(mixed), mixed);
    } catch (error) { toast(error instanceof Error ? error.message : 'Mix playback failed.', { kind: 'error' }); }
  });

  // ------------------------------------------------------------------ settings

  const effectFields: { id: string; key: keyof Effects }[] = [
    { id: 'cd-fx-high', key: 'highPassHz' }, { id: 'cd-fx-low', key: 'lowPassHz' },
    { id: 'cd-fx-bass', key: 'bassDb' }, { id: 'cd-fx-mid', key: 'midDb' }, { id: 'cd-fx-treble', key: 'trebleDb' },
    { id: 'cd-fx-threshold', key: 'compressorThresholdDb' }, { id: 'cd-fx-ratio', key: 'compressorRatio' },
    { id: 'cd-fx-attack', key: 'attackMs' }, { id: 'cd-fx-release', key: 'releaseMs' },
    { id: 'cd-fx-gate', key: 'gateThresholdDb' }, { id: 'cd-fx-output', key: 'outputGainDb' },
  ];
  function showEffects(): void {
    const effects = reviveEffects(current?.clip.effects);
    for (const { id, key } of effectFields) $<HTMLInputElement>(id).value = String(effects[key]);
    $<HTMLInputElement>('cd-fx-enabled').checked = effects.enabled;
    $<HTMLInputElement>('cd-fx-limiter').checked = effects.limiter;
  }
  async function saveEffects(): Promise<void> {
    if (!current) return;
    const raw: Record<string, unknown> = {};
    for (const { id, key } of effectFields) raw[key] = Number($<HTMLInputElement>(id).value);
    raw.enabled = $<HTMLInputElement>('cd-fx-enabled').checked;
    raw.limiter = $<HTMLInputElement>('cd-fx-limiter').checked;
    current.clip.effects = reviveEffects(raw);
    await saveClip(current.clip);
    stopPlayback();
  }
  for (const { id } of effectFields) $<HTMLInputElement>(id).addEventListener('change', () => void saveEffects());
  for (const id of ['cd-fx-enabled', 'cd-fx-limiter']) $<HTMLInputElement>(id).addEventListener('change', () => void saveEffects());
  $<HTMLButtonElement>('cd-effects-voice').addEventListener('click', async () => {
    if (!current) return;
    current.clip.effects = { ...voiceEffects };
    showEffects();
    await saveEffects();
  });
  $<HTMLButtonElement>('cd-effects-reset').addEventListener('click', async () => {
    if (!current) return;
    current.clip.effects = { ...defaultEffects };
    showEffects();
    await saveEffects();
  });

  const formatEl = $<HTMLSelectElement>('cd-format');
  for (const entry of EXPORT_FORMATS) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.title = entry.note;
    formatEl.append(option);
  }

  const numberSettings: [string, keyof Settings, number, number][] = [
    ['cd-fade-length', 'fadeSeconds', 0, 60],
    ['cd-crossfade', 'crossfadeSeconds', 0, 30],
    ['cd-target', 'normaliseTargetDb', -40, 0],
    ['cd-threshold', 'silenceThresholdDb', -90, -10],
  ];

  for (const [id, key, low, high] of numberSettings) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      const clamped = Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : settings[key] as number;
      input.value = String(clamped);
      settings = { ...settings, [key]: clamped };
      saveSettings(settings);
    });
  }

  formatEl.addEventListener('change', () => {
    settings = { ...settings, format: formatEl.value as Settings['format'] };
    saveSettings(settings);
  });

  // ------------------------------------------------------------------ download

  const transcribeButton = $<HTMLButtonElement>('cd-transcribe');
  const transcriptEl = $<HTMLTextAreaElement>('cd-transcript');
  const transcriptStatusEl = $<HTMLElement>('cd-transcript-status');
  const transcriptSaveButton = $<HTMLButtonElement>('cd-transcript-save');
  if (!canTranscribe()) transcribeButton.disabled = true;
  transcriptEl.addEventListener('input', () => { transcriptSaveButton.disabled = !transcriptEl.value.trim(); });
  transcribeButton.addEventListener('click', async () => {
    if (!current) return;
    transcribeButton.disabled = true;
    try {
      const buffer = toAudioBuffer(current.samples, audioContext());
      const cues = await transcribe(buffer, 'tiny', (progress) => {
        transcriptStatusEl.textContent = `${progress.stage === 'model' ? 'Downloading model' : progress.stage === 'library' ? 'Loading library' : 'Transcribing'}${progress.ratio === null ? '' : ` ${Math.round(progress.ratio * 100)}%`}${progress.detail ? ` · ${progress.detail}` : ''}`;
      });
      transcriptEl.value = cues.map((cue) => cue.text).join(' ').trim();
      transcriptSaveButton.disabled = !transcriptEl.value;
      transcriptStatusEl.textContent = transcriptEl.value ? 'Transcript ready. Review it for errors.' : 'No speech was recognized.';
    } catch (error) { transcriptStatusEl.textContent = error instanceof Error ? error.message : 'Transcription failed.'; }
    finally { transcribeButton.disabled = false; }
  });
  transcriptSaveButton.addEventListener('click', () => {
    if (!current || !transcriptEl.value.trim()) return;
    downloadBlob(`${fileStem(current.clip.name)}-transcript.txt`, new Blob([transcriptEl.value], { type: 'text/plain;charset=utf-8' }));
  });

  const exportKindEl = $<HTMLSelectElement>('cd-export-kind');
  const exportRateEl = $<HTMLSelectElement>('cd-export-rate');
  const exportChannelsEl = $<HTMLSelectElement>('cd-export-channels');
  const opusBitrateEl = $<HTMLSelectElement>('cd-opus-bitrate');
  const savedExport = readPref('cadence:export', { kind: 'wav', rate: '0', channels: '0', bitrate: '128000' });
  exportKindEl.value = savedExport.kind;
  exportRateEl.value = savedExport.rate;
  exportChannelsEl.value = savedExport.channels;
  opusBitrateEl.value = savedExport.bitrate;
  if (!canEncodeAudio()) exportKindEl.querySelector<HTMLOptionElement>('option[value=opus]')!.disabled = true;
  for (const element of [exportKindEl, exportRateEl, exportChannelsEl, opusBitrateEl]) element.addEventListener('change', () => {
    writePref('cadence:export', { kind: exportKindEl.value, rate: exportRateEl.value, channels: exportChannelsEl.value, bitrate: opusBitrateEl.value });
  });

  $<HTMLButtonElement>('cd-download').addEventListener('click', async () => {
    if (!current) return;
    const depth = EXPORT_FORMATS.find((entry) => entry.id === settings.format)?.depth ?? 16;
    const window = selection ? trim(current.samples, selection.start, selection.end) : current.samples;
    const name = current.clip.name;
    const effects = reviveEffects(current.clip.effects);
    const exportKind = exportKindEl.value;
    const exportRate = Number(exportRateEl.value);
    const exportChannels = Number(exportChannelsEl.value);
    const opusBitrate = Number(opusBitrateEl.value);
    try {
      const bytes = await runJob('Export audio', async (signal, progress) => {
        progress(`Processing ${window.channels.length} audio channels. Your source stays available if you cancel.`);
        let prepared = await processEffects(window, effects);
        if (exportRate && exportRate !== prepared.sampleRate) prepared = resample(prepared, exportRate);
        if (exportChannels === 1) prepared = toMono(prepared);
        if (exportChannels === 2) prepared = toStereo(prepared);
        if (signal.aborted) throw new Error('Export cancelled.');
        if (exportKind === 'opus') {
          if (!canEncodeAudio()) throw new Error('Opus export is unavailable in this browser.');
          progress('Encoding Opus.');
          const sourceWav = encodeWav(prepared, 16);
          const encoded = await encodeOpus(new Blob([sourceWav as unknown as BlobPart], { type: 'audio/wav' }), { track: 1, bitrate: opusBitrate, channels: Math.min(2, prepared.channels.length) as 1 | 2 });
          if (!encoded) throw new Error('This browser could not encode Opus.');
          return muxWebm({ tracks: [encoded.track], writingApp: 'Cadence on alexmerced.app' }, encoded.samples);
        }
        const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
        try { return await new Promise<Uint8Array>((resolve, reject) => {
          signal.addEventListener('abort', () => { worker.terminate(); reject(new Error('Export cancelled.')); }, { once: true });
          worker.onerror = () => reject(new Error('WAV export failed. Try a shorter selection.'));
          worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.bytes);
          worker.postMessage({ samples: prepared, depth });
        }); } finally { worker.terminate(); }
      });
      const opus = exportKind === 'opus';
      downloadBlob(`${fileStem(name)}.${opus ? 'webm' : 'wav'}`, new Blob([bytes as unknown as BlobPart], { type: opus ? 'audio/webm' : 'audio/wav' }));
      toast(`Saved as ${opus ? 'Opus' : 'WAV'}.`, { kind: 'good' });
    } catch (error) { toast(error instanceof Error ? error.message : 'Audio export failed.', { kind: 'error' }); }

  });

  $<HTMLButtonElement>('cd-download-source').addEventListener('click', () => {
    if (!current) return;
    const mime = current.clip.originalMime ?? current.clip.mime;
    const bytes = current.clip.originalBytes ?? current.clip.bytes;
    const extension = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a'
      : mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3'
      : mime.includes('flac') ? 'flac' : mime.includes('aac') ? 'aac' : 'wav';
    downloadBlob(`${fileStem(current.clip.name)}.${extension}`, new Blob([bytes as unknown as BlobPart], { type: mime }));
    toast('Saved in its stored format.', { kind: 'good' });
  });

  async function refreshStorage(): Promise<void> {
    const total = await storedBytes();
    storageEl.textContent = total > 0 ? `${formatBytes(total)} stored in this browser` : '';
  }

  // ------------------------------------------------------------------ start

  window.addEventListener('resize', () => { if (current) drawWave(); });

  wireDataMenu(root, {
    app: APP_ID,
    buildExport,
    applyImport: async (text, mode) => {
      if (recorder && recorder.state !== 'inactive') throw new Error('Stop recording before importing project data.');
      const count = await applyImport(text, mode);
      return `${count} clip${count === 1 ? '' : 's'} in place.`;
    },
    onImported: async () => {
      clips = await loadClips();
      settings = loadSettings();
      current = null;
      await showFirstOrEmpty();
      void refreshStorage();
    },
    onClearAll: async () => {
      stopPlayback();
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
        recorder = null;
      }
      window.clearInterval(recordTimer);
      closeInput();
      activeSession = null;
      pendingPunch = null;
      await writeQueue.catch(() => {});
      await clearAll();
      clips = [];
      current = null;
      await showFirstOrEmpty();
      void refreshStorage();
    },
    clearWarning: 'Every recording and clip stored in this browser will be deleted.',
  });

  clips = await loadClips();
  formatEl.value = settings.format;
  for (const [id, key] of numberSettings) $<HTMLInputElement>(id).value = String(settings[key]);
  await showFirstOrEmpty();
  void refreshStorage();
  await renderRecovery();

  // Everything this app can do, offered to an agent on this page.
  registerTools(cadenceTools());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
