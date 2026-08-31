import { describe, expect, it } from 'vitest';
import { muxWebm, type WebmSample, type WebmTrack } from './webm';
import { demuxWebmVideo, readVint } from './webm-demux';

/**
 * Round trips through the muxer next door.
 *
 * Testing a parser against files it produced itself would be circular if the
 * muxer were untested, but it has its own suite and is what actually writes
 * every recording this app makes. What matters here is that the two agree.
 */
function build(samples: WebmSample[], track?: Partial<Extract<WebmTrack, { kind: 'video' }>>): Uint8Array {
  const video: WebmTrack = {
    kind: 'video', codec: 'V_VP8', width: 320, height: 240, ...track,
  } as WebmTrack;
  return muxWebm({ tracks: [video] }, samples);
}

function frame(timestamp: number, keyframe: boolean, byte: number): WebmSample {
  return { track: 1, timestamp, keyframe, data: Uint8Array.from([byte, byte, byte]) };
}

/**
 * Hand-builds a file that stores frames as BlockGroup rather than SimpleBlock.
 *
 * The muxer here only writes SimpleBlock, so this is assembled by hand to match
 * what Chrome's MediaRecorder produces.
 */
function buildWithBlockGroups(frames: { time: number; key: boolean; byte: number }[]): Uint8Array {
  const size = (value: number) => Uint8Array.from([0x80 | value]);
  const el = (id: number[], payload: Uint8Array) =>
    Uint8Array.from([...id, ...size(payload.length), ...payload]);

  const groups = frames.map((entry) => {
    const block = el([0xa1], Uint8Array.from([
      0x81,                                     // track 1
      (entry.time >> 8) & 0xff, entry.time & 0xff,
      0x00,                                     // no flags on a plain Block
      entry.byte, entry.byte, entry.byte,
    ]));
    // A delta frame carries a ReferenceBlock; a keyframe carries none.
    const reference = entry.key ? new Uint8Array() : el([0xfb], Uint8Array.from([0x81]));
    return el([0xa0], Uint8Array.from([...block, ...reference]));
  });

  const cluster = el([0x1f, 0x43, 0xb6, 0x75], Uint8Array.from([
    ...el([0xe7], Uint8Array.from([0x00])),
    ...groups.flatMap((group) => [...group]),
  ]));

  const trackEntry = el([0xae], Uint8Array.from([
    ...el([0xd7], Uint8Array.from([0x01])),
    ...el([0x83], Uint8Array.from([0x01])),
    ...el([0x86], new TextEncoder().encode('V_VP8')),
    ...el([0xe0], Uint8Array.from([
      ...el([0xb0], Uint8Array.from([0x01, 0x40])),
      ...el([0xba], Uint8Array.from([0x00, 0xf0])),
    ])),
  ]));

  const segment = el([0x18, 0x53, 0x80, 0x67], Uint8Array.from([
    ...el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], Uint8Array.from([0x0f, 0x42, 0x40]))),
    ...el([0x16, 0x54, 0xae, 0x6b], trackEntry),
    ...cluster,
  ]));
  return segment;
}

describe('readVint', () => {
  it('keeps the marker for an id and strips it for a size', () => {
    const bytes = Uint8Array.from([0xa3]);
    expect(readVint(bytes, 0, true)?.value).toBe(0xa3);
    expect(readVint(bytes, 0, false)?.value).toBe(0x23);
  });

  it('reads a multi byte value', () => {
    // 0x4001 with the marker stripped is 1, across two bytes.
    expect(readVint(Uint8Array.from([0x40, 0x01]), 0, false)).toEqual({ value: 1, length: 2 });
  });

  it('refuses a zero first byte, which is not a valid length', () => {
    expect(readVint(Uint8Array.from([0x00, 0x01]), 0, false)).toBeNull();
  });

  it('refuses to read past the end', () => {
    expect(readVint(Uint8Array.from([0x40]), 0, false)).toBeNull();
  });
});

describe('demuxWebmVideo', () => {
  it('finds the track and its dimensions', () => {
    const file = build([frame(0, true, 1)], { width: 1280, height: 720 });
    const out = demuxWebmVideo(file)!;
    expect(out.track.number).toBe(1);
    expect(out.track.codec).toBe('V_VP8');
    expect(out.track.width).toBe(1280);
    expect(out.track.height).toBe(720);
  });

  it('names the WebCodecs codec for VP8 and VP9', () => {
    expect(demuxWebmVideo(build([frame(0, true, 1)]))!.track.webCodec).toBe('vp8');
    const vp9 = demuxWebmVideo(build([frame(0, true, 1)], { codec: 'V_VP9' }))!;
    expect(vp9.track.webCodec).toBe('vp09.00.10.08');
  });

  it('returns every frame, in order, with its timestamp', () => {
    const file = build([
      frame(0, true, 1),
      frame(33_333, false, 2),
      frame(66_666, false, 3),
      frame(100_000, true, 4),
    ]);
    const out = demuxWebmVideo(file)!;
    expect(out.frames).toHaveLength(4);
    // Matroska keeps timestamps in milliseconds, so what comes back is what
    // was written rounded to the millisecond, not the microsecond given.
    expect(out.frames.map((f) => f.timestamp)).toEqual([0, 33_000, 67_000, 100_000]);
    expect(out.frames.map((f) => f.data[0])).toEqual([1, 2, 3, 4]);
  });

  it('marks keyframes as keyframes', () => {
    const file = build([frame(0, true, 1), frame(33_333, false, 2), frame(66_666, true, 3)]);
    expect(demuxWebmVideo(file)!.frames.map((f) => f.keyframe)).toEqual([true, false, true]);
  });

  it('reads across several clusters', () => {
    // The muxer starts a new cluster on a keyframe, so this makes four of them.
    const samples = Array.from({ length: 12 }, (_, index) =>
      frame(index * 33_333, index % 3 === 0, index + 1));
    const out = demuxWebmVideo(build(samples))!;
    expect(out.frames).toHaveLength(12);
    expect(out.frames.map((f) => f.data[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('gives back timestamps that only ever increase', () => {
    const samples = Array.from({ length: 30 }, (_, index) =>
      frame(index * 33_333, index % 10 === 0, index));
    const out = demuxWebmVideo(build(samples))!;
    for (let index = 1; index < out.frames.length; index += 1) {
      expect(out.frames[index].timestamp).toBeGreaterThanOrEqual(out.frames[index - 1].timestamp);
    }
  });

  it('keeps the frame data byte for byte', () => {
    const payload = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const file = build([{ track: 1, timestamp: 0, keyframe: true, data: payload }]);
    expect([...demuxWebmVideo(file)!.frames[0].data]).toEqual([...payload]);
  });

  it('carries CodecPrivate through as the decoder description', () => {
    const avcc = Uint8Array.from([1, 0x42, 0x00, 0x1f, 0xff]);
    const file = build([frame(0, true, 1)], { codec: 'V_VP9', codecPrivate: avcc });
    expect([...(demuxWebmVideo(file)!.track.description ?? [])]).toEqual([...avcc]);
  });

  it('returns null for something that is not a WebM at all', () => {
    expect(demuxWebmVideo(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('returns null for an empty file rather than throwing', () => {
    expect(demuxWebmVideo(new Uint8Array())).toBeNull();
  });

  it('reads a BlockGroup, and takes a missing ReferenceBlock to mean keyframe', () => {
    // This is how Chrome's MediaRecorder actually writes, and it caught the
    // parser out: the muxer next door uses SimpleBlock, so the round trip test
    // above never exercised this path. Matroska has no keyframe flag on a
    // Block, and marks one by the absence of a ReferenceBlock, since a frame
    // that references nothing depends on nothing. Reading it the other way
    // makes every frame look like a delta and no decoder will start.
    const file = buildWithBlockGroups([
      { time: 0, key: true, byte: 1 },
      { time: 33, key: false, byte: 2 },
      { time: 66, key: false, byte: 3 },
    ]);
    const out = demuxWebmVideo(file)!;
    expect(out.frames.map((f) => f.keyframe)).toEqual([true, false, false]);
    expect(out.frames.map((f) => f.data[0])).toEqual([1, 2, 3]);
    expect(out.frames.map((f) => f.timestamp)).toEqual([0, 33_000, 66_000]);
  });

  it('survives a truncated file', () => {
    // Half a recording is what a crashed tab leaves behind, and it should read
    // as far as it can rather than take the app down.
    const file = build(Array.from({ length: 9 }, (_, index) =>
      frame(index * 33_333, index % 3 === 0, index + 1)));
    const cut = file.slice(0, Math.floor(file.length * 0.7));
    expect(() => demuxWebmVideo(cut)).not.toThrow();
  });
});
