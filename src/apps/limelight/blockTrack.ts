/**
 * One timeline track, for any kind of block.
 *
 * Zoom, speed, hide, shapes and text were five copies of the same two hundred
 * lines: draw a bar per block, grips at each end, drag to move or resize,
 * select on press, rebuild on release. Copies drift, and this session proved
 * it. The unguarded setPointerCapture that silently ate a gesture existed in
 * five places; the full rebuild on every pointermove existed in five places
 * and was fixed in two. Every future fix would have had the same problem.
 *
 * What differs between the tracks is small and passed in: what a bar says, how
 * far a block may be dragged, and what to do once it has been.
 */

export type Block = { id: string; start: number; end: number };

export type TrackEdge = 'start' | 'end' | 'move';

export type TrackOptions<T extends Block> = {
  element: HTMLDivElement;
  /** The blocks, read fresh on every render so the caller stays the owner. */
  blocks: () => T[];
  /** Hands back the edited list. The caller decides what to keep. */
  onChange: (blocks: T[]) => void;
  /** The whole recording's length, for turning pixels into seconds. */
  duration: () => number;
  /** Which block is selected, if any. */
  selected: () => string | null;
  onSelect: (id: string, block: T) => void;
  /** Settles overlaps and limits after a drag. Defaults to leaving them alone. */
  constrain?: (blocks: T[], id: string) => T[];
  /** What the bar says. */
  label: (block: T) => string;
  /** The bar's tooltip. */
  title?: (block: T) => string;
  /** Extra classes for a bar, for the per-track colours. */
  barClass?: (block: T) => string;
  /** Called when a drag finishes, for persisting and redrawing. */
  onCommit: () => void;
  /**
   * What a bar is called when it is read out rather than looked at.
   *
   * A bar says "1.8x" and sits at a position that means something only if you
   * can see where it is. Read aloud it has to carry both.
   */
  describe?: (block: T) => string;
  /** How far the arrow keys move a block, in seconds. */
  nudge?: { small: number; large: number };
  /** Double click, which opens rather than deletes. */
  onOpen?: (block: T) => void;
  onContextMenu?: (event: MouseEvent, block: T) => void;
};

export type TrackHandle = {
  /** Rebuilds every bar. For after the blocks change. */
  render: () => void;
  /** Moves the existing bars without rebuilding them. For during a drag. */
  reposition: () => void;
  /** Puts the keyboard on one block, for after it has been added. */
  focus: (id: string) => void;
};

/**
 * What a key press does to the block that has the keyboard.
 *
 * Pure, and separate from the DOM, because this is the part with a right
 * answer. The scheme: left and right move the whole block, up and down change
 * how long it is, Alt does the same to the start edge instead, and Shift makes
 * every one of those ten times bigger.
 */
export function keyEdit(
  key: string,
  modifiers: { shift?: boolean; alt?: boolean },
  nudge: { small: number; large: number },
): { edge: TrackEdge; shift: number } | null {
  const size = modifiers.shift ? nudge.large : nudge.small;
  const edge: TrackEdge = modifiers.alt ? 'start' : 'move';
  switch (key) {
    case 'ArrowLeft': return { edge, shift: -size };
    case 'ArrowRight': return { edge, shift: size };
    // Up and down always work on the end, since Alt already means the start
    // and a block cannot be lengthened from both ends at once.
    case 'ArrowUp': return { edge: 'end', shift: size };
    case 'ArrowDown': return { edge: 'end', shift: -size };
    default: return null;
  }
}

/**
 * Applies a drag to one block.
 *
 * Exported and pure, because this is the arithmetic worth testing: everything
 * around it is DOM.
 */
export function applyDrag<T extends Block>(
  blocks: T[], id: string, edge: TrackEdge, shift: number,
  origin: { start: number; end: number },
): T[] {
  return blocks.map((block) => {
    if (block.id !== id) return block;
    if (edge === 'move') {
      const width = origin.end - origin.start;
      return { ...block, start: origin.start + shift, end: origin.start + shift + width };
    }
    if (edge === 'start') return { ...block, start: origin.start + shift };
    return { ...block, end: origin.end + shift };
  });
}

export function mountBlockTrack<T extends Block>(options: TrackOptions<T>): TrackHandle {
  const { element } = options;
  const nudge = options.nudge ?? { small: 0.1, large: 1 };
  let drag: { id: string; edge: TrackEdge; from: number; start: number; end: number } | null = null;

  // The track itself takes the keyboard when the block that had it is deleted,
  // so focus lands somewhere related rather than back at the top of the page.
  element.tabIndex = -1;

  function focus(id: string): void {
    const bar = element.querySelector<HTMLDivElement>(`.ll-zoom[data-id="${CSS.escape(id)}"]`);
    if (bar && document.activeElement !== bar) bar.focus();
  }

  const timeAt = (event: PointerEvent): number => {
    const box = element.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * options.duration();
  };

  function begin(event: PointerEvent, block: T, edge: TrackEdge): void {
    drag = { id: block.id, edge, from: timeAt(event), start: block.start, end: block.end };
    // Capture is a convenience, and throws once the pointer has gone. Left
    // unguarded it aborts the handler and the whole gesture is silently lost.
    try { element.setPointerCapture(event.pointerId); } catch { /* the drag still tracks */ }
    // No render here: onSelect leads back to the caller's own render, and doing
    // it twice replaces the bar under the pointer for no reason.
    options.onSelect(block.id, block);
  }

  function render(): void {
    const duration = Math.max(0.001, options.duration());
    // Every bar is about to be thrown away. If one of them has the keyboard,
    // the browser hands focus back to the body, which is a long way from here.
    const had = element.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>('.ll-zoom')?.dataset.id ?? null
      : null;
    element.innerHTML = '';

    for (const block of options.blocks()) {
      const bar = document.createElement('div');
      bar.className = `ll-zoom${options.barClass ? ` ${options.barClass(block)}` : ''}`;
      bar.style.left = `${(block.start / duration) * 100}%`;
      bar.style.width = `${((block.end - block.start) / duration) * 100}%`;
      bar.dataset.id = block.id;
      if (options.title) bar.title = options.title(block);

      const label = document.createElement('span');
      label.className = 'll-zoom__label';
      label.textContent = options.label(block);
      bar.append(label);

      for (const edge of ['start', 'end'] as const) {
        const grip = document.createElement('button');
        grip.type = 'button';
        grip.className = `ll-zoom__grip ll-zoom__grip--${edge}`;
        grip.setAttribute('aria-label', `Move the ${edge} of this block`);
        grip.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
          begin(event, block, edge);
        });
        bar.append(grip);
      }

      // A div with a pointer handler is invisible to the keyboard, and this is
      // the only way to reach a block: every edit here, including the Delete
      // the shortcut list promises, needed a mouse first.
      bar.tabIndex = 0;
      bar.setAttribute('role', 'button');
      bar.setAttribute('aria-label', options.describe
        ? options.describe(block)
        : options.title?.(block) ?? options.label(block));

      bar.addEventListener('focus', () => {
        // Reaching a block with Tab selects it, so the panel below shows the
        // one you are on and Delete has something to act on.
        if (options.selected() === block.id) return;
        options.onSelect(block.id, block);
        // onSelect leads back to the caller's render, which replaces this very
        // element. Without this the focus falls to the body mid-Tab.
        focus(block.id);
      });

      bar.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey) return;
        const edit = keyEdit(event.key, { shift: event.shiftKey, alt: event.altKey }, nudge);
        if (edit) {
          // The arrows step the playhead everywhere else on the page, and the
          // handler for that listens on the window.
          event.preventDefault();
          event.stopPropagation();
          const current = options.blocks().find((entry) => entry.id === block.id);
          if (!current) return;
          const moved = applyDrag(
            options.blocks(), block.id, edit.edge, edit.shift,
            { start: current.start, end: current.end },
          );
          options.onChange(options.constrain ? options.constrain(moved, block.id) : moved);
          render();
          options.onCommit();
          focus(block.id);
          return;
        }
        if (event.key === 'Enter' && options.onOpen) {
          event.preventDefault();
          event.stopPropagation();
          options.onOpen(block);
        }
        // Delete is deliberately left alone: it belongs to the window handler,
        // which removes whatever is selected, and focus has just selected this.
      });

      bar.addEventListener('pointerdown', (event) => begin(event, block, 'move'));
      if (options.onOpen) bar.addEventListener('dblclick', () => options.onOpen!(block));
      if (options.onContextMenu) {
        bar.addEventListener('contextmenu', (event) => options.onContextMenu!(event, block));
      }
      element.append(bar);
    }

    const selected = options.selected();
    for (const bar of element.querySelectorAll<HTMLDivElement>('.ll-zoom')) {
      bar.classList.toggle('is-selected', bar.dataset.id === selected);
    }

    if (had) {
      const again = element.querySelector<HTMLDivElement>(`.ll-zoom[data-id="${CSS.escape(had)}"]`);
      // The block it was on may have just been deleted, in which case the track
      // takes the keyboard rather than losing it.
      (again ?? element).focus();
    }
  }

  /**
   * Moves the bars that exist rather than making new ones.
   *
   * Rebuilding on every pointermove discarded and recreated every bar, its
   * label, two grips and four listeners at pointer rate. A block squeezed out
   * of existence by its neighbour loses its bar here, since leaving it would
   * point at nothing.
   */
  function reposition(): void {
    const duration = Math.max(0.001, options.duration());
    const byId = new Map(options.blocks().map((block) => [block.id, block]));
    for (const bar of element.querySelectorAll<HTMLDivElement>('.ll-zoom')) {
      const block = byId.get(bar.dataset.id ?? '');
      if (!block) { bar.remove(); continue; }
      bar.style.left = `${(block.start / duration) * 100}%`;
      bar.style.width = `${((block.end - block.start) / duration) * 100}%`;
      if (options.title) bar.title = options.title(block);
    }
  }

  element.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const shift = timeAt(event) - drag.from;
    const moved = applyDrag(options.blocks(), drag.id, drag.edge, shift, drag);
    options.onChange(options.constrain ? options.constrain(moved, drag.id) : moved);
    reposition();
  });

  for (const done of ['pointerup', 'pointercancel'] as const) {
    element.addEventListener(done, () => {
      if (!drag) return;
      drag = null;
      // The full rebuild happens once, now that the constraints have settled.
      render();
      options.onCommit();
    });
  }

  return { render, reposition, focus };
}
