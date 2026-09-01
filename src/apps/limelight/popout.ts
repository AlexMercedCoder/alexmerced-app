import { toast } from '../../lib/toast';

/**
 * The preview, floating in a window of its own.
 *
 * Picture in picture only accepts a video, and the preview is a canvas, so the
 * canvas is streamed into one. What floats is exactly what the editor draws,
 * which means it follows the scrubber and every setting rather than being a
 * second renderer that could disagree with the first.
 */

export type PopoutHandle = {
  /** Whether this browser can do it at all. */
  available: boolean;
};

export function mountPopout(
  button: HTMLButtonElement,
  canvas: HTMLCanvasElement,
  redraw: () => Promise<void>,
): PopoutHandle {
  const available = typeof document !== 'undefined'
    && 'pictureInPictureEnabled' in document
    && document.pictureInPictureEnabled
    && typeof canvas.captureStream === 'function';

  button.hidden = !available;
  if (!available) return { available };

  let floating: HTMLVideoElement | null = null;

  button.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }

      if (!floating) {
        floating = document.createElement('video');
        floating.muted = true;
        floating.playsInline = true;
        floating.addEventListener('leavepictureinpicture', () => {
          button.textContent = 'Pop out';
        });
      }
      // A fresh stream each time, since the canvas is resized when the output
      // size changes and a stream captured from the old size would be stale.
      floating.srcObject = canvas.captureStream(30);
      await floating.play();
      await floating.requestPictureInPicture();
      button.textContent = 'Put back';
      // The stream only carries frames the canvas actually draws, so an idle
      // editor would show a still. Redrawing once gives it something to start on.
      await redraw();
    } catch {
      toast('This browser would not open a floating preview.');
    }
  });

  return { available };
}
