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

// ── Asia/Karachi calendar helpers ─────────────────────────────
// The DB is Asia/Karachi-locked (mig 095) but the cluster runs UTC and browsers
// are local, so "what day/month is it" must be asked in Karachi or it is wrong
// for the first ~5h of every UTC day and at every month boundary. These derive
// the Karachi calendar date from the SERVER-anchored clock (getNow), so a user
// with a wrong system clock still gets the right business day. Use these instead
// of new Date().toISOString().slice(...) or getFullYear()/getMonth() anywhere a
// business "today"/"this month" is needed (attendance, incentives, performance).
const _KARACHI_PARTS = (ms) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => p.find((x) => x.type === t)?.value;
  return { y: get('year'), m: get('month'), d: get('day') };
};

// 'YYYY-MM-DD' for the Karachi business day.
export function karachiYmd(ms = getNow()) {
  const { y, m, d } = _KARACHI_PARTS(ms);
  return `${y}-${m}-${d}`;
}

// 'YYYY-MM' for the Karachi business month.
export function karachiMonth(ms = getNow()) {
  const { y, m } = _KARACHI_PARTS(ms);
  return `${y}-${m}`;
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
