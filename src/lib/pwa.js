// Registers the service worker on boot and captures the browser's
// install prompt so the UI can offer "Install app" at a time of
// our choosing. Kept tiny — push subscription is handled elsewhere.

let deferredPrompt = null;
const listeners = new Set();

function emit() {
  for (const cb of listeners) {
    try { cb(!!deferredPrompt); } catch (_) { /* noop */ }
  }
}

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Only register in production builds — the dev server serves a fresh
  // bundle every reload and an aggressive SW fetch handler will fight it.
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* best effort */ });
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    emit();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });
}

export function canInstall() {
  return !!deferredPrompt;
}

export function onInstallAvailable(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const p = deferredPrompt;
  deferredPrompt = null;
  emit();
  try {
    await p.prompt();
    const choice = await p.userChoice;
    return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch (_) {
    return 'error';
  }
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}
