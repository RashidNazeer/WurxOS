import { supabase } from './supabase';
// Server-anchored Karachi calendar month — the single source for "is this month
// CLOSED" (the money gate). Do NOT reintroduce a local new Date() month here: it
// drifts for the first ~5h of every UTC day and at every month boundary.
import { karachiMonth } from './serverTime';

export function currentMonth() { return new Date().toISOString().slice(0, 7); }

export function autoComplete(item) {
  const t = Number(item.targetValue), a = Number(item.achievedValue);
  if (!t || t <= 0) return !!item.completed;
  return (a / t) >= 0.9;
}

// ── Attendance auto-fill ──────────────────────────────────────────
// An incentive/bonus line item flagged { source: 'attendance' } gets its
// achievedValue filled from the user's monthly attendance % (the same
// figure the Performance attendance pillar uses, via perf_attendance_score)
// instead of being typed in by hand. This runs at READ time so the number
// is always current, and — crucially — it produces a plain number that
// behaves identically to a hand-entered one for every downstream calc
// (pct/completion ≥90%, earned/potential, verify, payout, rollover).
// Target is pinned to 100 and the unit to '%', so "≥90% attendance" completes
// the item under the existing rule with zero special-casing elsewhere.
export async function fetchAttendancePct(month, userIds) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length) return new Map();
  const { data, error } = await supabase.rpc('incentive_attendance_pct', {
    p_month: month, p_user_ids: ids,
  });
  if (error) throw new Error(error.message);
  const m = new Map();
  (data || []).forEach((r) => m.set(r.user_id, Number(r.pct) || 0));
  return m;
}

function _hasAttendanceItem(row) {
  return [...(row?.incentives || []), ...(row?.bonuses || [])]
    .some((it) => it && it.source === 'attendance');
}

// A payout_cleared row is FROZEN: the % the payout was based on is snapshotted
// into the JSONB server-side at clear time. Never re-overlay it — the live
// figure could drift (backdated leave/adjustment edits to a past month) and
// silently move an already-paid number. Handles raw (payout_cleared) and
// normalised (payoutCleared) rows.
function _isPaid(row) {
  return !!(row && (row.payout_cleared || row.payoutCleared));
}

// Attendance items are auto-filled at READ time, so their achievedValue/completed
// must never be persisted as a frozen literal by an edit funnel (a mid-month
// 40.9% would get baked into data-at-rest and every non-overlay consumer —
// ai-chat, backups — would read the stale number). Strip the derived fields on
// save; keep the source flag + Target=100 + suffix invariant. The paid-time
// snapshot is written server-side at payout-clear, not here.
function stripAttendanceForSave(items) {
  return (items || []).map((it) => {
    if (!it) return it;
    // Attendance % is pinned to a /100 target; OL-brands % keeps its own target
    // (e.g. 70). Both are read-time-derived, so never freeze achieved/completed.
    if (it.source === 'attendance') return { ...it, achievedValue: null, completed: false, completedBy: null, targetValue: 100, suffix: it.suffix || '%' };
    if (it.source === 'ol_brands')  return { ...it, achievedValue: null, completed: false, completedBy: null, suffix: it.suffix || '%' };
    return it;
  });
}

// Patch attendance-linked items on the given rows with live %.
// No-op (and no network call) when no non-paid row has an attendance-linked
// item, so this is safe to run on every incentives fetch. Fails soft: if the
// RPC isn't there yet (pre-migration), rows are returned untouched.
export async function applyAttendanceAutofill(rows, month) {
  const list = Array.isArray(rows) ? rows : [];
  const needIds = list
    .filter((r) => !_isPaid(r) && _hasAttendanceItem(r))
    .map((r) => r.user_id || r.userId).filter(Boolean);
  if (!needIds.length) return list;
  let pctByUser;
  try {
    pctByUser = await fetchAttendancePct(month, needIds);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('attendance autofill skipped:', e.message);
    return list;
  }
  // MONEY GATE. incentive_attendance_pct returns coverage SO FAR: its
  // denominator is least(today, month_end). Mid-month that number is
  // provisional — and on the 1st of a month that starts on a Saturday it is
  // 100% for everyone, including someone who has never clocked in (the single
  // elapsed day is a weekend, and weekends are covered). Under the old
  // hardcoded /22 formula reaching 90% before ~day 20 was arithmetically
  // impossible, so the item could never read "earned" early. It can now.
  //
  // So: keep showing the running % (that is what the Boss asked for), but only
  // let it COMPLETE — i.e. count toward Earned / become payable — once the
  // month is CLOSED and the figure is final.
  const isFinalMonth = String(month) < karachiMonth();
  const patchItem = (it, uid) => {
    if (!it || it.source !== 'attendance') return it;
    const val = pctByUser.has(uid) ? pctByUser.get(uid) : (Number(it.achievedValue) || 0);
    const next = { ...it, achievedValue: val, targetValue: 100, suffix: it.suffix || '%' };
    next.completed = isFinalMonth ? autoComplete(next) : false;
    return next;
  };
  return list.map((r) => {
    // FREEZE: a payout_cleared row keeps the % the payout was based on (snapshotted
    // into the JSONB server-side at clear time). Return it untouched so it reads the
    // FROZEN achievedValue + completed verbatim — never re-overlay a paid figure.
    if (_isPaid(r)) return r;
    const uid = r.user_id || r.userId;
    return {
      ...r,
      incentives: (r.incentives || []).map((it) => patchItem(it, uid)),
      bonuses:    (r.bonuses    || []).map((it) => patchItem(it, uid)),
    };
  });
}

// ── OL brands auto-fill ───────────────────────────────────────────
// An OL incentive item flagged { source: 'ol_brands' } gets its achievedValue
// filled from the % of the OL's CURATED brands (Settings) whose owning TL marked
// the matching per-brand GMV item complete (mig 291 RPC). Mirrors the attendance
// overlay: read-time, never frozen at rest, money-gated to a CLOSED month.
export async function fetchOlBrandPct(month, olIds) {
  const ids = Array.from(new Set((olIds || []).filter(Boolean)));
  if (!ids.length) return new Map();
  const { data, error } = await supabase.rpc('ol_brand_incentive_pct', { p_month: month, p_ol_ids: ids });
  if (error) throw new Error(error.message);
  const m = new Map();
  (data || []).forEach((r) => m.set(r.ol_id, { hits: Number(r.hits) || 0, total: Number(r.total) || 0, pct: Number(r.pct) || 0 }));
  return m;
}
function _hasOlBrandsItem(row) {
  return [...(row?.incentives || []), ...(row?.bonuses || [])].some((it) => it && it.source === 'ol_brands');
}
export async function applyOlBrandsAutofill(rows, month) {
  const list = Array.isArray(rows) ? rows : [];
  const needIds = list.filter((r) => !_isPaid(r) && _hasOlBrandsItem(r)).map((r) => r.user_id || r.userId).filter(Boolean);
  if (!needIds.length) return list;
  let pctByOl;
  try { pctByOl = await fetchOlBrandPct(month, needIds); }
  catch (e) { console.warn('ol-brands autofill skipped:', e.message); return list; }
  // MONEY GATE (same as attendance): show the running % always, but only let the
  // item COMPLETE (become payable / count as Earned) once the month is CLOSED —
  // mid-month a TL may still mark/unmark brand targets.
  const isFinalMonth = String(month) < karachiMonth();
  const patchItem = (it, uid) => {
    if (!it || it.source !== 'ol_brands') return it;
    const info = pctByOl.get(uid);
    const val = info ? info.pct : (Number(it.achievedValue) || 0);
    const tgt = Number(it.targetValue) || 70;
    const next = { ...it, achievedValue: val, suffix: it.suffix || '%' };
    next.completed = isFinalMonth ? (val >= tgt) : false;
    return next;
  };
  return list.map((r) => {
    if (_isPaid(r)) return r;
    const uid = r.user_id || r.userId;
    return { ...r, incentives: (r.incentives || []).map((it) => patchItem(it, uid)), bonuses: (r.bonuses || []).map((it) => patchItem(it, uid)) };
  });
}

// Both read-time overlays, in sequence — the single entry point every read path uses.
export async function applyDerivedAutofill(rows, month) {
  return applyOlBrandsAutofill(await applyAttendanceAutofill(rows, month), month);
}

// ── OL incentive-brands curation (Settings) + per-brand status (panel) ──────
export async function getOlIncentiveBrands(olId) {
  const { data, error } = await supabase.from('ol_incentive_brands').select('brand_id').eq('ol_id', olId);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.brand_id);
}
export async function setOlIncentiveBrands(olId, brandIds) {
  const ids = Array.from(new Set((brandIds || []).filter(Boolean)));
  // Atomic replace via RPC (mig 295): a plain delete-then-insert is two separate
  // autocommit calls, so a payout-lock landing between them could wipe the set.
  const { error } = await supabase.rpc('ol_set_incentive_brands', { p_ol: olId, p_brand_ids: ids });
  if (error) throw new Error(error.message);
}
// [{ brand_id, brand_name, client_name, owner_name, matched_text, is_hit }]
export async function fetchOlBrandStatus(olId, month) {
  const { data, error } = await supabase.rpc('ol_brand_incentive_status', { p_ol: olId, p_month: month });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getIncentives(userId, month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
    .eq('user_id', userId).eq('month', month).maybeSingle();
  if (error) throw new Error(error.message);
  // Note: _normRow attaches v1 aliases (basicSalary, userId, payoutCleared,
  // verifiedByName, etc.) so v1 markup reads it without translation.
  if (!data) return null;
  const [row] = await applyDerivedAutofill([_normRow(data)], month);
  return row;
}

export async function listIncentivesForMonth(month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, role)')
    .eq('month', month).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  // Overlay derived items even though this loader has no live consumer today —
  // cheap safety so a future rewire can't silently bypass the overlay.
  return applyDerivedAutofill(data || [], month);
}

export async function upsertIncentives(userId, month, patch) {
  const { data: me } = await supabase.auth.getUser();
  // Never freeze a read-time attendance % at rest — strip on any patch that
  // carries items (keeps this generic funnel consistent with savePlan).
  const items = {};
  if (patch && 'incentives' in patch) items.incentives = stripAttendanceForSave(patch.incentives);
  if (patch && 'bonuses'    in patch) items.bonuses    = stripAttendanceForSave(patch.bonuses);
  const payload = {
    user_id: userId, month,
    ...patch,
    ...items,
    last_updated_by: me?.user?.id,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('incentives')
    .upsert(payload, { onConflict: 'user_id,month' })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export function recomputeCompletion(items) {
  return (items || []).map((it) => ({ ...it, completed: autoComplete(it) }));
}

export function earnedTotal(row) {
  if (!row) return 0;
  const inc = (row.incentives || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0);
  const bon = (row.bonuses    || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0);
  return Number(row.basic_salary || 0) + inc + bon;
}

// Total potential (if all items hit) — shown alongside "earned" for context.
export function potentialTotal(row) {
  if (!row) return 0;
  const inc = (row.incentives || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const bon = (row.bonuses    || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  return Number(row.basic_salary || 0) + inc + bon;
}

// Summary for badges — count of items completed vs total.
export function completionCounts(row) {
  const inc = row?.incentives || [];
  const bon = row?.bonuses    || [];
  const totalItems     = inc.length + bon.length;
  const completedItems = inc.filter((i) => i.completed).length + bon.filter((i) => i.completed).length;
  return { completedItems, totalItems };
}

// --------------------------------------------------------------
// Verification + payout management (admin-only RPCs)
// --------------------------------------------------------------
export async function verifyIncentives(id, verified = true) {
  const { data, error } = await supabase.rpc('inc_verify', { p_id: id, p_verified: !!verified });
  if (error) throw new Error(error.message);
  return data;
}

export async function clearIncentivePayout(id, cleared = true) {
  const { data, error } = await supabase.rpc('inc_clear_payout', { p_id: id, p_cleared: !!cleared });
  if (error) throw new Error(error.message);
  return data;
}

export async function notifyIncentiveEmployee(id) {
  const { data, error } = await supabase.rpc('inc_notify_employee', { p_id: id });
  if (error) throw new Error(error.message);
  return data;
}

// Boss-only end-of-month reset-and-roll workflow.
export async function resetAndRoll({ sourceMonth, targetMonth, forceClear = false }) {
  const { data, error } = await supabase.rpc('inc_reset_and_roll', {
    p_source: sourceMonth,
    p_target: targetMonth,
    p_force_clear: !!forceClear,
  });
  if (error) throw new Error(error.message);
  return data;  // { cleared, created, skipped }
}

// --------------------------------------------------------------
// Richer queries for the Boss + OL pages
// --------------------------------------------------------------
// Month view scoped to a given role (APC / TL / OL) for the Boss tabs.
export async function listIncentivesForRole(role, month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to, is_active)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  // Overlay attendance-linked items (cheap no-op when none present) so this loader
  // stays consistent with the read paths if it is ever wired to a live surface.
  return applyDerivedAutofill((data || []).filter((r) => r.user?.role === role), month);
}

// Month view scoped to a manager's direct-report team (for OL viewing APCs).
export async function listIncentivesForMyTeam(managerId, month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to, is_active)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  // Overlay attendance-linked items (cheap no-op when none present) so this loader
  // stays consistent with the read paths if it is ever wired to a live surface.
  return applyDerivedAutofill((data || []).filter((r) => r.user?.reports_to === managerId), month);
}

// All months that have any incentive row — for the month picker.
export async function listAvailableMonths() {
  const { data, error } = await supabase
    .from('incentives')
    .select('month')
    .order('month', { ascending: false });
  if (error) throw new Error(error.message);
  const seen = new Set();
  const out = [];
  (data || []).forEach((r) => { if (!seen.has(r.month)) { seen.add(r.month); out.push(r.month); } });
  return out;
}

// ============================================================
// v1 PARITY LAYER
// ------------------------------------------------------------
// Helpers + normalisers + extra loaders the verbatim-ported v1
// pages need. Same pattern as the Performance port.
// ============================================================

export function getCurrentMonth() { return currentMonth(); }
export function getMonthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
export function getNextMonth(ym) {
  if (!ym) return ym;
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1); // m is 0-based when used as second arg → next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function pct(achieved, target) {
  if (!target || target <= 0) return 0;
  return Math.min(Math.round((Number(achieved) / Number(target)) * 100), 100);
}
export function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}
export function uid4() { return Math.random().toString(36).slice(2, 10); }

// Mirror of v1's calcBreakdown — returns both potential and
// achieved totals. PKR amounts are summed as-is.
export function calcBreakdown(rec) {
  if (!rec) return { basic: 0, incTotal: 0, bonTotal: 0, incAchieved: 0, bonAchieved: 0, totalPotential: 0, totalAchieved: 0, total: 0 };
  const incs = rec.incentives || [];
  const bons = rec.bonuses    || [];
  const incTotal       = incs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal       = bons.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const incAchieved    = incs.filter((i) => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonAchieved    = bons.filter((b) => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const basic          = Number(rec.basicSalary ?? rec.basic_salary) || 0;
  const totalPotential = basic + incTotal + bonTotal;
  const totalAchieved  = basic + incAchieved + bonAchieved;
  return { basic, incTotal, bonTotal, incAchieved, bonAchieved, totalPotential, totalAchieved, total: totalAchieved };
}

// ── Row normaliser — v2 snake_case → v1 camelCase + alias fields ──
// v1 markup reads: id, userId, apcId, userRole, userName, basicSalary,
// month, incentives[], bonuses[], verified, payoutCleared, notified,
// verifiedByName, verifiedByRole, ownerId, brandNames[], ghosted,
// sourceMonth, carriedFrom.
function _normRow(r) {
  if (!r) return r;
  const u = r.user || {};
  const role = u.role || r.user_role || null;
  const isApc = role === 'apc' || role === 'ipc';
  return {
    ...r,
    id:               r.id,
    userId:           r.user_id,
    apcId:            isApc ? r.user_id : (r.apc_id || null),
    apcName:          isApc ? (u.display_name || r.user_name || '') : null,
    userRole:         role,
    userName:         u.display_name || r.user_name || '',
    userEmail:        u.email || '',
    ownerId:          u.reports_to || null,
    ownerName:        '',  // resolved on demand by callers; v1 read it from a separate join
    basicSalary:      Number(r.basic_salary) || 0,
    incentives:       Array.isArray(r.incentives) ? r.incentives : [],
    bonuses:          Array.isArray(r.bonuses) ? r.bonuses : [],
    verified:         !!r.verified,
    verifiedAt:       r.verified_at,
    verifiedBy:       r.verified_by,
    verifiedByName:   r.verifier?.display_name || null,
    verifiedByRole:   null, // v2 doesn't store; left null (UI handles)
    payoutCleared:    !!r.payout_cleared,
    payoutClearedAt:  r.payout_cleared_at,
    payoutClearedBy:  r.payout_cleared_by,
    notified:         !!r.notified,
    notifiedAt:       r.notified_at,
    brandNames:       r.brand_names || [],   // not stored in v2 schema; safe fallback
    ghosted:          !!r._ghost,
    sourceMonth:      r._source_month || null,
    carriedFrom:      r.carried_from || null,
  };
}

// Single-row normalise (exposed for callers that fetch via getIncentives).
export function normalizeRow(r) { return _normRow(r); }

// ── Bulk loaders the v1 pages need ─────────────────────────────
// Returns rows already normalised so v1 markup reads them as-is.
export async function listIncentivesMonth(month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to, is_active), verifier:verified_by(display_name)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  return applyDerivedAutofill((data || []).map(_normRow), month);
}

// Most recent prior plan for one user (used for ghost auto-carry-forward).
// Returns null if the user never had a plan before the picked month.
export async function getMostRecentPriorPlan(userId, beforeMonth) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to)')
    .eq('user_id', userId)
    .lt('month', beforeMonth)
    .order('month', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return _normRow(data);
}

// User loaders the management pages need — same shape v1 used.
//   { id, displayName, userName, userType, role, email, ownerId, ownerName,
//     assignedBrands? (UI uses .map(b => b.name)) }
export async function listUsersByRoles(roles) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to, is_active, deleted_at')
    .in('role', roles)
    .is('deleted_at', null)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  // Build owner-name lookup so APC cards can show "Under {TL}".
  const ownerIds = new Set();
  (data || []).forEach((p) => { if (p.reports_to) ownerIds.add(p.reports_to); });
  let ownerById = new Map();
  if (ownerIds.size) {
    const { data: owners, error: e2 } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', Array.from(ownerIds));
    if (e2) throw new Error(e2.message);
    ownerById = new Map((owners || []).map((o) => [o.id, o.display_name]));
  }

  // Brand assignments — single batched query keyed by user_id, joined to
  // brands so the incentive UI can show what brands each team member is
  // running (with tier so the OL can design tier-aware incentives).
  // Column is `brand_name` in the schema (mig 004) — we surface it as
  // `name` for the UI which expects that field.
  const userIds = (data || []).map((p) => p.id);
  let brandsByUser = new Map();
  if (userIds.length) {
    const { data: links, error: e3 } = await supabase
      .from('brand_assignments')
      .select('user_id, brand:brand_id(id, brand_name, tier, status, client_name)')
      .in('user_id', userIds);
    if (e3) throw new Error(e3.message);
    (links || []).forEach((row) => {
      if (!row.brand) return;
      const list = brandsByUser.get(row.user_id) || [];
      list.push({
        id:     row.brand.id,
        name:   row.brand.brand_name,
        tier:   row.brand.tier        || null,
        status: row.brand.status      || null,
        notes:  row.brand.client_name || null,
      });
      brandsByUser.set(row.user_id, list);
    });
  }

  return (data || []).map((p) => ({
    id:              p.id,
    displayName:     p.display_name || p.email || '—',
    userName:        p.display_name || p.email || '—',
    userType:        p.role,
    role:            p.role,
    email:           p.email,
    ownerId:         p.reports_to || null,
    ownerName:       p.reports_to ? (ownerById.get(p.reports_to) || '') : '',
    assignedBrands:  brandsByUser.get(p.id) || [],
  }));
}

// Resolve a single user for IncentiveForm's "Edit plan for X" header.
export async function getUserForEditor(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to')
    .eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  let ownerName = '';
  if (data.reports_to) {
    const { data: o } = await supabase
      .from('profiles').select('display_name').eq('id', data.reports_to).maybeSingle();
    ownerName = o?.display_name || '';
  }
  // The user's ACTIVE brands, resolved per the team model: a TL owns brands
  // (brands.owner_id); an APC/IPC gets them via brand_assignments. These drive
  // the brand-linked incentive sections, so they must be the live assignment.
  let assignedBrands = [];
  const shape = (b) => ({ id: b.id, name: b.brand_name, tier: b.tier, status: b.status, client: b.client_name });
  if (data.role === 'tl') {
    const { data: bs, error: be } = await supabase
      .from('brands').select('id, brand_name, tier, status, client_name')
      .eq('owner_id', userId).eq('status', 'active').order('brand_name');
    // Throw (never swallow) — a silent [] here would make the editor's carry-forward
    // reconcile DROP every brand-linked item as an orphan. Fail loud instead.
    if (be) throw new Error(be.message);
    assignedBrands = (bs || []).map(shape);
  } else if (data.role === 'apc' || data.role === 'ipc') {
    const { data: rows, error: ae } = await supabase
      .from('brand_assignments')
      .select('brand:brand_id(id, brand_name, tier, status, client_name)')
      .eq('user_id', userId);
    if (ae) throw new Error(ae.message);
    assignedBrands = (rows || []).map((r) => r.brand).filter(Boolean)
      .filter((b) => b.status === 'active').map(shape)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  return {
    id:              data.id,
    displayName:     data.display_name || data.email || '—',
    userName:        data.display_name || data.email || '—',
    userType:        data.role,
    role:            data.role,
    email:           data.email,
    ownerId:         data.reports_to || null,
    ownerName,
    assignedBrands,
  };
}

// ── Mutation: write an items-only progress patch (APC / TL / OL editing
// their own progress, or APC EditModal). Server-side guard already
// blocks non-admins from changing verified / payout_cleared / basic_salary.
export async function updateIncentivesProgress({
  rowId, incentives, bonuses,
  /* eslint-disable-next-line no-unused-vars */
  notifyManagerMessage = null, // optional: also fire inc_notify_manager
}) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('incentives')
    .update({
      // Attendance items are read-time-derived; never freeze the overlaid % at rest.
      incentives: stripAttendanceForSave(incentives),
      bonuses:    stripAttendanceForSave(bonuses),
      last_updated_by: me?.user?.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rowId)
    .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normRow(data);
}

// ── Mutation: full plan upsert (Boss / OL editing the structure).
// Accepts v1 payload shape (basicSalary, incentives, bonuses) and
// converts to snake_case. If `id` is given, updates; otherwise upserts
// on (user_id, month).
export async function savePlan({
  id, userId, month, basicSalary,
  incentives: inc, bonuses: bon,
}) {
  const { data: me } = await supabase.auth.getUser();
  if (id) {
    const { data, error } = await supabase
      .from('incentives')
      .update({
        basic_salary: Number(basicSalary) || 0,
        incentives: stripAttendanceForSave(inc || []),
        bonuses:    stripAttendanceForSave(bon || []),
        last_updated_by: me?.user?.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
      .single();
    if (error) throw new Error(error.message);
    return _normRow(data);
  }
  const { data, error } = await supabase
    .from('incentives')
    .upsert({
      user_id: userId,
      month,
      basic_salary: Number(basicSalary) || 0,
      incentives: stripAttendanceForSave(inc || []),
      bonuses:    stripAttendanceForSave(bon || []),
      last_updated_by: me?.user?.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month' })
    .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normRow(data);
}

// ── Default plan template (Save / Load Default in IncentiveForm) ─
// v1 stored at templates/incentivesTemplate. v2 uses app_config row
// keyed 'incentives_default_template'. Same shape: { basicSalary,
// incentives[], bonuses[], savedByName, savedAt }.
export async function getIncentivesTemplate() {
  const { data, error } = await supabase
    .from('app_config')
    .select('value, updated_at')
    .eq('key', 'incentives_default_template')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.value) return null;
  return data.value;
}

export async function setIncentivesTemplate({ basicSalary, incentives: inc, bonuses: bon, savedByName }) {
  const value = {
    basicSalary: Number(basicSalary) || 0,
    incentives:  (inc || []).map((i) => ({
      id: i.id, text: i.text, amount: Number(i.amount) || 0,
      targetValue: Number(i.targetValue) || 0,
      suffix: itemSuffix(i),
      ...(i.source ? { source: i.source } : {}),
    })),
    bonuses:     (bon || []).map((b) => ({
      id: b.id, text: b.text, amount: Number(b.amount) || 0,
      targetValue: Number(b.targetValue) || 0,
      suffix: itemSuffix(b),
      ...(b.source ? { source: b.source } : {}),
    })),
    savedByName: savedByName || '',
    savedAt:     new Date().toISOString(),
  };
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'incentives_default_template', value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return value;
}
