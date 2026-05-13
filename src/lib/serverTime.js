import { supabase } from './supabase';

// Drift between server and client clocks, in ms. `serverNow = Date.now() + drift`.
// Stays 0 until the first sync completes, so calls before sync degrade gracefully
// to local Date.now() (current pre-fix behavior).
let drift = 0;
let synced = false;

export function getNow() {
  return Date.now() + drift;
}

export function getNowDate() {
  return new Date(getNow());
}

export function hasSyncedServerTime() {
  return synced;
}

export async function syncServerTime() {
  try {
    const t0 = Date.now();
    const { data, error } = await supabase.rpc('server_now');
    if (error) throw error;
    const t1 = Date.now();
    const serverMs = new Date(data).getTime();
    // Subtract half the roundtrip so the drift reflects the moment of the call,
    // not the moment the response arrived.
    const rtt = t1 - t0;
    drift = serverMs - (t0 + rtt / 2);
    synced = true;
  } catch {
    // Leave drift at its previous value (0 or last successful sync). The
    // running timer will still tick — just anchored to local time, which
    // is correct for users with correct clocks.
  }
}
