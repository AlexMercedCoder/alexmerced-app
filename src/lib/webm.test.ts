import { describe, expect, it } from 'vitest';
import {
  children, concat, element, encodeFloat, encodeLength, encodeString, encodeUnsigned, findChild,
  muxWebm, preSkipNanos, readElement, readFloat, readString, readUnsigned, simpleBlock, TIMESTAMP_SCALE,
  WEBM_IDS, type WebmSample, type WebmTrack,
} from './webm';

const VIDEO: WebmTrack = { kind: 'video', codec: 'V_VP9', width: 640, height: 480, frameDuration: 33_333_333 };
const AUDIO: WebmTrack = { kind: 'audio', codec: 'A_OPUS', sampleRate: 48000, channels: 2 };

function frames(count: number, track = 1, stepUs = 33_333): WebmSample[] {
  return Array.from({ length: count }, (_, index) => ({
    track,
    timestamp: index * stepUs,
    data: Uint8Array.from([index & 0xff, 0xaa, 0xbb]),
    keyframe: index % 30 === 0,
  }));
}

describe('encodeLength', () => {
  it('uses one byte for small values, with the marker bit set', () => {
    expect(Array.from(encodeLength(0))).toEqual([0x80]);
    expect(Array.from(encodeLength(1))).toEqual([0x81]);
    expect(Array.from(encodeLength(126))).toEqual([0xfe]);
  });

  it('grows to two bytes rather than colliding with the reserved value', () => {
    // 127 in one byte would be 0xFF, which means "unknown length".
    expect(encodeLength(127)).toHaveLength(2);
    expect(Array.from(encodeLength(127))).toEqual([0x40, 0x7f]);
  });

  it('grows as the value does', () => {
    expect(encodeLength(1000)).toHaveLength(2);
    expect(encodeLength(100_000)).toHaveLength(3);
    expect(encodeLength(20_000_000)).toHaveLength(4);
  });

  it('honours a minimum width, which reserves room for a later rewrite', () => {
    expect(encodeLength(5, 8)).toHaveLength(8);
    expect(Array.from(encodeLength(5, 8))[0]).toBe(0x01);
  });

  it('refuses a negative length', () => {
    expect(() => encodeLength(-1)).toThrow(/cannot be negative/);
  });

  it('round trips through the reader', () => {
    for (const value of [0, 1, 126, 127, 128, 16383, 16384, 1_000_000]) {
      const wrapped = element(0x80, new Uint8Array(value > 4096 ? 0 : value));
      const parsed = readElement(wrapped, 0)!;
      expect(parsed.size, String(value)).toBe(value > 4096 ? 0 : value);
    }
  });
});

describe('encoding values', () => {
  it('writes an unsigned integer in as few bytes as possible', () => {
    expect(Array.from(encodeUnsigned(0))).toEqual([0]);
    expect(Array.from(encodeUnsigned(255))).toEqual([255]);
    expect(Array.from(encodeUnsigned(256))).toEqual([1, 0]);
    expect(Array.from(encodeUnsigned(1_000_000))).toEqual([15, 66, 64]);
  });

  it('round trips an unsigned integer', () => {
    for (const value of [0, 1, 255, 65535, 1_000_000, TIMESTAMP_SCALE]) {
      expect(readUnsigned(encodeUnsigned(value)), String(value)).toBe(value);
    }
  });

  it('writes a float as eight big-endian bytes', () => {
    expect(encodeFloat(1.5)).toHaveLength(8);
    expect(readFloat(encodeFloat(1234.5))).toBe(1234.5);
  });

  it('round trips a string', () => {
    expect(readString(encodeString('webm'))).toBe('webm');
  });
});

describe('element', () => {
  it('writes an identifier, a length, and the payload', () => {
    const written = element(0x4282, encodeString('webm'));
    const parsed = readElement(written, 0)!;
    expect(parsed.id).toBe(0x4282);
    expect(parsed.size).toBe(4);
    expect(readString(parsed.payload)).toBe('webm');
  });

  it('handles a four byte identifier', () => {
    const parsed = readElement(element(0x1a45dfa3, new Uint8Array([1])), 0)!;
    expect(parsed.id).toBe(0x1a45dfa3);
  });

  it('handles an empty payload', () => {
    const parsed = readElement(element(0x83, new Uint8Array(0)), 0)!;
    expect(parsed.size).toBe(0);
  });
});

describe('simpleBlock', () => {
  it('writes the track, the offset, and the flags before the frame', () => {
    const block = readElement(simpleBlock(1, 40, true, Uint8Array.from([9, 8, 7])), 0)!;
    expect(block.id).toBe(WEBM_IDS.SimpleBlock);
    expect(block.payload[0]).toBe(0x81);
    expect(new DataView(block.payload.buffer, block.payload.byteOffset).getInt16(1, false)).toBe(40);
    expect(block.payload[3]).toBe(0x80);
    expect(Array.from(block.payload.subarray(4))).toEqual([9, 8, 7]);
  });

  it('clears the keyframe flag for a delta frame', () => {
    const block = readElement(simpleBlock(1, 0, false, new Uint8Array(1)), 0)!;
    expect(block.payload[3]).toBe(0x00);
  });

  it('writes a negative offset, which a B-frame needs', () => {
    const block = readElement(simpleBlock(1, -30, false, new Uint8Array(1)), 0)!;
    expect(new DataView(block.payload.buffer, block.payload.byteOffset).getInt16(1, false)).toBe(-30);
  });

  it('refuses an offset too far to address', () => {
    expect(() => simpleBlock(1, 40000, false, new Uint8Array(1))).toThrow(/too far/);
  });
});

describe('muxWebm', () => {
  it('starts with the EBML header naming webm', () => {
    const file = muxWebm({ tracks: [VIDEO] }, frames(10));
    const header = readElement(file, 0)!;
    expect(header.id).toBe(WEBM_IDS.EBML);
    expect(readString(findChild(header.payload, WEBM_IDS.DocType)!.payload)).toBe('webm');
  });

  it('writes a segment with a real length rather than an unknown one', () => {
    const file = muxWebm({ tracks: [VIDEO] }, frames(10));
    const header = readElement(file, 0)!;
    const segment = readElement(file, header.headerSize + header.size)!;
    expect(segment.id).toBe(WEBM_IDS.Segment);
    expect(segment.size).toBeGreaterThan(0);
    // The whole file is accounted for, which is what a real length means.
    expect(header.headerSize + header.size + segment.headerSize + segment.size).toBe(file.length);
  });

  function segmentOf(file: Uint8Array) {
    const header = readElement(file, 0)!;
    return readElement(file, header.headerSize + header.size)!;
  }

  it('describes a video track with its size and codec', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, frames(4)));
    const tracks = findChild(segment.payload, WEBM_IDS.Tracks)!;
    const entry = findChild(tracks.payload, WEBM_IDS.TrackEntry)!;

    expect(readString(findChild(entry.payload, WEBM_IDS.CodecID)!.payload)).toBe('V_VP9');
    expect(readUnsigned(findChild(entry.payload, WEBM_IDS.TrackType)!.payload)).toBe(1);
    const video = findChild(entry.payload, WEBM_IDS.Video)!;
    expect(readUnsigned(findChild(video.payload, WEBM_IDS.PixelWidth)!.payload)).toBe(640);
    expect(readUnsigned(findChild(video.payload, WEBM_IDS.PixelHeight)!.payload)).toBe(480);
  });

  it('describes an audio track with its rate and channels', () => {
    const segment = segmentOf(muxWebm({ tracks: [AUDIO] }, frames(4)));
    const tracks = findChild(segment.payload, WEBM_IDS.Tracks)!;
    const entry = findChild(tracks.payload, WEBM_IDS.TrackEntry)!;
    expect(readUnsigned(findChild(entry.payload, WEBM_IDS.TrackType)!.payload)).toBe(2);
    const audio = findChild(entry.payload, WEBM_IDS.Audio)!;
    expect(readFloat(findChild(audio.payload, WEBM_IDS.SamplingFrequency)!.payload)).toBe(48000);
    expect(readUnsigned(findChild(audio.payload, WEBM_IDS.Channels)!.payload)).toBe(2);
  });

  it('writes one track entry per track', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO, AUDIO] }, frames(4)));
    const tracks = findChild(segment.payload, WEBM_IDS.Tracks)!;
    expect(children(tracks.payload).filter((child) => child.id === WEBM_IDS.TrackEntry)).toHaveLength(2);
  });

  it('numbers the tracks from one', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO, AUDIO] }, frames(4)));
    const tracks = findChild(segment.payload, WEBM_IDS.Tracks)!;
    const numbers = children(tracks.payload)
      .filter((child) => child.id === WEBM_IDS.TrackEntry)
      .map((entry) => readUnsigned(findChild(entry.payload, WEBM_IDS.TrackNumber)!.payload));
    expect(numbers).toEqual([1, 2]);
  });

  it('carries the codec private data when a codec needs it', () => {
    const withPrivate: WebmTrack = { ...AUDIO, codecPrivate: Uint8Array.from([1, 2, 3, 4]) };
    const segment = segmentOf(muxWebm({ tracks: [withPrivate] }, frames(2)));
    const tracks = findChild(segment.payload, WEBM_IDS.Tracks)!;
    const entry = findChild(tracks.payload, WEBM_IDS.TrackEntry)!;
    expect(Array.from(findChild(entry.payload, WEBM_IDS.CodecPrivate)!.payload)).toEqual([1, 2, 3, 4]);
  });

  it('records the duration in milliseconds', () => {
    // Sixty frames at thirty a second is just under two seconds.
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, frames(60)));
    const info = findChild(segment.payload, WEBM_IDS.Info)!;
    const duration = readFloat(findChild(info.payload, WEBM_IDS.Duration)!.payload);
    expect(duration).toBeGreaterThan(1900);
    expect(duration).toBeLessThan(2000);
  });

  it('sets the timestamp scale to one millisecond', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, frames(4)));
    const info = findChild(segment.payload, WEBM_IDS.Info)!;
    expect(readUnsigned(findChild(info.payload, WEBM_IDS.TimestampScale)!.payload)).toBe(1_000_000);
  });

  it('writes every frame into a cluster', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, frames(90)));
    const blocks = children(segment.payload)
      .filter((child) => child.id === WEBM_IDS.Cluster)
      .flatMap((cluster) => children(cluster.payload).filter((child) => child.id === WEBM_IDS.SimpleBlock));
    expect(blocks).toHaveLength(90);
  });

  it('starts a new cluster once one gets long, and only on a keyframe', () => {
    // Ten seconds at thirty a second, with a keyframe every second.
    const samples = Array.from({ length: 300 }, (_, index) => ({
      track: 1,
      timestamp: index * 33_333,
      data: new Uint8Array([index & 0xff]),
      keyframe: index % 30 === 0,
    }));
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, samples));
    const clusters = children(segment.payload).filter((child) => child.id === WEBM_IDS.Cluster);
    expect(clusters.length).toBeGreaterThan(1);

    // The first block of every cluster after the first must be a keyframe.
    for (const cluster of clusters.slice(1)) {
      const first = children(cluster.payload).find((child) => child.id === WEBM_IDS.SimpleBlock)!;
      expect(first.payload[3] & 0x80).toBe(0x80);
    }
  });

  it('interleaves two tracks in time order', () => {
    const video = frames(10, 1, 100_000);
    const audio = frames(10, 2, 100_000).map((sample) => ({ ...sample, timestamp: sample.timestamp + 20_000 }));
    const segment = segmentOf(muxWebm({ tracks: [VIDEO, AUDIO] }, [...audio, ...video]));
    const blocks = children(segment.payload)
      .filter((child) => child.id === WEBM_IDS.Cluster)
      .flatMap((cluster) => children(cluster.payload).filter((child) => child.id === WEBM_IDS.SimpleBlock));

    // Track numbers should alternate: video then audio, at each step.
    const trackNumbers = blocks.map((block) => block.payload[0] & 0x7f);
    expect(trackNumbers.slice(0, 6)).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('writes a cue index so a player can seek', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, frames(300)));
    const cues = findChild(segment.payload, WEBM_IDS.Cues)!;
    expect(cues).not.toBeNull();
    const points = children(cues.payload).filter((child) => child.id === WEBM_IDS.CuePoint);
    expect(points.length).toBeGreaterThan(0);
  });

  it('points each cue at a cluster that really starts there', () => {
    const file = muxWebm({ tracks: [VIDEO] }, frames(300));
    const header = readElement(file, 0)!;
    const segment = readElement(file, header.headerSize + header.size)!;
    const segmentStart = header.headerSize + header.size + segment.headerSize;

    const cues = findChild(segment.payload, WEBM_IDS.Cues)!;
    for (const point of children(cues.payload).filter((child) => child.id === WEBM_IDS.CuePoint)) {
      const positions = findChild(point.payload, WEBM_IDS.CueTrackPositions)!;
      const at = readUnsigned(findChild(positions.payload, WEBM_IDS.CueClusterPosition)!.payload);
      const cluster = readElement(file, segmentStart + at)!;
      expect(cluster.id).toBe(WEBM_IDS.Cluster);
    }
  });

  it('handles a single frame', () => {
    const segment = segmentOf(muxWebm({ tracks: [VIDEO] }, frames(1)));
    expect(children(segment.payload).filter((child) => child.id === WEBM_IDS.Cluster)).toHaveLength(1);
  });

  it('handles no frames at all', () => {
    const file = muxWebm({ tracks: [VIDEO] }, []);
    const header = readElement(file, 0)!;
    const segment = readElement(file, header.headerSize + header.size)!;
    expect(segment.id).toBe(WEBM_IDS.Segment);
    expect(findChild(segment.payload, WEBM_IDS.Tracks)).not.toBeNull();
  });

  it('refuses a file with no tracks', () => {
    expect(() => muxWebm({ tracks: [] }, [])).toThrow(/at least one track/);
  });

  it('parses cleanly from start to finish', () => {
    // Every element accounted for, with nothing left over, is the real check.
    const file = muxWebm({ tracks: [VIDEO, AUDIO] }, [...frames(60, 1), ...frames(90, 2, 21_333)]);
    let offset = 0;
    const top: number[] = [];
    while (offset < file.length) {
      const parsed = readElement(file, offset);
      expect(parsed).not.toBeNull();
      top.push(parsed!.id);
      offset += parsed!.headerSize + parsed!.size;
    }
    expect(offset).toBe(file.length);
    expect(top).toEqual([WEBM_IDS.EBML, WEBM_IDS.Segment]);
  });
});

describe('concat', () => {
  it('joins byte runs in order', () => {
    expect(Array.from(concat([Uint8Array.from([1, 2]), Uint8Array.from([3])]))).toEqual([1, 2, 3]);
    expect(concat([])).toHaveLength(0);
  });
});

describe('Opus in Matroska', () => {
  /** An OpusHead with a pre-skip, which is what a real encoder hands back. */
  function opusHead(preSkip: number): Uint8Array {
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode('OpusHead'), 0);
    head[8] = 1;
    head[9] = 2;
    new DataView(head.buffer).setUint16(10, preSkip, true);
    new DataView(head.buffer).setUint32(12, 48000, true);
    return head;
  }

  function audioEntry(track: WebmTrack) {
    const file = muxWebm({ tracks: [track] }, frames(4, 1, 20_000));
    const header = readElement(file, 0)!;
    const segment = readElement(file, header.headerSize + header.size)!;
    const tracks = findChild(segment.payload, WEBM_IDS.Tracks)!;
    return findChild(tracks.payload, WEBM_IDS.TrackEntry)!;
  }

  it('carries the OpusHead as CodecPrivate, without which nothing can decode it', () => {
    const head = opusHead(312);
    const entry = audioEntry({ ...AUDIO, codecPrivate: head });
    expect(Array.from(findChild(entry.payload, WEBM_IDS.CodecPrivate)!.payload)).toEqual(Array.from(head));
  });

  it('writes the codec delay from the pre-skip in the header', () => {
    // 312 samples at 48 kHz is 6.5 ms, which is 6,500,000 nanoseconds.
    const entry = audioEntry({ ...AUDIO, codecPrivate: opusHead(312) });
    expect(readUnsigned(findChild(entry.payload, WEBM_IDS.CodecDelay)!.payload)).toBe(6_500_000);
  });

  it('writes the eighty millisecond seek pre-roll Opus requires', () => {
    const entry = audioEntry({ ...AUDIO, codecPrivate: opusHead(312) });
    expect(readUnsigned(findChild(entry.payload, WEBM_IDS.SeekPreRoll)!.payload)).toBe(80_000_000);
  });

  it('writes a zero delay when there is no header to read one from', () => {
    const entry = audioEntry(AUDIO);
    expect(readUnsigned(findChild(entry.payload, WEBM_IDS.CodecDelay)!.payload)).toBe(0);
  });

  it('leaves those elements off a video track, where they mean nothing', () => {
    const entry = audioEntry(VIDEO);
    expect(findChild(entry.payload, WEBM_IDS.CodecDelay)).toBeNull();
    expect(findChild(entry.payload, WEBM_IDS.SeekPreRoll)).toBeNull();
  });

  it('reads a pre-skip only from a header long enough to hold one', () => {
    expect(preSkipNanos(undefined)).toBe(0);
    expect(preSkipNanos(new Uint8Array(4))).toBe(0);
  });
});

describe('refusing a file that would not play', () => {
  it('rejects a frame pointing at a track that does not exist', () => {
    // The commonest way to get this wrong: encode audio as track 2, then mux
    // it on its own, where it is track 1. The file writes, and plays silence.
    expect(() => muxWebm({ tracks: [AUDIO] }, [
      { track: 2, timestamp: 0, data: new Uint8Array(1), keyframe: true },
    ])).toThrow(/only track 1/);
  });

  it('names the range when there is more than one track', () => {
    expect(() => muxWebm({ tracks: [VIDEO, AUDIO] }, [
      { track: 3, timestamp: 0, data: new Uint8Array(1), keyframe: true },
    ])).toThrow(/tracks 1 to 2/);
  });

  it('rejects track zero, which EBML cannot address', () => {
    expect(() => muxWebm({ tracks: [VIDEO] }, [
      { track: 0, timestamp: 0, data: new Uint8Array(1), keyframe: true },
    ])).toThrow(/refers to track 0/);
  });

  it('accepts frames that name real tracks', () => {
    expect(() => muxWebm({ tracks: [VIDEO, AUDIO] }, [
      { track: 1, timestamp: 0, data: new Uint8Array(1), keyframe: true },
      { track: 2, timestamp: 0, data: new Uint8Array(1), keyframe: true },
    ])).not.toThrow();
  });
});
