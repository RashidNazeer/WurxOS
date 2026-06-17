import React, { useState } from 'react';
import WeeklyReportView from '../../components/reporting/WeeklyReportView';
import { makeWeekFromStart } from '../../lib/reportsApi';
import { eukaOverview, eukaTopCreators, eukaTopProducts } from '../../lib/eukaAnalyticsApi';
import { Section } from './EukaKit';

const num = (v) => (v == null || Number.isNaN(Number(v)) ? '' : Number(v));

// Snap any picked date to the Sunday that starts its week (Solid Gold's
// weeks run Sun–Sat, matching the APC's "Week N (Jun 7-13)" labels).
function weekFromPicked(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  const y = sunday.getFullYear();
  const m = String(sunday.getMonth() + 1).padStart(2, '0');
  const da = String(sunday.getDate()).padStart(2, '0');
  return makeWeekFromStart(`${y}-${m}-${da}`, 1);
}

function overallInsights(ov, topCreators) {
  const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const top = topCreators.slice(0, 3).map((c) => `${c.name} (${money(c.gmv)})`).join(', ');
  return `<ul>`
    + `<li>Total Shop GMV <b>${money(ov.totalShopGMV)}</b>, Affiliate GMV <b>${money(ov.totalAffiliateGMV)}</b>, with <b>${n(ov.totalOrders)}</b> orders this week.</li>`
    + (top ? `<li>Top creators by GMV: <b>${top}</b>.</li>` : '')
    + `</ul>`;
}

// Map ONLY the fields Euka provides exactly (verified to match the manual
// report): GMV, Affiliate GMV, Orders, Top Creators by GMV, and per-product
// AFFILIATE GMV (via the productIds filter on performance-overview — this is
// the number the report's "Products driving GMV" uses, e.g. Feline Favorites
// $4,392). Everything else is left blank for manual entry (ROI, Shop Score,
// GMV Max, Off-site = not exposed; samples/videos-posted/top-videos = a
// different metric than the report).
function buildReport(week, store, { overview, creators, products }) {
  const ov = overview || {};
  const topCreators = (creators?.affiliates || []).map((c) => ({
    name: c.handle ? `@${c.handle}` : '', videosPosted: '', itemsSold: '', gmv: num(c.totalGmv), notes: '',
  }));
  const productHighlights = (products || [])
    .filter((p) => Number(p.affiliateGmv) > 0)
    .sort((a, b) => Number(b.affiliateGmv) - Number(a.affiliateGmv))
    .slice(0, 8)
    .map((p) => ({
      productId: p.productId || '', productName: p.title || '', unitsSold: '',
      gmv: num(p.affiliateGmv), newVideos: num(p.videoCount), notes: '',
    }));
  return {
    id: null, brandId: null, brandName: store?.name || 'Store', status: 'draft', currency: 'USD',
    weekLabel: week.label, weekStart: week.startDate, weekEnd: week.endDate, week: week.week, year: week.year, month: week.month,
    overallPerformance: {
      gmv: num(ov.totalShopGMV),
      affiliateGmv: num(ov.totalAffiliateGMV),
      orders: num(ov.totalOrders),
      samplesApproved: '',      // Euka 'approved' (96) ≠ report (67) — manual
      videosPosted: '',         // Euka counts differ from the report — manual
      roi: '',                  // needs ad spend; Euka hasAdsApiConfig=false — manual
      shopPerformanceScore: '', // not exposed by Euka — manual
    },
    overallInsights: overallInsights(ov, topCreators),
    topCreators, topCreatorsInsights: '',
    productHighlights, productHighlightsInsights: '', // per-product affiliate GMV (accurate)
    topVideos: [], topVideosInsights: '',             // earned-in-week videos not in Euka — manual
    gmvMax: [], gmvMaxInsights: '',                    // GMV Max ads not in Euka — manual
    offsitePerformance: { offsiteGmv: '', tiktokShopGmv: '', offsiteEffect: '' }, offsiteInsights: '',
    upcomingCampaigns: '', operationalUpdates: '', recommendations: '', actionItems: '',
    customFields: {},
  };
}

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return <div className="alert alert-warning py-2 small mb-0">Preview couldn’t render: {String(this.state.err?.message || this.state.err)}</div>;
    return this.props.children;
  }
}

export default function EukaReportPreview({ storeId, store }) {
  const [anchor, setAnchor] = useState('2026-06-07'); // the Jun 7–13 week to verify
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const week = weekFromPicked(anchor);

  async function generate() {
    if (!storeId || !week) return;
    setBusy(true); setErr(''); setReport(null);
    const s = week.startDate, e = week.endDate;
    try {
      const [overview, creators, prodResp] = await Promise.all([
        eukaOverview(storeId, s, e),
        eukaTopCreators(storeId, s, e, { limit: 10 }).catch(() => null),
        eukaTopProducts(storeId, s, e, { limit: 10 }).catch(() => null),
      ]);
      if (!overview) throw new Error('Euka returned no performance data for this week.');
      // Per-product affiliate GMV: one filtered performance-overview per product
      // (the productIds filter). This is the number the report's product column uses.
      const baseProducts = prodResp?.products || [];
      const products = await Promise.all(baseProducts.map((p) =>
        eukaOverview(storeId, s, e, { productIds: [p.productId] })
          .then((o) => ({ ...p, affiliateGmv: o?.totalAffiliateGMV ?? null }))
          .catch(() => ({ ...p, affiliateGmv: null })),
      ));
      setReport(buildReport(week, store, { overview, creators, products }));
    } catch (ex) {
      setErr(ex?.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section span={12} title="Weekly report — auto-fill preview" icon="bi-magic" color="#7c3aed"
      eyebrow="Generates the weekly-report template from Euka for any week. Preview only — nothing is saved and no existing report is touched.">
      <div className="d-flex align-items-center flex-wrap gap-3 mb-1">
        <div className="d-inline-flex align-items-center gap-2">
          <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>Anchor date</span>
          <input type="date" className="form-control form-control-sm" style={{ width: 'auto', borderRadius: 9 }}
            value={anchor} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setAnchor(e.target.value)} />
        </div>
        {week && (
          <span className="rounded-pill px-3 py-1" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600 }}>
            {week.label}
          </span>
        )}
        <button className="btn btn-sm btn-primary d-inline-flex align-items-center gap-2" style={{ borderRadius: 9 }}
          disabled={busy || !storeId || !week} onClick={generate}>
          {busy ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-magic" />}
          Generate preview
        </button>
      </div>
      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
        <i className="bi bi-check-circle me-1 text-success" />
        Auto-filled (verified exact): <b>GMV, Affiliate GMV, Orders, Top creators by GMV, Products by affiliate GMV</b>.
        Left blank for manual entry: ROI, Shop Score, Samples, Videos Posted, Top videos, GMV Max, Off-site.
      </div>

      {err && <div className="alert alert-danger py-2 small mt-3 mb-0">{err}</div>}

      {report && (
        <div className="mt-3" style={{ border: '1px dashed var(--border-default)', borderRadius: 12, padding: 4 }}>
          <div className="px-3 pt-2 pb-1 text-muted" style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <i className="bi bi-eye me-1" />Preview · not saved
          </div>
          <Boundary>
            <WeeklyReportView report={report} previousReport={null} allReports={[]} clientView={false} />
          </Boundary>
        </div>
      )}
    </Section>
  );
}
