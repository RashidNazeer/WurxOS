import { useEffect, useMemo, useState } from 'react';
import WeeklyReportView from '../reporting/WeeklyReportView';
import MonthlyReportView from '../reporting/MonthlyReportView';
import BrandSectionsPanel from './BrandSectionsPanel';

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

function num(v) { const n = parseFloat(v); return Number.isNaN(n) ? 0 : n; }

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
    const brandReports = inType.filter(r => r.brandId === viewReport.brandId);
    const prev = findPreviousReport(brandReports, viewReport);
    const brandSections = sectionsByBrand.get(viewReport.brandId) || [];
    const reportValues  = valuesByReport.get(viewReport.id) || [];
    return (
      <div>
        <button
          onClick={() => setViewReport(null)}
          style={{
            background: 'transparent', border: 0, padding: 0,
            color: 'var(--text-muted)', fontSize: 13, marginBottom: 12,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <span style={{ fontSize: 14 }}>←</span> Back to reports
        </button>
        {viewReport.type === 'monthly' ? (
          <MonthlyReportView report={viewReport} previousReport={prev} clientView />
        ) : (
          <WeeklyReportView report={viewReport} previousReport={prev} allReports={brandReports} clientView />
        )}
        {/* Custom client sections — appears below the report dashboard.
            In client-mode (token present) they can add/edit/remove. */}
        <BrandSectionsPanel
          brandId={viewReport.brandId}
          brandName={viewReport.brandName}
          reportId={viewReport.id}
          sections={brandSections}
          sectionValues={reportValues}
          token={token}
          readOnly={!token}
          onMutate={onMutate}
        />
      </div>
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
                const perf = r.overallPerformance || {};
                const prevPerf = prev?.overallPerformance || {};
                const gmvChange = num(prevPerf.gmv)
                  ? (((num(perf.gmv) - num(prevPerf.gmv)) / num(prevPerf.gmv)) * 100)
                  : null;
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
                              ${Number(num(perf.gmv)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>ORDERS</div>
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>
                              {Number(num(perf.orders)).toLocaleString()}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>ROI</div>
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>
                              {num(perf.roi).toFixed(2)}
                            </div>
                          </div>
                        </div>
                        {gmvChange !== null && (
                          <div className="mt-1" style={{
                            fontSize: '0.65rem', fontWeight: 600,
                            color: gmvChange >= 0 ? '#16a34a' : '#dc2626',
                          }}>
                            <i className={`bi bi-arrow-${gmvChange >= 0 ? 'up' : 'down'}-short`} />
                            {gmvChange >= 0 ? '+' : ''}{gmvChange.toFixed(1)}% vs prev{' '}
                            {activeType === 'biweekly' ? 'period' : activeType === 'monthly' ? 'month' : 'week'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function findPreviousReport(list, current) {
  const cur = current.weekStart || current.periodStart || (current.monthKey ? current.monthKey + '-01' : '');
  if (!cur) return null;
  return [...list]
    .filter(r => {
      const s = r.weekStart || r.periodStart || (r.monthKey ? r.monthKey + '-01' : '');
      return s && s < cur;
    })
    .sort((a, b) => {
      const sa = a.weekStart || a.periodStart || (a.monthKey ? a.monthKey + '-01' : '');
      const sb = b.weekStart || b.periodStart || (b.monthKey ? b.monthKey + '-01' : '');
      return sb.localeCompare(sa);
    })[0] || null;
}
