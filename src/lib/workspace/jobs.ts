/** A consistent cancellable job surface. Callers retain input so a failed job can retry. */
let active = false;
export async function runJob<T>(title: string, work: (signal: AbortSignal, progress: (text: string) => void) => Promise<T>): Promise<T> {
  if (active) throw new Error('Wait for the current job to finish or cancel it first.');
  active = true;
  const previousFocus = document.activeElement as HTMLElement | null;
  const controller = new AbortController();
  const panel = document.createElement('section'); panel.className = 'workspace-job'; panel.setAttribute('aria-label', title);
  const label = document.createElement('strong'); label.textContent = title;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Starting…';
  const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = 'Cancel'; cancel.setAttribute('aria-label', `Cancel ${title.toLowerCase()}`);
  cancel.onclick = () => { controller.abort(); cancel.disabled = true; status.textContent = 'Cancelling…'; };
  panel.append(label, status, cancel); document.body.append(panel);
  try { return await work(controller.signal, text => { if (!controller.signal.aborted) status.textContent = text; }); }
  finally { const returnFocus = panel.contains(document.activeElement); panel.remove(); active = false; if (returnFocus && previousFocus?.isConnected) previousFocus.focus(); }
}
