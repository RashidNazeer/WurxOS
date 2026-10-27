// ============================================================
// Reacher -> WurxOS report/checkpoint mapping. PURE: no Deno APIs, no network,
// so it runs under `npm run test:reacher` against real captured responses.
//
// Every field mapped here was checked against what Irwin Naturals' APC typed by
// hand from Reacher, across the weeks of 11 Sep -> 24 Oct 2026. What matched,
// and what did NOT, decides what is filled:
//
//   FILLED (matched the hand-entered report)
//     overallPerformance.gmv              metrics/summary.total_gmv   exact, 3/3 weeks
//     overallPerformance.affiliateGmv     metrics/summary.gmv         exact to the cent; the
//                                         APC rounded to whole dollars in 2 of 3 weeks
//     overallPerformance.orders           metrics/summary.orders      exact, 3/3
//     overallPerformance.videosPosted     creators/summary.video_posts  exact in the newest
//                                         week, within 1% in the others (Reacher revises
//                                         video counts after the fact)
//     overallPerformance.shopPerformanceScore  shop-health series, last point <= end date
//     overallNotes.gmv                    month-to-date metrics/summary.total_gmv  exact, 3/3
//     topCreators[]                       creators/performance: handle, gmv, units_sold  exact
//     productHighlights[]                 products/list: sc_total_gmv, sc_orders,
//                                         video_count  exact
//
//   NOT FILLED (no Reacher field reproduces the number the APC reports)
//     samplesApproved (week and MTD)      metrics/summary says 124, samples/by-product sums
//                                         to 123 or 124, the APC entered 102. Different
//                                         definitions; a wrong number the APC must then
//                                         notice and overwrite is worse than a blank.
//     roi                                 not exposed (gmv_max.avg_roas is ROAS, not ROI)
//     per-creator videosPosted            not in creators/performance
//     videosMtd / samplesApprovedMtd / samplesApprovedWeek per product
//
// Checkpoint (funnel):
//     optedIn / sampleRequests   metrics/summary.sample_requests  exact in the 2 newest
//                                weeks; older weeks drift because Reacher revises history
//     targetInvites              creators/tier-performance weeks[].total.creators  within
//                                1% for the 3 newest weeks, not exact. Reported with
//                                approximate: true so the form can say so.
// ============================================================

export const REACHER_BASE = 'https://api.reacherapp.com/public/v1';

const isNil = (v: unknown) => v === null || v === undefined || v === '';
// Counts (orders, videos, units) -> integer. Money -> 2-decimal exact, so the
// report fields never show float noise like 4812.860000000001.
export const num = (v: unknown) => (isNil(v) || Number.isNaN(Number(v)) ? '' : Math.round(Number(v)));
export const money = (v: unknown) => (isNil(v) || Number.isNaN(Number(v)) ? '' : Number(Number(v).toFixed(2)));
const score = (v: unknown) => (isNil(v) || Number.isNaN(Number(v)) ? '' : Number(Number(v).toFixed(1)));

// ---- shapes of the Reacher responses we read (only the fields we use) --------
export interface MetricsSummary {
  total_gmv?: number | null; gmv?: number | null; orders?: number | null;
  sample_requests?: number | null;
}
export interface CreatorsSummary { data?: { video_posts?: number | null } }
export interface CreatorRow { creator_handle?: string; gmv?: number; units_sold?: number }
export interface ProductRow {
  product_id?: string; product_name?: string;
  sc_total_gmv?: number; sc_orders?: number; video_count?: number;
}
export interface HealthPoint { date?: string; sps_score?: number }
export interface TierWeek { week_start?: string; total?: { creators?: number } }

export interface ReportInputs {
  summary: MetricsSummary;
  mtd: MetricsSummary | null;          // null when the week starts on the 1st (it IS the MTD)
  creatorsSummary: CreatorsSummary | null;
  creators: CreatorRow[] | null;
  products: ProductRow[] | null;
  health: HealthPoint[] | null;
  endDate: string;
}

// SPS is a daily snapshot. The report wants the score AS OF the end of the week,
// so take the last point on or before the end date, never "latest" (today's).
export function spsAsOf(series: HealthPoint[] | null, endDate: string): number | '' {
  const pts = (series || []).filter((p) => p?.date && p.date <= endDate && p.sps_score != null);
  if (!pts.length) return '';
  pts.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return score(pts[pts.length - 1].sps_score) as number | '';
}

export function buildReportData(i: ReportInputs) {
  const topCreators = (i.creators || [])
    .filter((c) => c?.creator_handle)
    .slice(0, 3)
    .map((c) => ({
      // Plain handle, no "@": that is how Irwin's APC has always entered them.
      name: String(c.creator_handle),
      // Not in creators/performance. Blank, not 0 -- 0 would assert "posted
      // nothing" when the truth is "unknown".
      videosPosted: '',
      itemsSold: num(c.units_sold),
      gmv: money(c.gmv),
      notes: '',
    }));

  const productHighlights = (i.products || [])
    .filter((p) => Number(p?.sc_total_gmv) > 0)
    .sort((a, b) => Number(b.sc_total_gmv) - Number(a.sc_total_gmv))
    .slice(0, 5)
    .map((p) => ({
      productId: p.product_id || '',
      productName: p.product_name || '',
      unitsSold: num(p.sc_orders),     // the report uses ORDERS as "units"
      gmv: money(p.sc_total_gmv),
      newVideos: num(p.video_count),
      videosMtd: '', samplesApprovedWeek: '', samplesApprovedMtd: '', notes: '',
    }));

  const mtdGmv = money((i.mtd ?? i.summary)?.total_gmv);

  const data: Record<string, unknown> = {
    overallPerformance: {
      gmv: money(i.summary.total_gmv),
      affiliateGmv: money(i.summary.gmv),
      orders: num(i.summary.orders),
      videosPosted: num(i.creatorsSummary?.data?.video_posts),
      shopPerformanceScore: spsAsOf(i.health, i.endDate),
      samplesApproved: '', roi: '',
    },
    ...(mtdGmv !== '' ? { overallNotes: { gmv: mtdGmv } } : {}),
    overallInsights: insightsHtml(i.summary, topCreators),
    topCreators: topCreators.length ? topCreators : undefined,
    productHighlights: productHighlights.length ? productHighlights : undefined,
  };
  return { data, mtdGmv, creatorCount: topCreators.length, productCount: productHighlights.length };
}

export function insightsHtml(s: MetricsSummary, creators: Array<{ name: string; gmv: unknown }>): string {
  const usd = (v: unknown) => (isNil(v) ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  const n = (v: unknown) => (isNil(v) ? '—' : Number(v).toLocaleString('en-US'));
  const top = (creators || []).slice(0, 3)
    .map((c) => `${c.name} (${usd(typeof c.gmv === 'number' ? c.gmv : null)})`)
    .join(', ');
  return '<ul>'
    + `<li>Total Shop GMV <b>${usd(s.total_gmv)}</b>, Affiliate GMV <b>${usd(s.gmv)}</b>, with <b>${n(s.orders)}</b> orders this week.</li>`
    + (top ? `<li>Top creators by GMV: <b>${top}</b>.</li>` : '')
    + '</ul>';
}

// ---- checkpoint --------------------------------------------------------------
export function buildCheckpoint(summary: MetricsSummary | null, tierWeeks: TierWeek[] | null, weekStart: string) {
  // tier-performance returns one entry per week it covers. We ask for exactly
  // one, so prefer the week that starts when ours does; fall back to the only
  // entry. Never sum several weeks into one number.
  const weeks = tierWeeks || [];
  const wk = weeks.find((w) => w?.week_start === weekStart) ?? (weeks.length === 1 ? weeks[0] : null);
  const invites = wk?.total?.creators;
  const requests = summary?.sample_requests;
  return {
    targetInvites: isNil(invites) ? null : Math.round(Number(invites)),
    optedIn: isNil(requests) ? null : Math.round(Number(requests)),
    sampleRequests: isNil(requests) ? null : Math.round(Number(requests)),
    // targetInvites tracks the APC's own figure to within ~1% but is not exact.
    approximate: ['targetInvites'],
  };
}
