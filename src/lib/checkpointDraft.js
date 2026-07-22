// Local draft persistence for the Weekly Checkpoint builder.
//
// v1 keeps everything client-side: no DB round-trip. A draft is saved to
// localStorage keyed by brand + week so an APC can fill it over a couple of
// sittings without losing work, and each brand/week keeps its own draft.
// (When we add auto-fetch + sharing later this becomes a server table.)

import { EMPTY_CHECKPOINT } from './checkpointModel';

const PREFIX = 'wurxos.checkpoint.';

const keyFor = (brandId, weekLabel) =>
  `${PREFIX}${brandId || 'nobrand'}::${(weekLabel || '').trim() || 'nodate'}`;

// Deep-merge a saved draft over a fresh empty template so older drafts that
// predate a new field still load with that field defaulted (never undefined).
function hydrate(saved) {
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

export function loadDraft(brandId, weekLabel) {
  try {
    const raw = localStorage.getItem(keyFor(brandId, weekLabel));
    return raw ? hydrate(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function saveDraft(brandId, weekLabel, data) {
  try {
    localStorage.setItem(keyFor(brandId, weekLabel), JSON.stringify(data));
    return true;
  } catch { return false; }
}

export function clearDraft(brandId, weekLabel) {
  try { localStorage.removeItem(keyFor(brandId, weekLabel)); } catch { /* ignore */ }
}
