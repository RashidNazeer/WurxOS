import { useEffect, useRef, useState } from 'react';

// A drop-in replacement for useState that remembers the value for the tab.
//
// WHY: the reports lists open a report by swapping the page's own render, not
// by changing the URL. So the in-page "Back to all reports" button keeps your
// filters, but the BROWSER back button — which is what people actually press —
// leaves /weekly-reports altogether, and coming back remounts the page with
// every filter cleared. Same story after visiting any other page and returning.
//
// sessionStorage, not localStorage, on purpose: a filter should outlive
// navigation but not the tab. Coming back tomorrow to a list still filtered to
// one client and one week, with no memory of setting it, is worse than a clean
// slate.
//
// Storage can throw outright (private browsing, blocked site data), so every
// read and write is guarded and the hook silently degrades to plain useState.
export function useStickyState(key, initial) {
  const storageKey = `wx.sticky.${key}`;

  const [value, setValue] = useState(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      // Guard against a stored shape that no longer matches the code, e.g. a
      // filter that used to be a string and is now an array. Falling back to
      // the default beats handing the page a value it cannot render.
      if (Array.isArray(initial) !== Array.isArray(parsed)) return initial;
      return parsed;
    } catch {
      return initial;
    }
  });

  // Skip the very first write: it would only rewrite what we just read, and on
  // a fresh page it would persist the default before the user has done
  // anything.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch { /* storage unavailable — the filter just will not stick */ }
  }, [storageKey, value]);

  return [value, setValue];
}

// Clear every sticky value for one page, for a "Reset filters" control.
export function clearStickyState(prefix) {
  try {
    const full = `wx.sticky.${prefix}`;
    const doomed = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(full)) doomed.push(k);
    }
    doomed.forEach((k) => window.sessionStorage.removeItem(k));
  } catch { /* nothing to do */ }
}
