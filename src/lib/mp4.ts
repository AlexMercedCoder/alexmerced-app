/**
 * An MP4 muxer.
 *
 * WebM is the better container and the browser writes neither, but MP4 is what
 * people actually send each other, so a tool that cannot produce one is a tool
 * people will not use.
 *
 * MP4 is a tree of boxes: four bytes of length, four of type, then a payload
 * that is either data or more boxes. The whole format is that shape, which is
 * what makes it writable by hand.
 *
 * The layout here is ftyp, then mdat holding every frame, then moov describing
 * where they all are. moov last means the byte offsets are known by the time
 * they have to be written. It also means the file is not streamable, which does
 * not matter for something being saved to disk.
 */

export class Mp4Error extends Error {}

export type Mp4VideoTrack = {
  kind: 'video';
  /** The avcC record from the encoder's decoder configuration. */
  description: Uint8Array;
  width: number;
  height: number;
  frameRate: number;
};

export type Mp4AudioTrack = {
  kind: 'audio';
  /** AudioSpecificConfig for AAC, or the OpusHead for Opus. */
  description: Uint8Array;
  codec: 'aac' | 'opus';
  sampleRate: number;
  channels: number;
};

export type Mp4Track = Mp4VideoTrack | Mp4AudioTrack;

export type Mp4Sample = {
  /** Which track, numbered from one, matching the order tracks were given. */
  track: number;
  /** Microseconds from the start. */
  timestamp: number;
  /** Microseconds this sample lasts. */
  duration: number;
  data: Uint8Array;
  keyframe: boolean;
};

/** The clock MP4 counts the film in. Ninety thousand divides most frame rates. */
const MOVIE_TIMESCALE = 1000;
const VIDEO_TIMESCALE = 90_000;

// --------------------------------------------------------------------- writing

function fourcc(type: string): Uint8Array {
  if (type.length !== 4) throw new Mp4Error(`"${type}" is not a four character box type.`);
  return new TextEncoder().encode(type);
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(fourcc(type), 4);
  out.set(body, 8);
  return out;
}

/** A box whose first four bytes are a version and three flag bytes. */
export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 0xff;
  head[2] = (flags >> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, head, ...payload);
}

export function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values.map((value) => value & 0xff));
}

export function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

/** A 16.16 fixed point number, which is how MP4 stores rates and matrices. */
export function fixed16(value: number): Uint8Array {
  return u32(Math.round(value * 65536));
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

/** The identity transform, which every track carries whether it needs one or not. */
const UNITY_MATRIX = concat([
  fixed16(1), fixed16(0), fixed16(0),
  fixed16(0), fixed16(1), fixed16(0),
  u32(0), u32(0), u32(0x40000000),
]);

// --------------------------------------------------------------------- descriptors

/**
 * The elementary stream descriptor AAC needs.
 *
 * This is the one part of MP4 that is not boxes: it is a nested tag-length
 * structure inherited from MPEG-4 Systems, and it has to be built by hand.
 */
export function esds(config: Uint8Array, channels: number): Uint8Array {
  const descriptor = (tag: number, body: Uint8Array): Uint8Array => {
    // Lengths use seven bits a byte, with the top bit meaning "more follows".
    const length: number[] = [];
    let remaining = body.length;
    do {
      length.unshift(remaining & 0x7f);
      remaining >>= 7;
    } while (remaining > 0);
    for (let index = 0; index < length.length - 1; index += 1) length[index] |= 0x80;
    return concat([u8(tag), Uint8Array.from(length), body]);
  };

  const decoderSpecific = descriptor(0x05, config);
  const decoderConfig = descriptor(0x04, concat([
    u8(0x40),               // MPEG-4 audio
    u8(0x15),               // audio stream
    u8(0, 0, 0),            // buffer size, unknown
    u32(0),                 // maximum bitrate, unknown
    u32(0),                 // average bitrate, unknown
    decoderSpecific,
  ]));
  const slConfig = descriptor(0x06, u8(0x02));

  void channels;
  return fullBox('esds', 0, 0, descriptor(0x03, concat([
    u16(1),                 // elementary stream id
    u8(0x00),               // no dependency, no URL, not upstream
    decoderConfig,
    slConfig,
  ])));
}

/** The Opus configuration box, which carries the OpusHead minus its magic. */
export function dOps(head: Uint8Array, channels: number, sampleRate: number): Uint8Array {
  // OpusHead is: magic(8) version(1) channels(1) preSkip(2) rate(4) gain(2) map(1).
  // dOps keeps everything after the magic and the version byte, with the
  // pre-skip and rate in big-endian rather than little.
  const hasHead = head.length >= 19;
  const view = hasHead ? new DataView(head.buffer, head.byteOffset, head.byteLength) : null;
  const preSkip = view ? view.getUint16(10, true) : 0;
  const rate = view ? view.getUint32(12, true) : sampleRate;
  const gain = view ? view.getInt16(16, true) : 0;

  const body = new Uint8Array(11);
  const out = new DataView(body.buffer);
  body[0] = 0;                       // version
  body[1] = hasHead ? head[9] : channels;
  out.setUint16(2, preSkip, false);
  out.setUint32(4, rate, false);
  out.setInt16(8, gain, false);
  body[10] = 0;                      // channel mapping family
  return box('dOps', body);
}

// --------------------------------------------------------------------- tables

type Prepared = {
  track: Mp4Track;
  number: number;
  timescale: number;
  samples: Mp4Sample[];
  /** Byte offset of this track's run inside the file. */
  offset: number;
  totalBytes: number;
  duration: number;
};

/** Runs of equal sample durations, which is what stts stores. */
export function timeToSample(durations: number[]): { count: number; delta: number }[] {
  const runs: { count: number; delta: number }[] = [];
  for (const delta of durations) {
    const last = runs[runs.length - 1];
    if (last && last.delta === delta) last.count += 1;
    else runs.push({ count: 1, delta });
  }
  return runs;
}

function stbl(prepared: Prepared): Uint8Array {
  const { track, samples, timescale } = prepared;

  const durations = samples.map((sample) =>
    Math.max(1, Math.round((sample.duration / 1_000_000) * timescale)));
  const runs = timeToSample(durations);

  const entry = track.kind === 'video'
    ? box('avc1', concat([
        u8(0, 0, 0, 0, 0, 0), u16(1),          // reserved, data reference index
        u16(0), u16(0), u32(0), u32(0), u32(0), // predefined and reserved
        u16(track.width), u16(track.height),
        u32(0x00480000), u32(0x00480000),       // 72 dpi horizontal and vertical
        u32(0), u16(1),                         // reserved, frame count
        new Uint8Array(32),                     // compressor name, blank
        u16(0x0018), u16(0xffff),               // depth, predefined
        box('avcC', track.description),
      ]))
    : box(track.codec === 'aac' ? 'mp4a' : 'Opus', concat([
        u8(0, 0, 0, 0, 0, 0), u16(1),
        u32(0), u32(0),
        u16(track.channels), u16(16),
        u16(0), u16(0),
        // The sample rate is 16.16 fixed point, so a rate above 65535 cannot be
        // written here. Everything real is well below that.
        u32(Math.min(65535, track.sampleRate) * 65536),
        track.codec === 'aac'
          ? esds(track.description, track.channels)
          : dOps(track.description, track.channels, track.sampleRate),
      ]));

  const syncSamples = samples
    .map((sample, index) => (sample.keyframe ? index + 1 : 0))
    .filter((index) => index > 0);

  const boxes: Uint8Array[] = [
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(runs.length), concat(runs.map((run) => concat([u32(run.count), u32(run.delta)])))),
  ];

  // A video track lists its keyframes. An audio track where every sample is one
  // omits the box entirely, which is what says "all of them".
  if (track.kind === 'video' && syncSamples.length < samples.length) {
    boxes.push(fullBox('stss', 0, 0, u32(syncSamples.length), concat(syncSamples.map(u32))));
  }

  boxes.push(
    // Every sample of a track sits in one chunk, so this is always one entry.
    fullBox('stsc', 0, 0, u32(1), concat([u32(1), u32(samples.length), u32(1)])),
    fullBox('stsz', 0, 0, u32(0), u32(samples.length), concat(samples.map((sample) => u32(sample.data.length)))),
    fullBox('stco', 0, 0, u32(1), u32(prepared.offset)),
  );

  return box('stbl', ...boxes);
}

function trak(prepared: Prepared, movieDuration: number): Uint8Array {
  const { track, number, timescale, duration } = prepared;
  const video = track.kind === 'video';

  return box('trak',
    fullBox('tkhd', 0, 0x000003, concat([   // enabled and in the movie
      u32(0), u32(0),                       // created, modified
      u32(number), u32(0),                  // track id, reserved
      u32(Math.round(movieDuration * MOVIE_TIMESCALE)),
      u32(0), u32(0),                       // reserved
      u16(0), u16(video ? 0 : 0x0100),      // layer, volume
      u16(0), UNITY_MATRIX,
      fixed16(video ? track.width : 0),
      fixed16(video ? track.height : 0),
    ])),
    box('mdia',
      fullBox('mdhd', 0, 0, concat([
        u32(0), u32(0),
        u32(timescale),
        u32(Math.round(duration * timescale)),
        // Language 'und' packed as three five-bit letters offset from 0x60.
        u16(0x55c4), u16(0),
      ])),
      fullBox('hdlr', 0, 0, concat([
        u32(0),
        fourcc(video ? 'vide' : 'soun'),
        u32(0), u32(0), u32(0),
        new TextEncoder().encode(video ? 'Video\0' : 'Sound\0'),
      ])),
      box('minf',
        video
          ? fullBox('vmhd', 0, 1, concat([u16(0), u16(0), u16(0), u16(0)]))
          : fullBox('smhd', 0, 0, concat([u16(0), u16(0)])),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl(prepared),
      ),
    ),
  );
}

export type MuxMp4Options = { tracks: Mp4Track[] };

/**
 * Builds the finished file.
 *
 * Each track's samples are written as one contiguous run, so the sample-to-chunk
 * table is a single entry and the chunk offset is a single number. That is
 * simpler than interleaving and costs nothing for a file being downloaded, since
 * the whole thing arrives before anything plays it.
 */
export function muxMp4(options: MuxMp4Options, samples: Mp4Sample[]): Uint8Array {
  if (options.tracks.length === 0) throw new Mp4Error('An MP4 needs at least one track.');

  const highest = options.tracks.length;
  for (const sample of samples) {
    if (!Number.isInteger(sample.track) || sample.track < 1 || sample.track > highest) {
      throw new Mp4Error(
        `A sample refers to track ${sample.track}, but this file has ${highest === 1 ? 'only track 1' : `tracks 1 to ${highest}`}.`,
      );
    }
  }

  const prepared: Prepared[] = options.tracks.map((track, index) => {
    const own = samples
      .filter((sample) => sample.track === index + 1)
      .sort((a, b) => a.timestamp - b.timestamp);

    const totalBytes = own.reduce((sum, sample) => sum + sample.data.length, 0);
    const last = own[own.length - 1];
    const duration = last ? (last.timestamp + last.duration) / 1_000_000 : 0;

    return {
      track,
      number: index + 1,
      timescale: track.kind === 'video' ? VIDEO_TIMESCALE : track.sampleRate,
      samples: own,
      offset: 0,
      totalBytes,
      duration,
    };
  });

  if (prepared.every((entry) => entry.samples.length === 0)) {
    throw new Mp4Error('An MP4 needs at least one sample.');
  }

  const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));

  // mdat's payload begins eight bytes after the box starts, and every track's
  // run is placed in order, which is what fixes the chunk offsets.
  const mdatStart = ftyp.length;
  let cursor = mdatStart + 8;
  for (const entry of prepared) {
    entry.offset = cursor;
    cursor += entry.totalBytes;
  }

  const mdat = box('mdat', ...prepared.flatMap((entry) => entry.samples.map((sample) => sample.data)));
  const movieDuration = Math.max(...prepared.map((entry) => entry.duration), 0);

  const moov = box('moov',
    fullBox('mvhd', 0, 0, concat([
      u32(0), u32(0),
      u32(MOVIE_TIMESCALE),
      u32(Math.round(movieDuration * MOVIE_TIMESCALE)),
      fixed16(1),                       // rate
      u16(0x0100), u16(0),              // volume, reserved
      u32(0), u32(0),
      UNITY_MATRIX,
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
      u32(prepared.length + 1),         // next free track id
    ])),
    ...prepared.filter((entry) => entry.samples.length > 0).map((entry) => trak(entry, movieDuration)),
  );

  return concat([ftyp, mdat, moov]);
}

// --------------------------------------------------------------------- reading back

export type ParsedBox = { type: string; size: number; start: number; payload: Uint8Array };

/** Reads one box, so a test can prove the output parses rather than assuming it. */
export function readBox(bytes: Uint8Array, offset: number): ParsedBox | null {
  if (offset + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(offset, false);
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  if (size < 8 || offset + size > bytes.length) return null;
  return { type, size, start: offset, payload: bytes.subarray(offset + 8, offset + size) };
}

export function readBoxes(payload: Uint8Array): ParsedBox[] {
  const found: ParsedBox[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const parsed = readBox(payload, offset);
    if (!parsed) break;
    found.push(parsed);
    offset += parsed.size;
  }
  return found;
}

/** Walks a path of box types, skipping the version and flags of full boxes. */
export function findBox(bytes: Uint8Array, path: string[]): ParsedBox | null {
  const FULL = new Set(['stsd', 'dref']);
  let level = readBoxes(bytes);
  let found: ParsedBox | null = null;

  for (let depth = 0; depth < path.length; depth += 1) {
    found = level.find((entry) => entry.type === path[depth]) ?? null;
    if (!found) return null;
    if (depth < path.length - 1) {
      // A few containers carry a version, flags and a count before their children.
      const skip = FULL.has(found.type) ? 8 : 0;
      level = readBoxes(found.payload.subarray(skip));
    }
  }
  return found;
}
