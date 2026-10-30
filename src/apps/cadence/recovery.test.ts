import { beforeEach, describe, expect, it } from 'vitest';
import { appendRecordingChunk, clearAll, discardRecordingSession, loadRecordingSessions, recordingBlob, startRecordingSession, type RecordingSession } from './store';

const session = (): RecordingSession => ({ id: crypto.randomUUID(), name: 'Take', mime: 'audio/webm', startedAt: new Date().toISOString(), state: 'recording', chunkCount: 0, bytes: 0 });

beforeEach(async () => { await clearAll(); });

describe('incremental recording recovery', () => {
  it('commits chunks independently and rebuilds their original order', async () => {
    const item = session();
    await startRecordingSession(item);
    await appendRecordingChunk(item, Uint8Array.from([1, 2]));
    await appendRecordingChunk(item, Uint8Array.from([3, 4]));
    const saved = (await loadRecordingSessions())[0];
    expect(saved.bytes).toBe(4);
    expect(Array.from(new Uint8Array(await (await recordingBlob(saved)).arrayBuffer()))).toEqual([1, 2, 3, 4]);
    await discardRecordingSession(item.id);
    expect(await loadRecordingSessions()).toEqual([]);
  });

  it('retains a session without a final stop event for recovery', async () => {
    const item = session();
    await startRecordingSession(item);
    await appendRecordingChunk(item, Uint8Array.from([9]));
    expect((await loadRecordingSessions())[0].state).toBe('recording');
    expect((await recordingBlob(item)).size).toBe(1);
  });
});
