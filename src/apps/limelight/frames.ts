import { demuxWebmVideo, type WebmFrame } from '../../lib/webm-demux';

/**
 * Getting frames out of a recording, in order, without seeking for each one.
 *
 * The export walks the finished video frame by frame, and it used to ask the
 * video element to seek to every one of them. A seek is the most expensive
 * thing a media element does: off a keyframe the decoder rewinds to the last
 * one and decodes forward again. A minute at thirty frames a second is
 * eighteen hundred of those, which is the reason exports were slow, not the
 * encoder.
 *
 * Frames are handed over by increasing time, which is what the export asks for
 * anyway, so a decoder can run straight through the file exactly as it was
 * built to. When any of this is unavailable, or the file is not a WebM this
 * understands, the caller falls back to seeking and simply takes longer.
 */

export type FrameSource = {
  /** The frame to draw for a moment in the recording, or null to seek instead. */
  frameAt(time: number): Promise<VideoFrame | null>;
  close(): void;
};

export function canDecodeSequentially(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

/**
 * Builds a sequential source for a recording, or null if one is not possible.
 *
 * Returning null rather than throwing is deliberate: every reason this can fail
 * is a reason to use the slower path, not a reason to refuse the export.
 */
export async function openFrameSource(
  blob: Blob, shared?: ArrayBuffer,
): Promise<FrameSource | null> {
  if (!canDecodeSequentially()) return null;

  let parsed;
  try {
    // The caller may already have read the file, in which case reading it again
    // would hold a second full copy of the recording for no reason. Export does
    // exactly that: it needs the bytes for the video and again for the sound.
    parsed = demuxWebmVideo(new Uint8Array(shared ?? await blob.arrayBuffer()));
  } catch {
    return null;
  }
  if (!parsed?.track.webCodec) return null;

  const config: VideoDecoderConfig = {
    codec: parsed.track.webCodec,
    codedWidth: parsed.track.width || undefined,
    codedHeight: parsed.track.height || undefined,
    ...(parsed.track.description ? { description: parsed.track.description } : {}),
    optimizeForLatency: false,
  };

  try {
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) return null;
  } catch {
    return null;
  }

  return new SequentialFrames(parsed.frames, config);
}

class SequentialFrames implements FrameSource {
  private decoder: VideoDecoder | null = null;
  /** Decoded frames waiting to be asked for, oldest first. */
  private queue: VideoFrame[] = [];
  /** The most recent frame handed out, held until something later replaces it. */
  private current: VideoFrame | null = null;
  private next = 0;
  private failed = false;
  private closed = false;
  private drained = false;
  /** Resolves the current pump when a frame arrives. */
  private waiting: (() => void) | null = null;

  constructor(private readonly frames: WebmFrame[], private readonly config: VideoDecoderConfig) {}

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder || this.failed) return this.decoder;
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          if (this.closed) { frame.close(); return; }
          this.queue.push(frame);
          const waiting = this.waiting;
          this.waiting = null;
          waiting?.();
        },
        // A decode error is not worth losing the export over: the caller can
        // still seek. The source simply stops producing.
        error: () => {
          this.failed = true;
          const waiting = this.waiting;
          this.waiting = null;
          waiting?.();
        },
      });
      this.decoder.configure(this.config);
    } catch {
      this.failed = true;
      this.decoder = null;
    }
    return this.decoder;
  }

  /**
   * Waits for the decoder to hand something over, or gives up after a moment.
   *
   * The timeout is a stall guard rather than a normal path: a decoder that has
   * gone quiet with work outstanding would otherwise hang the export.
   */
  private pump(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.waiting === finish) this.waiting = null;
        resolve();
      };
      this.waiting = finish;
      setTimeout(finish, 250);
    });
  }

  /** Feeds chunks until something at or past the wanted time has come out. */
  private async fill(wanted: number): Promise<void> {
    const decoder = this.ensureDecoder();
    if (!decoder) return;

    while (!this.failed) {
      const newest = this.queue[this.queue.length - 1];
      if (newest && newest.timestamp >= wanted) return;

      if (this.next >= this.frames.length) {
        // Everything has been fed, so flushing is safe here: nothing else will
        // be decoded afterwards.
        if (!this.drained) {
          this.drained = true;
          try { await decoder.flush(); } catch { this.failed = true; }
        }
        return;
      }

      // Keep the decoder busy without swamping it, by waiting for frames to
      // come out rather than flushing.
      //
      // Flushing is the obvious way to throttle and it is wrong here: a VP8 or
      // VP9 decoder requires a keyframe after a flush, and the next chunk is
      // almost always a delta. Doing it that way delivered nine frames and then
      // failed for the rest of the recording.
      while (decoder.decodeQueueSize > 16 && !this.failed) await this.pump();
      if (this.failed) return;

      const frame = this.frames[this.next];
      this.next += 1;
      try {
        decoder.decode(new EncodedVideoChunk({
          type: frame.keyframe ? 'key' : 'delta',
          timestamp: frame.timestamp,
          data: frame.data as unknown as BufferSource,
        }));
      } catch {
        this.failed = true;
        return;
      }

      // Nothing has come out yet on the first pass, so give the decoder a
      // chance rather than feeding the whole file into it at once.
      if (this.queue.length === 0 && decoder.decodeQueueSize > 4) await this.pump();
    }
  }

  async frameAt(time: number): Promise<VideoFrame | null> {
    if (this.failed || this.closed) return null;
    const wanted = Math.round(time * 1_000_000);

    await this.fill(wanted);
    if (this.failed) return null;

    // Advance through everything at or before the wanted moment, keeping the
    // last one. Frames passed over are closed straight away, because a
    // VideoFrame holds a hardware buffer until it is.
    while (this.queue.length > 0 && this.queue[0].timestamp <= wanted) {
      this.current?.close();
      this.current = this.queue.shift() ?? null;
    }

    // Before the first frame there is nothing to show yet, which happens when
    // an export starts at a moment earlier than any decoded timestamp.
    if (!this.current && this.queue.length > 0) {
      this.current = this.queue.shift() ?? null;
    }
    return this.current;
  }

  close(): void {
    this.closed = true;
    for (const frame of this.queue) frame.close();
    this.queue = [];
    this.current?.close();
    this.current = null;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
    try { this.decoder?.close(); } catch { /* already gone */ }
    this.decoder = null;
  }
}
