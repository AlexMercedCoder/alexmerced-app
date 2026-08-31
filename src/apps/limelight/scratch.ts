import { Collection } from '../../lib/idb';

/**
 * Writing a recording down while it is still being made.
 *
 * MediaRecorder hands over a chunk roughly every second, and those chunks used
 * to sit in an array until somebody pressed stop. A tab crash, an out of memory
 * kill, or a laptop lid closing took the whole recording with it, which is the
 * worst thing this app can do to a person: the one artefact they cannot make
 * again by trying harder.
 *
 * Chunks are now written as they arrive. Blobs go into IndexedDB directly, so
 * the browser is free to keep them on disk rather than in the tab's memory,
 * which is also why this helps the memory ceiling rather than adding to it.
 */

export type ScratchKind = 'screen' | 'camera';

export type ScratchChunk = {
  /** `${session}:${kind}:${seq}` so ordering is recoverable from the key alone. */
  id: string;
  session: string;
  kind: ScratchKind;
  seq: number;
  blob: Blob;
};

export type ScratchSession = {
  id: string;
  startedAt: string;
  mime: string;
  /** Set on stop. An unfinished session is one that never got these. */
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  finished?: boolean;
};

export class Scratch {
  constructor(
    private readonly chunks: Collection<ScratchChunk>,
    private readonly sessions: Collection<ScratchSession>,
  ) {}

  async begin(session: ScratchSession): Promise<void> {
    await this.sessions.put(session);
  }

  /**
   * Keeps one chunk.
   *
   * Deliberately not awaited by the caller during a recording: a slow write
   * must not stall the recorder or drop the next chunk. Failures are swallowed
   * here for the same reason, because a recording that keeps going with no
   * safety net still beats one that stops.
   */
  async append(session: string, kind: ScratchKind, seq: number, blob: Blob): Promise<void> {
    await this.chunks.put({ id: `${session}:${kind}:${seq}`, session, kind, seq, blob });
  }

  async finish(session: string, detail: Partial<ScratchSession>): Promise<void> {
    const all = await this.sessions.all();
    const found = all.find((entry) => entry.id === session);
    if (found) await this.sessions.put({ ...found, ...detail, finished: true });
  }

  /** Sessions that were never finished, newest first. */
  async unfinished(): Promise<ScratchSession[]> {
    const all = await this.sessions.all();
    return all
      .filter((entry) => !entry.finished)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Puts the chunks of a session back together.
   *
   * Order comes from the sequence number rather than from the store's key
   * order, because a string key sorts "10" before "2" and a recording
   * reassembled in that order is unplayable.
   */
  async assemble(session: string, kind: ScratchKind, mime: string): Promise<Blob | null> {
    const all = await this.chunks.all();
    const mine = all
      .filter((chunk) => chunk.session === session && chunk.kind === kind)
      .sort((a, b) => a.seq - b.seq);
    if (mine.length === 0) return null;
    return new Blob(mine.map((chunk) => chunk.blob), { type: mime });
  }

  async discard(session: string): Promise<void> {
    const all = await this.chunks.all();
    for (const chunk of all) {
      if (chunk.session === session) await this.chunks.delete(chunk.id);
    }
    await this.sessions.delete(session);
  }

  /** Throws away everything, for when storage is tight or a recording is kept. */
  async discardAll(): Promise<void> {
    for (const session of await this.sessions.all()) await this.discard(session.id);
  }

  async bytes(): Promise<number> {
    const all = await this.chunks.all();
    return all.reduce((total, chunk) => total + chunk.blob.size, 0);
  }
}
