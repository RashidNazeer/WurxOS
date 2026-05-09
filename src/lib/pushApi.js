import { supabase } from './supabase';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

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

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
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
