import { beforeEach, describe, expect, it } from 'vitest';
import { Collection } from '../../lib/idb';
import { Scratch, type ScratchChunk, type ScratchSession } from './scratch';

/**
 * A Collection standing in for the real one.
 *
 * The IndexedDB helper is tested on its own; what matters here is the ordering
 * and assembly logic, which is where the interesting mistakes live.
 */
class FakeCollection<T extends { id: string }> {
  private readonly rows = new Map<string, T>();
  async all(): Promise<T[]> { return [...this.rows.values()]; }
  async put(record: T): Promise<T> { this.rows.set(record.id, record); return record; }
  async delete(id: string): Promise<void> { this.rows.delete(id); }
  async clear(): Promise<void> { this.rows.clear(); }
  async count(): Promise<number> { return this.rows.size; }
}

const asCollection = <T extends { id: string }>(fake: FakeCollection<T>) =>
  fake as unknown as Collection<T>;

let chunks: FakeCollection<ScratchChunk>;
let sessions: FakeCollection<ScratchSession>;
let scratch: Scratch;

beforeEach(() => {
  chunks = new FakeCollection<ScratchChunk>();
  sessions = new FakeCollection<ScratchSession>();
  scratch = new Scratch(asCollection(chunks), asCollection(sessions));
});

const session = (id: string, extra: Partial<ScratchSession> = {}): ScratchSession => ({
  id, startedAt: '2026-08-31T10:00:00.000Z', mime: 'video/webm', ...extra,
});

const piece = (text: string) => new Blob([text], { type: 'video/webm' });

async function textOf(blob: Blob | null): Promise<string> {
  return blob ? blob.text() : '';
}

describe('Scratch', () => {
  it('keeps chunks and puts them back in order', async () => {
    await scratch.begin(session('take1'));
    for (const [seq, text] of ['a', 'b', 'c'].entries()) {
      await scratch.append('take1', 'screen', seq, piece(text));
    }
    expect(await textOf(await scratch.assemble('take1', 'screen', 'video/webm'))).toBe('abc');
  });

  it('orders by sequence rather than by key, which sorts 10 before 2', async () => {
    // The keys are strings, so a naive sort puts take1:screen:10 before
    // take1:screen:2 and reassembles an unplayable file.
    await scratch.begin(session('take1'));
    const letters = 'abcdefghijkl'.split('');
    for (const [seq, text] of letters.entries()) {
      await scratch.append('take1', 'screen', seq, piece(text));
    }
    expect(await textOf(await scratch.assemble('take1', 'screen', 'video/webm'))).toBe(letters.join(''));
  });

  it('keeps the screen and the camera apart', async () => {
    await scratch.begin(session('take1'));
    await scratch.append('take1', 'screen', 0, piece('screen'));
    await scratch.append('take1', 'camera', 0, piece('camera'));
    expect(await textOf(await scratch.assemble('take1', 'screen', 'video/webm'))).toBe('screen');
    expect(await textOf(await scratch.assemble('take1', 'camera', 'video/webm'))).toBe('camera');
  });

  it('keeps sessions apart', async () => {
    await scratch.begin(session('take1'));
    await scratch.begin(session('take2'));
    await scratch.append('take1', 'screen', 0, piece('one'));
    await scratch.append('take2', 'screen', 0, piece('two'));
    expect(await textOf(await scratch.assemble('take1', 'screen', 'video/webm'))).toBe('one');
    expect(await textOf(await scratch.assemble('take2', 'screen', 'video/webm'))).toBe('two');
  });

  it('gives back nothing for a session with no chunks', async () => {
    await scratch.begin(session('empty'));
    expect(await scratch.assemble('empty', 'screen', 'video/webm')).toBeNull();
  });

  it('reports a session that was never finished', async () => {
    await scratch.begin(session('crashed'));
    await scratch.append('crashed', 'screen', 0, piece('x'));
    const orphans = await scratch.unfinished();
    expect(orphans.map((entry) => entry.id)).toEqual(['crashed']);
  });

  it('does not report one that finished properly', async () => {
    await scratch.begin(session('done'));
    await scratch.finish('done', { duration: 12 });
    expect(await scratch.unfinished()).toEqual([]);
  });

  it('puts the newest unfinished session first', async () => {
    await scratch.begin(session('old', { startedAt: '2026-08-30T09:00:00.000Z' }));
    await scratch.begin(session('new', { startedAt: '2026-08-31T09:00:00.000Z' }));
    expect((await scratch.unfinished()).map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('carries what was learned on stop onto the session', async () => {
    await scratch.begin(session('take1'));
    await scratch.finish('take1', { duration: 8.5, width: 1280, height: 720, hasAudio: true });
    const all = await sessions.all();
    expect(all[0]).toMatchObject({ duration: 8.5, width: 1280, height: 720, hasAudio: true, finished: true });
  });

  it('ignores a finish for a session it does not have', async () => {
    await expect(scratch.finish('ghost', { duration: 1 })).resolves.toBeUndefined();
  });

  it('discards one session without touching another', async () => {
    await scratch.begin(session('keep'));
    await scratch.begin(session('drop'));
    await scratch.append('keep', 'screen', 0, piece('keep'));
    await scratch.append('drop', 'screen', 0, piece('drop'));
    await scratch.discard('drop');
    expect(await scratch.assemble('drop', 'screen', 'video/webm')).toBeNull();
    expect(await textOf(await scratch.assemble('keep', 'screen', 'video/webm'))).toBe('keep');
    expect((await sessions.all()).map((entry) => entry.id)).toEqual(['keep']);
  });

  it('clears everything', async () => {
    await scratch.begin(session('a'));
    await scratch.begin(session('b'));
    await scratch.append('a', 'screen', 0, piece('a'));
    await scratch.append('b', 'screen', 0, piece('b'));
    await scratch.discardAll();
    expect(await chunks.count()).toBe(0);
    expect(await sessions.count()).toBe(0);
  });

  it('adds up what is being held', async () => {
    await scratch.begin(session('take1'));
    await scratch.append('take1', 'screen', 0, piece('12345'));
    await scratch.append('take1', 'screen', 1, piece('678'));
    expect(await scratch.bytes()).toBe(8);
  });
});
