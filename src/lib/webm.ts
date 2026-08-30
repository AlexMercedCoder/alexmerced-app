/**
 * A WebM (Matroska) muxer.
 *
 * WebCodecs will encode frames but hands back bare chunks with no container
 * around them, and the browser offers no way to write one. This puts the chunks
 * into a file that a player will accept.
 *
 * Matroska is EBML: every element is an identifier, a length, and a payload,
 * nested arbitrarily. That regularity is the whole reason it can be written by
 * hand in a few hundred lines.
 */

// Element identifiers, written as their full big-endian byte sequence.
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,

  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,

  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Language: 0x22b59c,

  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,

  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,

  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,

  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

/** One millisecond per tick, which is what every WebM in the wild uses. */
export const TIMESTAMP_SCALE = 1_000_000;

export type WebmTrack =
  | {
      kind: 'video';
      codec: 'V_VP8' | 'V_VP9' | 'V_AV1';
      width: number;
      height: number;
      /** Nanoseconds per frame, when the rate is fixed. */
      frameDuration?: number;
      codecPrivate?: Uint8Array;
    }
  | {
      kind: 'audio';
      codec: 'A_OPUS' | 'A_VORBIS';
      sampleRate: number;
      channels: number;
      codecPrivate?: Uint8Array;
    };

export type WebmSample = {
  track: number;
  /** Microseconds from the start, as WebCodecs reports them. */
  timestamp: number;
  data: Uint8Array;
  keyframe: boolean;
};

// --------------------------------------------------------------------- writing

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = id;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.from(bytes.length ? bytes : [0]);
}

/**
 * EBML's variable-length integer: a leading marker bit says how many bytes
 * follow, and the value fills the rest.
 */
export function encodeLength(value: number, minimumBytes = 0): Uint8Array {
  if (value < 0) throw new Error('An EBML length cannot be negative.');

  let width = 1;
  // Each width can hold 7 fewer bits than 8 times its size, because of the marker.
  while (width < 8 && value >= 2 ** (7 * width) - 1) width += 1;
  if (width < minimumBytes) width = minimumBytes;
  if (width > 8) throw new Error('That length is too large for EBML.');

  const bytes = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  // Set the marker bit for the chosen width.
  bytes[0] |= 1 << (8 - width);
  return bytes;
}

/** The reserved "unknown length" marker, used for a live-written segment. */
export function unknownLength(width = 8): Uint8Array {
  const bytes = new Uint8Array(width).fill(0xff);
  bytes[0] = (1 << (8 - width)) | ((1 << (8 - width)) - 1);
  return bytes;
}

export function encodeUnsigned(value: number): Uint8Array {
  if (value === 0) return Uint8Array.from([0]);
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Uint8Array.from(bytes);
}

export function encodeFloat(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

export function encodeString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function element(id: number, payload: Uint8Array): Uint8Array {
  const head = idBytes(id);
  const length = encodeLength(payload.length);
  const out = new Uint8Array(head.length + length.length + payload.length);
  out.set(head, 0);
  out.set(length, head.length);
  out.set(payload, head.length + length.length);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A SimpleBlock: the track number, a signed 16-bit offset from the cluster's
 * timestamp, a flags byte, then the frame.
 */
export function simpleBlock(track: number, relativeMs: number, keyframe: boolean, data: Uint8Array): Uint8Array {
  if (relativeMs < -32768 || relativeMs > 32767) {
    throw new Error('That frame is too far from its cluster to address.');
  }
  const number = encodeLength(track);
  const payload = new Uint8Array(number.length + 3 + data.length);
  payload.set(number, 0);
  const view = new DataView(payload.buffer);
  view.setInt16(number.length, Math.round(relativeMs), false);
  payload[number.length + 2] = keyframe ? 0x80 : 0x00;
  payload.set(data, number.length + 3);
  return element(ID.SimpleBlock, payload);
}

function trackEntry(track: WebmTrack, number: number): Uint8Array {
  const parts: Uint8Array[] = [
    element(ID.TrackNumber, encodeUnsigned(number)),
    element(ID.TrackUID, encodeUnsigned(number)),
    element(ID.FlagLacing, encodeUnsigned(0)),
    element(ID.Language, encodeString('und')),
    element(ID.CodecID, encodeString(track.codec)),
    element(ID.TrackType, encodeUnsigned(track.kind === 'video' ? 1 : 2)),
  ];

  if (track.codecPrivate?.length) parts.push(element(ID.CodecPrivate, track.codecPrivate));

  if (track.kind === 'video') {
    if (track.frameDuration) parts.push(element(ID.DefaultDuration, encodeUnsigned(Math.round(track.frameDuration))));
    parts.push(element(ID.Video, concat([
      element(ID.PixelWidth, encodeUnsigned(track.width)),
      element(ID.PixelHeight, encodeUnsigned(track.height)),
      element(ID.DisplayWidth, encodeUnsigned(track.width)),
      element(ID.DisplayHeight, encodeUnsigned(track.height)),
    ])));
  } else {
    parts.push(element(ID.Audio, concat([
      element(ID.SamplingFrequency, encodeFloat(track.sampleRate)),
      element(ID.Channels, encodeUnsigned(track.channels)),
      element(ID.BitDepth, encodeUnsigned(32)),
    ])));
  }

  return element(ID.TrackEntry, concat(parts));
}

/** How long a cluster may run before a new one has to start, in milliseconds. */
const CLUSTER_MS = 5000;

export type MuxOptions = { tracks: WebmTrack[]; writingApp?: string };

/**
 * Builds the finished file.
 *
 * Everything is held in memory and written at the end, so the segment can carry
 * a real length and a cue index. That is what lets a player seek instead of
 * scanning the whole file.
 */
export function muxWebm(options: MuxOptions, samples: WebmSample[]): Uint8Array {
  if (options.tracks.length === 0) throw new Error('A WebM file needs at least one track.');

  const header = element(ID.EBML, concat([
    element(ID.EBMLVersion, encodeUnsigned(1)),
    element(ID.EBMLReadVersion, encodeUnsigned(1)),
    element(ID.EBMLMaxIDLength, encodeUnsigned(4)),
    element(ID.EBMLMaxSizeLength, encodeUnsigned(8)),
    element(ID.DocType, encodeString('webm')),
    element(ID.DocTypeVersion, encodeUnsigned(2)),
    element(ID.DocTypeReadVersion, encodeUnsigned(2)),
  ]));

  // Sort by time so clusters come out in order, keeping the original order
  // within a timestamp so a video and audio frame at the same moment stay put.
  const ordered = samples
    .map((sample, index) => ({ sample, index }))
    .sort((a, b) => a.sample.timestamp - b.sample.timestamp || a.index - b.index)
    .map((entry) => entry.sample);

  const lastTimestamp = ordered.length ? ordered[ordered.length - 1].timestamp : 0;
  const durationMs = lastTimestamp / 1000;

  const info = element(ID.Info, concat([
    element(ID.TimestampScale, encodeUnsigned(TIMESTAMP_SCALE)),
    element(ID.MuxingApp, encodeString(options.writingApp ?? 'alexmerced.app')),
    element(ID.WritingApp, encodeString(options.writingApp ?? 'alexmerced.app')),
    element(ID.Duration, encodeFloat(Math.max(0, durationMs))),
  ]));

  const tracks = element(ID.Tracks, concat(
    options.tracks.map((track, index) => trackEntry(track, index + 1)),
  ));

  // ------------------------------------------------------------- clusters
  const clusters: Uint8Array[] = [];
  const cues: { time: number; position: number }[] = [];
  // Positions in a cue are relative to the start of the segment's payload.
  let position = info.length + tracks.length;

  let index = 0;
  while (index < ordered.length) {
    const startMs = Math.round(ordered[index].timestamp / 1000);
    const blocks: Uint8Array[] = [];
    let firstKeyframe = -1;

    while (index < ordered.length) {
      const sample = ordered[index];
      const relative = Math.round(sample.timestamp / 1000) - startMs;
      // A new cluster starts on a keyframe once the current one is long enough,
      // and always before the relative offset could overflow its signed field.
      if (blocks.length > 0 && (relative > 32000 || (relative >= CLUSTER_MS && sample.keyframe))) break;

      if (sample.keyframe && firstKeyframe === -1 && sample.track === 1) firstKeyframe = startMs + relative;
      blocks.push(simpleBlock(sample.track, relative, sample.keyframe, sample.data));
      index += 1;
    }

    const cluster = element(ID.Cluster, concat([
      element(ID.Timestamp, encodeUnsigned(startMs)),
      ...blocks,
    ]));
    if (firstKeyframe >= 0) cues.push({ time: firstKeyframe, position });
    clusters.push(cluster);
    position += cluster.length;
  }

  const cuesElement = cues.length
    ? element(ID.Cues, concat(cues.map((cue) => element(ID.CuePoint, concat([
        element(ID.CueTime, encodeUnsigned(cue.time)),
        element(ID.CueTrackPositions, concat([
          element(ID.CueTrack, encodeUnsigned(1)),
          element(ID.CueClusterPosition, encodeUnsigned(cue.position)),
        ])),
      ])))))
    : new Uint8Array(0);

  const segmentBody = concat([info, tracks, ...clusters, cuesElement]);
  return concat([header, element(ID.Segment, segmentBody)]);
}

// --------------------------------------------------------------------- reading back

export type ParsedElement = { id: number; size: number; headerSize: number; payload: Uint8Array };

/** Reads one element at an offset. Used by the tests to prove the output parses. */
export function readElement(bytes: Uint8Array, offset: number): ParsedElement | null {
  if (offset >= bytes.length) return null;

  // The identifier's own width is marked the same way a length is.
  const first = bytes[offset];
  let idWidth = 1;
  for (let bit = 7; bit >= 0; bit -= 1) {
    if (first & (1 << bit)) { idWidth = 8 - bit; break; }
  }
  if (offset + idWidth > bytes.length) return null;

  let id = 0;
  for (let index = 0; index < idWidth; index += 1) id = id * 256 + bytes[offset + index];

  const sizeStart = offset + idWidth;
  if (sizeStart >= bytes.length) return null;
  const sizeFirst = bytes[sizeStart];
  let sizeWidth = 1;
  for (let bit = 7; bit >= 0; bit -= 1) {
    if (sizeFirst & (1 << bit)) { sizeWidth = 8 - bit; break; }
  }

  let size = sizeFirst & ((1 << (8 - sizeWidth)) - 1);
  for (let index = 1; index < sizeWidth; index += 1) size = size * 256 + bytes[sizeStart + index];

  const headerSize = idWidth + sizeWidth;
  const start = offset + headerSize;
  return { id, size, headerSize, payload: bytes.subarray(start, Math.min(bytes.length, start + size)) };
}

/** Walks the children of a payload, which is how a test can check the structure. */
export function children(payload: Uint8Array): ParsedElement[] {
  const found: ParsedElement[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const element = readElement(payload, offset);
    if (!element) break;
    found.push(element);
    offset += element.headerSize + element.size;
  }
  return found;
}

export function findChild(payload: Uint8Array, id: number): ParsedElement | null {
  return children(payload).find((child) => child.id === id) ?? null;
}

export function readUnsigned(payload: Uint8Array): number {
  let value = 0;
  for (const byte of payload) value = value * 256 + byte;
  return value;
}

export function readFloat(payload: Uint8Array): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return payload.length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

export function readString(payload: Uint8Array): string {
  return new TextDecoder().decode(payload).replace(/\0+$/, '');
}

export const WEBM_IDS = ID;
