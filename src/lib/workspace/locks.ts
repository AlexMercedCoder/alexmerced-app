/** One editing tab per tool prevents stale tabs from overwriting newer work. */
export async function withWorkspaceLock<T>(app: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return work();
  return navigator.locks.request(`workspace:${app}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(`Close the other ${app} tab before changing its saved work.`);
    return work();
  });
}
export async function mountWorkspace(app: string, mount: () => unknown): Promise<void> {
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  const run = async () => {
    await mount();
    document.querySelector('main')?.setAttribute('data-workspace-ready', app);
    await new Promise<void>((resolve) => window.addEventListener('pagehide', () => resolve(), { once: true }));
  };
  try { await withWorkspaceLock(app, run); }
  catch (error) {
    const panel = document.createElement('section');
    panel.className = 'workspace-notice';
    panel.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = error instanceof Error ? error.message : 'This workspace could not open.';
    const retry = document.createElement('button');
    retry.className = 'btn'; retry.textContent = 'Try again'; retry.onclick = () => location.reload();
    panel.append(message, retry);
    const main = document.querySelector('main')!;
    main.replaceChildren(panel);
  }

}
