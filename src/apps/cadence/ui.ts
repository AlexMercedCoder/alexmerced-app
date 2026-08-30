import { formatBytes } from '../../lib/bytes';
import { wireDataMenu } from '../../lib/dataMenu';
import { downloadBlob } from '../../lib/portable';
import { toast } from '../../lib/toast';
import { audioContext, canRecord, decode, DecodeError, pickRecordingMime, toAudioBuffer } from './audio';
import {
  changeSpeed, cut, fadeIn, fadeOut, findBounds, formatTime, gain, gainToDecibels, join,
  normalisePeak, normaliseRms, peak, resample, reverse, rms, toMono, toStereo, trim, trimSilence,
  waveformPeaks,
} from './dsp';
import {
  APP_ID, createClip, EXPORT_FORMATS, fileStem, nameFromFile, uniqueName, type Clip, type Settings,
} from './model';
import {
  applyImport, buildExport, clearAll, deleteClip, loadClips, loadSettings, saveClip, saveSettings, storedBytes,
} from './store';
import { duration as sampleDuration, encodeWav, frameCount, type Samples } from './wav';

type Loaded = { clip: Clip; samples: Samples };

const MAX_UNDO = 12;

export async function mountCadence(root: HTMLElement): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const listEl = $<HTMLDivElement>('cd-list');
  const emptyEl = $<HTMLDivElement>('cd-empty');
  const workEl = $<HTMLDivElement>('cd-work');
  const canvas = $<HTMLCanvasElement>('cd-wave');
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

  // ------------------------------------------------------------------ playback

  let source: AudioBufferSourceNode | null = null;
  let playStartedAt = 0;
  let playOffset = 0;
  let raf = 0;

  function stopPlayback(): void {
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      source.disconnect();
      source = null;
    }
    cancelAnimationFrame(raf);
    playButton.textContent = 'Play';
    playheadEl.style.opacity = '0';
  }

  function play(from: number, to: number): void {
    if (!current) return;
    stopPlayback();
    const ctx = audioContext();
    void ctx.resume();

    const buffer = toAudioBuffer(current.samples, ctx);
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    playOffset = from;
    playStartedAt = ctx.currentTime;
    source.start(0, from, Math.max(0.01, to - from));
    source.onended = () => { stopPlayback(); };
    playButton.textContent = 'Stop';
    playheadEl.style.opacity = '1';

    const tick = () => {
      if (!source || !current) return;
      const elapsed = audioContext().currentTime - playStartedAt + playOffset;
      const total = sampleDuration(current.samples);
      playheadEl.style.left = `${Math.min(100, (elapsed / Math.max(total, 0.001)) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  playButton.addEventListener('click', () => {
    if (!current) return;
    if (source) { stopPlayback(); return; }
    const total = sampleDuration(current.samples);
    play(selection?.start ?? 0, selection?.end ?? total);
  });

  // ------------------------------------------------------------------ waveform

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

    const peaks = waveformPeaks(current.samples, Math.round(width));
    context.fillStyle = accent;
    for (let column = 0; column < peaks.max.length; column += 1) {
      const top = middle - peaks.max[column] * middle * 0.94;
      const bottom = middle - peaks.min[column] * middle * 0.94;
      // A flat column still needs a visible line, hence the minimum height.
      context.fillRect(column, top, 1, Math.max(1, bottom - top));
    }

    updateSelectionOverlay();
  }

  function updateSelectionOverlay(): void {
    if (!current || !selection) {
      selectionEl.hidden = true;
      return;
    }
    const total = sampleDuration(current.samples) || 1;
    selectionEl.hidden = false;
    selectionEl.style.left = `${(selection.start / total) * 100}%`;
    selectionEl.style.width = `${((selection.end - selection.start) / total) * 100}%`;
  }

  // Dragging across the waveform picks a region to work on.
  let dragging = false;
  let dragFrom = 0;

  function timeAt(event: PointerEvent): number {
    if (!current) return 0;
    const box = canvas.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    return position * sampleDuration(current.samples);
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
    if (!current) return;
    stopPlayback();
    const before = current.samples;
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
    current.samples = next;

    // The stored bytes are rewritten as WAV, because the edit no longer matches
    // whatever the source file contained.
    await persistCurrent();
    selection = null;
    drawWave();
    renderStats();
    renderList();
    toast(label, { kind: 'good' });
  }

  async function persistCurrent(): Promise<void> {
    if (!current) return;
    const depth = EXPORT_FORMATS.find((entry) => entry.id === settings.format)?.depth ?? 16;
    const bytes = encodeWav(current.samples, depth);
    current.clip = {
      ...current.clip,
      bytes,
      mime: 'audio/wav',
      duration: sampleDuration(current.samples),
      sampleRate: current.samples.sampleRate,
      channelCount: current.samples.channels.length,
      updatedAt: new Date().toISOString(),
    };
    clips = clips.map((clip) => (clip.id === current!.clip.id ? current!.clip : clip));
    await saveClip(current.clip);
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
    if (!current || undoStack.length === 0) return;
    stopPlayback();
    current.samples = undoStack.pop()!;
    await persistCurrent();
    selection = null;
    drawWave();
    renderStats();
    renderList();
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
  }

  // ------------------------------------------------------------------ clip list

  function renderList(): void {
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

      row.append(pick, open, remove);
      listEl.append(row);
    }

    emptyEl.hidden = clips.length > 0;
    $<HTMLButtonElement>('cd-join').disabled = clips.length < 2;
  }

  async function select(id: string): Promise<void> {
    const clip = clips.find((entry) => entry.id === id);
    if (!clip) return;
    stopPlayback();
    try {
      const samples = await decode(clip.bytes, clip.mime);
      current = { clip, samples };
      undoStack.length = 0;
      selection = null;
      workEl.hidden = false;
      $<HTMLInputElement>('cd-name').value = clip.name;
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

  if (!canRecord()) {
    recordButton.disabled = true;
    recordButton.title = 'This browser does not offer microphone recording.';
  }

  recordButton.addEventListener('click', async () => {
    if (recorder) {
      recorder.stop();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      toast('The microphone was not made available. Check the permission for this site.', { kind: 'error' });
      return;
    }

    const mime = pickRecordingMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();

    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      window.clearInterval(recordTimer);
      recordTimeEl.textContent = '';
      recordButton.textContent = 'Record';
      recordButton.classList.remove('is-recording');
      // Releasing the tracks is what turns the browser's recording indicator off.
      for (const track of stream.getTracks()) track.stop();
      recorder = null;

      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length === 0) {
        toast('Nothing was recorded.', { kind: 'error' });
        return;
      }
      try {
        const samples = await decode(bytes, blob.type);
        const clip = createClip(
          uniqueName('Recording', clips.map((entry) => entry.name)),
          bytes, blob.type,
          { duration: sampleDuration(samples), sampleRate: samples.sampleRate, channelCount: samples.channels.length },
        );
        await saveClip(clip);
        clips = [...clips, clip];
        await select(clip.id);
        void refreshStorage();
        toast(`Recorded ${formatTime(sampleDuration(samples))}.`, { kind: 'good' });
      } catch {
        toast('The recording was made but could not be decoded for editing.', { kind: 'error' });
      }
    };

    recorder.start();
    recordButton.textContent = 'Stop';
    recordButton.classList.add('is-recording');
    recordTimer = window.setInterval(() => {
      recordTimeEl.textContent = formatTime((Date.now() - startedAt) / 1000);
    }, 100);
  });

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

  // ------------------------------------------------------------------ settings

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

  $<HTMLButtonElement>('cd-download').addEventListener('click', () => {
    if (!current) return;
    const depth = EXPORT_FORMATS.find((entry) => entry.id === settings.format)?.depth ?? 16;
    const window = selection ? trim(current.samples, selection.start, selection.end) : current.samples;
    downloadBlob(`${fileStem(current.clip.name)}.wav`, new Blob([encodeWav(window, depth) as unknown as BlobPart], { type: 'audio/wav' }));
    toast(selection ? 'Selection saved as WAV.' : 'Saved as WAV.', { kind: 'good' });
  });

  $<HTMLButtonElement>('cd-download-source').addEventListener('click', () => {
    if (!current) return;
    const extension = current.clip.mime.includes('webm') ? 'webm' : current.clip.mime.includes('mp4') ? 'm4a' : current.clip.mime.includes('ogg') ? 'ogg' : 'wav';
    downloadBlob(`${fileStem(current.clip.name)}.${extension}`, new Blob([current.clip.bytes as unknown as BlobPart], { type: current.clip.mime }));
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
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
}
