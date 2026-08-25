import { supabase } from './supabase';
// Server-anchored Karachi calendar month — the single source for "is this month
// CLOSED" (the money gate). Do NOT reintroduce a local new Date() month here: it
// drifts for the first ~5h of every UTC day and at every month boundary.
import { karachiMonth } from './serverTime';
// Commission lines measure achieved/target in the BRAND's currency (mig 280),
// while `amount` stays PKR like every other incentive — see applyCommissionAutofill.
import { currencySymbol } from '../utils/currencies';

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
    // GMV-Max: achieved is derived, but `completed` is a HUMAN decision (a TL/OL
    // ticks it) and the TARGET is real money the OL set — so blank the achieved
    // only and leave both of those alone.
    if (it.source === 'gmv_max')    return { ...it, achievedValue: null };
    // Commission tier: the benchmark (targetValue), the achieved figure and the
    // percentage are all TYPED by an OL, so they are real data and must persist.
    // Only the money and the completion flag are derived — the money because the
    // FX rate lives in another table and moves on its own, so a figure baked in
    // here would be read as pay by every non-overlaying consumer (backups,
    // ai-chat, the Performance page) long after the rate had changed. Both are
    // written once, server-side, by _inc_freeze_commission_items at payout.
    if (it.source === 'commission_tier') {
      const { _commissionInfo, ...rest } = it;   // eslint-disable-line no-unused-vars
      return { ...rest, amount: 0, completed: false, completedBy: null };
    }
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

// ── GMV-Max auto-fill (mig 317) ───────────────────────────────────
// A per-brand item flagged { source: 'gmv_max' } takes its achievedValue from
// that brand's month figure in Brand Analytics — brand_monthly_metrics
// .gmv_achieved, which is what the APC enters at clock-in (mig 311). Verified
// same metric: for every brand carrying one of these items the incentive target
// and the Brand Analytics GMV target are identical, currency included.
//
// Unlike attendance/ol_brands this does NOT derive `completed` — a TL/OL still
// ticks the item — so there is no month-closed money gate to apply here. It
// only ever replaces a number the person used to type by hand.
export async function fetchGmvMaxAchieved(month) {
  const { data, error } = await supabase.rpc('gmv_max_achieved_map', { p_month: month });
  if (error) throw new Error(error.message);
  const m = new Map();
  (data || []).forEach((r) => m.set(r.brand_id, Number(r.achieved) || 0));
  return m;
}
function _hasGmvMaxItem(row) {
  return [...(row?.incentives || []), ...(row?.bonuses || [])]
    .some((it) => it && it.source === 'gmv_max' && it.brandId);
}
export async function applyGmvMaxAutofill(rows, month) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((r) => !_isPaid(r) && _hasGmvMaxItem(r))) return list;
  let byBrand;
  try { byBrand = await fetchGmvMaxAchieved(month); }
  // eslint-disable-next-line no-console
  catch (e) { console.warn('gmv-max autofill skipped:', e.message); return list; }
  const patchItem = (it) => {
    if (!it || it.source !== 'gmv_max' || !it.brandId) return it;
    // No metrics row yet for this brand+month → 0, not the stale typed figure.
    // Leaving the old number would be worse than an honest zero: it would read
    // as progress nobody can trace to a source.
    return { ...it, achievedValue: byBrand.has(it.brandId) ? byBrand.get(it.brandId) : 0 };
  };
  return list.map((r) => {
    if (_isPaid(r)) return r;   // frozen at payout — never re-overlay
    return {
      ...r,
      incentives: (r.incentives || []).map(patchItem),
      bonuses:    (r.bonuses    || []).map(patchItem),
    };
  });
}

// ── Commission Based Tier (migs 333-336) ──────────────────────────
// A brand-linked item flagged { source: 'commission_tier' } carrying THREE
// hand-entered numbers, all set by an OL:
//
//   targetValue    the GMV benchmark
//   achievedValue  what was actually achieved   (OL only — never APC/TL)
//   commissionPct  this person's percentage
//
// and paying on the EXCESS above the benchmark, converted to PKR:
//
//   amount = (achieved - benchmark) x commissionPct% x rate-to-PKR
//
// e.g. benchmark $1,000, achieved $1,200, 0.5% -> $6 -> x280 -> PKR 1,680.
//
// Only `amount` and `completed` are derived. The three numbers above are real
// stored values — unlike migs 333-335, where the benchmark and achieved were
// read from Brand Analytics and blanked at rest. The amount still has to be
// derived because the FX rate lives in another table and moves on its own, and
// it is still frozen server-side at payout so a later rate change can never
// move a figure somebody has already been paid.
export async function fetchCommissionFxMap(month) {
  const { data, error } = await supabase.rpc('commission_fx_map', { p_month: month });
  if (error) throw new Error(error.message);
  const m = new Map();
  (data || []).forEach((r) => m.set(r.brand_id, {
    currency: r.currency || 'USD',
    fxRate:   r.fx_rate == null ? null : Number(r.fx_rate),
    fxMonth:  r.fx_month || null,
  }));
  return m;
}

// A benchmark is FLOORED at zero, and zero means "no benchmark": the commission
// is then a straight percentage of everything achieved. That is a real mode,
// not a blank field — leaving the box empty is how an OL asks for it.
//
// The floor is the one guard kept: `achieved - (-500)` would ADD 500 to the
// excess and pay on money nobody earned, and no one means a negative benchmark.
//
// Must read identically to commission_line_state and to perf_incentives_score's
// branch (mig 337), and to scripts/composite-parity.mjs.
export function commissionBenchmark(item) { return Math.max(Number(item?.targetValue) || 0, 0); }
export function commissionAchieved(item)  { return Number(item?.achievedValue) || 0; }

// NOT decoration: earnedTotal and calcBreakdown sum `amount` ONLY over items
// where this is true, so a line that pays but is not completed contributes
// nothing to anyone's pay. The invariant to preserve is therefore "anything
// paying above zero is completed" — with a benchmark, clearing it is the bar;
// without one there is no bar, so anything achieved at all counts.
export function commissionCompleted(item) {
  const b = commissionBenchmark(item);
  const a = commissionAchieved(item);
  return b > 0 ? a >= b : a > 0;
}

// The part of `achieved` the commission is actually paid on. With no benchmark
// that is the whole of it.
export function commissionExcess(item) {
  return Math.max(commissionAchieved(item) - commissionBenchmark(item), 0);
}

// In the BRAND's currency, before conversion.
export function commissionEarnedRaw(item) {
  const pct = Math.min(Math.max(Number(item?.commissionPct) || 0, 0), 100);  // clamp, as the freeze does
  return commissionExcess(item) * (pct / 100);
}

// In PKR. A missing rate pays 0 here, and clearing the payout is refused
// server-side rather than freezing that zero.
export function commissionAmount(item, fxRate) {
  if (fxRate == null) return 0;
  return Math.round(commissionEarnedRaw(item) * Number(fxRate));
}

function _hasCommissionItem(row) {
  return [...(row?.incentives || []), ...(row?.bonuses || [])]
    .some((it) => it && it.source === 'commission_tier' && it.brandId);
}

export async function applyCommissionAutofill(rows, month) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((r) => !_isPaid(r) && _hasCommissionItem(r))) return list;
  let byBrand;
  try { byBrand = await fetchCommissionFxMap(month); }
  // eslint-disable-next-line no-console
  catch (e) { console.warn('commission autofill skipped:', e.message); return list; }
  const patchItem = (it) => {
    if (!it || it.source !== 'commission_tier' || !it.brandId) return it;
    const info = byBrand.get(it.brandId) || null;
    return {
      ...it,
      suffix:    info ? currencySymbol(info.currency) : (it.suffix || ''),
      completed: commissionCompleted(it),
      amount:    commissionAmount(it, info ? info.fxRate : null),
      // For the UI only — why it pays what it pays, and which month's rate is
      // in play. Never reaches the database: stripAttendanceForSave drops it,
      // and every save funnel rebuilds items from a fixed field list anyway.
      _commissionInfo: info ? { ...info, earnedRaw: commissionEarnedRaw(it), excess: commissionExcess(it) } : null,
    };
  };
  return list.map((r) => {
    if (_isPaid(r)) return r;   // frozen at payout — never re-overlay
    return {
      ...r,
      incentives: (r.incentives || []).map(patchItem),
      bonuses:    (r.bonuses    || []).map(patchItem),
    };
  });
}

// All four read-time overlays, in sequence — the single entry point every read
// path uses. Order is irrelevant: each only touches its own `source`.
export async function applyDerivedAutofill(rows, month) {
  return applyCommissionAutofill(
    await applyGmvMaxAutofill(
      await applyOlBrandsAutofill(await applyAttendanceAutofill(rows, month), month),
      month,
    ),
    month,
  );
}

// Who else already has a commission line on a brand this month, and for how
// much. Each item is independent JSONB on a different person's row, so nothing
// in the data model knows about its siblings: three people can each be given
// 3% of the same brand's GMV and nothing anywhere would say so until payday.
// The editor shows this so the OL is dividing a visible total rather than
// guessing. Read-only and advisory — it does not block, because the OL may
// legitimately be mid-way through re-allocating.
export async function fetchBrandCommissionAllocations(month) {
  const { data, error } = await supabase
    .from('incentives')
    .select('user_id, incentives, bonuses, user:user_id(display_name)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  const byBrand = new Map();
  (data || []).forEach((row) => {
    [...(row.incentives || []), ...(row.bonuses || [])].forEach((it) => {
      if (!it || it.source !== 'commission_tier' || !it.brandId) return;
      const list = byBrand.get(it.brandId) || [];
      list.push({
        userId: row.user_id,
        userName: row.user?.display_name || '—',
        pct: Number(it.commissionPct) || 0,
        itemId: it.id,
      });
      byBrand.set(it.brandId, list);
    });
  });
  return byBrand;
}

// ── Payout FX rates (Boss-only, mig 333) ──────────────────────────
export async function listPayoutFxRates(month) {
  const { data, error } = await supabase
    .from('payout_fx_rates')
    .select('month_key, currency, rate, updated_at')
    .eq('month_key', month)
    .order('currency');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function setPayoutFxRate(month, currency, rate) {
  const { data: me } = await supabase.auth.getUser();
  const n = Number(rate);
  if (!(n > 0)) throw new Error('Rate must be greater than zero.');
  const { error } = await supabase
    .from('payout_fx_rates')
    .upsert({
      month_key: month, currency: String(currency).toUpperCase(), rate: n,
      updated_at: new Date().toISOString(), updated_by: me?.user?.id || null,
    }, { onConflict: 'month_key,currency' });
  if (error) throw new Error(error.message);
}

export async function deletePayoutFxRate(month, currency) {
  const { error } = await supabase
    .from('payout_fx_rates')
    .delete().eq('month_key', month).eq('currency', String(currency).toUpperCase());
  if (error) throw new Error(error.message);
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
// ── Ads-manager brands (OL-curated in Settings; mig 316) ───────────────────
// This one list does double duty: it is what the ads manager can SEE
// (can_view_brand) and the brand groups the OL builds their plan from.
export async function getAdsManagerBrands(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('ads_manager_brands').select('brand_id').eq('ads_manager_id', userId);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.brand_id);
}
export async function setAdsManagerBrands(userId, brandIds) {
  const ids = Array.from(new Set((brandIds || []).filter(Boolean)));
  // Atomic replace (same reasoning as ol_set_incentive_brands): delete-then-
  // insert as two calls would leave the manager brand-less — i.e. blind — in
  // between.
  const { error } = await supabase.rpc('ads_manager_set_brands', { p_user: userId, p_brand_ids: ids });
  if (error) throw new Error(error.message);
}
// user_id -> [brand_id] for a set of ads managers, in one query.
export async function fetchAdsManagerBrandMap(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('ads_manager_brands')
    .select('ads_manager_id, brand:brand_id(id, brand_name, tier, status, client_name, currency)')
    .in('ads_manager_id', ids);
  if (error) throw new Error(error.message);
  const m = new Map();
  for (const row of data || []) {
    if (!row.brand) continue;
    const list = m.get(row.ads_manager_id) || [];
    list.push(row.brand);
    m.set(row.ads_manager_id, list);
  }
  return m;
}

// [{ brand_id, brand_name, client_name, owner_name, matched_text, is_hit }]
export async function fetchOlBrandStatus(olId, month) {
  const { data, error } = await supabase.rpc('ol_brand_incentive_status', { p_ol: olId, p_month: month });
  if (error) throw new Error(error.message);
  return data || [];
}
// Map ol_id -> that OL's curated incentive brands, for showing every OL what
// brands sit behind each OL's incentive. One query; the oib_select RLS lets an
// active OL/Boss read ALL OLs' rows (self-only otherwise). Includes inactive
// brands (BrandTierChip dims them) so nothing silently disappears.
export async function listOlBrandsByOl() {
  const { data, error } = await supabase
    .from('ol_incentive_brands')
    .select('ol_id, brand:brand_id(id, brand_name, status, client_name, owner_id)');
  if (error) throw new Error(error.message);
  const map = {};
  (data || []).forEach((r) => {
    if (!r.brand) return;
    (map[r.ol_id] ||= []).push({ id: r.brand.id, name: r.brand.brand_name, status: r.brand.status, notes: r.brand.client_name || null, ownerId: r.brand.owner_id });
  });
  Object.values(map).forEach((arr) => arr.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
  return map;
}

// Does a brand "hit" for its owning TL? Mirrors the ol_brand_incentive_pct RPC
// (mig 296): the TL has a COMPLETED item linked by brandId (or, for unlinked
// legacy items, a normalised-text name match). Used client-side to badge OL cards.
const _normBrand = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function brandHitByTL(tlRecord, brand) {
  if (!tlRecord || !brand) return false;
  const nb = _normBrand(brand.name);
  const items = [...(tlRecord.incentives || []), ...(tlRecord.bonuses || [])];
  return items.some((it) => it && it.completed && (
    (it.brandId != null && String(it.brandId) === String(brand.id)) ||
    (it.brandId == null && nb.length >= 3 && _normBrand(it.text).includes(nb))
  ));
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
// Format a value with its unit: currency symbols go BEFORE the number ($4,500),
// everything else (%, plain counts) stays after (95%). Keeps money reading naturally.
const CURRENCY_UNITS = ['$', '£', '€', '¥', '₹'];
export function fmtUnitValue(value, sfx) {
  const n = Number(value || 0).toLocaleString();
  return CURRENCY_UNITS.includes(sfx) ? `${sfx}${n}` : `${n}${sfx || ''}`;
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
  const pushBrand = (userId, brand) => {
    if (!brand) return;
    const list = brandsByUser.get(userId) || [];
    list.push({
      id:     brand.id,
      name:   brand.brand_name,
      tier:   brand.tier        || null,
      status: brand.status      || null,
      notes:  brand.client_name || null,
    });
    brandsByUser.set(userId, list);
  };
  if (userIds.length) {
    const { data: links, error: e3 } = await supabase
      .from('brand_assignments')
      .select('user_id, brand:brand_id(id, brand_name, tier, status, client_name, currency)')
      .in('user_id', userIds);
    if (e3) throw new Error(e3.message);
    (links || []).forEach((row) => pushBrand(row.user_id, row.brand));
  }
  // An ads manager's brands live in their own table, not brand_assignments —
  // so the OL's cards show the brands they run ads for (mig 316).
  const adsIds = (data || []).filter((p) => p.role === 'ads_manager').map((p) => p.id);
  if (adsIds.length) {
    const adsMap = await fetchAdsManagerBrandMap(adsIds);
    for (const [userId, brands] of adsMap) brands.forEach((b) => pushBrand(userId, b));
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
  // `currency` is new here and load-bearing for commission lines: their Target
  // and Achieved are the brand's GMV goal and GMV, which are in the CLIENT's
  // currency, not PKR. Without it every brand would render a '$'.
  const shape = (b) => ({ id: b.id, name: b.brand_name, tier: b.tier, status: b.status, client: b.client_name, currency: b.currency || 'USD' });
  if (data.role === 'tl') {
    const { data: bs, error: be } = await supabase
      .from('brands').select('id, brand_name, tier, status, client_name, currency')
      .eq('owner_id', userId).eq('status', 'active').order('brand_name');
    // Throw (never swallow) — a silent [] here would make the editor's carry-forward
    // reconcile DROP every brand-linked item as an orphan. Fail loud instead.
    if (be) throw new Error(be.message);
    assignedBrands = (bs || []).map(shape);
  } else if (data.role === 'apc' || data.role === 'ipc') {
    const { data: rows, error: ae } = await supabase
      .from('brand_assignments')
      .select('brand:brand_id(id, brand_name, tier, status, client_name, currency)')
      .eq('user_id', userId);
    if (ae) throw new Error(ae.message);
    assignedBrands = (rows || []).map((r) => r.brand).filter(Boolean)
      .filter((b) => b.status === 'active').map(shape)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (data.role === 'ads_manager') {
    // Third source, same contract as the two above: the OL-curated ads brands
    // (mig 316) ARE this user's brand groups in the plan editor. Throws like the
    // TL branch — a swallowed [] would make carry-forward drop every linked item.
    const { data: rows, error: me } = await supabase
      .from('ads_manager_brands')
      .select('brand:brand_id(id, brand_name, tier, status, client_name, currency)')
      .eq('ads_manager_id', userId);
    if (me) throw new Error(me.message);
    assignedBrands = (rows || []).map((r) => r.brand).filter(Boolean)
      .filter((b) => b.status === 'active').map(shape)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (data.role === 'ol') {
    // Fourth source. An OL owns no brands and is assigned none, so until now
    // their plan had no brand groups at all and could hold no brand-linked
    // line. Their CURATED incentive brands (mig 291, Settings -> My Incentive
    // Brands) are already defined as "the brands that count toward my
    // incentive", which is exactly the right set — needed so a Commission
    // Based Tier line can be given to an OL as well as a TL/APC.
    const { data: rows, error: oe } = await supabase
      .from('ol_incentive_brands')
      .select('brand:brand_id(id, brand_name, tier, status, client_name, currency)')
      .eq('ol_id', userId);
    if (oe) throw new Error(oe.message);
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

// Inactive brands a user is responsible for, for the "not included in incentives"
// notice. A TL owns brands (brands.owner_id); an APC/IPC gets them via
// brand_assignments. `role` is optional — when unknown we check both sources.
// Non-critical (drives a hint), so it never throws — returns [] on any error.
export async function listInactiveBrandsForUser(userId, role) {
  if (!userId) return [];
  const seen = new Map();
  const add = (b) => { if (b && b.status && b.status !== 'active') seen.set(b.id, { id: b.id, name: b.brand_name, status: b.status }); };
  if (!role || role === 'tl' || role === 'pctl') {
    const { data } = await supabase.from('brands')
      .select('id, brand_name, status').eq('owner_id', userId).neq('status', 'active');
    (data || []).forEach(add);
  }
  if (!role || role === 'apc' || role === 'ipc') {
    const { data } = await supabase.from('brand_assignments')
      .select('brand:brand_id(id, brand_name, status)').eq('user_id', userId);
    (data || []).forEach((r) => add(r.brand));
  }
  if (!role || role === 'ads_manager') {
    const { data } = await supabase.from('ads_manager_brands')
      .select('brand:brand_id(id, brand_name, status)').eq('ads_manager_id', userId);
    (data || []).forEach((r) => add(r.brand));
  }
  return [...seen.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
  // A template is the DEFAULT plan applied to whoever is being set up next, so
  // it deliberately carries no brand link. A commission line is meaningless
  // without one — the brand IS the whole calculation — so it is dropped here
  // rather than templated into a line that shows a percentage and can never
  // pay. (Keeping commissionPct while losing brandId is the worst of both: it
  // looks configured and is permanently dead.)
  const templatable = (i) => i && i.source !== 'commission_tier';
  // NOTE: this rebuilds each item from a fixed field list, so anything not
  // named here is dropped.
  const mapTemplateItem = (i) => ({
    id: i.id, text: i.text,
    // A derived source's amount is a live overlaid figure, not something a
    // person typed. It must never be captured into a saved template.
    amount: i.source ? 0 : (Number(i.amount) || 0),
    targetValue: Number(i.targetValue) || 0,
    suffix: itemSuffix(i),
    ...(i.source ? { source: i.source } : {}),
  });
  const value = {
    basicSalary: Number(basicSalary) || 0,
    incentives:  (inc || []).filter(templatable).map(mapTemplateItem),
    bonuses:     (bon || []).filter(templatable).map(mapTemplateItem),
    savedByName: savedByName || '',
    savedAt:     new Date().toISOString(),
  };
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'incentives_default_template', value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return value;
}
