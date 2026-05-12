import { supabase } from './supabase';
import { logAppEvent } from './appEvents';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// Map a DOMException raised by pushManager.subscribe() into something a
// user can actually act on. Generic "push service error" reveals nothing
// about whether it's a Windows-notifications-off case, a corp-policy
// case, a bad VAPID key, or a network blip — different fixes for each.
function explainPushError(err) {
  const name = err?.name || '';
  const msg  = String(err?.message || err || '');
  if (name === 'NotAllowedError') {
    return 'The browser blocked the push subscription. Open browser site settings and allow notifications, then try again.';
  }
  if (name === 'AbortError') {
    return 'The push service handshake was aborted. This usually means Windows system notifications are off — open Settings → Notifications, turn them on, then try again.';
  }
  if (name === 'NotSupportedError') {
    return 'This browser/profile does not support push (guest mode, private window, or an enterprise policy may be blocking it).';
  }
  if (name === 'InvalidStateError') {
    return 'There is a stale push subscription. Disable it, refresh the page, then try enabling again.';
  }
  if (name === 'NetworkError') {
    return 'The browser could not reach the push service. Check your internet connection (or a corporate firewall) and try again.';
  }
  if (/applicationServerKey is not valid/i.test(msg)) {
    return 'The VAPID public key is invalid. Please contact Mr Rashid — this is a server config issue, not your laptop.';
  }
  // Fallback: surface the raw browser message so we can debug it.
  return `Push registration failed (${name || 'error'}): ${msg}`;
}

export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function permissionState() {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registerSW() {
  const existing = await navigator.serviceWorker.getRegistration('/sw.js');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js');
}

export async function getCurrentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function enablePush(userId) {
  if (!pushSupported())  throw new Error('Push is not supported in this browser.');
  if (!VAPID_PUBLIC_KEY) throw new Error('VAPID public key missing. Add VITE_VAPID_PUBLIC_KEY to .env.local.');

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted.');

  const reg = await registerSW();
  await navigator.serviceWorker.ready;

  // pushManager.subscribe is the call that throws "push service error"
  // when Windows Notifications are off or a corp policy is in the way.
  // Wrap it so we can attach a human-friendly explanation and log the
  // raw failure to app_events for later forensics.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    } catch (err) {
      // Persist the raw browser-side details so we can correlate
      // user reports without asking them to open DevTools.
      try {
        logAppEvent(userId, 'push.subscribe_failed', {
          name: err?.name || null,
          message: String(err?.message || err).slice(0, 500),
          user_agent: navigator.userAgent.slice(0, 300),
        });
      } catch {}
      const wrapped = new Error(explainPushError(err));
      wrapped.cause = err;
      wrapped.code  = err?.name || null;
      throw wrapped;
    }
  }

  const raw = sub.toJSON();
  const row = {
    user_id:    userId,
    endpoint:   raw.endpoint,
    p256dh:     raw.keys?.p256dh,
    auth:       raw.keys?.auth,
    user_agent: navigator.userAgent,
  };

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(row, { onConflict: 'endpoint' });
  if (error) throw error;

  return sub;
}

export async function disablePush() {
  const sub = await getCurrentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch (_) {}
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

// List every push subscription tied to the current user. RLS on the
// table scopes results to `auth.uid() = user_id`, so this is safe
// even though we don't add an explicit filter.
export async function listMyPushSubscriptions() {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, user_agent, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// Remove one subscription. If it happens to be this browser's, also
// unregister it from the push service so we don't leak a dead entry
// next time the user re-enables push here.
export async function removePushSubscription(id, endpoint) {
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);

  const current = await getCurrentSubscription();
  if (current && current.endpoint === endpoint) {
    try { await current.unsubscribe(); } catch (_) {}
  }
}

// Derive a friendly "Chrome on Windows" style label from the stored
// user_agent, and a short origin-ish host from the push endpoint
// (fcm.googleapis.com → Google/Chrome; mozilla.com → Firefox; etc.).
export function describePushSubscription({ endpoint = '', user_agent = '' } = {}) {
  const ua = user_agent || '';
  const browser = /Edg\//.test(ua)      ? 'Edge'
               : /Chrome\//.test(ua)    ? 'Chrome'
               : /Firefox\//.test(ua)   ? 'Firefox'
               : /Safari\//.test(ua)    ? 'Safari'
               : 'Unknown browser';
  const os = /Windows NT/.test(ua)      ? 'Windows'
           : /Mac OS X/.test(ua)        ? 'macOS'
           : /Android/.test(ua)         ? 'Android'
           : /iPhone|iPad/.test(ua)     ? 'iOS'
           : /Linux/.test(ua)           ? 'Linux'
           : '';
  let host = '';
  try { host = new URL(endpoint).host; } catch (_) {}
  const service = /googleapis|fcm\./.test(host)   ? 'Google push'
               : /mozilla\./.test(host)            ? 'Mozilla push'
               : /windows\.com/.test(host)         ? 'Windows push'
               : host || 'push service';
  return { browser, os, service, label: os ? `${browser} on ${os}` : browser };
}
