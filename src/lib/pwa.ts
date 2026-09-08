/**
 * Progressive web app plumbing: register the worker, offer installation when
 * the browser says it is possible, and say something useful when the network
 * goes away. Cached tools remain available offline; optional engines and
 * models must be downloaded before their first use.
 */
import { toast } from './toast';

export function setupPwa(): void {
  registerWorker();
  wireInstallPrompt();
  wireOfflineIndicator();
}

function registerWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

  let observed: ServiceWorkerRegistration | null = null;
  const connect = async () => {
    try {
      // Looking up an existing registration works offline. Re-registering first
      // can reject in Firefox and leave a cached page without update listeners.
      const registration = await navigator.serviceWorker.getRegistration('/')
        ?? await navigator.serviceWorker.register('/sw.js');
      if (observed !== registration) {
        observed = registration;
        const offerUpdate = (worker: ServiceWorker) => {
          toast('A new version is ready.', {
            actionLabel: 'Reload',
            onAction: () => {
              navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
              worker.postMessage('skip-waiting');
            },
          });
        };
        if (registration.waiting) offerUpdate(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(installing);
          });
        });
      }
      if (navigator.onLine) void registration.update().catch(() => {});
    } catch {
      // First-time registration can fail offline or in private windows.
      // Retry when connectivity returns; the ordinary page still works.
    }
  };
  if (document.readyState === 'complete') void connect();
  else window.addEventListener('load', () => { void connect(); }, { once: true });
  window.addEventListener('online', () => { void connect(); });

}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function wireInstallPrompt(): void {
  const button = document.getElementById('install-app');
  if (!button) return;

  let deferred: InstallPromptEvent | null = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    button.hidden = false;
  });

  button.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    button.hidden = true;
    if (outcome === 'accepted') toast('Installed. It will open like any other app.', { kind: 'good' });
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
  });

  // Already running as an installed app, so there is nothing to offer.
  if (window.matchMedia('(display-mode: standalone)').matches) button.hidden = true;
}

function wireOfflineIndicator(): void {
  const badge = document.getElementById('offline-badge');
  if (!badge) return;

  const update = () => { badge.hidden = navigator.onLine; };
  window.addEventListener('online', () => {
    update();
    toast('Back online.', { kind: 'good', duration: 2000 });
  });
  window.addEventListener('offline', () => {
    update();
    toast('Offline. Cached tools and your saved data are available.', { duration: 4000 });
  });
  update();
}
