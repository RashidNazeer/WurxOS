/**
 * Knowledge Base duplicate detection helpers.
 *
 * Used to:
 *   1. Block save when the same URL is already in the library.
 *   2. Power a "Check Duplicates" review modal for Boss.
 *
 * Matching is intentionally loose (canonical URL + lowercased title) so
 * small variations like trailing slashes, utm params, or extra whitespace
 * are caught.
 */

export function normalizeUrl(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s) return '';
  try {
    const hasProtocol = /^https?:\/\//i.test(s);
    const u = new URL(hasProtocol ? s : `https://${s}`);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '');
    const drop = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']);
    const params = [...u.searchParams.entries()].filter(([k]) => !drop.has(k.toLowerCase()));
    params.sort(([a], [b]) => a.localeCompare(b));
    const search = params.length ? ('?' + params.map(([k, v]) => `${k}=${v}`).join('&')) : '';
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\/+$/, '');
  }
}

export function normalizeTitle(input) {
  return (input || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findDuplicateByUrl(url, items, { excludeId } = {}) {
  const key = normalizeUrl(url);
  if (!key) return null;
  for (const it of items) {
    if (excludeId && it.id === excludeId) continue;
    if (normalizeUrl(it.url) === key) return it;
  }
  return null;
}

export function findDuplicateByTitle(title, items, { excludeId } = {}) {
  const key = normalizeTitle(title);
  if (!key) return null;
  for (const it of items) {
    if (excludeId && it.id === excludeId) continue;
    if (normalizeTitle(it.title) === key) return it;
  }
  return null;
}

export function groupDuplicates(items) {
  const byUrl = new Map();
  const byTitle = new Map();
  items.forEach((it) => {
    const u = normalizeUrl(it.url);
    if (u) {
      if (!byUrl.has(u)) byUrl.set(u, []);
      byUrl.get(u).push(it);
    }
    const t = normalizeTitle(it.title);
    if (t) {
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(it);
    }
  });
  const urlGroups   = [...byUrl.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, list }));
  const titleGroups = [...byTitle.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, list }));
  return { urlGroups, titleGroups };
}
