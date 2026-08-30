/**
 * Progressive web app plumbing: register the worker, offer installation when
 * the browser says it is possible, and say something useful when the network
 * goes away. None of the apps need a connection, so going offline should be
 * reassuring rather than alarming.
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

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // A new version is ready and an old one is still driving the page.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready.', {
              actionLabel: 'Reload',
              onAction: () => {
                installing.postMessage('skip-waiting');
                window.location.reload();
              },
            });
          }
        });
      });
    }).catch(() => {
      /* Registration can fail in private windows. The site still works. */
    });
  });
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
    toast('Offline. Everything here still works.', { duration: 4000 });
  });
  update();
}
