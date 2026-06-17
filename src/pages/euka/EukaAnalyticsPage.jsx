import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  eukaMe, eukaStores, eukaOverview, eukaSeries, eukaAffiliateFunnel, eukaConversionFunnel,
  eukaOutreachFunnel, eukaTopCreators, eukaTopProducts, eukaTopVideos, eukaContentOverview,
  eukaAdsOverview, eukaCreatorTiers, eukaSampleApproval, eukaFeaturedProducts, eukaLivestreamGmv,
  eukaCampaignBreakdown, eukaDataExport,
} from '../../lib/eukaAnalyticsApi';
import {
  fmtMoney, fmtMoney0, fmtNum, fmtPct, fmtCompact, Delta, Section, Kpi, Empty,
  LineChart, FunnelBars, Table,
} from './EukaKit';

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const PRESETS = [{ k: '7d', label: '7 days', n: 7 }, { k: '30d', label: '30 days', n: 30 }, { k: '90d', label: '90 days', n: 90 }];

// One-shot "bypass server cache" flag, consumed by the queries during a
// Refresh wave (reset shortly after so normal navigation stays cached).
const freshRef = { current: false };

function useEuka(key, fn, enabled) {
  return useQuery({
    queryKey: ['euka', ...key],
    queryFn: () => fn(freshRef.current),
    enabled: !!enabled,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

export default function EukaAnalyticsPage() {
  const qc = useQueryClient();
  const [storeId, setStoreId] = useState('');
  const [preset, setPreset] = useState('30d');
  const [customStart, setCustomStart] = useState(ymd(daysAgo(29)));
  const [customEnd, setCustomEnd] = useState(ymd(new Date()));

  const meQ = useQuery({ queryKey: ['euka', 'me'], queryFn: eukaMe, staleTime: 30 * 60 * 1000, retry: 1 });
  const storesQ = useQuery({ queryKey: ['euka', 'stores'], queryFn: eukaStores, staleTime: 30 * 60 * 1000, retry: 1 });

  useEffect(() => {
    if (!storeId && Array.isArray(storesQ.data) && storesQ.data.length) setStoreId(storesQ.data[0].id);
  }, [storesQ.data, storeId]);

  const { startDate, endDate } = useMemo(() => {
    if (preset === 'custom') return { startDate: customStart, endDate: customEnd };
    const n = PRESETS.find((p) => p.k === preset)?.n || 30;
    return { startDate: ymd(daysAgo(n - 1)), endDate: ymd(new Date()) };
  }, [preset, customStart, customEnd]);

  const ready = !!storeId && !!startDate && !!endDate;

  function refreshAll() {
    freshRef.current = true;
    qc.invalidateQueries({ queryKey: ['euka'] });
    setTimeout(() => { freshRef.current = false; }, 6000);
  }

  const store = (storesQ.data || []).find((s) => s.id === storeId);

  return (
    <div style={{ padding: '28px 28px 56px' }}>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between flex-wrap gap-2 mb-1">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-graph-up-arrow" style={{ color: 'var(--accent)' }} /> Euka Analytics
          </h5>
          <div className="text-muted" style={{ fontSize: '0.74rem' }}>
            TikTok Shop performance, creators &amp; content — live from Euka{meQ.data?.name ? ` · key: ${meQ.data.name}` : ''}
          </div>
        </div>
        <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ borderRadius: 9 }} onClick={refreshAll}>
          <i className="bi bi-arrow-clockwise" /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="d-flex align-items-center flex-wrap mt-3 mb-4 px-3 py-2 rounded-3"
        style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', columnGap: 18, rowGap: 10 }}>
        {/* Store */}
        <div className="d-inline-flex align-items-center gap-2">
          <i className="bi bi-shop text-muted" style={{ fontSize: '0.95rem' }} />
          <select className="form-select form-select-sm" style={{ width: 'auto', minWidth: 168, borderRadius: 9 }}
            value={storeId} onChange={(e) => setStoreId(e.target.value)} disabled={storesQ.isLoading}>
            {(storesQ.data || []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.region})</option>)}
            {storesQ.isLoading && <option>Loading stores…</option>}
          </select>
        </div>

        {/* Range — segmented control */}
        <div className="d-inline-flex align-items-center gap-1 p-1 rounded-3" style={{ background: 'var(--surface-2)' }}>
          {[...PRESETS, { k: 'custom', label: 'Custom' }].map((p) => {
            const on = preset === p.k;
            return (
              <button key={p.k} type="button" className="btn btn-sm border-0"
                style={{
                  borderRadius: 7, fontSize: '0.78rem', fontWeight: 600, padding: '3px 14px',
                  background: on ? 'var(--surface-1)' : 'transparent',
                  color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  boxShadow: on ? 'var(--shadow-sm)' : 'none',
                }}
                onClick={() => setPreset(p.k)}>{p.label}</button>
            );
          })}
        </div>

        {preset === 'custom' && (
          <div className="d-inline-flex align-items-center gap-2">
            <input type="date" className="form-control form-control-sm" style={{ width: 'auto', borderRadius: 9 }}
              value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} />
            <span className="text-muted">→</span>
            <input type="date" className="form-control form-control-sm" style={{ width: 'auto', borderRadius: 9 }}
              value={customEnd} min={customStart} max={ymd(new Date())} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
        )}

        <span className="ms-auto rounded-pill d-inline-flex align-items-center gap-1 px-3 py-1"
          style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600 }}>
          <i className="bi bi-calendar3" />{startDate} → {endDate}
        </span>
      </div>

      {storesQ.isError && <div className="alert alert-danger py-2 small">Couldn’t reach Euka: {String(storesQ.error?.message || storesQ.error)}</div>}
      {!ready && !storesQ.isError && <div className="text-muted small">Select a store to begin.</div>}

      {ready && (
        <>
          <KpiRow storeId={storeId} start={startDate} end={endDate} />

          <div className="row g-3 mt-1">
            <TrendSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <AffiliateFunnelSection storeId={storeId} start={startDate} end={endDate} />
            <OutreachFunnelSection storeId={storeId} start={startDate} end={endDate} />
            <ConversionFunnelSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <TopCreatorsSection storeId={storeId} start={startDate} end={endDate} />
            <TopProductsSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <TopVideosSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <ContentSection storeId={storeId} start={startDate} end={endDate} />
            <AdsSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <CreatorTiersSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <SmallStatsSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <CampaignSection storeId={storeId} start={startDate} end={endDate} />
          </div>

          <div className="row g-3 mt-1">
            <ExportSection storeId={storeId} start={startDate} end={endDate} store={store} />
          </div>
        </>
      )}
    </div>
  );
}

function Loading() { return <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading…</div>; }
function Err({ q }) { return <div className="text-danger small py-2">Failed: {String(q.error?.message || q.error)}</div>; }

// ── KPIs ──────────────────────────────────────────────────────────
function KpiRow({ storeId, start, end }) {
  const q = useEuka(['overview', storeId, start, end], (f) => eukaOverview(storeId, start, end, {}, f), true);
  const d = q.data || {};
  if (q.isLoading) return <div className="row g-3"><div className="col-12"><Loading /></div></div>;
  if (q.isError) return <div className="row g-3"><div className="col-12"><Err q={q} /></div></div>;
  return (
    <div className="row g-3">
      <Kpi label="Total Shop GMV" value={fmtMoney0(d.totalShopGMV)} delta={d.totalShopGMVDifference} />
      <Kpi label="Affiliate GMV" value={fmtMoney0(d.totalAffiliateGMV)} delta={d.totalAffiliateGMVDifference} />
      <Kpi label="Orders" value={fmtNum(d.totalOrders)} delta={d.totalOrdersDifference} />
      <Kpi label="Ad Spend" value={fmtMoney0(d.totalAdSpend)} delta={d.totalAdSpendDifference} invertDelta />
      <Kpi label="Impressions" value={fmtCompact(d.impressions)} delta={d.impressionsDifference} />
      <Kpi label="Creators Reached" value={fmtNum(d.creatorsReached)} delta={d.creatorsReachedDifference} />
      <Kpi label="Active Creators" value={fmtNum(d.activeCreators)} delta={d.activeCreatorsDifference} />
      <Kpi label="Samples Approved" value={fmtNum(d.samplesApproved)} delta={d.samplesApprovedDifference} />
      <Kpi label="Video Conv. Rate" value={fmtPct(d.videoConvRate)} delta={d.videoConvRateDifference} sub={`${fmtNum(d.videoConvRateConvertingVideos)}/${fmtNum(d.videoConvRateTotalVideos)}`} />
      <Kpi label="Avg Views / Video" value={fmtCompact(d.avgViewsPerVideo)} delta={d.avgViewsPerVideoDifference} />
      <Kpi label="Revenue / Creator" value={fmtMoney(d.revenuePerCreator)} delta={d.revenuePerCreatorDifference} />
      <Kpi label="Post Rate" value={d.postRate?.value != null ? `${Number(d.postRate.value).toFixed(2)}` : '—'} sub={`${fmtNum(d.postRate?.posted)} posted`} />
    </div>
  );
}

// ── Trend ─────────────────────────────────────────────────────────
function TrendSection({ storeId, start, end }) {
  const q = useEuka(['series', storeId, start, end], (f) => eukaSeries(storeId, start, end, {}, f), true);
  const perf = q.data?.data?.performances || [];
  const gmvSeries = {
    label: 'Total GMV', color: 'var(--accent)',
    points: perf.map((p) => ({ x: (p.date || '').slice(5), y: Number(p.total_shop_gmv ?? p.total_gmv) || 0 })),
  };
  const ordSeries = {
    label: 'Orders', color: '#f59e0b',
    points: perf.map((p) => ({ x: (p.date || '').slice(5), y: Number(p.total_orders) || 0 })),
  };
  return (
    <Section span={12} title="Daily performance" eyebrow="GMV & orders over the selected range" icon="bi-graph-up" color="var(--accent)">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <div className="row g-3">
          <div className="col-12 col-lg-7"><LineChart series={[gmvSeries]} yFmt={(v) => fmtMoney0(v)} /></div>
          <div className="col-12 col-lg-5"><LineChart series={[ordSeries]} yFmt={fmtCompact} /></div>
        </div>
      )}
    </Section>
  );
}

// ── Funnels ───────────────────────────────────────────────────────
function AffiliateFunnelSection({ storeId, start, end }) {
  const q = useEuka(['affFunnel', storeId, start, end], (f) => eukaAffiliateFunnel(storeId, start, end, f), true);
  const d = q.data || {};
  return (
    <Section span={4} title="Affiliate funnel" icon="bi-funnel" color="#8b5cf6">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <FunnelBars color="#8b5cf6" rows={[
          { label: 'Unique creators', value: d.unique },
          { label: 'Posted', value: d.posted },
          { label: 'Samples shipped', value: d.samplesShipped },
          { label: 'Unfulfilled', value: d.unfulfilled },
        ]} />
      )}
    </Section>
  );
}
function OutreachFunnelSection({ storeId, start, end }) {
  const q = useEuka(['outreach', storeId, start, end], (f) => eukaOutreachFunnel(storeId, start, end, {}, f), true);
  const stages = q.data?.stages || [];
  return (
    <Section span={4} title="Creator outreach funnel" icon="bi-people" color="#06b6d4">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <FunnelBars color="#06b6d4" rows={stages.map((s) => ({ label: s.label, value: s.value, sub: s.convFromPrev != null ? `${Number(s.convFromPrev).toFixed(0)}%` : null }))} />
      )}
    </Section>
  );
}
function ConversionFunnelSection({ storeId, start, end }) {
  const q = useEuka(['convFunnel', storeId, start, end], (f) => eukaConversionFunnel(storeId, start, end, f), true);
  const c = q.data?.conversionFunnel || {};
  return (
    <Section span={4} title="Conversion funnel" icon="bi-cart-check" color="#10b981">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <FunnelBars color="#10b981" rows={[
          { label: 'Impressions', value: c.impressions },
          { label: 'PDP impressions', value: c.pdp_impressions },
          { label: 'Checkout', value: c.checkout },
        ]} />
      )}
    </Section>
  );
}

// ── Tops ──────────────────────────────────────────────────────────
function TopCreatorsSection({ storeId, start, end }) {
  const q = useEuka(['topCreators', storeId, start, end], (f) => eukaTopCreators(storeId, start, end, { limit: 10 }, f), true);
  const rows = q.data?.affiliates || [];
  return (
    <Section span={6} title="Top creators by GMV" icon="bi-star-fill" color="#f59e0b">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <Table empty="No creators in range." rows={rows} cols={[
          { key: 'handle', label: 'Creator', render: (r) => <span className="fw-semibold">@{r.handle}</span> },
          { key: 'videoCount', label: 'Videos', align: 'right', render: (r) => fmtNum(r.videoCount) },
          { key: 'totalGmv', label: 'GMV', align: 'right', render: (r) => fmtMoney0(r.totalGmv) },
          { key: 'revenueDelta', label: 'Δ', align: 'right', render: (r) => <Delta pct={r.revenueDelta} /> },
        ]} />
      )}
    </Section>
  );
}
function TopProductsSection({ storeId, start, end }) {
  const q = useEuka(['topProducts', storeId, start, end], (f) => eukaTopProducts(storeId, start, end, { limit: 10 }, f), true);
  const rows = q.data?.products || [];
  return (
    <Section span={6} title="Top products by video revenue" icon="bi-box-seam" color="#3b82f6">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <Table empty="No products in range." rows={rows} cols={[
          { key: 'title', label: 'Product', render: (r) => <span className="fw-semibold text-truncate d-inline-block" style={{ maxWidth: 260 }}>{r.title || r.productId}</span> },
          { key: 'videoCount', label: 'Videos', align: 'right', render: (r) => fmtNum(r.videoCount) },
          { key: 'totalRevenue', label: 'Revenue', align: 'right', render: (r) => fmtMoney0(r.totalRevenue) },
          { key: 'revenueDelta', label: 'Δ', align: 'right', render: (r) => <Delta pct={r.revenueDelta} /> },
        ]} />
      )}
    </Section>
  );
}
function TopVideosSection({ storeId, start, end }) {
  const q = useEuka(['topVideos', storeId, start, end], (f) => eukaTopVideos(storeId, start, end, {}, f), true);
  const rows = (q.data?.videos || []).slice(0, 12);
  return (
    <Section span={12} title="Top videos by revenue" icon="bi-play-btn" color="#ec4899">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <Table empty="No videos in range." rows={rows} cols={[
          { key: 'creatorHandle', label: 'Creator', render: (r) => <span className="fw-semibold">@{r.creatorHandle || '—'}</span> },
          { key: 'productTitle', label: 'Product', render: (r) => <span className="text-truncate d-inline-block" style={{ maxWidth: 220 }}>{r.productTitle || '—'}</span> },
          { key: 'viewsCount', label: 'Views', align: 'right', render: (r) => fmtCompact(r.viewsCount) },
          { key: 'likesCount', label: 'Likes', align: 'right', render: (r) => fmtCompact(r.likesCount) },
          { key: 'productClicks', label: 'Clicks', align: 'right', render: (r) => fmtCompact(r.productClicks) },
          { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => fmtMoney0(r.revenue) },
        ]} />
      )}
    </Section>
  );
}

// ── Content + Ads ─────────────────────────────────────────────────
function ContentSection({ storeId, start, end }) {
  const q = useEuka(['content', storeId, start, end], (f) => eukaContentOverview(storeId, start, end, { granularity: 'weekly' }, f), true);
  const t = q.data?.totals || {};
  const monthly = q.data?.monthly || [];
  return (
    <Section span={6} title="Content overview" icon="bi-collection-play" color="#0ea5e9">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <>
          <div className="row g-2 mb-3">
            {[['Videos', t.videos], ['Views', t.views], ['Likes', t.likes], ['Comments', t.comments]].map(([l, v]) => (
              <div className="col-3" key={l}>
                <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px', textAlign: 'center' }}>
                  <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 700, textTransform: 'uppercase' }}>{l}</div>
                  <div className="fw-bold" style={{ fontSize: '0.95rem' }}>{fmtCompact(v)}</div>
                </div>
              </div>
            ))}
          </div>
          <LineChart series={[{ label: 'Videos', color: '#0ea5e9', points: monthly.map((m) => ({ x: m.month, y: m.tiktok })) }]} yFmt={fmtCompact} height={160} />
        </>
      )}
    </Section>
  );
}
function AdsSection({ storeId, start, end }) {
  const q = useEuka(['ads', storeId, start, end], (f) => eukaAdsOverview(storeId, start, end, {}, f), true);
  const s = q.data?.stats || {};
  const top = q.data?.topBoosted || [];
  return (
    <Section span={6} title="Ads overview" icon="bi-megaphone" color="#ef4444">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <>
          <div className="row g-2 mb-3">
            {[['Boosted videos', fmtNum(s.boostedCount)], ['Coverage', fmtPct(s.coverage)], ['Boosted GMV', fmtMoney0(s.boostedGmv)], ['Total videos', fmtNum(s.totalVideos)]].map(([l, v]) => (
              <div className="col-3" key={l}>
                <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px', textAlign: 'center' }}>
                  <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 700, textTransform: 'uppercase' }}>{l}</div>
                  <div className="fw-bold" style={{ fontSize: '0.9rem' }}>{v}</div>
                </div>
              </div>
            ))}
          </div>
          <Table empty="No boosted videos." rows={top.slice(0, 6)} cols={[
            { key: 'creatorHandle', label: 'Creator', render: (r) => <span className="fw-semibold">@{r.creatorHandle || '—'}</span> },
            { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => fmtMoney0(r.revenue) },
            { key: 'adSpend', label: 'Spend', align: 'right', render: (r) => fmtMoney0(r.adSpend) },
            { key: 'roas', label: 'ROAS', align: 'right', render: (r) => r.roas != null ? `${Number(r.roas).toFixed(2)}×` : '—' },
          ]} />
        </>
      )}
    </Section>
  );
}

// ── Creator tiers ─────────────────────────────────────────────────
function CreatorTiersSection({ storeId, start, end }) {
  const q = useEuka(['tiers', storeId, start, end], (f) => eukaCreatorTiers(storeId, start, end, {}, f), true);
  const rows = q.data?.tiers || [];
  return (
    <Section span={12} title="Creator level breakdown" icon="bi-bar-chart-steps" color="#8b5cf6">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <Table empty="No tier data." rows={rows} cols={[
          { key: 'tier', label: 'Tier', render: (r) => <span className="fw-semibold">{r.tier} <span className="text-muted fw-normal">{r.range}</span></span> },
          { key: 'creators', label: 'Creators', align: 'right', render: (r) => fmtNum(r.creators) },
          { key: 'videos', label: 'Videos', align: 'right', render: (r) => fmtNum(r.videos) },
          { key: 'totalGmv', label: 'GMV', align: 'right', render: (r) => fmtMoney0(r.totalGmv) },
          { key: 'sampleRequests', label: 'Sample reqs', align: 'right', render: (r) => fmtNum(r.sampleRequests) },
          { key: 'samplesApproved', label: 'Approved', align: 'right', render: (r) => fmtNum(r.samplesApproved) },
          { key: 'samplesDelivered', label: 'Delivered', align: 'right', render: (r) => fmtNum(r.samplesDelivered) },
          { key: 'samplesPosted', label: 'Posted', align: 'right', render: (r) => fmtNum(r.samplesPosted) },
        ]} />
      )}
    </Section>
  );
}

// ── Small stat cards ──────────────────────────────────────────────
function SmallStatsSection({ storeId, start, end }) {
  const sample = useEuka(['sample', storeId, start, end], (f) => eukaSampleApproval(storeId, start, end, f), true);
  const featured = useEuka(['featured', storeId, start, end], (f) => eukaFeaturedProducts(storeId, start, end, f), true);
  const live = useEuka(['live', storeId, start, end], (f) => eukaLivestreamGmv(storeId, start, end, f), true);
  const card = (title, icon, color, value, delta) => (
    <div className="col-12 col-md-4">
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '16px 18px' }}>
        <div className="d-flex align-items-center gap-2 mb-1">
          <i className={`bi ${icon}`} style={{ color }} />
          <span className="text-muted" style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase' }}>{title}</span>
        </div>
        <div className="fw-bold" style={{ fontSize: '1.3rem', color: 'var(--text-primary)' }}>{value}</div>
        {delta != null && <Delta pct={delta} />}
      </div>
    </div>
  );
  return (
    <>
      {card('Sample approval rate', 'bi-clipboard-check', '#10b981', sample.isLoading ? '…' : fmtPct(sample.data?.rate), sample.data?.delta)}
      {card('Featured products', 'bi-pin-angle', '#3b82f6', featured.isLoading ? '…' : fmtNum(featured.data?.total), featured.data?.delta)}
      {card('Livestream GMV', 'bi-broadcast', '#ec4899', live.isLoading ? '…' : fmtMoney0(live.data?.current), live.data?.delta)}
    </>
  );
}

// ── Campaign breakdown ────────────────────────────────────────────
function CampaignSection({ storeId, start, end }) {
  const q = useEuka(['campaigns', storeId, start, end], (f) => eukaCampaignBreakdown(storeId, start, end, {}, f), true);
  const rows = q.data?.videos_data || [];
  const reach = q.data?.creators_reached_data || [];
  const reachBy = Object.fromEntries(reach.map((r) => [r.campaign_id, r]));
  return (
    <Section span={12} title="Campaign breakdown" icon="bi-diagram-3" color="#f59e0b">
      {q.isLoading ? <Loading /> : q.isError ? <Err q={q} /> : (
        <Table empty="No campaigns in range." rows={rows} cols={[
          { key: 'campaign_name', label: 'Campaign', render: (r) => <span className="fw-semibold">{r.campaign_name || `#${r.campaign_id}`}</span> },
          { key: 'videos_posted', label: 'Videos', align: 'right', render: (r) => fmtNum(r.videos_posted) },
          { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => fmtMoney0(r.revenue) },
          { key: 'revenue_per_creator', label: 'Rev/creator', align: 'right', render: (r) => fmtMoney0(r.revenue_per_creator) },
          { key: 'average_views_per_video', label: 'Avg views', align: 'right', render: (r) => fmtCompact(r.average_views_per_video) },
          { key: 'creators_reached', label: 'Reached', align: 'right', render: (r) => fmtNum(reachBy[r.campaign_id]?.creators_reached) },
          { key: 'response_rate', label: 'Response', align: 'right', render: (r) => fmtPct(reachBy[r.campaign_id]?.response_rate) },
        ]} />
      )}
    </Section>
  );
}

// ── Data export ───────────────────────────────────────────────────
const EXPORTS = [
  { type: 'creator_videos', label: 'Creator videos' },
  { type: 'sample_requests', label: 'Sample requests' },
  { type: 'creator_level', label: 'Creator level' },
  { type: 'target_collab_invites', label: 'Collab invites' },
  { type: 'spark_codes_video_download_links', label: 'Spark codes' },
];
function ExportSection({ storeId, start, end, store }) {
  const [busy, setBusy] = useState('');
  async function download(type) {
    setBusy(type);
    try {
      const data = await eukaDataExport(type, storeId, { startDate: start, endDate: end, exportType: 'json' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `euka-${(store?.name || 'store').replace(/\s+/g, '_')}-${type}-${start}_${end}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Export failed: ' + (e?.message || e));
    } finally {
      setBusy('');
    }
  }
  return (
    <Section span={12} title="Data export" eyebrow="Download the raw data (JSON) for the selected store & range" icon="bi-download" color="#64748b">
      <div className="d-flex flex-wrap gap-2">
        {EXPORTS.map((e) => (
          <button key={e.type} className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ borderRadius: 9 }}
            disabled={!!busy} onClick={() => download(e.type)}>
            {busy === e.type ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-filetype-json" />} {e.label}
          </button>
        ))}
      </div>
    </Section>
  );
}
