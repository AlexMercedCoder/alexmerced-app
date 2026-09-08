import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PdfFile, assemble, isStream } from '../lib/pdf/parse';
import { decodeMatrix } from '../apps/tessera/decode';
import { scanImage, matrixToImage } from '../apps/tessera/scan';
import { demuxWebmVideo } from '../lib/webm-demux';
import { decodeWav } from '../apps/cadence/wav';
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url)));

describe('independently generated compatibility fixtures', () => {
  it('reads compressed ReportLab pages and preserves their content when reordered', async () => {
    const input = await PdfFile.open(fixture('reportlab.pdf'));
    expect(input.pageCount).toBe(2);
    const output = await PdfFile.open(await assemble([{ file: input, pageIndex: 1 }, { file: input, pageIndex: 0 }]));
    const text = async (page: number) => {
      let result = '';
      for (const id of output.dependencies(output.pages[page].ref)) {
        const object = output.getObject(id);
        if (isStream(object)) result += new TextDecoder().decode(await output.decodeStream(object));
      }
      return result;
    };
    expect(await text(0)).toContain('Independent fixture page two');
    expect(await text(1)).toContain('Independent fixture page one');
    expect(output.pages[0].width).toBe(612);
  });

  it('rejects a genuinely encrypted ReportLab document', async () => {
    await expect(PdfFile.open(fixture('reportlab-encrypted.pdf'))).rejects.toThrow(/encrypted/i);
  });

  const codes: { version: number; ec: string; text: string; modules: boolean[][] }[] = JSON.parse(new TextDecoder().decode(fixture('reportlab-qr.json')));
  for (const code of codes) {
    it(`decodes ReportLab QR version ${code.version}, level ${code.ec}, as a matrix and image`, () => {
      expect(decodeMatrix(code.modules).text).toBe(code.text);
      expect(scanImage(matrixToImage(code.modules, 5)).text).toBe(code.text);
    });
  }

  it('demuxes actual FFmpeg VP8 packets and timestamps', () => {
    const video = demuxWebmVideo(fixture('ffmpeg-vp8.webm'))!;
    expect(video.track).toMatchObject({ width: 64, height: 48, codec: 'V_VP8' });
    expect(video.frames).toHaveLength(5);
    expect(video.frames.map((frame) => frame.timestamp)).toEqual([0, 200000, 400000, 600000, 800000]);
    expect(video.frames[0].keyframe).toBe(true);
    expect(video.frames.every((frame) => frame.data.byteLength > 0)).toBe(true);
  });

  it('reads an FFmpeg WAV containing metadata chunks', () => {
    const audio = decodeWav(fixture('ffmpeg-pcm.wav'));
    expect(audio.sampleRate).toBe(8000);
    expect(audio.channels).toHaveLength(1);
    expect(audio.channels[0]).toHaveLength(800);
    expect(Math.max(...audio.channels[0])).toBeCloseTo(0.125, 2);
  });

  it('refuses truncated PDF/WAV headers and truncated QR matrices', async () => {
    for (const length of [0, 1, 4, 8, 16]) {
      await expect(PdfFile.open(fixture('reportlab.pdf').slice(0, length))).rejects.toThrow();
      expect(() => decodeWav(fixture('ffmpeg-pcm.wav').slice(0, length))).toThrow();
    }
    expect(() => decodeMatrix(codes[0].modules.slice(0, 10))).toThrow();
  });
});
