import { downloadBlob } from '../../lib/portable';
import { runJob } from '../../lib/workspace/jobs';
import { createId } from '../../lib/id';
import { splitCue, sortCues, type Cue } from './captions';
import type { EditorState } from './editorState';
import {
  captionStyle,
  excerptProject,
  exportDuration,
  mergeCues,
  overlappingCues,
  replaceWords,
  shiftCues,
} from './enhancements';
import { freezeExport, renderFrozen, type FrozenExport } from './exportQueue';
import { capabilities, type Project } from './render';
import { loadProjects, saveProject, type Project as StoredProject } from './store';
import { findSilences, keptSpans, type Span, type Wave } from './waveform';
import { mountTimelineView } from './timelineView';

export type EnhancementHooks = {
  editor: EditorState;
  project: () => Project | null;
  camera: () => Blob | null;
  time: () => number;
  duration: () => number;
  picked: Set<string>;
  seek: (t: number) => void;
  previewSpan: (span: Span | null) => void;
  wave: () => Wave | null;
  applyCuts: (spans: Span[], label: string) => void;
  changed: (label: string) => void;
  renderCues: () => void;
  captureStored: () => Promise<StoredProject>;
  open: (id: string) => Promise<void>;
  currentId: () => string | null;
  renderProjects: () => Promise<void>;
  alignedCues: () => Cue[];
  thumbnail: (mime: string) => Promise<Blob>;
};
export function mountEnhancements(root: HTMLElement, h: EnhancementHooks) {
  const $ = <T extends HTMLElement = HTMLInputElement>(id: string) =>
    root.querySelector<T>(`#${id}`)!;
  const status = (s: string) => {
    $('ll-tools-status').textContent = s;
  };
  const action = (id: string, fn: () => unknown | Promise<unknown>) =>
    $(id).addEventListener('click', async () => {
      const button = $<HTMLButtonElement>(id);
      button.disabled = true;
      try {
        await fn();
      } catch (e) {
        status(e instanceof Error ? e.message : 'Could not complete that action.');
      } finally {
        button.disabled = false;
      }
    });
  const change = (label: string) => {
    h.changed(label);
    h.renderCues();
    refresh();
  };
  function requireProject() {
    const p = h.project();
    if (!p) throw new Error('Open or record a video first.');
    return p;
  }
  let nextMatch = 0;
  function matches() {
    const q = $('ll-transcript-find').value.toLowerCase();
    return q ? h.editor.captions.filter((c) => c.text.toLowerCase().includes(q)) : [];
  }
  function markMatches() {
    const found = new Set(matches().map((c) => c.id));
    $('ll-transcript-count').textContent = `${found.size} matching lines`;
    for (const row of root.querySelectorAll<HTMLElement>('.ll-cue'))
      row.classList.toggle('is-match', found.has(row.dataset.id ?? ''));
  }
  $('ll-transcript-find').addEventListener('input', () => {
    nextMatch = 0;
    markMatches();
  });
  action('ll-transcript-next', () => {
    const found = matches();
    if (!found.length) {
      status('No matching lines.');
      return;
    }
    const cue = found[nextMatch++ % found.length];
    h.seek(cue.start);
    const row = root.querySelector<HTMLElement>(`.ll-cue[data-id="${CSS.escape(cue.id)}"]`);
    const details = row?.closest('details');
    if (details) details.open = true;
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  });
  action('ll-transcript-replace', () => {
    const count = matches().length;
    if (!count) throw new Error('Enter text that matches the transcript.');
    h.editor.captions = replaceWords(
      h.editor.captions,
      $('ll-transcript-find').value,
      $('ll-transcript-replacement').value,
    );
    change('replace-transcript');
    status(`Updated ${count} lines. Undo restores the previous words.`);
  });
  action('ll-transcript-download', () => {
    requireProject();
    downloadBlob(
      'transcript.txt',
      new Blob(
        [
          h
            .alignedCues()
            .map((c) => c.text)
            .join('\n'),
        ],
        { type: 'text/plain' },
      ),
    );
  });
  action('ll-cue-merge', () => {
    h.editor.captions = mergeCues(h.editor.captions, h.picked);
    h.picked.clear();
    change('merge-subtitles');
  });
  action('ll-cue-shift', () => {
    h.editor.captions = shiftCues(
      h.editor.captions,
      Number($('ll-cue-shift-seconds').value),
      h.duration(),
    );
    change('shift-subtitles');
  });
  const styleKeys = [
    'font',
    'color',
    'background',
    'opacity',
    'position',
    'lineHeight',
    'margin',
  ] as const;
  for (const key of styleKeys)
    $(`ll-style-${key}`).addEventListener('change', () => {
      const value = $(`ll-style-${key}`).value;
      h.editor.settings.captionStyle = captionStyle({
        ...captionStyle(h.editor.settings.captionStyle),
        [key]: ['opacity', 'lineHeight', 'margin'].includes(key) ? Number(value) : value,
      });
      change('caption-style');
    });
  const stylesKey = 'limelight:caption-styles';
  function readStyles(): Record<string, ReturnType<typeof captionStyle>> {
    try {
      const raw = JSON.parse(localStorage.getItem(stylesKey) ?? '{}');
      return Object.fromEntries(
        Object.entries(raw).map(([name, value]) => [name, captionStyle(value)]),
      );
    } catch {
      return {};
    }
  }
  function listStyles() {
    const pick = $<HTMLSelectElement>('ll-style-pick');
    pick.replaceChildren(new Option('Choose a style', ''));
    for (const name of Object.keys(readStyles())) pick.add(new Option(name, name));
  }
  action('ll-style-save', () => {
    const name = $('ll-style-name').value.trim();
    if (!name) throw new Error('Name the caption style first.');
    const styles = readStyles();
    Object.defineProperty(styles, name, {
      value: captionStyle(h.editor.settings.captionStyle),
      enumerable: true,
      configurable: true,
    });
    localStorage.setItem(stylesKey, JSON.stringify(styles));
    listStyles();
    status('Caption style saved in this browser.');
  });
  action('ll-style-apply', () => {
    const name = $('ll-style-pick').value,
      styles = readStyles();
    if (!Object.hasOwn(styles, name)) throw new Error('Choose a saved caption style.');
    h.editor.settings.captionStyle = captionStyle(styles[name]);
    change('apply-caption-style');
  });
  action('ll-style-delete', () => {
    const styles = readStyles();
    delete styles[$('ll-style-pick').value];
    localStorage.setItem(stylesKey, JSON.stringify(styles));
    listStyles();
  });
  listStyles();

  let proposals: Span[] = [],
    proposedFor = '';
  const silenceSignature = () =>
    JSON.stringify([h.currentId(), h.editor.clips, h.editor.trim, h.editor.cuts]);
  action('ll-silence-find', () => {
    const wave = h.wave();
    if (!wave) throw new Error('No decoded audio is available in this recording.');
    for (const id of ['ll-silence-threshold', 'll-silence-min', 'll-silence-pad'])
      if (!$(id).checkValidity())
        throw new Error('Use values within the displayed silence control limits.');
    const found = findSilences(wave.loudness, h.duration(), {
      threshold: Number($('ll-silence-threshold').value) / 100,
      minSeconds: Number($('ll-silence-min').value),
      padSeconds: Number($('ll-silence-pad').value),
    });
    proposals = found
      .flatMap((s) =>
        keptSpans(
          h.editor.cuts,
          Math.max(s.start, h.editor.trim.start),
          Math.min(s.end, h.editor.trim.end),
        ),
      )
      .filter((s) => s.end - s.start >= 0.05);
    proposedFor = silenceSignature();
    const list = $('ll-silence-list');
    list.replaceChildren();
    for (const [i, span] of proposals.entries()) {
      const row = document.createElement('li'),
        label = document.createElement('label'),
        check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = true;
      check.value = String(i);
      label.append(check, ` Cut ${span.start.toFixed(2)} to ${span.end.toFixed(2)} seconds`);
      const preview = document.createElement('button');
      preview.className = 'btn btn--sm';
      preview.textContent = 'Preview gap';
      preview.onclick = () =>
        h.previewSpan({
          start: Math.max(h.editor.trim.start, span.start - 0.3),
          end: Math.min(h.editor.trim.end, span.end + 0.3),
        });
      row.append(label, preview);
      list.append(row);
    }
    $('ll-silence-summary').textContent =
      `${proposals.length} proposed cuts, ${proposals.reduce((n, s) => n + s.end - s.start, 0).toFixed(2)} seconds in total.`;
    $<HTMLButtonElement>('ll-silence-apply').disabled = !proposals.length;
  });
  action('ll-silence-stop', () => h.previewSpan(null));
  action('ll-silence-apply', () => {
    if (proposedFor !== silenceSignature())
      throw new Error('The timeline changed. Find proposed cuts again before applying them.');
    const spans = [
      ...root.querySelectorAll<HTMLInputElement>('#ll-silence-list input:checked'),
    ].map((c) => proposals[Number(c.value)]);
    if (!spans.length) throw new Error('Select at least one cut.');
    h.previewSpan(null);
    h.applyCuts([...h.editor.cuts, ...spans], 'reviewed-silences');
    $('ll-silence-list').replaceChildren();
    proposals = [];
    status(`Applied ${spans.length} cuts. Undo restores the removed sections.`);
  });
  function showSilences() {
    $<HTMLDetailsElement>('ll-silence-tools').open = true;
    $('ll-silence-tools').scrollIntoView({ block: 'center' });
  }

  async function listCheckpoints() {
    const pick = $<HTMLSelectElement>('ll-checkpoint-pick'),
      previous = pick.value;
    pick.replaceChildren(new Option('Choose a checkpoint', ''));
    for (const p of await loadProjects()) if (p.checkpointOf) pick.add(new Option(p.name, p.id));
    pick.value = previous;
  }
  async function copy(checkpoint: boolean) {
    requireProject();
    const name = $('ll-version-name').value.trim();
    if (!name) throw new Error('Enter a version name.');
    const original = await h.captureStored(),
      stamp = new Date().toISOString();
    const copy = {
      ...original,
      id: createId('rec'),
      name: checkpoint ? `Checkpoint: ${name}` : name,
      checkpointOf: checkpoint ? original.id : undefined,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await saveProject(copy);
    await h.renderProjects();
    await listCheckpoints();
    if (!checkpoint) await h.open(copy.id);
    status(checkpoint ? 'Checkpoint saved with its media.' : 'Opened the duplicate project.');
  }
  action('ll-copy-project', () => copy(false));
  action('ll-checkpoint-save', () => copy(true));
  action('ll-checkpoint-restore', async () => {
    const chosen = (await loadProjects()).find(
      (p) => p.id === $('ll-checkpoint-pick').value && p.checkpointOf,
    );
    if (!chosen) throw new Error('Choose a saved checkpoint.');
    const stamp = new Date().toISOString();
    const copy = {
      ...chosen,
      id: createId('rec'),
      name: `${chosen.name} (restored)`,
      checkpointOf: undefined,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await saveProject(copy);
    await h.open(copy.id);
    status('Opened a restored copy. The saved checkpoint is unchanged.');
  });
  void listCheckpoints().catch((e) => status(String(e)));

  type QueueItem = {
    name: string;
    frozen: FrozenExport;
    state: string;
    url?: string;
    extension?: string;
  };
  const queue: QueueItem[] = [];
  let running = false;
  function queueList() {
    const list = $('ll-export-queue');
    list.replaceChildren();
    for (const [i, item] of queue.entries()) {
      const row = document.createElement('li');
      row.textContent = `${i + 1}. ${item.name}: ${item.state}`;
      if (item.url) {
        const link = document.createElement('a');
        link.href = item.url;
        link.download = `${item.name}.${item.extension}`;
        link.textContent = 'Download file';
        link.className = 'btn btn--sm';
        row.append(' ', link);
      }
      list.append(row);
    }
  }
  action('ll-export-review', async () => {
    const p = requireProject(),
      duration = exportDuration(p),
      supported = await capabilities(p.composition.width, p.composition.height);
    const estimate =
      ((p.bitrate + (p.keepAudio || p.music?.length ? 128000 : 0)) * duration) / 8 / 1024 / 1024;
    $('ll-export-summary').textContent =
      `${duration.toFixed(2)} seconds, ${p.composition.width} × ${p.composition.height}, ${p.frameRate} fps, ${p.format.toUpperCase()}. ${p.keepAudio ? 'Recorded audio enabled.' : 'Recorded audio off.'} ${p.music?.length ? 'Music loaded.' : ''} ${p.format === 'gif' ? 'GIF has no audio. File size depends on image detail.' : `Estimated ${estimate.toFixed(1)} MB at the selected bitrate; actual size varies.`} Available formats: ${[supported.webm ? 'WebM' : '', supported.mp4 ? 'MP4' : '', supported.gif ? 'GIF' : ''].filter(Boolean).join(', ')}.${p.format === 'mp4' && !supported.aac ? ' AAC audio encoding is unavailable; MP4 audio compatibility may vary.' : ''}`;
  });
  const safeName = (name: string) =>
    name
      .trim()
      .replace(/[^a-z0-9_-]+/gi, '-')
      .slice(0, 80) || 'video';
  action('ll-test-export', async () => {
    if (!$('ll-test-length').checkValidity())
      throw new Error('Choose a test length between 0.1 and 30 seconds.');
    const p = excerptProject(
      requireProject(),
      h.editor.captions,
      Number($('ll-test-from').value),
      Number($('ll-test-length').value),
    );
    const frozen = await freezeExport(p, h.camera());
    try {
      const result = await runJob('Export test range', (signal, report) =>
        renderFrozen(frozen, (v) => report(`${v.stage}: ${v.done} of ${v.total}`), signal),
      );
      downloadBlob(`limelight-test.${result.extension}`, result.blob);
      status(`Test export ready.${result.note ? ` ${result.note}` : ''}`);
    } finally {
      frozen.wallpaper?.close();
    }
  });
  action('ll-queue-add', async () => {
    if (running) throw new Error('Wait for the queue to stop before adding a version.');
    if (queue.length >= 8) throw new Error('Keep at most eight versions in the queue.');
    const name = safeName($('ll-export-name').value || `version-${queue.length + 1}`);
    const frozen = await freezeExport(requireProject(), h.camera());
    queue.push({ name, frozen, state: 'Waiting' });
    queueList();
    status('Version added with the current framing and edits.');
  });
  action('ll-queue-run', async () => {
    if (running || !queue.some((i) => !i.url)) throw new Error('Add a version to the queue first.');
    running = true;
    try {
      await runJob('Export queued versions', async (signal, report) => {
        for (const item of queue) {
          if (item.url) continue;
          signal.throwIfAborted();
          item.state = 'Rendering';
          queueList();
          try {
            const result = await renderFrozen(
              item.frozen,
              (v) => {
                report(`${item.name}: ${v.stage}, ${v.done} of ${v.total}`);
              },
              signal,
            );
            item.url = URL.createObjectURL(result.blob);
            item.extension = result.extension;
            item.state = `Ready (${(result.blob.size / 1024 / 1024).toFixed(1)} MB)${result.note ? ` ${result.note}` : ''}`;
          } catch (e) {
            item.state = signal.aborted ? 'Cancelled' : e instanceof Error ? e.message : 'Failed';
            queueList();
            if (signal.aborted) throw e;
          }
          queueList();
        }
      });
      status('Queue finished. Download the ready files or retry failed entries.');
    } finally {
      running = false;
    }
  });
  const clearQueue = () => {
    for (const item of queue) {
      if (item.url) URL.revokeObjectURL(item.url);
      item.frozen.wallpaper?.close();
    }
    queue.length = 0;
    queueList();
  };
  action('ll-queue-clear', () => {
    if (running) throw new Error('Cancel the running queue before clearing it.');
    clearQueue();
  });
  window.addEventListener('pagehide', clearQueue);
  for (const mime of ['png', 'jpeg'])
    action(`ll-thumbnail-${mime}`, async () => {
      requireProject();
      downloadBlob(
        `limelight-frame.${mime === 'jpeg' ? 'jpg' : 'png'}`,
        await h.thumbnail(`image/${mime}`),
      );
    });
  $('ll-guides').addEventListener('change', () => {
    $('ll-safe-guide').hidden = !$('ll-guides').checked;
  });
  mountTimelineView(
    root,
    (id) => [
      0,
      h.duration(),
      h.time(),
      ...h.editor.captions.filter((c) => c.id !== id).flatMap((c) => [c.start, c.end]),
      ...h.editor.clips.reduce<number[]>(
        (all, c) => [...all, (all.at(-1) ?? 0) + c.out - c.in],
        [],
      ),
    ],
    () => h.time() / Math.max(0.001, h.duration()),
  );

  function decorateCue(row: HTMLElement, cue: Cue) {
    const panel = document.createElement('div');
    panel.className = 'll-cue-timing';
    for (const key of ['start', 'end'] as const) {
      const label = document.createElement('label');
      label.textContent = `${key === 'start' ? 'Start' : 'End'} seconds `;
      const input = document.createElement('input');
      input.className = 'field';
      input.type = 'number';
      input.min = '0';
      input.max = String(h.duration());
      input.step = '.01';
      input.value = String(Number(cue[key].toFixed(3)));
      input.setAttribute(
        'aria-label',
        `${key === 'start' ? 'Start' : 'End'} of subtitle ${cue.text}`,
      );
      input.onchange = () => {
        const value = Number(input.value),
          start = key === 'start' ? value : cue.start,
          end = key === 'end' ? value : cue.end;
        if (!Number.isFinite(value) || start < 0 || end > h.duration() || end - start < 0.05) {
          status('Keep subtitle times inside the recording, with the end after the start.');
          input.value = String(cue[key]);
          return;
        }
        h.editor.captions = sortCues(
          h.editor.captions.map((c) => (c.id === cue.id ? { ...c, start, end } : c)),
        );
        change('subtitle-timing');
      };
      label.append(input);
      panel.append(label);
    }
    const split = document.createElement('button');
    split.className = 'btn btn--sm';
    split.textContent = 'Split at playhead';
    split.onclick = () => {
      if (h.time() - cue.start < 0.1 || cue.end - h.time() < 0.1) {
        status('Place the playhead inside this subtitle, at least 0.1 seconds from either end.');
        return;
      }
      h.editor.captions = splitCue(h.editor.captions, cue.id, h.time(), () => createId('cue'));
      change('split-subtitle');
    };
    panel.append(split);
    row.append(panel);
  }
  function refresh() {
    markMatches();
    const overlaps = overlappingCues(h.editor.captions);
    $('ll-cue-overlaps').textContent = overlaps.size
      ? `${overlaps.size} subtitle lines overlap. Review their start and end times.`
      : 'No overlapping subtitle lines.';
    const style = captionStyle(h.editor.settings.captionStyle);
    for (const key of styleKeys) $(`ll-style-${key}`).value = String(style[key]);
  }
  refresh();
  return {
    refresh,
    decorateCue,
    showSilences,
    previewGap: h.previewSpan,
    refreshCheckpoints: () => listCheckpoints().catch((e) => status(String(e))),
  };
}
