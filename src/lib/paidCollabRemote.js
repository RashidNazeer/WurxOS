// Remote paid-collab data (creators / videos / deals) lives on the
// wurx-base API, backed by Google Sheets. Read-only from our side;
// edits happen in the sheet.

const API_URL = 'https://wurx-base.netlify.app/api/all';
const TTL_MS  = 10 * 60 * 1000;  // 10 minutes

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

export async function fetchCreators({ force = false } = {}) {
  const fresh = _cache && (Date.now() - _cacheAt < TTL_MS);
  if (fresh && !force) return _cache;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`wurx-base ${res.status}`);
      const raw = await res.json();
      const list = Array.isArray(raw) ? raw : (raw?.creators || raw?.data || []);
      _cache   = list.map(normalizeCreator);
      _cacheAt = Date.now();
      return _cache;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

function normalizeCreator(c) {
  const deal = typeof c.deal === 'string' ? c.deal : '';
  const dealAmount = parseDealAmount(deal);
  const hiring = c.hiring_date || c.hiringDate || '';
  const hiringMonth = hiring.length >= 7 ? hiring.slice(0, 7) : '';
  return {
    id:              c.id || c._id || `${c.name}-${c.brand}-${hiring}`,
    name:            c.name || c.creator || '—',
    brand:           c.brand || '',
    product:         c.product || '',
    deal,
    dealAmount,
    paymentStatus:   normStatus(c.payment_status || c.paymentStatus),
    videosStatus:    normStatus(c.videos || c.videoStatus),
    hiredBy:         c.hired_by || c.hiredBy || '',
    hiringDate:      hiring,
    hiringMonth,
    tiktokAccount:   c.tiktok_account || c.tiktokAccount || '',
    videoCodes:      Array.isArray(c.video_codes) ? c.video_codes : (Array.isArray(c.videoCodes) ? c.videoCodes : []),
    _raw:            c,
  };
}

function parseDealAmount(deal) {
  if (!deal) return 0;
  const m = String(deal).match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : 0;
}

function normStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v.includes('paid') || v === 'done')   return 'paid';
  if (v.includes('pend') || v.includes('progress')) return 'pending';
  if (v.includes('not'))  return 'not_yet';
  return v || 'not_yet';
}

export const PAYMENT_STATUSES = [
  { v: 'paid',    label: 'Paid',    tone: 'success' },
  { v: 'pending', label: 'Pending', tone: 'warning' },
  { v: 'not_yet', label: 'Not yet', tone: 'muted' },
];

export const VIDEO_STATUSES = [
  { v: 'paid',    label: 'Done',        tone: 'success' },   // 'paid' from normStatus = 'done'
  { v: 'pending', label: 'In progress', tone: 'warning' },
  { v: 'not_yet', label: 'Not yet',     tone: 'muted' },
];

export function statusLabel(list, v) {
  return list.find((s) => s.v === v)?.label || v;
}

export function tiktokEmbedUrl(videoUrl) {
  if (!videoUrl) return null;
  // Matches /video/1234567 or /@handle/video/1234567
  const m = String(videoUrl).match(/\/video\/(\d+)/);
  if (!m) return null;
  return `https://www.tiktok.com/embed/v2/${m[1]}`;
}

export function formatMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
