// "Recently visited" for global search. Per user, in localStorage
// (wurxos.recent.<uid>), max 8, newest first, de-duplicated by path.
// AppShell records every route change with the topbar title; a page that
// knows a better title (a brand or report name) calls recordVisit({ title })
// after it loads and the entry for the current path is updated in place.

const MAX = 8;
const SKIP = [/^\/$/, /^\/dashboard\/?$/, /^\/login/, /^\/signup/, /\/(new|edit)\/?$/];
let currentUid = null;

const keyFor = (uid) => `wurxos.recent.${uid}`;

function read(uid) {
  if (!uid) return [];
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(uid)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function write(uid, list) {
  try { localStorage.setItem(keyFor(uid), JSON.stringify(list.slice(0, MAX))); } catch { /* storage off */ }
}

export function setRecentUser(uid) { currentUid = uid || null; }

export function kindForPath(path) {
  if (/^\/(weekly|biweekly|monthly)-reports|^\/r\//.test(path)) return 'report';
  if (/^\/brands\//.test(path)) return 'brand';
  if (/^\/tasks/.test(path)) return 'task';
  return 'page';
}

export function recordVisit({ path, title, kind } = {}) {
  const uid = currentUid;
  const p = path || (typeof window !== 'undefined' ? window.location.pathname + window.location.search : '');
  if (!uid || !p || SKIP.some((re) => re.test(p.split('?')[0]))) return;
  const list = read(uid);
  const existing = list.find((v) => v.path === p);
  const entry = {
    path: p,
    title: title || existing?.title || p,
    kind: kind || existing?.kind || kindForPath(p),
    ts: Date.now(),
  };
  write(uid, [entry, ...list.filter((v) => v.path !== p)]);
}

export function listVisits(uid = currentUid) { return read(uid); }

export function clearVisits(uid = currentUid) {
  if (!uid) return;
  try { localStorage.removeItem(keyFor(uid)); } catch { /* ignore */ }
}
