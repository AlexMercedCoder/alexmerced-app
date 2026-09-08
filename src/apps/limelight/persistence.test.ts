import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, readTakeRecords } from './persistence';

afterEach(() => vi.useRealTimers());

describe('project autosave', () => {
  it('debounces edits without dropping a different project on navigation', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_value: string) => {});
    const save = createAutosave(write, vi.fn());
    save.queue('a', async () => 'old a');
    save.queue('a', async () => 'new a');
    save.queue('b', async () => 'b');
    await vi.advanceTimersByTimeAsync(600);
    await save.flush();
    expect(write.mock.calls).toEqual([['new a'], ['b']]);
  });

  it('serializes asynchronous writes so an older save cannot finish last', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const delayed = new Promise<string>((resolve) => { release = () => resolve('old'); });
    const write = vi.fn(async (_value: string) => {});
    const save = createAutosave(write, vi.fn());
    save.queue('a', () => delayed);
    await vi.advanceTimersByTimeAsync(600);
    save.queue('a', async () => 'new');
    const flushed = save.flush();
    expect(write).not.toHaveBeenCalled();
    release();
    await flushed;
    expect(write.mock.calls).toEqual([['old'], ['new']]);
  });

  it('reports a failed save and still saves the next project', async () => {
    const error = new Error('Storage full');
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const report = vi.fn();
    const save = createAutosave(write, report);
    save.queue('a', async () => 'a');
    save.queue('b', async () => 'b');
    await save.flush();
    expect(report).toHaveBeenCalledWith(error);
    expect(write.mock.calls).toEqual([['a'], ['b']]);
  });

  it('cancels a pending save before deleting a project', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_value: string) => {});
    const save = createAutosave(write, vi.fn());
    save.queue('deleted', async () => 'must not reappear');
    save.queue('kept', async () => 'keep');
    await save.cancel('deleted');
    await save.flush();
    await vi.advanceTimersByTimeAsync(600);
    expect(write.mock.calls).toEqual([['keep']]);
  });

  it('refuses an unreadable active take instead of saving an incomplete reel', async () => {
    const blob = new Blob(['recording']);
    vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Unreadable take'));
    await expect(readTakeRecords(new Map([['second', { blob }]]), new Set(['second']), 'first', true))
      .rejects.toThrow('Unreadable take');
  });
});
