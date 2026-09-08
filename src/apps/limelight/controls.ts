import { CAMERA_SHAPES, OUTPUT_SIZES, PRESETS, QUALITY, type CameraCorner, type CameraShape } from './layout';
import { MOTIONS, defaultTilt, type Motion } from './plate';
import { capabilities, type OutputFormat } from './render';
import type { Settings } from './store';
import type { ZoomBlock } from './zooms';

interface Context {
  $: <T extends HTMLElement>(id: string) => T;
  settings: Settings;
  zooms: ZoomBlock[];
  remember: (label?: string) => void;
  drawPreview: () => Promise<void>;
  invalidateTrack: () => void;
  renderZooms: () => void;
  countdownEl: HTMLSelectElement;
  renderWallpaper: () => void;
  suggestBitrate: () => number;
  analyse: () => Promise<void>;
}

/** Owns controls behavior; live accessors keep edits and restored state in sync. */
export function mountControls(c: Context) {
  const presetsEl = c.$<HTMLDivElement>('ll-presets');
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
      c.settings.composition.background = preset.background;
      c.settings.composition.colours = [...preset.colours];
      c.remember();
      markPresets();
      void c.drawPreview();
    });
    presetsEl.append(button);
  }
  function markPresets(): void {
    for (const button of presetsEl.querySelectorAll<HTMLButtonElement>('.ll-preset')) {
      const preset = PRESETS.find((entry) => entry.id === button.dataset.preset)!;
      const active = preset.background === c.settings.composition.background
        && preset.colours[0] === c.settings.composition.colours[0];
      button.setAttribute('aria-pressed', String(active));
    }
  }

  const sizeEl = c.$<HTMLSelectElement>('ll-size');
  for (const size of OUTPUT_SIZES) {
    const option = document.createElement('option');
    option.value = size.id;
    option.textContent = size.label;
    sizeEl.append(option);
  }
  sizeEl.addEventListener('change', () => {
    const size = OUTPUT_SIZES.find((entry) => entry.id === sizeEl.value);
    if (!size) return;
    c.settings.composition.width = size.width;
    c.settings.composition.height = size.height;
    c.remember();
    void describeFormat();
    void c.drawPreview();
  });

  const sliders: [string, (value: number) => void, () => number][] = [
    ['ll-padding', (value) => { c.settings.composition.padding = value; }, () => c.settings.composition.padding],
    ['ll-radius', (value) => { c.settings.composition.radius = value; }, () => c.settings.composition.radius],
    ['ll-shadow', (value) => { c.settings.composition.shadow = value; }, () => c.settings.composition.shadow],
    ['ll-zoom-scale', (value) => { c.settings.zoom.scale = value; }, () => c.settings.zoom.scale],
    ['ll-zoom-hold', (value) => { c.settings.zoom.holdSeconds = value; }, () => c.settings.zoom.holdSeconds],
    ['ll-zoom-move', (value) => { c.settings.zoom.moveSeconds = value; }, () => c.settings.zoom.moveSeconds],
    ['ll-camera-size', (value) => { c.settings.composition.camera.size = value; }, () => c.settings.composition.camera.size],
    ['ll-tilt-x', (value) => { c.settings.tilt.x = value; }, () => c.settings.tilt.x],
    ['ll-tilt-y', (value) => { c.settings.tilt.y = value; }, () => c.settings.tilt.y],
    ['ll-tilt-rotate', (value) => { c.settings.tilt.rotate = value; }, () => c.settings.tilt.rotate],
    ['ll-tilt-depth', (value) => { c.settings.tilt.depth = value; }, () => c.settings.tilt.depth],
    ['ll-motion-seconds', (value) => { c.settings.motion.seconds = value; }, () => c.settings.motion.seconds],
    ['ll-cursor-size', (value) => { c.settings.cursorSize = value; }, () => c.settings.cursorSize],
    ['ll-voice-highpass', (value) => { c.settings.voice.highPass = value; }, () => c.settings.voice.highPass],
    ['ll-voice-gate', (value) => { c.settings.voice.gate = value; }, () => c.settings.voice.gate],
    ['ll-spotlight', (value) => { c.settings.spotlight = value; }, () => c.settings.spotlight],
  ];
  for (const [id, apply] of sliders) {
    const input = c.$<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      apply(Number(input.value));
      // The default scale used to write a value that only new blocks would ever
      // read, so after a recording the slider looked broken. It now carries the
      // blocks nobody has touched with it, which is what a default should mean.
      if (id === 'll-zoom-scale') applyDefaultScale();
      c.remember(`slider:${id}`);
      renderReadouts();
      void c.drawPreview();
    });
  }

  /** Retunes every zoom still on the automatic settings. Pinned ones are yours. */
  function applyDefaultScale(): void {
    if (!c.zooms.some((zoom) => !zoom.pinned)) return;
    c.zooms = c.zooms.map((zoom) => (zoom.pinned ? zoom : { ...zoom, scale: c.settings.zoom.scale }));
    c.invalidateTrack();
    c.renderZooms();
  }

  const toggles: [string, (value: boolean) => void, () => boolean][] = [
    ['ll-zoom-on', (value) => { c.settings.zoom.enabled = value; }, () => c.settings.zoom.enabled],
    ['ll-clicks', (value) => { c.settings.showClicks = value; }, () => c.settings.showClicks],
    ['ll-cursor', (value) => { c.settings.showCursor = value; }, () => c.settings.showCursor],
    ['ll-keys', (value) => { c.settings.showKeys = value; }, () => c.settings.showKeys],
    ['ll-voice-normalise', (value) => { c.settings.voice.normalise = value; }, () => c.settings.voice.normalise],
    ['ll-camera-on', (value) => { c.settings.composition.camera.enabled = value; }, () => c.settings.composition.camera.enabled],
    ['ll-audio', (value) => { c.settings.keepAudio = value; }, () => c.settings.keepAudio],
  ];
  for (const [id, apply] of toggles) {
    const input = c.$<HTMLInputElement>(id);
    input.addEventListener('change', () => {
      apply(input.checked);
      c.remember();
      void c.drawPreview();
    });
  }

  for (const [id, key] of [['ll-motion-in', 'entrance'], ['ll-motion-out', 'exit']] as [string, 'entrance' | 'exit'][]) {
    const select = c.$<HTMLSelectElement>(id);
    for (const entry of MOTIONS) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      select.append(option);
    }
    select.addEventListener('change', () => {
      c.settings.motion[key] = select.value as Motion;
      c.remember();
      void c.drawPreview();
    });
  }

  c.$<HTMLButtonElement>('ll-tilt-reset').addEventListener('click', () => {
    c.settings.tilt = { ...defaultTilt };
    c.remember();
    renderControls();
    void c.drawPreview();
  });

  const shapeEl = c.$<HTMLSelectElement>('ll-camera-shape');
  for (const shape of CAMERA_SHAPES) {
    const option = document.createElement('option');
    option.value = shape.id;
    option.textContent = shape.label;
    shapeEl.append(option);
  }
  shapeEl.addEventListener('change', () => {
    c.settings.composition.camera.shape = shapeEl.value as CameraShape;
    c.remember();
    void c.drawPreview();
  });

  const cornerEl = c.$<HTMLSelectElement>('ll-camera-corner');
  cornerEl.addEventListener('change', () => {
    c.settings.composition.camera.corner = cornerEl.value as CameraCorner;
    c.remember();
    void c.drawPreview();
  });

  const formatEl = c.$<HTMLSelectElement>('ll-format');
  formatEl.addEventListener('change', async () => {
    c.settings.format = formatEl.value as OutputFormat;
    c.remember();
    await describeFormat();
  });

  const qualityEl = c.$<HTMLSelectElement>('ll-quality');
  for (const entry of QUALITY) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    qualityEl.append(option);
  }
  qualityEl.addEventListener('change', () => {
    c.settings.quality = qualityEl.value as Settings['quality'];
    c.remember();
    renderReadouts();
  });

  /** Says what this browser can write, and what each choice costs. */
  async function describeFormat(): Promise<void> {
    const note = c.$<HTMLParagraphElement>('ll-format-note');
    const { width, height } = c.settings.composition;
    const able = await capabilities(width, height);

    const mp4Option = formatEl.querySelector<HTMLOptionElement>('option[value="mp4"]');
    if (mp4Option) {
      mp4Option.disabled = !able.mp4;
      mp4Option.textContent = able.mp4 ? 'MP4' : 'MP4, not available here';
    }

    if (c.settings.format === 'mp4' && !able.mp4) {
      c.settings.format = 'webm';
      formatEl.value = 'webm';
      c.remember();
    }

    note.textContent =
      c.settings.format === 'gif'
        ? 'A GIF plays anywhere but has no sound and only 256 colours a frame. Keep it short and small.'
        : c.settings.format === 'mp4'
          ? able.aac
            ? 'MP4 with H.264. The most portable choice.'
            : 'MP4 with H.264. This browser cannot encode AAC, so the sound will be Opus, which Safari does not play. WebM keeps sound everywhere.'
          : 'WebM with VP9. Best quality for the size, and sound that plays in every current browser.';
  }

  const fpsEl = c.$<HTMLSelectElement>('ll-fps');
  fpsEl.addEventListener('change', () => {
    c.settings.frameRate = Number(fpsEl.value) || 30;
    c.remember();
    renderReadouts();
  });

  function renderControls(): void {
    for (const [id, , read] of sliders) c.$<HTMLInputElement>(id).value = String(read());
    for (const [id, , read] of toggles) c.$<HTMLInputElement>(id).checked = read();
    cornerEl.value = c.settings.composition.camera.corner;
    shapeEl.value = c.settings.composition.camera.shape;
    c.$<HTMLSelectElement>('ll-motion-in').value = c.settings.motion.entrance;
    c.$<HTMLSelectElement>('ll-motion-out').value = c.settings.motion.exit;
    c.countdownEl.value = String(c.settings.countdown);
    c.$<HTMLInputElement>('ll-countdown-sound').checked = c.settings.countdownSound;
    c.$<HTMLInputElement>('ll-camera-blur').checked = c.settings.cameraBlur;
    c.renderWallpaper();
    fpsEl.value = String(c.settings.frameRate);
    formatEl.value = c.settings.format;
    qualityEl.value = c.settings.quality;
    const size = OUTPUT_SIZES.find((entry) =>
      entry.width === c.settings.composition.width && entry.height === c.settings.composition.height);
    sizeEl.value = size?.id ?? OUTPUT_SIZES[0].id;
    markPresets();
    renderReadouts();
  }

  function renderReadouts(): void {
    const readouts: [string, string][] = [
      ['ll-padding-out', `${Math.round(c.settings.composition.padding * 100)}%`],
      ['ll-radius-out', `${Math.round(c.settings.composition.radius * 100)}%`],
      ['ll-shadow-out', `${Math.round(c.settings.composition.shadow * 100)}%`],
      ['ll-zoom-scale-out', `${c.settings.zoom.scale.toFixed(1)}x`],
      ['ll-zoom-hold-out', `${c.settings.zoom.holdSeconds.toFixed(1)}s`],
      ['ll-zoom-move-out', `${c.settings.zoom.moveSeconds.toFixed(2)}s`],
      ['ll-camera-size-out', `${Math.round(c.settings.composition.camera.size * 100)}%`],
      ['ll-tilt-x-out', `${Math.round(c.settings.tilt.x)}\u00b0`],
      ['ll-tilt-y-out', `${Math.round(c.settings.tilt.y)}\u00b0`],
      ['ll-tilt-rotate-out', `${Math.round(c.settings.tilt.rotate)}\u00b0`],
      ['ll-tilt-depth-out', `${Math.round(c.settings.tilt.depth * 100)}%`],
      ['ll-motion-seconds-out', `${c.settings.motion.seconds.toFixed(2)}s`],
      ['ll-cursor-size-out', `${c.settings.cursorSize.toFixed(1)}x`],
      ['ll-voice-highpass-out', c.settings.voice.highPass > 0 ? `${c.settings.voice.highPass} Hz` : 'off'],
      ['ll-voice-gate-out', c.settings.voice.gate > 0 ? `${Math.round(c.settings.voice.gate * 100)}%` : 'off'],
      ['ll-spotlight-out', c.settings.spotlight > 0 ? `${Math.round(c.settings.spotlight * 100)}%` : 'off'],
    ];
    for (const [id, text] of readouts) c.$<HTMLSpanElement>(id).textContent = text;
    c.$<HTMLSpanElement>('ll-bitrate-out').textContent = `${Math.round(c.suggestBitrate() / 1000)} kbps`;
    c.$<HTMLDivElement>('ll-camera-fields').hidden = !c.settings.composition.camera.enabled;
  }

  c.$<HTMLButtonElement>('ll-reanalyse').addEventListener('click', () => { void c.analyse().then(c.drawPreview); });


  return { renderControls, markPresets, describeFormat };
}
