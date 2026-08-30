/**
 * Undo and redo for the editor.
 *
 * A snapshot stack rather than a list of reversible commands. An editor like
 * this has a few dozen ways to change things, and inventing an inverse for each
 * one is where undo bugs come from: a command you forget to invert leaves the
 * stack quietly lying about what the previous state was. Snapshots cannot get
 * that wrong, and the state here is small enough that copying it is free next
 * to the recording it describes.
 *
 * The one thing snapshots need is coalescing. Dragging a slider fires a change
 * per pixel, and an undo that stepped back through four hundred of those would
 * be useless. Consecutive edits carrying the same label inside a short window
 * fold into a single step.
 */

export type HistoryOptions = {
  /** How many steps to keep. Older ones fall off the bottom. */
  limit?: number;
  /** How long a repeat of the same label keeps folding into one step. */
  coalesceMs?: number;
};

export class History<T> {
  private readonly states: T[];
  private index = 0;
  private readonly limit: number;
  private readonly coalesceMs: number;
  private lastLabel = '';
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(initial: T, options: HistoryOptions = {}) {
    this.states = [clone(initial)];
    this.limit = Math.max(2, options.limit ?? 60);
    this.coalesceMs = Math.max(0, options.coalesceMs ?? 700);
  }

  get present(): T {
    return clone(this.states[this.index]);
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.states.length - 1;
  }

  /** How many steps are held, for tests and for a status line. */
  get length(): number {
    return this.states.length;
  }

  /**
   * Records a new state.
   *
   * A label folds this into the step before it when that step carried the same
   * label recently, which is what turns a drag into one undo rather than
   * hundreds. An empty label never folds.
   */
  push(next: T, label = '', now = Date.now()): void {
    const folding = label !== '' && label === this.lastLabel && now - this.lastAt <= this.coalesceMs;
    this.lastLabel = label;
    this.lastAt = now;

    if (folding && this.index === this.states.length - 1) {
      this.states[this.index] = clone(next);
      return;
    }

    // Anything ahead of here was a future that has now been overwritten.
    this.states.length = this.index + 1;
    this.states.push(clone(next));
    this.index += 1;

    if (this.states.length > this.limit) {
      this.states.shift();
      this.index -= 1;
    }
  }

  undo(): T | null {
    if (!this.canUndo) return null;
    this.index -= 1;
    // A step taken deliberately ends any folding, so editing again after an
    // undo does not merge into the step that was just restored.
    this.lastLabel = '';
    return this.present;
  }

  redo(): T | null {
    if (!this.canRedo) return null;
    this.index += 1;
    this.lastLabel = '';
    return this.present;
  }

  /** Starts again from a given state, throwing away everything held. */
  reset(state: T): void {
    this.states.length = 0;
    this.states.push(clone(state));
    this.index = 0;
    this.lastLabel = '';
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}

/**
 * A deep copy that leaves typed arrays alone.
 *
 * A structured clone would copy the bytes of a background picture on every
 * keystroke. Those bytes are never modified in place, so sharing the reference
 * is both correct and the difference between a snapshot costing nothing and
 * costing a megabyte.
 */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as unknown as T;

  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = clone(entry);
  }
  return copy as T;
}
