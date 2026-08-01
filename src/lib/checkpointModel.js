// ============================================================
// Weekly Performance Checkpoint — data model + derive/format helpers.
//
// The APC fills this in by hand (v1: no auto-fetch). One object drives both
// the on-screen deck preview and the generated PDF. Field labels live here;
// there is deliberately NO instructional/helper copy (that was for developers,
// never shown to users or in the PDF).
// ============================================================

export function EMPTY_CHECKPOINT() {
  return {
    currency: '$',
    cover: { brandName: '', apcName: '', team: '', weekLabel: '' },

    // Affiliate funnel — recruit (same-week) + produce (cohort approved ~2 wks ago)
    funnel: {
      targetInvites: '', optedIn: '', sampleRequests: '', approved: '',
      approvedN2: '', videosLive: '', affiliateOrders: '',
      notes: '',
    },

    // APC effort log
    effort: {
      invitesSent: '', sampleRequested: '', creatorsOnboarded: '',
      onboardedAutoApproval: '', adCodeFollowups: '', videosAuthNeeded: '',
      narrative: '',
    },

    // Outreach & creator sourcing
    outreach: {
      reachInvites: '', reachCompetitors: '', reachDmEmail: '',
      tierL0L1: '', tierL2: '', tierL3: '', tierL3plus: '',
      niches: '', optInRatePrev: '', readNext: '',
    },

    // Performance snapshot — 8 KPIs, each current + previous (delta auto)
    snapshot: {
      status: 'on_track', // on_track | watch | off_track
      kpis: {
        gmv:          { cur: '', prev: '' },
        gmvMaxSpend:  { cur: '', prev: '' },
        roi:          { cur: '', prev: '' },
        orders:       { cur: '', prev: '' },
        ctor:         { cur: '', prev: '' },
        costPerOrder: { cur: '', prev: '' },
        videosLive:   { cur: '', prev: '' },
        rating:       { cur: '', prev: '' },
      },
      whyMoved: '',
    },

    // Samples
    samples: {
      requestsReceived: '', requestsPrev: '', approvedThisWeek: '', mtdApproved: '',
      sampleToVideoN2: '',
      tiers: { L0: '', L1: '', L2: '', L3: '', L3plus: '' },
      products: [{ name: '', count: '' }],
      notes: '',
    },

    // Content & on-site traffic
    traffic: {
      impressions: '', clicks: '', orders: '',
      impressionsPrev: '', clicksPrev: '', ordersPrev: '',
      topVideos: [{ creator: '', angle: '', gmv: '' }],
      why: '',
    },

    // Creative angle performance
    angles: {
      rows: [{ angle: '', videos: '', gmv: '', cvr: '', verdict: 'scale' }],
      decision: '',
    },

    // GMV Max & paid
    paid: {
      spend: '', grossRevenue: '', skuOrders: '', targetRoi: '',
      spendPrev: '', grossRevenuePrev: '', costPerOrderPrev: '',
      roiProtection: 'on', mode: '',
      decision: '',
      screenshot: '', // data URL (optional)
    },

    // Paid Collab
    paidCollab: {
      creatorsOnboarded: '', totalBudget: '', budgetAllocated: '',
      totalVideos: '', videosCompleted: '', creatorsInPipeline: '',
      notes: '',
    },

    // Research & suggestions
    research: {
      findings: [''],
      suggestions: [{ suggestion: '', impact: '' }],
    },

    // Bottlenecks & action tracker
    actions: {
      bottlenecks: [],
      rows: [{ action: '', owner: '', due: '', status: 'open' }],
    },
  };
}

// KPI display metadata for the snapshot slide.
export const SNAPSHOT_KPIS = [
  { key: 'gmv',          label: 'Total GMV',   fmt: 'money', better: 'up' },
  { key: 'gmvMaxSpend',  label: 'GMV Max Spend', fmt: 'money', better: 'flat' },
  { key: 'roi',          label: 'Blended ROI', fmt: 'x',     better: 'up' },
  { key: 'orders',       label: 'SKU Orders',  fmt: 'int',   better: 'up' },
  { key: 'ctor',         label: 'Video CTOR',  fmt: 'pct',   better: 'up' },
  { key: 'costPerOrder', label: 'Cost / Order', fmt: 'money', better: 'down' },
  { key: 'videosLive',   label: 'Videos Live', fmt: 'int',   better: 'up' },
  { key: 'rating',       label: 'Avg Rating',  fmt: 'ratingNum', better: 'up' },
];

export const VERDICTS = [
  { value: 'scale', label: 'Scale' },
  { value: 'hold',  label: 'Hold' },
  { value: 'test',  label: 'Test' },
  { value: 'kill',  label: 'Kill' },
];

export const ACTION_STATUSES = [
  { value: 'open',        label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done',        label: 'Done' },
];

export const STATUS_OPTIONS = [
  { value: 'on_track',  label: 'On track' },
  { value: 'watch',     label: 'Watch' },
  { value: 'off_track', label: 'Off track' },
];

export const COMMON_BOTTLENECKS = [
  'Mass Authorisation', 'Low creative volume', 'SPS issues',
  'Budget capped', 'Inventory', 'Below break-even ROI',
];

// ── numeric + format helpers ────────────────────────────────────────
export const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Tolerate what people actually type into money/number fields — a currency
  // symbol ("$5,000", even "$$5,000"), thousands separators, "%", stray spaces.
  // Keep only digits, sign and decimal, so budgets don't silently blank to "—".
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
export const ratio = (a, b) => {
  const x = num(a), y = num(b);
  if (x === null || y === null || y === 0) return null;
  return x / y;
};
export const pct = (a, b) => { const r = ratio(a, b); return r === null ? null : r * 100; };
export const deltaPct = (cur, prev) => {
  const c = num(cur), p = num(prev);
  if (c === null || p === null || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
};

export const fmtInt = (v) => { const n = num(v); return n === null ? '—' : Math.round(n).toLocaleString(); };
export const fmtNum = (v, d = 2) => { const n = num(v); return n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: d }); };
export const fmtMoney = (v, sym = '$') => { const n = num(v); return n === null ? '—' : sym + n.toLocaleString(undefined, { maximumFractionDigits: 2 }); };
export const fmtPct = (v, d = 1) => { const n = num(v); return n === null ? '—' : `${n.toFixed(d)}%`; };
export const fmtX = (v) => { const n = num(v); return n === null ? '—' : `${n.toFixed(2)}x`; };

// Format a KPI value by its declared format + currency.
export function fmtKpi(fmtType, v, sym = '$') {
  switch (fmtType) {
    case 'money': return fmtMoney(v, sym);
    case 'x': return fmtX(v);
    case 'pct': return fmtPct(v);
    case 'int': return fmtInt(v);
    case 'ratingNum': { const n = num(v); return n === null ? '—' : `${n.toFixed(1)} / 5`; }
    default: return fmtNum(v);
  }
}

// ── week helpers (weeks are Monday→Sunday; keyed by the Monday date) ──
const _p2 = (n) => String(n).padStart(2, '0');
const _isoOf = (dt) => `${dt.getUTCFullYear()}-${_p2(dt.getUTCMonth() + 1)}-${_p2(dt.getUTCDate())}`;
function _pakistanTodayUTC() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

const _parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

// Today (YYYY-MM-DD) on the Pakistan calendar.
export function todayISO() { return _isoOf(_pakistanTodayUTC()); }

// Snap `dateStr` onto a brand's reporting-week grid (weeks step 7 days from
// `anchor`, the brand's first report start) → the start of the grid-week that
// contains `dateStr`. This is what keeps a checkpoint's week_start identical to
// the weekly report's period_start so the two join cleanly for auto-fetch.
export function alignToGrid(anchor, dateStr) {
  const a = _parse(anchor), d = _parse(dateStr);
  const weeks = Math.floor(Math.round((d - a) / 86400000) / 7);
  const dt = new Date(a); dt.setUTCDate(dt.getUTCDate() + weeks * 7);
  return _isoOf(dt);
}

// Monday (YYYY-MM-DD) of the week containing `dateStr` (default: today, PK).
// Fallback week grid for brands with no weekly reports yet (no anchor).
export function mondayOf(dateStr) {
  let dt;
  if (dateStr) { const [y, m, d] = dateStr.split('-').map(Number); dt = new Date(Date.UTC(y, m - 1, d)); }
  else dt = _pakistanTodayUTC();
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return _isoOf(dt);
}
export function addWeeks(weekStart, n) {
  const [y, m, d] = weekStart.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n * 7);
  return _isoOf(dt);
}
// The week just ended (Tuesday's meeting reviews last week): last week's Monday.
export function defaultReviewWeekStart() { return addWeeks(mondayOf(), -1); }

// "Mmm D–D, YYYY" label for a Monday week-start.
export function weekLabelForStart(weekStart) {
  const [y, m, d] = weekStart.split('-').map(Number);
  const s = new Date(Date.UTC(y, m - 1, d));
  const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
  return weekLabelFrom(s, e);
}
export function weekLabelFrom(start, end) {
  const mo = (d) => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  const y = end.getUTCFullYear();
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${mo(start)} ${start.getUTCDate()}–${end.getUTCDate()}, ${y}`;
  }
  return `${mo(start)} ${start.getUTCDate()} – ${mo(end)} ${end.getUTCDate()}, ${y}`;
}
// Back-compat: the current Monday→Sunday week label.
export function currentWeekLabel() { return weekLabelForStart(mondayOf()); }
