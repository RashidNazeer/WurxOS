// Local safety copy of a Weekly Checkpoint the database has not confirmed yet
// (a flaky connection must not lose an APC's work).
//
// ── ONE PERSON, ONE BRAND, ONE WEEK ─────────────────────────────────────────
// Prod incident, 15 Sept 2026: copies were keyed by brand + week only and were
// written on every edit. A TL who had an APC's Kenashii checkpoint open and
// switched brand got that checkpoint copied under Bentgo and Pure Daily Care,
// and the copies were then saved to the database under the TL's login with the
// APC's name on the cover. Now a copy is keyed by the signed-in user as well,
// records whose it is and which brand and week it belongs to, and is restored
// only when all three match. Copies from the old scheme are deleted unread.

import { EMPTY_CHECKPOINT } from './checkpointModel';

const LEGACY_PREFIX = 'wurxos.checkpoint.';
const PREFIX = 'wurxos.checkpoint.v2::';

const keyFor = (userId, brandId, weekStart) => `${PREFIX}${userId}::${brandId}::${weekStart}`;

// Deep-merge a saved payload over a fresh empty template so older data that
// predates a new field still loads with that field defaulted (never undefined).
// Exported so DB-loaded checkpoints get the same safety.
export function hydrate(saved) {
  const base = EMPTY_CHECKPOINT();
  if (!saved || typeof saved !== 'object') return base;
  const merge = (b, s) => {
    if (Array.isArray(b)) return Array.isArray(s) ? s : b;
    if (b && typeof b === 'object') {
      const out = { ...b };
      for (const k of Object.keys(b)) out[k] = k in (s || {}) ? merge(b[k], s[k]) : b[k];
      return out;
    }
    return s === undefined ? b : s;
  };
  return merge(base, saved);
}

/** Deletes every copy saved under the old brand + week key. Returns how many. */
export function purgeLegacyDrafts() {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX) && !key.startsWith(PREFIX)) stale.push(key);
    }
    stale.forEach((key) => localStorage.removeItem(key));
    return stale.length;
  } catch { return 0; }
}

/** This person's own unsynced copy of this brand + week, or null. */
export function loadDraft(userId, brandId, weekStart) {
  if (!userId || !brandId || !weekStart) return null;
  try {
    const raw = localStorage.getItem(keyFor(userId, brandId, weekStart));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    // Trust what the copy says about itself, not only the key it sits under.
    if (saved?.v !== 2 || saved.userId !== userId || saved.brandId !== brandId || saved.weekStart !== weekStart) return null;
    return hydrate(saved.data);
  } catch { return null; }
}

export function saveDraft(userId, brandId, weekStart, data) {
  if (!userId || !brandId || !weekStart || !data) return false;
  try {
    localStorage.setItem(
      keyFor(userId, brandId, weekStart),
      JSON.stringify({ v: 2, userId, brandId, weekStart, savedAt: Date.now(), data }),
    );
    return true;
  } catch { return false; }
}

/**
 * Removes the copy once the database has it. Pass the saved snapshot so a copy
 * of NEWER edits made while that save was in flight is kept.
 */
export function clearDraft(userId, brandId, weekStart, onlyIfSnapshot = null) {
  if (!userId || !brandId || !weekStart) return;
  try {
    const key = keyFor(userId, brandId, weekStart);
    if (onlyIfSnapshot != null) {
      const raw = localStorage.getItem(key);
      if (raw && JSON.stringify(JSON.parse(raw).data) !== onlyIfSnapshot) return;
    }
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}
