// ============================================================
// Weekly Checkpoint — carry-forward from last week into a new week.
//
// STRICT BOUNDARY (per the boss): this ONLY moves last week's *current* values
// into this week's *"previous"* comparison slots, plus a few non-stat config
// fields and open action items. It must NEVER carry:
//   • N-2 cohort stats (approvedN2, cohort videos live, sample→video N-2)
//   • current-week stats (they start blank; later auto-fetched from Euka /
//     the weekly report)
//   • running totals (MTD / all-time)
// so the carry-forward mechanism and the future auto-fetch never collide.
// ============================================================
import { EMPTY_CHECKPOINT, num, pct, SNAPSHOT_KPIS } from './checkpointModel';

const str = (v) => (v === null || v === undefined ? '' : v);

export function carryForward(prev) {
  const d = EMPTY_CHECKPOINT();
  if (!prev) return d;

  // ── non-stat config (identity/format — never fetched, so safe) ──────
  d.currency = prev.currency || '$';
  d.cover.apcName = str(prev.cover?.apcName);
  d.cover.team = str(prev.cover?.team);

  // ── PREVIOUS comparison columns = last week's CURRENT values ────────
  for (const k of SNAPSHOT_KPIS) {
    d.snapshot.kpis[k.key].prev = str(prev.snapshot?.kpis?.[k.key]?.cur);
  }
  d.samples.requestsPrev = str(prev.samples?.requestsReceived);
  d.traffic.impressionsPrev = str(prev.traffic?.impressions);
  d.traffic.clicksPrev = str(prev.traffic?.clicks);
  d.traffic.ordersPrev = str(prev.traffic?.orders);

  // opt-in rate "last week" = last week's computed opt-in rate
  const oip = pct(prev.funnel?.optedIn, prev.funnel?.targetInvites);
  d.outreach.optInRatePrev = oip == null ? '' : String(Math.round(oip * 10) / 10);

  // paid "last week" comparison values
  d.paid.spendPrev = str(prev.paid?.spend);
  d.paid.grossRevenuePrev = str(prev.paid?.grossRevenue);
  const prevSpend = num(prev.paid?.spend);
  const prevOrders = num(prev.paid?.skuOrders);
  const prevCpo = (prevSpend != null && prevOrders) ? prevSpend / prevOrders : null;
  d.paid.costPerOrderPrev = prevCpo == null ? '' : String(Math.round(prevCpo * 100) / 100);

  // ── sticky paid config (manual, not a fetched stat) ─────────────────
  d.paid.targetRoi = str(prev.paid?.targetRoi);
  d.paid.roiProtection = prev.paid?.roiProtection || 'on';
  d.paid.mode = str(prev.paid?.mode);

  // Niches invited — carried so the APC doesn't retype the same niches each
  // week (editable). Not a stat; not fetched.
  d.outreach.niches = str(prev.outreach?.niches);

  // ── open action items roll forward (template: "roll open items to next
  //    Tuesday"). Done items drop off. ─────────────────────────────────
  const openRows = (prev.actions?.rows || [])
    .filter((r) => r && r.status !== 'done' && ((r.action || '').trim() || (r.owner || '').trim()))
    .map((r) => ({ action: str(r.action), owner: str(r.owner), due: str(r.due), status: r.status || 'open' }));
  if (openRows.length) d.actions.rows = openRows;

  return d;
}
