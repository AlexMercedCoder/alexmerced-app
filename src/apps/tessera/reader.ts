import { toast } from '../../lib/toast';
import type { Point } from '../../lib/homography';
import { scanImage, ScanError, type ScanResult } from './scan';

/**
 * The reading half of Tessera: camera, files, clipboard, and drag and drop, all
 * feeding the same scanner.
 */

/** How a payload should be described once it has been read. */
export type Reading = {
  kind: string;
  /** A URL, when the payload is one that can safely be opened. */
  link: string | null;
  /** A warning worth showing before anyone follows it. */
  caution: string | null;
};

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'geo:']);

/**
 * Works out what a payload is, and whether it should be offered as a link.
 *
 * A QR code is an instruction from a stranger, so anything that would join a
 * network, send a message, or hand over money is described rather than made
 * clickable. Only plain web and contact links get a button.
 */
export function describePayload(text: string): Reading {
  const trimmed = text.trim();

  if (/^WIFI:/i.test(trimmed)) {
    return {
      kind: 'Wi-Fi network',
      link: null,
      caution: 'This code joins a wireless network. Check the name is one you meant to connect to.',
    };
  }
  if (/^BEGIN:VCARD/i.test(trimmed)) return { kind: 'Contact card', link: null, caution: null };
  if (/^BEGIN:VEVENT/i.test(trimmed)) return { kind: 'Calendar event', link: null, caution: null };
  if (/^otpauth:/i.test(trimmed)) {
    return {
      kind: 'Two factor secret',
      link: null,
      caution: 'This carries an authentication secret. Do not share this code or a picture of it.',
    };
  }
  if (/^bitcoin:|^ethereum:|^lightning:/i.test(trimmed)) {
    return {
      kind: 'Payment request',
      link: null,
      caution: 'This is a request for money. Nothing here can tell you who is asking.',
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }

  if (url && SAFE_SCHEMES.has(url.protocol)) {
    const kind =
      url.protocol === 'mailto:' ? 'Email address'
      : url.protocol === 'tel:' ? 'Phone number'
      : url.protocol === 'sms:' ? 'Text message'
      : url.protocol === 'geo:' ? 'Map location'
      : 'Web address';

    // A hostname made of confusable characters is the oldest trick there is.
    const suspicious = /xn--/i.test(url.hostname) ? 'This address uses non-Latin characters that can imitate a familiar name.' : null;
    return { kind, link: url.protocol.startsWith('http') || url.protocol === 'mailto:' ? url.href : null, caution: suspicious };
  }

  if (url) {
    return {
      kind: `Link using ${url.protocol.replace(':', '')}`,
      link: null,
      caution: 'This uses a scheme that can hand the payload to another app. It is shown as text only.',
    };
  }

  if (/^\d+$/.test(trimmed)) return { kind: 'Number', link: null, caution: null };
  return { kind: 'Plain text', link: null, caution: null };
}

/** Reduces an image so scanning stays quick on a large photograph. */
export function fitToScan(width: number, height: number, longest = 1400): { width: number; height: number } {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type ReaderHandle = {
  scanImageData(image: ImageData): ScanResult;
  destroy(): void;
};

type ReaderOptions = {
  onResult(result: ScanResult, reading: Reading): void;
  onStatus(message: string, state: 'idle' | 'busy' | 'good' | 'bad'): void;
  onFrame(corners: Point[] | null): void;
};

/**
 * Drives a live camera scan. Frames are pulled on an interval rather than every
 * animation frame, because scanning is the expensive part and thirty attempts a
 * second would only heat the phone up.
 */
export class CameraScanner {
  private stream: MediaStream | null = null;
  private timer = 0;
  private busy = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: ReaderOptions,
  ) {}

  get running(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.options.onStatus('Point the camera at a code.', 'busy');

    this.timer = window.setInterval(() => this.tick(), 220);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    if (this.stream) {
      // Releasing the tracks is what turns the recording indicator off.
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.options.onFrame(null);
  }

  private tick(): void {
    if (this.busy || !this.video.videoWidth) return;
    this.busy = true;
    try {
      const size = fitToScan(this.video.videoWidth, this.video.videoHeight, 800);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(this.video, 0, 0, size.width, size.height);
      const image = context.getImageData(0, 0, size.width, size.height);

      const result = scanImage(image);
      // Report in the video's own pixels, so the overlay lines up.
      const factor = this.video.videoWidth / size.width;
      const corners = result.corners.map((point) => ({ x: point.x * factor, y: point.y * factor }));
      this.options.onFrame(corners);
      this.options.onResult({ ...result, corners }, describePayload(result.text));
      this.stop();
    } catch (error) {
      if (!(error instanceof ScanError)) {
        toast('Something went wrong while scanning.', { kind: 'error' });
        this.stop();
      }
    } finally {
      this.busy = false;
    }
  }
}
