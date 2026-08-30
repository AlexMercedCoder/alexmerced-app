import { describe, expect, it } from 'vitest';
import { History } from './history';

type State = { value: number; nested?: { list: number[] } };

describe('History', () => {
  it('starts with nowhere to go', () => {
    const history = new History<State>({ value: 1 });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it('steps back and forward through what was recorded', () => {
    const history = new History<State>({ value: 1 });
    history.push({ value: 2 });
    history.push({ value: 3 });

    expect(history.present.value).toBe(3);
    expect(history.undo()?.value).toBe(2);
    expect(history.undo()?.value).toBe(1);
    expect(history.canUndo).toBe(false);
    expect(history.redo()?.value).toBe(2);
    expect(history.redo()?.value).toBe(3);
    expect(history.canRedo).toBe(false);
  });

  it('drops the future once a new edit is made', () => {
    const history = new History<State>({ value: 1 });
    history.push({ value: 2 });
    history.push({ value: 3 });
    history.undo();
    history.push({ value: 9 });

    expect(history.canRedo).toBe(false);
    expect(history.present.value).toBe(9);
    expect(history.undo()?.value).toBe(2);
  });

  it('folds a run of edits carrying the same label into one step', () => {
    const history = new History<State>({ value: 0 }, { coalesceMs: 500 });
    for (let step = 1; step <= 50; step += 1) {
      history.push({ value: step }, 'slider:padding', 1000 + step * 5);
    }
    expect(history.length).toBe(2);
    expect(history.present.value).toBe(50);
    expect(history.undo()?.value).toBe(0);
  });

  it('starts a new step once the run pauses', () => {
    const history = new History<State>({ value: 0 }, { coalesceMs: 500 });
    history.push({ value: 1 }, 'drag', 1000);
    history.push({ value: 2 }, 'drag', 1200);
    history.push({ value: 3 }, 'drag', 5000);

    expect(history.length).toBe(3);
    expect(history.undo()?.value).toBe(2);
  });

  it('starts a new step when the label changes', () => {
    const history = new History<State>({ value: 0 });
    history.push({ value: 1 }, 'padding', 1000);
    history.push({ value: 2 }, 'radius', 1010);
    expect(history.length).toBe(3);
  });

  it('never folds an unlabelled edit', () => {
    const history = new History<State>({ value: 0 });
    history.push({ value: 1 }, '', 1000);
    history.push({ value: 2 }, '', 1001);
    expect(history.length).toBe(3);
  });

  it('does not fold an edit into a step that was just undone to', () => {
    const history = new History<State>({ value: 0 }, { coalesceMs: 10_000 });
    history.push({ value: 1 }, 'drag', 1000);
    history.undo();
    history.push({ value: 5 }, 'drag', 1010);

    // The undone state has to survive as something to come back to.
    expect(history.undo()?.value).toBe(0);
  });

  it('forgets the oldest steps rather than growing without limit', () => {
    const history = new History<State>({ value: 0 }, { limit: 4 });
    for (let step = 1; step <= 10; step += 1) history.push({ value: step });

    expect(history.length).toBe(4);
    expect(history.present.value).toBe(10);
    history.undo(); history.undo(); history.undo();
    expect(history.canUndo).toBe(false);
    expect(history.present.value).toBe(7);
  });

  it('keeps a limit of at least two, so undo always means something', () => {
    const history = new History<State>({ value: 0 }, { limit: 0 });
    history.push({ value: 1 });
    expect(history.canUndo).toBe(true);
  });

  it('hands out copies, so a caller cannot edit the past by accident', () => {
    const history = new History<State>({ value: 1, nested: { list: [1, 2] } });
    const taken = history.present;
    taken.value = 99;
    taken.nested!.list.push(3);

    expect(history.present.value).toBe(1);
    expect(history.present.nested!.list).toEqual([1, 2]);
  });

  it('does not keep a reference to what it was handed', () => {
    const state: State = { value: 1, nested: { list: [1] } };
    const history = new History<State>(state);
    state.nested!.list.push(2);
    expect(history.present.nested!.list).toEqual([1]);
  });

  it('shares typed arrays rather than copying them', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const history = new History<{ bytes: Uint8Array }>({ bytes });
    expect(history.present.bytes).toBe(bytes);
  });

  it('starts over on reset', () => {
    const history = new History<State>({ value: 1 });
    history.push({ value: 2 });
    history.reset({ value: 7 });

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.present.value).toBe(7);
    expect(history.length).toBe(1);
  });

  it('survives values that are not objects', () => {
    const history = new History<number>(1);
    history.push(2);
    expect(history.undo()).toBe(1);
    expect(history.redo()).toBe(2);
  });
});
