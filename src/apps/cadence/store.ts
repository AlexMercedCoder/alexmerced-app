import { fromBase64, toBase64 } from '../../lib/bytes';
import { Collection, openDatabase } from '../../lib/idb';
import { createEnvelope, parseEnvelope, type ImportMode } from '../../lib/portable';
import { readPref, writePref } from '../../lib/prefs';
import {
  APP_ID, APP_VERSION, defaultSettings, reviveClip, reviveSettings, type Clip, type Settings,
} from './model';

const DB_NAME = 'cadence';
const DB_VERSION = 2;
const SETTINGS_KEY = 'cadence:settings';

let clips: Collection<Clip> | null = null;
let sessions: Collection<RecordingSession> | null = null;
let chunks: Collection<RecordingChunk> | null = null;

export type RecordingSession = { id: string; name: string; mime: string; startedAt: string; state: 'recording' | 'paused' | 'stopped'; chunkCount: number; bytes: number; markers?: { time: number; label: string }[] };
export type RecordingChunk = { id: string; sessionId: string; index: number; bytes: Uint8Array };

async function connect(): Promise<Collection<Clip>> {
  if (clips) return clips;
  const db = await openDatabase(DB_NAME, DB_VERSION, [
    { name: 'clips', keyPath: 'id' }, { name: 'recordingSessions', keyPath: 'id' }, { name: 'recordingChunks', keyPath: 'id' },
  ]);
  clips = new Collection<Clip>(db, 'clips');
  sessions = new Collection<RecordingSession>(db, 'recordingSessions');
  chunks = new Collection<RecordingChunk>(db, 'recordingChunks');
  return clips;
}

async function recordingStores() {
  await connect();
  return { sessions: sessions!, chunks: chunks! };
}

export async function startRecordingSession(session: RecordingSession): Promise<void> {
  const stores = await recordingStores();
  await stores.sessions.put(session);
}

/** Each small MediaRecorder timeslice is committed independently. */
export async function appendRecordingChunk(session: RecordingSession, bytes: Uint8Array): Promise<void> {
  const stores = await recordingStores();
  await stores.chunks.put({ id: `${session.id}:${session.chunkCount}`, sessionId: session.id, index: session.chunkCount, bytes });
  session.chunkCount += 1;
  session.bytes += bytes.length;
  await stores.sessions.put(session);
}

export async function updateRecordingSession(session: RecordingSession): Promise<void> {
  const stores = await recordingStores();
  await stores.sessions.put(session);
}

export async function loadRecordingSessions(): Promise<RecordingSession[]> {
  const stores = await recordingStores();
  return (await stores.sessions.all()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function recordingBlob(session: RecordingSession): Promise<Blob> {
  const stores = await recordingStores();
  const parts = (await stores.chunks.all()).filter((chunk) => chunk.sessionId === session.id).sort((a, b) => a.index - b.index);
  if (!parts.length || parts.some((part, i) => part.index !== i)) throw new Error('Some saved recording chunks are missing.');
  return new Blob(parts.map((part) => part.bytes as BlobPart), { type: session.mime });
}

export async function discardRecordingSession(id: string): Promise<void> {
  const stores = await recordingStores();
  const parts = (await stores.chunks.all()).filter((chunk) => chunk.sessionId === id);
  await stores.chunks.deleteMany(parts.map((part) => part.id));
  await stores.sessions.delete(id);
}

export function loadSettings(): Settings { return reviveSettings(readPref(SETTINGS_KEY, defaultSettings)); }
export function saveSettings(settings: Settings): void { writePref(SETTINGS_KEY, settings); }

export async function loadClips(): Promise<Clip[]> {
  const store = await connect();
  const list = (await store.all()).map(reviveClip).filter((clip): clip is Clip => clip !== null);
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveClip(clip: Clip): Promise<void> { await (await connect()).put(clip); }
export async function deleteClip(id: string): Promise<void> { await (await connect()).delete(id); }
export async function clearAll(): Promise<void> {
  const stores = await recordingStores();
  await Promise.all([(await connect()).clear(), stores.sessions.clear(), stores.chunks.clear()]);
}

export async function storedBytes(): Promise<number> {
  return (await loadClips()).reduce((sum, clip) => sum + clip.bytes.length, 0);
}

/** The clip as it travels in an export: bytes become base64 so it fits in JSON. */
type PortableClip = Omit<Clip, 'bytes' | 'originalBytes'> & { bytes: string; originalBytes?: string };

export type CadenceExport = { clips: PortableClip[]; settings: Settings };

export function toPortable(clip: Clip): PortableClip {
  return { ...clip, bytes: toBase64(clip.bytes), originalBytes: clip.originalBytes ? toBase64(clip.originalBytes) : undefined };
}

export function fromPortable(value: unknown): Clip | null {
  if (typeof value !== 'object' || value === null) return null;
  const portable = value as Partial<PortableClip>;
  if (typeof portable.bytes !== 'string') return null;
  try {
    return reviveClip({ ...portable, bytes: fromBase64(portable.bytes), originalBytes: portable.originalBytes ? fromBase64(portable.originalBytes) : undefined });
  } catch {
    // A payload that is not valid base64 means one broken clip, not a failed import.
    return null;
  }
}

export async function buildExport(now: Date = new Date()) {
  const list = await loadClips();
  return createEnvelope<CadenceExport>(
    APP_ID, APP_VERSION,
    { clips: list.map(toPortable), settings: loadSettings() },
    { clips: list.length },
    now,
  );
}

export async function applyImport(text: string, mode: ImportMode): Promise<number> {
  const envelope = parseEnvelope<CadenceExport>(text, APP_ID);
  const incoming = (Array.isArray(envelope.data.clips) ? envelope.data.clips : [])
    .map(fromPortable)
    .filter((clip): clip is Clip => clip !== null);
  if (!incoming.length) throw new Error('That export contains no readable audio.');

  if (envelope.data.settings) saveSettings(reviveSettings(envelope.data.settings));

  const store = await connect();
  if (mode === 'replace') {
    await store.replaceAll(incoming);
    return incoming.length;
  }

  // Clips are never edited in place, so an id collision means the same clip.
  const current = await loadClips();
  const byId = new Map(current.map((clip) => [clip.id, clip]));
  for (const clip of incoming) if (!byId.has(clip.id)) byId.set(clip.id, clip);
  const merged = [...byId.values()];
  await store.replaceAll(merged);
  return merged.length;
}
