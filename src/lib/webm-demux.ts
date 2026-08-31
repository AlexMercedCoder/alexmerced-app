/**
 * Reading a WebM back out again.
 *
 * The muxer next door writes these files; this takes one apart far enough to
 * hand its video frames to a decoder in order. That is the whole point: a
 * seek asks the decoder to jump, which on a file with sparse keyframes means
 * rewinding to the previous one and decoding forward every time. Walking the
 * clusters in order asks it to do what it is built for.
 *
 * Only what is needed is parsed. Matroska is a large format and almost none of
 * it matters for a recording that came out of MediaRecorder ten seconds ago.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;

/** Containers whose children are walked rather than read as a value. */
const CONTAINERS = new Set([ID_SEGMENT, ID_INFO, ID_TRACKS, ID_TRACK_ENTRY, ID_VIDEO, ID_CLUSTER, ID_BLOCK_GROUP]);

export type WebmVideoTrack = {
  number: number;
  codec: string;
  /** The WebCodecs codec string, when it can be worked out. */
  webCodec: string | null;
  description: Uint8Array | null;
  width: number;
  height: number;
};

export type WebmFrame = {
  /** Microseconds from the start of the file. */
  timestamp: number;
  keyframe: boolean;
  data: Uint8Array;
};

type Element = { id: number; start: number; size: number; end: number };

/**
 * Reads one variable-length integer.
 *
 * Matroska writes both element ids and sizes this way, and the difference
 * matters: an id keeps its leading marker bit, a size has it stripped. Getting
 * that backwards is the classic way to produce a parser that reads the first
 * element and then loses its place.
 */
function readVint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number } | null {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) { mask >>= 1; length += 1; }
  if (length > 8 || at + length > bytes.length) return null;

  let value = keepMarker ? first : first & (mask - 1);
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[at + index];
  return { value, length };
}

function readElement(bytes: Uint8Array, at: number, limit: number): Element | null {
  const id = readVint(bytes, at, true);
  if (!id) return null;
  const size = readVint(bytes, at + id.length, false);
  if (!size) return null;

  const start = at + id.length + size.length;
  // An unknown size is all ones in the size field, which MediaRecorder uses for
  // the Segment while it is still writing. Such an element runs to the end.
  const unknown = size.value >= 2 ** (7 * size.length) - 1;
  const end = unknown ? limit : Math.min(limit, start + size.value);
  return { id: id.value, start, size: end - start, end };
}

function readUnsigned(bytes: Uint8Array, element: Element): number {
  let value = 0;
  for (let at = element.start; at < element.end; at += 1) value = value * 256 + bytes[at];
  return value;
}

function readString(bytes: Uint8Array, element: Element): string {
  let out = '';
  for (let at = element.start; at < element.end; at += 1) {
    const code = bytes[at];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/** Walks the direct children of a range, calling back for each. */
function walk(bytes: Uint8Array, from: number, to: number, visit: (element: Element) => void): void {
  let at = from;
  while (at < to) {
    const element = readElement(bytes, at, to);
    if (!element || element.end <= at) break;
    visit(element);
    at = element.end;
  }
}

/**
 * The WebCodecs codec string for a Matroska codec id.
 *
 * VP8 and VP9 name themselves. H.264 in Matroska carries an avcC record as
 * CodecPrivate, and its profile and level have to be read out of that, because
 * the decoder is configured with a string that spells them out.
 */
function webCodecFor(codec: string, description: Uint8Array | null): string | null {
  if (codec === 'V_VP8') return 'vp8';
  if (codec === 'V_VP9') return 'vp09.00.10.08';
  if (codec === 'V_AV1') return 'av01.0.04M.08';
  if (codec === 'V_MPEG4/ISO/AVC') {
    if (!description || description.length < 4) return 'avc1.42001f';
    const hex = (value: number) => value.toString(16).padStart(2, '0');
    return `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
  }
  return null;
}

export type WebmVideo = {
  track: WebmVideoTrack;
  frames: WebmFrame[];
  /** Nanoseconds per timestamp unit. One millisecond is the usual. */
  timestampScale: number;
};

/**
 * Pulls the video track and every frame in it out of a WebM file.
 *
 * Returns null rather than throwing when the file is not one this understands,
 * because the caller always has the slower seeking path to fall back to and a
 * failed parse should cost a person nothing but time.
 */
export function demuxWebmVideo(bytes: Uint8Array): WebmVideo | null {
  let timestampScale = 1_000_000;
  let track: WebmVideoTrack | null = null;
  const frames: WebmFrame[] = [];

  const readTrackEntry = (entry: Element): void => {
    let number = -1;
    let type = -1;
    let codec = '';
    let description: Uint8Array | null = null;
    let width = 0;
    let height = 0;

    walk(bytes, entry.start, entry.end, (child) => {
      if (child.id === ID_TRACK_NUMBER) number = readUnsigned(bytes, child);
      else if (child.id === ID_TRACK_TYPE) type = readUnsigned(bytes, child);
      else if (child.id === ID_CODEC_ID) codec = readString(bytes, child);
      else if (child.id === ID_CODEC_PRIVATE) description = bytes.slice(child.start, child.end);
      else if (child.id === ID_VIDEO) {
        walk(bytes, child.start, child.end, (size) => {
          if (size.id === ID_PIXEL_WIDTH) width = readUnsigned(bytes, size);
          else if (size.id === ID_PIXEL_HEIGHT) height = readUnsigned(bytes, size);
        });
      }
    });

    // Type 1 is video. A recording with a camera in it has two video tracks in
    // separate files, not in one, so the first is the right one.
    if (type === 1 && number >= 0 && !track) {
      track = { number, codec, webCodec: webCodecFor(codec, description), description, width, height };
    }
  };

  const readCluster = (cluster: Element): void => {
    let clusterTime = 0;
    walk(bytes, cluster.start, cluster.end, (child) => {
      if (child.id === ID_TIMESTAMP) { clusterTime = readUnsigned(bytes, child); return; }

      // Two ways a frame can be stored, and both turn up in the wild. Our own
      // muxer writes SimpleBlock; Chrome's MediaRecorder writes a BlockGroup
      // wrapping a Block, which is why this has to handle each.
      const group = child.id === ID_BLOCK_GROUP ? readBlockGroup(bytes, child) : null;
      const block = child.id === ID_SIMPLE_BLOCK ? child : group?.block ?? null;
      if (!block || !track) return;

      const number = readVint(bytes, block.start, false);
      if (!number || number.value !== track.number) return;

      const at = block.start + number.length;
      if (at + 3 > block.end) return;
      // Signed, and relative to the cluster: a frame can be presented before
      // the cluster's own timestamp when there are B-frames.
      const relative = (bytes[at] << 8) | bytes[at + 1];
      const signed = relative > 0x7fff ? relative - 0x10000 : relative;
      const flags = bytes[at + 2];
      // SimpleBlock says so in its flags. A Block inside a BlockGroup has no
      // such flag: Matroska marks it a keyframe by the *absence* of a
      // ReferenceBlock, since a frame that references nothing depends on
      // nothing. Reading that backwards makes every frame look like a delta,
      // and a decoder refuses to start without a keyframe.
      const keyframe = child.id === ID_SIMPLE_BLOCK
        ? (flags & 0x80) !== 0
        : group !== null && !group.references;

      frames.push({
        timestamp: Math.round(((clusterTime + signed) * timestampScale) / 1000),
        keyframe,
        data: bytes.slice(at + 3, block.end),
      });
    });
  };

  const readSegment = (segment: Element): void => {
    walk(bytes, segment.start, segment.end, (child) => {
      if (child.id === ID_INFO) {
        walk(bytes, child.start, child.end, (info) => {
          if (info.id === ID_TIMESTAMP_SCALE) timestampScale = readUnsigned(bytes, info);
        });
      } else if (child.id === ID_TRACKS) {
        walk(bytes, child.start, child.end, (entry) => {
          if (entry.id === ID_TRACK_ENTRY) readTrackEntry(entry);
        });
      } else if (child.id === ID_CLUSTER) {
        readCluster(child);
      }
    });
  };

  walk(bytes, 0, bytes.length, (element) => {
    if (element.id === ID_SEGMENT) readSegment(element);
  });

  if (!track || frames.length === 0) return null;
  // Presentation order, since a decoder is fed in decode order but the caller
  // wants frames by the time they appear.
  frames.sort((a, b) => a.timestamp - b.timestamp);
  return { track, frames, timestampScale };
}

function readBlockGroup(
  bytes: Uint8Array, group: Element,
): { block: Element | null; references: boolean } {
  let block: Element | null = null;
  let references = false;
  walk(bytes, group.start, group.end, (child) => {
    if (child.id === ID_BLOCK && !block) block = child;
    else if (child.id === ID_REFERENCE_BLOCK) references = true;
  });
  return { block, references };
}

export { readVint, CONTAINERS };
