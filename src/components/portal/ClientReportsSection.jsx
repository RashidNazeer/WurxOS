import { useMemo, useState } from 'react';
import WeeklyReportView from '../reporting/WeeklyReportView';
import MonthlyReportView from '../reporting/MonthlyReportView';
import BrandSectionsPanel from './BrandSectionsPanel';

/**
 * Public reports viewer for the client portal.
 *
 * Receives the bundled `reports` array from get_client_access (already
 * filtered to approved + permitted brands and types). Renders the
 * exact same WeeklyReportView / MonthlyReportView used inside the app
 * (in clientView mode — no edit/copy/highlighter toolbar) so clients
 * see the full editorial dashboard for each report.
 *
 * Chrome mirrors v1's client portal:
 *   1. Dark hero card "{Weekly|Monthly} Reports · {client} · N brands"
 *   2. Report-type tab pills (only granted types appear)
 *   3. Month navigator + brand filter
 *   4. Reports grouped by brand → click to open the full dashboard view
 */

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
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

  // Available report types (from what's actually been shared).
  const availableTypes = useMemo(() => {
    const set = new Set(adapted.map(r => r.type).filter(Boolean));
    return ['weekly', 'biweekly', 'monthly'].filter(t => set.has(t));
  }, [adapted]);

  const [activeType, setActiveType] = useState(availableTypes[0] || 'weekly');

  // Default month: most recent that has data of the active type.
  const initialMonth = useMemo(() => {
    const inType = adapted.filter(r => r.type === activeType && (r.weekStart || r.periodStart || r.monthKey));
    inType.sort((a, b) => {
      const ka = a.monthKey || (a.weekStart || a.periodStart || '').slice(0, 7);
      const kb = b.monthKey || (b.weekStart || b.periodStart || '').slice(0, 7);
      return kb.localeCompare(ka);
    });
    const top = inType[0];
    if (top) {
      if (top.monthKey) {
        const [y, m] = top.monthKey.split('-').map(Number);
        return { y, m: m - 1 };
      }
      const ws = top.weekStart || top.periodStart;
      if (ws) {
        const [y, m] = ws.split('-').map(Number);
        return { y, m: m - 1 };
      }
    }
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() };
  }, [adapted, activeType]);

  const [calYear, setCalYear] = useState(initialMonth.y);
  const [calMonth, setCalMonth] = useState(initialMonth.m);
  const [filterBrand, setFilterBrand] = useState('');
  const [viewReport, setViewReport] = useState(null);

  // Reset month/brand when active type changes; jump to its newest data.
  // (Doing this via key + remount on tab change keeps the code simple.)

  const inType = useMemo(
    () => adapted.filter(r => r.type === activeType),
    [adapted, activeType],
  );

  const brandOptions = useMemo(() => {
    const s = new Set();
    inType.forEach(r => r.brandName && s.add(r.brandName));
    return [...s].sort();
  }, [inType]);

  const filtered = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    return inType.filter(r => {
      const start = r.monthKey ? r.monthKey + '-01' : (r.weekStart || r.periodStart || '');
      if (!start) return false;
      if (!start.startsWith(mk)) return false;
      if (filterBrand && r.brandName !== filterBrand) return false;
      return true;
    });
  }, [inType, calYear, calMonth, filterBrand]);

  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach(r => {
      const key = r.brandName || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    map.forEach(list => list.sort((a, b) => {
      const ka = a.weekStart || a.periodStart || (a.monthKey ? a.monthKey + '-01' : '');
      const kb = b.weekStart || b.periodStart || (b.monthKey ? b.monthKey + '-01' : '');
      return ka.localeCompare(kb);
    }));
    return map;
  }, [filtered]);

  const prevMonth = () => {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); }
    else setCalMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); }
    else setCalMonth(m => m + 1);
  };

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

  if (reports.length === 0) {
    return (
      <div className="wx-card" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 28, opacity: 0.4 }}>📋</div>
        <div style={{ fontWeight: 700, marginTop: 8, color: 'var(--text-secondary)' }}>No approved reports yet</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '4px 0 0' }}>
          Reports will appear here once they're approved by your account team.
        </p>
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

      {/* Month navigator + brand filter */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3 d-flex flex-wrap gap-3 align-items-center justify-content-between">
          <div className="d-flex align-items-center gap-2">
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={prevMonth}
              style={{ width: 32, height: 32, padding: 0 }}>
              <i className="bi bi-chevron-left" style={{ fontSize: '0.8rem' }} />
            </button>
            <div className="fw-bold" style={{ fontSize: '0.92rem', minWidth: 140, textAlign: 'center' }}>
              {MONTH_NAMES[calMonth]} {calYear}
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={nextMonth}
              style={{ width: 32, height: 32, padding: 0 }}>
              <i className="bi bi-chevron-right" style={{ fontSize: '0.8rem' }} />
            </button>
            <button className="btn btn-sm btn-outline-secondary ms-1" style={{ borderRadius: 8, fontSize: '0.72rem' }}
              onClick={() => { const n = new Date(); setCalYear(n.getFullYear()); setCalMonth(n.getMonth()); }}>
              Today
            </button>
          </div>
          <div className="d-flex align-items-center gap-2">
            <select className="form-select form-select-sm" value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
              style={{ width: 180, borderRadius: 8 }}>
              <option value="">All Brands</option>
              {brandOptions.map(b => <option key={b}>{b}</option>)}
            </select>
            <span className="text-muted small">{filtered.length} reports</span>
          </div>
        </div>
      </div>

      {/* Brand-grouped report cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-5">
          <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2.5rem', color: '#dee2e6' }} />
          <p className="text-muted mt-3 mb-0">
            No {activeType} reports for {MONTH_NAMES[calMonth]} {calYear}.
          </p>
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
