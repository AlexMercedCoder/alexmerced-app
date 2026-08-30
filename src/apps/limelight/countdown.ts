/**
 * The three, two, one before a recording starts.
 *
 * It exists for a practical reason rather than a decorative one: the share
 * dialog leaves you looking at the browser, and without a moment to get back to
 * whatever you meant to demonstrate, the first seconds of every recording are
 * of you finding your place.
 *
 * The tone is synthesised rather than loaded, because a sound file would be the
 * only asset this app fetches at runtime.
 */

export type CountdownOptions = {
  seconds: number;
  sound: boolean;
  /** Where to put the overlay. Defaults to the document body. */
  host?: HTMLElement;
  signal?: AbortSignal;
};

/** Resolves when the count reaches zero, or immediately if there is nothing to count. */
export async function countdown(options: CountdownOptions): Promise<void> {
  const seconds = Math.max(0, Math.min(10, Math.round(options.seconds)));
  if (seconds === 0) return;

  const host = options.host ?? document.body;
  const overlay = document.createElement('div');
  overlay.className = 'll-countdown';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'assertive');

  const number = document.createElement('strong');
  const note = document.createElement('span');
  note.textContent = 'Recording starts in';
  overlay.append(note, number);
  host.append(overlay);

  const beeper = options.sound ? tones() : null;

  try {
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (options.signal?.aborted) return;
      number.textContent = String(remaining);
      // Restarting the animation is what makes each number land as its own
      // beat rather than the first one playing and the rest appearing.
      number.style.animation = 'none';
      void number.offsetWidth;
      number.style.animation = '';
      beeper?.(remaining === 1 ? 880 : 620, 0.09);
      await pause(1000, options.signal);
    }
    number.textContent = 'Go';
    beeper?.(1180, 0.16);
    await pause(320, options.signal);
  } finally {
    overlay.remove();
    beeper?.close();
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, ms);
    function finish(): void {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * A short sine blip with a soft edge on both ends. A square wave would be
 * louder for the same effort and would also sound like an alarm.
 */
function tones(): ((frequency: number, duration: number) => void) & { close: () => void } {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
  } catch {
    context = null;
  }

  const play = (frequency: number, duration: number) => {
    if (!context) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  };

  play.close = () => { void context?.close().catch(() => {}); };
  return play;
}
