/** A temporary device preview. Closing or starting recording releases every track. */
export function mountDeviceCheck(
  root: HTMLElement,
  devices: () => { microphoneId: string; cameraId: string },
  busy: () => boolean,
) {
  const dialog = root.querySelector<HTMLDialogElement>('#ll-device-dialog')!;
  const video = root.querySelector<HTMLVideoElement>('#ll-device-video')!;
  const meter = root.querySelector<HTMLMeterElement>('#ll-device-meter')!;
  const status = root.querySelector<HTMLElement>('#ll-device-status')!;
  let stream: MediaStream | null = null,
    context: AudioContext | null = null,
    frame = 0,
    generation = 0;
  function stop() {
    generation++;
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void context?.close().catch(() => {});
    context = null;
    video.srcObject = null;
    video.hidden = true;
    meter.value = 0;
  }
  root.querySelector('#ll-device-close')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stop);
  dialog.addEventListener('cancel', stop);
  root.querySelector('#ll-record')!.addEventListener(
    'click',
    () => {
      stop();
      if (dialog.open) dialog.close();
    },
    true,
  );
  root.querySelector('#ll-device-check')!.addEventListener('click', async () => {
    if (busy()) return;
    stop();
    const token = generation;
    dialog.showModal();
    status.textContent = 'Waiting for device permission.';
    const audio = root.querySelector<HTMLInputElement>('#ll-mic')!.checked;
    const camera = root.querySelector<HTMLInputElement>('#ll-camera')!.checked;
    if (!audio && !camera) {
      status.textContent =
        'Select Microphone or Camera in the recording options, then open setup again.';
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Device preview is unavailable in this browser.');
      const selected = devices(),
        constraint = (id: string) => (id && id !== 'default' ? { deviceId: { exact: id } } : true);
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: audio ? constraint(selected.microphoneId) : false,
        video: camera ? constraint(selected.cameraId) : false,
      });
      if (token !== generation || !dialog.open) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      if (camera) {
        video.hidden = false;
        video.srcObject = stream;
        await video.play();
        if (token !== generation) return;
      }
      if (audio) {
        context = new AudioContext();
        await context.resume();
        if (token !== generation) return;
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const values = new Float32Array(analyser.fftSize);
        const tick = () => {
          if (token !== generation) return;
          analyser.getFloatTimeDomainData(values);
          meter.value = Math.min(
            1,
            Math.sqrt(values.reduce((n, v) => n + v * v, 0) / values.length) * 4,
          );
          frame = requestAnimationFrame(tick);
        };
        tick();
      }
      status.textContent = stream
        .getTracks()
        .map((t) => `${t.kind === 'audio' ? 'Microphone' : 'Camera'}: ${t.label || 'Connected'}`)
        .join('. ');
    } catch (e) {
      if (token !== generation) return;
      stop();
      status.textContent =
        e instanceof Error
          ? `Could not open the selected devices: ${e.message}`
          : 'Could not open the selected devices.';
    }
  });
  window.addEventListener('pagehide', stop);
}
