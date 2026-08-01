import { useEffect, useMemo, useRef, useState } from 'react';
import WeeklyReportView from '../reporting/WeeklyReportView';
import MonthlyReportView from '../reporting/MonthlyReportView';
import BrandSectionsPanel from './BrandSectionsPanel';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import { formatPctChange, pctChange, pctChangeDir } from '../../utils/formatPctChange';
import { exportReportToPdf } from '../../utils/exportReportPdf';

/**
 * Public reports viewer for the client portal — exact match to v1's
 * latest ClientReportsDashboard (origin/main as of May 2026):
 *
 *   1. Dark hero card "{Weekly|Bi-Weekly|Monthly} Reports · N brands"
 *   2. Report-type tab pills — appear when more than 1 type is granted
 *      via share_types. Empty types still get a tab so the client can
 *      see "no approved reports yet" rather than a missing section.
 *   3. Brand filter dropdown — only when more than 1 brand
 *   4. Reports grouped by brand → click opens the full dashboard view
 *
 * v1 dropped the month/date navigator (commit 515cf30) — clients see
 * every approved report. We match that here.
 */

// Tolerant numeric parse — strips currency symbols, thousands
// separators and stray characters before parsing, so a value stored
// as "£4,398.45" or "4,398.45" reads correctly instead of as 4 or 0.
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

// Headline metrics for a report card. Weekly / bi-weekly keep them
// in `overallPerformance`; monthly keeps them in `totalSales` /
// `keyMetrics` / `kpis`. Reading only `overallPerformance` is what
// made monthly cards show 0 / 0. ROI is only tracked on weekly /
// bi-weekly reports.
function reportMetrics(r) {
  const op = (r && r.overallPerformance) || {};
  const gmv = num(op.gmv) || num(r?.totalSales?.monthGmv) || num(r?.keyMetrics?.gmv);
  const orders = num(op.orders) || num(r?.keyMetrics?.orders) || num(r?.kpis?.totalOrders);
  const roiRaw = op.roi;
  const hasRoi = roiRaw != null && roiRaw !== ''
    && !Number.isNaN(parseFloat(String(roiRaw).replace(/[^0-9.-]/g, '')));
  // MTD GMV — the APC-entered month-to-date GMV (weekly/biweekly keep it in
  // overallNotes.gmv). Shown under the weekly GMV; absent on old reports.
  const gmvMtd = num(r?.overallNotes?.gmv);
  return { gmv, orders, roi: num(roiRaw), hasRoi, gmvMtd };
}

// Convert a row from get_client_access (snake_case, flattened) into the
// v1-style shape that WeeklyReportView / MonthlyReportView expect.
// _normReport in reportsApi.js does this for joined queries; the portal
// RPC returns a slimmer shape (no joined author/brand objects), so we
// inline a smaller adapter here.
function adaptReportForView(r) {
  if (!r) return r;
  const data = r.data || {};
  const base = {
    id: r.id,
    type: r.type,
    brandId: r.brand_id,
    brandName: r.brand_name || data.brandName || '',
    status: r.status || 'approved',
    sectionsEnabled: r.sections_enabled || data.sectionsEnabled || null,
    createdByName: r.author_name || data.createdByName || '',
    // Spread data fields onto the root so report.overallPerformance,
    // report.topCreators, report.gmvMax, etc. all work unchanged.
    ...data,
    // Brand currency (from get_client_access) is the single source of truth for
    // money symbols and wins over the legacy per-report snapshot, so the portal
    // shows one consistent currency across a brand's reports. Falls back to the
    // old snapshot then USD.
    currency: r.brand_currency || data.currency || 'USD',
  };
  if (r.type === 'monthly') {
    return {
      ...base,
      year: r.period_year,
      month: r.period_month,
      monthKey: r.period_year != null && r.period_month != null
        ? `${r.period_year}-${String(r.period_month + 1).padStart(2, '0')}`
        : null,
      monthLabel: r.period_label || data.monthLabel || '',
    };
  }
  if (r.type === 'biweekly') {
    return {
      ...base,
      period: r.period_number || 1,
      year: r.period_year,
      month: r.period_month,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      periodLabel: r.period_label || '',
    };
  }
  // Weekly
  return {
    ...base,
    week: r.period_number || 1,
    year: r.period_year,
    month: r.period_month,
    weekStart: r.period_start,
    weekEnd: r.period_end,
    weekLabel: r.period_label || '',
  };
}

export default function ClientReportsSection({
  reports = [],
  brands = [],
  shareTypes = [],       // ['weekly','biweekly','monthly','paidCollab','gmvMax']
  sections = [],         // [{ brand_id, sections: [{id, name, ...}] }]
  sectionValues = [],    // flat list across permitted reports
  reportResources = [],  // [{ brand_id, sections: [...] }] — brand "Report Links"
  token = null,
  onMutate,
}) {
  const adapted = useMemo(() => reports.map(adaptReportForView), [reports]);

  // Lookups: per-brand section template list, and per-report value rows.
  const sectionsByBrand = useMemo(() => {
    const m = new Map();
    for (const row of sections || []) {
      m.set(row.brand_id, row.sections || []);
    }
    return m;
  }, [sections]);
  const valuesByReport = useMemo(() => {
    const m = new Map();
    for (const v of sectionValues || []) {
      const arr = m.get(v.report_id) || [];
      arr.push(v);
      m.set(v.report_id, arr);
    }
    return m;
  }, [sectionValues]);
  // Per-brand "Report Links" sections, injected into the report views so
  // they render for the anonymous client (the table is RLS-gated to authed
  // users, so the views' own fetch returns nothing in the portal).
  const resourcesByBrand = useMemo(() => {
    const m = new Map();
    for (const row of reportResources || []) {
      m.set(row.brand_id, row.sections || []);
    }
    return m;
  }, [reportResources]);

  // Tab list comes from share_types (granted set) — NOT from data. That
  // way every granted report type gets a tab even if no reports of that
  // type are approved yet, so the client doesn't think the section is
  // missing entirely. Order matches v1: weekly, biweekly, monthly.
  const availableTypes = useMemo(() => {
    const granted = new Set(shareTypes || []);
    return ['weekly', 'biweekly', 'monthly'].filter(t => granted.has(t));
  }, [shareTypes]);

  const [activeType, setActiveType] = useState(availableTypes[0] || 'weekly');
  // If the granted set changes (e.g. Boss flips a toggle while client is
  // viewing), make sure the active tab is one of the granted ones.
  useEffect(() => {
    if (availableTypes.length > 0 && !availableTypes.includes(activeType)) {
      setActiveType(availableTypes[0]);
    }
  }, [availableTypes, activeType]);

  const [filterBrand, setFilterBrand] = useState('');
  const [viewReport, setViewReport] = useState(null);

  // ── Export-from-card support ───────────────────────────────────────
  // Exporting a report straight from its list card: we render the full
  // report view into an off-screen container, let charts + fonts
  // settle, capture it to a single-page PDF, then tear it down. Same
  // export the in-app views use, so the client gets an identical PDF.
  const offscreenRef = useRef(null);
  const [pendingExport, setPendingExport] = useState(null);

  function handleCardExport(report, brandReports) {
    if (pendingExport) return; // one export at a time
    const prev = findPreviousReport(brandReports, report);
    setPendingExport({ report, prev, brandReports });
  }

  useEffect(() => {
    if (!pendingExport) return undefined;
    let cancelled = false;
    // Give the off-screen report time to mount its Recharts charts
    // and load fonts before the capture.
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const node = offscreenRef.current
          && offscreenRef.current.querySelector('.report-canvas');
        if (node) {
          const r = pendingExport.report;
          const label = r.weekLabel || r.periodLabel || r.monthLabel || '';
          const typeLabel = r.type === 'monthly' ? 'Monthly'
            : r.type === 'biweekly' ? 'Bi-Weekly' : 'Weekly';
          await exportReportToPdf(node, {
            title: `${typeLabel} Report - ${r.brandName || 'Brand'} - ${label}`.trim(),
          });
        }
      } catch (err) {
        console.error('[client-export] failed:', err);
        alert('Failed to export the PDF. Please try again.');
      } finally {
        if (!cancelled) setPendingExport(null);
      }
    }, 1100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pendingExport]);

  const inType = useMemo(
    () => adapted.filter(r => r.type === activeType),
    [adapted, activeType],
  );

  const brandOptions = useMemo(() => {
    const s = new Set();
    inType.forEach(r => r.brandName && s.add(r.brandName));
    return [...s].sort();
  }, [inType]);

  // No date filtering — clients see every approved report (matches v1's
  // origin/main commit 515cf30: "remove date filter — clients see every
  // approved report").
  const filtered = useMemo(() => {
    return inType.filter(r => {
      if (filterBrand && r.brandName !== filterBrand) return false;
      return true;
    });
  }, [inType, filterBrand]);

  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach(r => {
      const key = r.brandName || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    // Sort each brand's reports newest first (v1 origin/main does this).
    map.forEach(list => list.sort((a, b) => {
      const ka = a.weekStart || a.periodStart || (a.monthKey ? a.monthKey + '-01' : '');
      const kb = b.weekStart || b.periodStart || (b.monthKey ? b.monthKey + '-01' : '');
      return kb.localeCompare(ka);
    }));
    return map;
  }, [filtered]);

  // ── Detail view ────────────────────────────────────────────────────
  if (viewReport) {
    return (
      <ReportDetailView
        report={viewReport}
        reportsForBrand={adapted.filter(r => r.brandId === viewReport.brandId)}
        grantedTypes={availableTypes}
        onSwitchType={setActiveType}
        onOpen={setViewReport}
        onBack={() => setViewReport(null)}
        sectionsByBrand={sectionsByBrand}
        valuesByReport={valuesByReport}
        resourcesByBrand={resourcesByBrand}
        token={token}
        onMutate={onMutate}
      />
    );
  }

  // ── List view ──────────────────────────────────────────────────────
  return (
    <div>
      {/* Hero header — matches v1's dark gradient + "{type} Reports" title */}
      <div className="card border-0 shadow-sm mb-4" style={{
        borderRadius: 14, background: 'linear-gradient(135deg, #1e293b, #0f172a)', color: '#fff',
      }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center gap-3">
            <div className="rounded-3 d-flex align-items-center justify-content-center"
              style={{ width: 52, height: 52, background: 'rgba(245,213,168,0.2)' }}>
              <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '1.5rem', color: '#f5d5a8' }} />
            </div>
            <div>
              <h4 className="fw-bold mb-0">
                {activeType === 'biweekly' ? 'Bi-Weekly' : activeType === 'monthly' ? 'Monthly' : 'Weekly'} Reports
              </h4>
              <div style={{ opacity: 0.7, fontSize: '0.85rem' }}>
                {brandOptions.length} brand{brandOptions.length !== 1 ? 's' : ''}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs — only when multiple types granted */}
      {availableTypes.length > 1 && (
        <ul className="nav nav-pills mb-4 gap-2">
          {availableTypes.map(t => (
            <li key={t} className="nav-item">
              <button
                className={`nav-link ${activeType === t ? 'active' : ''}`}
                style={{
                  fontSize: '0.82rem', borderRadius: 8, fontWeight: 600,
                  background: activeType === t ? '#1e293b' : '#fff',
                  color: activeType === t ? '#fff' : '#1e293b',
                  border: '1px solid #e2e8f0',
                }}
                onClick={() => setActiveType(t)}>
                <i className={`bi ${t === 'biweekly' ? 'bi-calendar2-week-fill' : t === 'monthly' ? 'bi-calendar-month-fill' : 'bi-file-earmark-bar-graph'} me-1`} />
                {t === 'biweekly' ? 'Bi-Weekly' : t === 'monthly' ? 'Monthly' : 'Weekly'} Reports
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Brand filter — only when there's more than one brand. v1's
          recent commit (515cf30) removed the date filter; clients see
          every approved report. */}
      {brandOptions.length > 1 && (
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
          <div className="card-body p-3 d-flex flex-wrap gap-3 align-items-center justify-content-between">
            <span className="text-muted small">
              {filtered.length} approved report{filtered.length !== 1 ? 's' : ''}
            </span>
            <select className="form-select form-select-sm" value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
              style={{ width: 200, borderRadius: 8 }}>
              <option value="">All Brands</option>
              {brandOptions.map(b => <option key={b}>{b}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Brand-grouped report cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-5">
          <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2.5rem', color: '#dee2e6' }} />
          <p className="text-muted mt-3 mb-0">No approved reports available yet.</p>
        </div>
      ) : (
        [...grouped.entries()].map(([brandName, brandReports]) => (
          <div key={brandName} className="mb-4">
            <div className="d-flex align-items-center gap-2 mb-3">
              <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                style={{ width: 32, height: 32, fontSize: '0.6rem', background: '#3b82f6' }}>
                {brandName.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '0.92rem' }}>{brandName}</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                  {brandReports.length} report{brandReports.length !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
            <div className="row g-3">
              {brandReports.map(r => {
                const prev = findPreviousReport(brandReports, r);
                const m = reportMetrics(r);
                const prevM = prev ? reportMetrics(prev) : null;
                const gmvChange = pctChange(m.gmv, prevM ? prevM.gmv : 0, !!prevM);
                const changeDir = pctChangeDir(gmvChange);
                const sym = currencySymbol(r.currency || DEFAULT_CURRENCY);
                const label = r.weekLabel || r.periodLabel || r.monthLabel || '—';
                return (
                  <div key={r.id} className="col-md-6 col-lg-4">
                    <div className="card border-0 shadow-sm h-100"
                      style={{ borderRadius: 14, cursor: 'pointer', transition: 'transform 0.15s' }}
                      onClick={() => setViewReport(r)}
                      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                      onMouseLeave={e => e.currentTarget.style.transform = 'none'}>
                      <div className="card-body p-3">
                        <div className="d-flex align-items-center justify-content-between mb-2">
                          <div className="fw-bold" style={{ fontSize: '0.82rem' }}>{label}</div>
                          <i className="bi bi-chevron-right text-muted" style={{ fontSize: '0.75rem' }} />
                        </div>
                        <div className="d-flex flex-wrap gap-3">
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>GMV</div>
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>
                              {sym}{Number(m.gmv).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </div>
                            {m.gmvMtd > 0 && (
                              <div className="text-muted" style={{ fontSize: '0.58rem', marginTop: 1 }}>
                                MTD {sym}{Number(m.gmvMtd).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>ORDERS</div>
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>
                              {Number(m.orders).toLocaleString()}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>ROI</div>
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>
                              {m.hasRoi ? m.roi.toFixed(2) : '—'}
                            </div>
                          </div>
                        </div>
                        {gmvChange !== null && (
                          <div className="mt-1" style={{
                            fontSize: '0.65rem', fontWeight: 600,
                            color: changeDir > 0 ? '#16a34a' : changeDir < 0 ? '#dc2626' : '#64748b',
                          }}>
                            <i className={`bi bi-arrow-${changeDir > 0 ? 'up' : changeDir < 0 ? 'down' : 'right'}-short`} />
                            {formatPctChange(gmvChange, { withSign: changeDir !== 0 })} vs prev{' '}
                            {activeType === 'biweekly' ? 'period' : activeType === 'monthly' ? 'month' : 'week'}
                          </div>
                        )}
                        {/* Export this report straight from the card. */}
                        <button
                          type="button"
                          className="btn btn-sm w-100 mt-2 d-inline-flex align-items-center justify-content-center gap-1"
                          style={{ borderRadius: 9, fontSize: '0.72rem', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
                          onClick={(e) => { e.stopPropagation(); handleCardExport(r, brandReports); }}
                          disabled={!!pendingExport}
                          title="Download this report as a single-page PDF">
                          {pendingExport && pendingExport.report.id === r.id
                            ? (<><span className="spinner-border spinner-border-sm" style={{ width: 11, height: 11 }} /> Exporting…</>)
                            : (<><i className="bi bi-file-earmark-pdf" /> Export PDF</>)}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      {/* Off-screen full report render — captured to a single-page
          PDF when the client exports straight from a list card.
          Positioned off-screen (not hidden) so it lays out fully. */}
      {pendingExport && (
        <div ref={offscreenRef} aria-hidden="true"
          style={{ position: 'fixed', left: '-100000px', top: 0, width: 1120, pointerEvents: 'none' }}>
          {pendingExport.report.type === 'monthly' ? (
            <MonthlyReportView report={pendingExport.report} previousReport={pendingExport.prev} clientView
              reportLinks={resourcesByBrand.get(pendingExport.report.brandId) || []} />
          ) : (
            <WeeklyReportView report={pendingExport.report} previousReport={pendingExport.prev}
              allReports={pendingExport.brandReports} clientView
              reportLinks={resourcesByBrand.get(pendingExport.report.brandId) || []} />
          )}
        </div>
      )}
    </div>
  );
}

function reportSortKey(r) {
  return r.weekStart || r.periodStart || (r.monthKey ? r.monthKey + '-01' : '');
}

function findPreviousReport(list, current) {
  const cur = reportSortKey(current);
  if (!cur) return null;
  return [...list]
    .filter(r => {
      const s = reportSortKey(r);
      return s && s < cur;
    })
    .sort((a, b) => reportSortKey(b).localeCompare(reportSortKey(a)))[0] || null;
}

// Short label for the prev/next nav buttons — the client asked to see the
// target period, e.g. "Week 2". Derive it from the stored label string
// ("Week 16 (Jul 19 - 25)" / "Period 2 (May 3 - 16)" / "June 2026"), NOT from
// period_number: the portal RPC doesn't return period_number, and it's null in
// the DB for every monthly report and some bi-weekly ones. The label is the
// always-populated, authoritative field (it's what the report cards show too).
function shortPeriodLabel(r) {
  if (!r) return '';
  const full = r.type === 'monthly'
    ? (r.monthLabel || '')
    : r.type === 'biweekly'
      ? (r.periodLabel || '')
      : (r.weekLabel || '');
  // Keep the leading name + number, drop the "(date range)" suffix.
  const short = full.split(' (')[0].trim();
  if (short) return short;
  if (r.type === 'monthly')  return 'Month';
  if (r.type === 'biweekly') return 'Period';
  return 'Week';
}

// The report body renders at this fixed design width and is scaled to fit the
// available column, so the layout is identical on every screen (it only shrinks
// uniformly on narrower windows — it never reflows to a different arrangement).
const DESIGN_W = 1140;

function scrollToTop() {
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

// The full stored period label, e.g. "Week 16 (Jul 19 - 25)" / "June 2026".
function fullPeriodLabel(r) {
  if (!r) return '';
  return r.type === 'monthly' ? (r.monthLabel || '')
    : r.type === 'biweekly' ? (r.periodLabel || '')
    : (r.weekLabel || '');
}

// The "(Jul 19 - 25)" date range pulled out of the label, for the tile subtitle.
function dateRangeLabel(r) {
  const m = fullPeriodLabel(r).match(/\(([^)]+)\)/);
  return m ? m[1] : '';
}

// ── Client report detail — a sticky header (brand + back + type toggle + a
// horizontally-scrollable strip of report tiles) over the report body. The body
// is rendered at a fixed design width and scaled to fit so it looks identical on
// every screen. A floating "back to top" button replaces the old sticky back.
function ReportDetailView({
  report, reportsForBrand, grantedTypes, onSwitchType, onOpen, onBack,
  sectionsByBrand, valuesByReport, resourcesByBrand, token, onMutate,
}) {
  const [viewType, setViewType] = useState(report.type);
  useEffect(() => { setViewType(report.type); }, [report.type]);

  // Only the report types this brand actually has AND the client is granted.
  const typeTabs = useMemo(() => {
    const present = new Set(reportsForBrand.map(r => r.type));
    return ['weekly', 'biweekly', 'monthly'].filter(t => present.has(t) && grantedTypes.includes(t));
  }, [reportsForBrand, grantedTypes]);

  // Tiles: this brand's reports of the selected type, oldest → newest.
  const tiles = useMemo(
    () => reportsForBrand.filter(r => r.type === viewType)
      .sort((a, b) => reportSortKey(a).localeCompare(reportSortKey(b))),
    [reportsForBrand, viewType],
  );

  const prev = findPreviousReport(tiles, report);
  const brandSections = sectionsByBrand.get(report.brandId) || [];
  const reportValues  = valuesByReport.get(report.id) || [];
  const brandLinks    = resourcesByBrand.get(report.brandId) || [];

  const open = (r) => { if (r && r.id !== report.id) { onOpen(r); scrollToTop(); } };
  const switchType = (t) => {
    if (t === viewType) return;
    setViewType(t);
    onSwitchType?.(t);
    const latest = reportsForBrand.filter(r => r.type === t)
      .sort((a, b) => reportSortKey(b).localeCompare(reportSortKey(a)))[0];
    if (latest && latest.id !== report.id) { onOpen(latest); scrollToTop(); }
  };

  // Scale-to-fit: measure the frame, render the fixed-width canvas scaled down
  // when the frame is narrower, centred when wider. Height tracks the scaled
  // canvas so the page flows correctly.
  const frameRef = useRef(null);
  const canvasRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [frameH, setFrameH] = useState(undefined);
  useEffect(() => {
    const frame = frameRef.current, canvas = canvasRef.current;
    if (!frame || !canvas) return undefined;
    const recompute = () => {
      const w = frame.clientWidth;
      const s = Math.min(1, w / DESIGN_W);
      setScale(s);
      setOffsetX(Math.max(0, (w - DESIGN_W * s) / 2));
      setFrameH(canvas.offsetHeight * s);
    };
    recompute();
    const roF = new ResizeObserver(recompute); roF.observe(frame);
    const roC = new ResizeObserver(recompute); roC.observe(canvas);
    return () => { roF.disconnect(); roC.disconnect(); };
  }, [report.id, viewType]);

  // Keep the active tile in view as the client moves between reports.
  const tilesRef = useRef(null);
  useEffect(() => {
    const el = tilesRef.current?.querySelector('[data-active="true"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [report.id, viewType]);

  const glyph = (report.brandName || '?').slice(0, 2).toUpperCase();

  return (
    <div>
      <div className="preport-header">
        <div className="preport-bar">
          <button className="preport-back" onClick={onBack}>
            <span aria-hidden>←</span> Back
          </button>
          <div className="preport-brand">
            <div className="preport-glyph">{glyph}</div>
            <div className="preport-brand-name">{report.brandName || 'Brand'}</div>
          </div>
          {typeTabs.length > 1 && (
            <div className="preport-tabs">
              {typeTabs.map(t => (
                <button key={t} className={`preport-tab ${viewType === t ? 'active' : ''}`} onClick={() => switchType(t)}>
                  {t === 'biweekly' ? 'Bi-Weekly' : t === 'monthly' ? 'Monthly' : 'Weekly'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="preport-tiles" ref={tilesRef}>
          {tiles.map(r => (
            <ReportTile key={r.id} report={r} active={r.id === report.id} onClick={() => open(r)} />
          ))}
        </div>
      </div>

      {/* Report body — fixed design width, scaled to fit for an identical layout everywhere. */}
      <div className="preport-frame" ref={frameRef} style={{ height: frameH }}>
        <div className="preport-canvas" ref={canvasRef}
          style={{ width: DESIGN_W, marginLeft: offsetX, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          {report.type === 'monthly' ? (
            <MonthlyReportView report={report} previousReport={prev} clientView reportLinks={brandLinks} />
          ) : (
            <WeeklyReportView report={report} previousReport={prev} allReports={tiles} clientView reportLinks={brandLinks} />
          )}
        </div>
      </div>

      {/* Custom client sections — kept at native width (interactive; can add/edit/remove). */}
      <div style={{ marginTop: 20 }}>
        <BrandSectionsPanel
          brandId={report.brandId}
          brandName={report.brandName}
          reportId={report.id}
          sections={brandSections}
          sectionValues={reportValues}
          token={token}
          readOnly={!token}
          onMutate={onMutate}
        />
      </div>

      <ScrollTopButton />
    </div>
  );
}

// A single modern report tile in the sticky header strip.
function ReportTile({ report, active, onClick }) {
  const m = reportMetrics(report);
  const sym = currencySymbol(report.currency || DEFAULT_CURRENCY);
  const range = dateRangeLabel(report);
  return (
    <button type="button" data-active={active ? 'true' : 'false'}
      className={`preport-tile ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="preport-tile-top">
        <span className="preport-tile-label">{shortPeriodLabel(report)}</span>
        {active && <span className="preport-tile-dot" />}
      </div>
      {range && <div className="preport-tile-range">{range}</div>}
      <div className="preport-tile-gmv">
        <span className="preport-tile-gmv-val">
          {sym}{Number(m.gmv).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
        <span className="preport-tile-gmv-lbl">GMV</span>
      </div>
    </button>
  );
}

// Floating "back to top" button — appears once the client scrolls down.
function ScrollTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <button className="preport-scrolltop" aria-label="Back to top" title="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
      <span aria-hidden>↑</span>
    </button>
  );
}
