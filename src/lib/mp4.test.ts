import { describe, expect, it } from 'vitest';
import {
  box, concat, dOps, esds, findBox, fixed16, fullBox, Mp4Error, muxMp4, readBox, readBoxes,
  timeToSample, u16, u32, u8, type Mp4Sample, type Mp4Track,
} from './mp4';

/** A plausible avcC record: the shape matters, the contents do not. */
const AVCC = Uint8Array.from([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1f, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80]);

const VIDEO: Mp4Track = { kind: 'video', description: AVCC, width: 1280, height: 720, frameRate: 30 };
const AAC: Mp4Track = { kind: 'audio', description: Uint8Array.from([0x12, 0x10]), codec: 'aac', sampleRate: 48000, channels: 2 };

/** OpusHead with a pre-skip of 312, as a real encoder produces. */
function opusHead(preSkip = 312): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1;
  head[9] = 2;
  const view = new DataView(head.buffer);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, 48000, true);
  return head;
}
const OPUS: Mp4Track = { kind: 'audio', description: opusHead(), codec: 'opus', sampleRate: 48000, channels: 2 };

function videoSamples(count: number, track = 1): Mp4Sample[] {
  const step = Math.round(1_000_000 / 30);
  return Array.from({ length: count }, (_, index) => ({
    track,
    timestamp: index * step,
    duration: step,
    data: Uint8Array.from([index & 0xff, 0xaa, 0xbb, 0xcc]),
    keyframe: index % 30 === 0,
  }));
}

describe('box writing', () => {
  it('writes a length, a type, and the payload', () => {
    const written = box('test', u32(7));
    expect(written).toHaveLength(12);
    const parsed = readBox(written, 0)!;
    expect(parsed.type).toBe('test');
    expect(parsed.size).toBe(12);
    expect(new DataView(parsed.payload.buffer, parsed.payload.byteOffset).getUint32(0, false)).toBe(7);
  });

  it('refuses a type that is not four characters', () => {
    expect(() => box('abc')).toThrow(/four character/);
    expect(() => box('abcde')).toThrow(/four character/);
  });

  it('writes a version and flags into a full box', () => {
    const parsed = readBox(fullBox('test', 1, 0x0000ff), 0)!;
    expect(parsed.payload[0]).toBe(1);
    expect(parsed.payload[3]).toBe(0xff);
  });

  it('writes fixed point the way MP4 stores rates', () => {
    expect(Array.from(fixed16(1))).toEqual([0, 1, 0, 0]);
    expect(Array.from(fixed16(0.5))).toEqual([0, 0, 128, 0]);
  });

  it('writes big-endian integers, which is what the format uses', () => {
    expect(Array.from(u16(0x1234))).toEqual([0x12, 0x34]);
    expect(Array.from(u32(0x01020304))).toEqual([1, 2, 3, 4]);
  });

  it('nests boxes without disturbing their lengths', () => {
    const outer = box('outr', box('innr', u8(1, 2, 3)));
    const parsed = readBox(outer, 0)!;
    const inner = readBox(parsed.payload, 0)!;
    expect(inner.type).toBe('innr');
    expect(inner.size).toBe(11);
  });
});

describe('timeToSample', () => {
  it('collapses a constant frame rate into one run', () => {
    expect(timeToSample([3000, 3000, 3000])).toEqual([{ count: 3, delta: 3000 }]);
  });

  it('starts a new run when the duration changes', () => {
    expect(timeToSample([3000, 3000, 1500, 3000])).toEqual([
      { count: 2, delta: 3000 }, { count: 1, delta: 1500 }, { count: 1, delta: 3000 },
    ]);
  });

  it('handles nothing at all', () => {
    expect(timeToSample([])).toEqual([]);
  });
});

describe('esds', () => {
  it('wraps the configuration in the nested descriptors AAC needs', () => {
    const written = esds(Uint8Array.from([0x12, 0x10]), 2);
    const parsed = readBox(written, 0)!;
    expect(parsed.type).toBe('esds');
    // Version and flags, then the ES descriptor tag.
    expect(parsed.payload[4]).toBe(0x03);
  });

  it('writes a multi-byte length for a large configuration', () => {
    // Descriptor lengths use seven bits a byte, so anything past 127 needs two.
    const written = esds(new Uint8Array(200), 2);
    expect(written.length).toBeGreaterThan(200);
    expect(readBox(written, 0)!.type).toBe('esds');
  });
});

describe('dOps', () => {
  it('carries the pre-skip across from the OpusHead, in big-endian', () => {
    const parsed = readBox(dOps(opusHead(312), 2, 48000), 0)!;
    expect(parsed.type).toBe('dOps');
    const view = new DataView(parsed.payload.buffer, parsed.payload.byteOffset);
    expect(parsed.payload[1]).toBe(2);
    expect(view.getUint16(2, false)).toBe(312);
    expect(view.getUint32(4, false)).toBe(48000);
  });

  it('falls back sensibly when there is no header to read', () => {
    const parsed = readBox(dOps(new Uint8Array(0), 1, 24000), 0)!;
    const view = new DataView(parsed.payload.buffer, parsed.payload.byteOffset);
    expect(parsed.payload[1]).toBe(1);
    expect(view.getUint32(4, false)).toBe(24000);
  });
});

describe('muxMp4', () => {
  it('starts with ftyp and holds mdat and moov', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(10));
    const top = readBoxes(file).map((entry) => entry.type);
    expect(top).toEqual(['ftyp', 'mdat', 'moov']);
  });

  it('parses cleanly from start to finish, with nothing left over', () => {
    const file = muxMp4({ tracks: [VIDEO, AAC] }, [
      ...videoSamples(30),
      ...Array.from({ length: 20 }, (_, index) => ({
        track: 2, timestamp: index * 20_000, duration: 20_000,
        data: Uint8Array.from([index, 1, 2]), keyframe: true,
      })),
    ]);
    let offset = 0;
    while (offset < file.length) {
      const parsed = readBox(file, offset);
      expect(parsed, `at ${offset}`).not.toBeNull();
      offset += parsed!.size;
    }
    expect(offset).toBe(file.length);
  });

  it('brands itself as something a player will recognise', () => {
    const ftyp = readBox(muxMp4({ tracks: [VIDEO] }, videoSamples(4)), 0)!;
    expect(new TextDecoder().decode(ftyp.payload.subarray(0, 4))).toBe('isom');
  });

  it('writes one track box per track that has samples', () => {
    const file = muxMp4({ tracks: [VIDEO, AAC] }, [
      ...videoSamples(5),
      { track: 2, timestamp: 0, duration: 20_000, data: u8(1), keyframe: true },
    ]);
    const moov = readBoxes(file).find((entry) => entry.type === 'moov')!;
    expect(readBoxes(moov.payload).filter((entry) => entry.type === 'trak')).toHaveLength(2);
  });

  it('leaves out a track that carries nothing', () => {
    const file = muxMp4({ tracks: [VIDEO, AAC] }, videoSamples(5));
    const moov = readBoxes(file).find((entry) => entry.type === 'moov')!;
    expect(readBoxes(moov.payload).filter((entry) => entry.type === 'trak')).toHaveLength(1);
  });

  it('describes video with avc1 and its avcC record', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(6));
    const stsd = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!;
    const avc1 = readBoxes(stsd.payload.subarray(8))[0];
    expect(avc1.type).toBe('avc1');

    const view = new DataView(avc1.payload.buffer, avc1.payload.byteOffset);
    expect(view.getUint16(24, false)).toBe(1280);
    expect(view.getUint16(26, false)).toBe(720);

    const avcC = readBoxes(avc1.payload.subarray(78)).find((entry) => entry.type === 'avcC')!;
    expect(Array.from(avcC.payload)).toEqual(Array.from(AVCC));
  });

  it('describes AAC with mp4a and an esds', () => {
    const file = muxMp4({ tracks: [AAC] }, [
      { track: 1, timestamp: 0, duration: 20_000, data: u8(1, 2), keyframe: true },
    ]);
    const stsd = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!;
    const mp4a = readBoxes(stsd.payload.subarray(8))[0];
    expect(mp4a.type).toBe('mp4a');
    expect(readBoxes(mp4a.payload.subarray(28)).some((entry) => entry.type === 'esds')).toBe(true);
  });

  it('describes Opus with an Opus entry and a dOps', () => {
    const file = muxMp4({ tracks: [OPUS] }, [
      { track: 1, timestamp: 0, duration: 20_000, data: u8(1, 2), keyframe: true },
    ]);
    const stsd = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!;
    const entry = readBoxes(stsd.payload.subarray(8))[0];
    expect(entry.type).toBe('Opus');
    expect(readBoxes(entry.payload.subarray(28)).some((child) => child.type === 'dOps')).toBe(true);
  });

  it('collapses a constant frame rate into a single stts run', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(60));
    const stts = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts'])!;
    const view = new DataView(stts.payload.buffer, stts.payload.byteOffset);
    expect(view.getUint32(4, false)).toBe(1);
    expect(view.getUint32(8, false)).toBe(60);
  });

  it('lists the keyframes, so a player can seek', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(90));
    const stss = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss'])!;
    const view = new DataView(stss.payload.buffer, stss.payload.byteOffset);
    expect(view.getUint32(4, false)).toBe(3);
    expect(view.getUint32(8, false)).toBe(1);
    expect(view.getUint32(12, false)).toBe(31);
  });

  it('omits the keyframe list when every sample is one', () => {
    const file = muxMp4({ tracks: [AAC] }, Array.from({ length: 10 }, (_, index) => ({
      track: 1, timestamp: index * 20_000, duration: 20_000, data: u8(index), keyframe: true,
    })));
    expect(findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss'])).toBeNull();
  });

  it('records every sample size', () => {
    const samples = videoSamples(5).map((sample, index) => ({ ...sample, data: new Uint8Array(index + 1) }));
    const file = muxMp4({ tracks: [VIDEO] }, samples);
    const stsz = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz'])!;
    const view = new DataView(stsz.payload.buffer, stsz.payload.byteOffset);
    expect(view.getUint32(4, false)).toBe(0);
    expect(view.getUint32(8, false)).toBe(5);
    for (let index = 0; index < 5; index += 1) {
      expect(view.getUint32(12 + index * 4, false)).toBe(index + 1);
    }
  });

  it('points the chunk offset at where the frames really are', () => {
    // This is the one that silently produces an unplayable file when wrong.
    const samples = videoSamples(4).map((sample, index) => ({
      ...sample, data: Uint8Array.from([0xf0 | index, index, index, index]),
    }));
    const file = muxMp4({ tracks: [VIDEO] }, samples);
    const stco = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])!;
    const offset = new DataView(stco.payload.buffer, stco.payload.byteOffset).getUint32(8, false);
    expect(Array.from(file.subarray(offset, offset + 4))).toEqual([0xf0, 0, 0, 0]);
  });

  it('points each track at its own run when there are two', () => {
    const audio: Mp4Sample[] = Array.from({ length: 3 }, (_, index) => ({
      track: 2, timestamp: index * 20_000, duration: 20_000,
      data: Uint8Array.from([0xa0 | index, 9]), keyframe: true,
    }));
    const file = muxMp4({ tracks: [VIDEO, AAC] }, [...videoSamples(4), ...audio]);

    const moov = readBoxes(file).find((entry) => entry.type === 'moov')!;
    const traks = readBoxes(moov.payload).filter((entry) => entry.type === 'trak');
    const offsets = traks.map((track) => {
      const stco = findBox(track.payload, ['mdia', 'minf', 'stbl', 'stco'])!;
      return new DataView(stco.payload.buffer, stco.payload.byteOffset).getUint32(8, false);
    });

    expect(file[offsets[0]]).toBe(0x00);
    expect(file[offsets[1]]).toBe(0xa0);
  });

  it('reports the movie duration in its own timescale', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(30));
    const mvhd = findBox(file, ['moov', 'mvhd'])!;
    const view = new DataView(mvhd.payload.buffer, mvhd.payload.byteOffset);
    // Thirty frames at thirty a second is a second, and the timescale is 1000.
    expect(view.getUint32(16, false)).toBeCloseTo(1000, -2);
  });

  it('refuses a sample naming a track that does not exist', () => {
    expect(() => muxMp4({ tracks: [VIDEO] }, [{ ...videoSamples(1)[0], track: 2 }]))
      .toThrow(/only track 1/);
    expect(() => muxMp4({ tracks: [VIDEO, AAC] }, [{ ...videoSamples(1)[0], track: 5 }]))
      .toThrow(/tracks 1 to 2/);
  });

  it('refuses a file with no tracks or no samples', () => {
    expect(() => muxMp4({ tracks: [] }, [])).toThrow(/at least one track/);
    expect(() => muxMp4({ tracks: [VIDEO] }, [])).toThrow(/at least one sample/);
  });

  it('puts samples in time order even when handed them shuffled', () => {
    const samples = videoSamples(5);
    const file = muxMp4({ tracks: [VIDEO] }, [samples[3], samples[0], samples[4], samples[1], samples[2]]);
    const stco = findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])!;
    const offset = new DataView(stco.payload.buffer, stco.payload.byteOffset).getUint32(8, false);
    // The first byte of each sample is its index, so the run should read 0..4.
    expect(Array.from([0, 1, 2, 3, 4].map((index) => file[offset + index * 4]))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('findBox', () => {
  it('walks a path down the tree', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(3));
    expect(findBox(file, ['moov', 'trak', 'mdia', 'minf', 'stbl'])).not.toBeNull();
  });

  it('returns nothing for a path that is not there', () => {
    const file = muxMp4({ tracks: [VIDEO] }, videoSamples(3));
    expect(findBox(file, ['moov', 'nope'])).toBeNull();
  });
});

describe('readBox', () => {
  it('refuses a box claiming more bytes than exist', () => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, 9999, false);
    expect(readBox(bytes, 0)).toBeNull();
  });

  it('refuses a box shorter than its own header', () => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, 4, false);
    expect(readBox(bytes, 0)).toBeNull();
  });
});
