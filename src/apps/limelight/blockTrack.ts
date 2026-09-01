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
  /** Double click, which opens rather than deletes. */
  onOpen?: (block: T) => void;
  onContextMenu?: (event: MouseEvent, block: T) => void;
};

export type TrackHandle = {
  /** Rebuilds every bar. For after the blocks change. */
  render: () => void;
  /** Moves the existing bars without rebuilding them. For during a drag. */
  reposition: () => void;
};

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
  let drag: { id: string; edge: TrackEdge; from: number; start: number; end: number } | null = null;

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

  return { render, reposition };
}
