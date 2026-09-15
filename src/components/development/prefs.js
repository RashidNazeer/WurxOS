// Per-viewer conveniences (zoom, list or board). Browser storage can be missing
// or blocked, so every read and write falls back quietly.
export function readPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the preference just isn't remembered */
  }
}
