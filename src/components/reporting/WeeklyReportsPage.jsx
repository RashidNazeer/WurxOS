import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useBrands } from '../../contexts/BrandsContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  getReportsForBrand, getReportsForTL, deleteReport, findPreviousReport, num,
  getWeeksForMonth, getAnchorDate, detectNextWeek, getFirstTimeWeekOptions,
  REPORT_STATUSES, getReportStatus, updateReportStatus,
} from '../../utils/reportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import { formatPctChange, pctChange, pctChangeDir } from '../../utils/formatPctChange';
import WeeklyReportForm from './WeeklyReportForm';
import WeeklyReportView from './WeeklyReportView';
import { notifyReportVerified, notifyReportRejected } from '../../utils/reportNotifications';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

const BRAND_COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#6366f1','#14b8a6','#f97316'];

function StatusBadge({ status, style }) {
  const cfg = REPORT_STATUSES[status] || REPORT_STATUSES.approved;
  return (
    <span className="badge rounded-pill d-inline-flex align-items-center gap-1"
      style={{ background: cfg.bg, color: cfg.color, fontSize: '0.62rem', ...style }}>
      <i className={`bi ${cfg.icon}`} />{cfg.label}
    </span>
  );
}

export default function WeeklyReportsPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const { brands } = useBrands();

  // Views: overview (all brands grid) | brand (single brand drill-down) | new | edit | detail
  const [view, setView] = useState('overview');
  const [editId, setEditId] = useState(null);
  const [detailReport, setDetailReport] = useState(null);

  // For brand detail view
  const [selectedBrandId, setSelectedBrandId] = useState('');
  const [brandReports, setBrandReports] = useState([]);
  const [loadingBrand, setLoadingBrand] = useState(false);

  // For overview: all reports across all brands
  const [allReports, setAllReports] = useState([]);
  const [loadingOverview, setLoadingOverview] = useState(true);

  // Calendar (used in brand detail view)
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [filterWeek, setFilterWeek] = useState('');

  // Filters for overview
  const [overviewFilter, setOverviewFilter] = useState(''); // '', 'submitted', 'pending'
  const [search, setSearch] = useState('');
  // Client filter — derived from the brand's clientName field. Empty
  // means "all clients"; otherwise we only show brands matching that
  // client. Hidden when no brand in scope has a client set.
  const [filterClient, setFilterClient] = useState('');

  const myBrands = brands;

  // Load all reports for overview (across all brands)
  useEffect(() => {
    if (myBrands.length === 0) { setAllReports([]); setLoadingOverview(false); return; }
    setLoadingOverview(true);
    const brandIds = myBrands.map(b => b.id);
    getReportsForTL(brandIds)
      .then(data => { setAllReports(data); setLoadingOverview(false); })
      .catch(() => setLoadingOverview(false));
  }, [myBrands]);

  // Load reports for a specific brand when drilled in
  const loadBrandReports = useCallback((brandId) => {
    if (!brandId) return;
    setLoadingBrand(true);
    getReportsForBrand(brandId)
      .then(data => { setBrandReports(data); setLoadingBrand(false); })
      .catch(() => setLoadingBrand(false));
  }, []);

  useEffect(() => {
    if (view === 'brand' && selectedBrandId) {
      loadBrandReports(selectedBrandId);
    }
  }, [view, selectedBrandId, loadBrandReports]);

  // Anchor + weeks for current calendar month (in brand detail view)
  const anchor = useMemo(() => getAnchorDate(brandReports), [brandReports]);
  const calWeeks = useMemo(() => getWeeksForMonth(calYear, calMonth, anchor), [calYear, calMonth, anchor]);

  // Filtered brand reports for selected month
  const filteredReports = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    let list = brandReports.filter(r => r.weekStart && r.weekStart.startsWith(mk));
    if (filterWeek) list = list.filter(r => String(r.week) === filterWeek);
    return list.sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || ''));
  }, [brandReports, calYear, calMonth, filterWeek]);

  /* ── Overview computations ─────────────────────────────────────────────── */

  // For each brand: latest report + workflow status for current week
  const brandSummaries = useMemo(() => {
    const today = todayStr();
    const allWeekOptions = getFirstTimeWeekOptions();
    const currentReportableWeek = [...allWeekOptions].reverse().find(w => w.endDate < today)
      || allWeekOptions.find(w => w.startDate <= today && w.endDate >= today);

    return myBrands.map((b, i) => {
      const reports = allReports.filter(r => r.brandId === b.id);
      const sorted = [...reports].sort((a, b) => (b.weekStart || '').localeCompare(a.weekStart || ''));
      const latest = sorted[0] || null;

      // Report for the current/most-recent reportable week
      const thisWeekReport = currentReportableWeek
        ? reports.find(r => r.weekStart === currentReportableWeek.startDate)
        : null;
      const thisWeekStatus = thisWeekReport ? getReportStatus(thisWeekReport) : null;

      // "Submitted this week" = APC has at least submitted (not just draft)
      const submittedThisWeek = thisWeekStatus && thisWeekStatus !== 'draft';
      // Overdue = week has ended with no report or only a draft
      const isOverdue = currentReportableWeek && currentReportableWeek.endDate < today && !submittedThisWeek;
      // Needs TL review = submitted but not yet verified/approved
      const needsReview = thisWeekStatus === 'submitted';

      return {
        brand: b,
        color: BRAND_COLORS[i % BRAND_COLORS.length],
        totalReports: reports.length,
        latest,
        currentWeekDue: currentReportableWeek,
        thisWeekReport,
        thisWeekStatus,
        submittedThisWeek,
        isOverdue,
        needsReview,
      };
    });
  }, [myBrands, allReports]);

  // Distinct client names across the brands in scope. Sorted A–Z so
  // the dropdown is predictable.
  const clientOptions = useMemo(() => {
    const s = new Set();
    brandSummaries.forEach((bs) => {
      const c = bs.brand.clientName || bs.brand.client_name;
      if (c && c.trim()) s.add(c.trim());
    });
    return [...s].sort();
  }, [brandSummaries]);

  // Filter brand cards
  const filteredBrandSummaries = useMemo(() => {
    const q = search.toLowerCase();
    return brandSummaries.filter(s => {
      const name = (s.brand.brandName || s.brand.name || '').toLowerCase();
      if (q && !name.includes(q)) return false;
      if (overviewFilter === 'submitted' && !s.submittedThisWeek) return false;
      if (overviewFilter === 'pending' && s.submittedThisWeek) return false;
      if (overviewFilter === 'needs_review' && !s.needsReview) return false;
      if (filterClient) {
        const c = s.brand.clientName || s.brand.client_name || '';
        if (c !== filterClient) return false;
      }
      return true;
    });
  }, [brandSummaries, search, overviewFilter, filterClient]);

  // Stats for header
  const stats = useMemo(() => {
    const submitted = brandSummaries.filter(s => s.submittedThisWeek).length;
    const pending = brandSummaries.length - submitted;
    const overdue = brandSummaries.filter(s => s.isOverdue).length;
    const needsReview = brandSummaries.filter(s => s.needsReview).length;
    return {
      totalBrands: brandSummaries.length,
      totalReports: allReports.length,
      submittedThisWeek: submitted,
      pending,
      overdue,
      needsReview,
    };
  }, [brandSummaries, allReports]);

  /* ── Handlers ──────────────────────────────────────────────────────────── */

  const handleDelete = async (reportId) => {
    if (!window.confirm('Delete this report? This cannot be undone.')) return;
    await deleteReport(reportId);
    setBrandReports(prev => prev.filter(r => r.id !== reportId));
    setAllReports(prev => prev.filter(r => r.id !== reportId));
  };

  const handleViewReport = (report) => {
    setDetailReport(report);
    setView('detail');
  };

  const handleEdit = (reportId) => {
    setEditId(reportId);
    setView('edit');
  };

  const handleSaved = (savedReport) => {
    if (savedReport) {
      // Refresh both overview and brand-specific lists
      const brandIds = myBrands.map(b => b.id);
      getReportsForTL(brandIds).then(setAllReports);
      if (savedReport.brandId) {
        setSelectedBrandId(savedReport.brandId);
        getReportsForBrand(savedReport.brandId).then(data => {
          setBrandReports(data);
          const found = data.find(r => r.id === savedReport.id);
          setDetailReport(found || savedReport);
          setView('detail');
          setEditId(null);
          if (savedReport.year != null && savedReport.month != null) {
            setCalYear(savedReport.year);
            setCalMonth(savedReport.month);
          }
        });
      }
    } else {
      setView(selectedBrandId ? 'brand' : 'overview');
      setEditId(null);
    }
  };

  const handleVerify = async (report) => {
    if (!window.confirm(`Verify this report (${report.weekLabel})? It will be sent to the Operation Lead for approval.`)) return;
    try {
      const senderName = currentUser.displayName || 'TL';
      await updateReportStatus(report.id, 'verified', {
        verifiedBy: currentUser.uid,
        verifiedByName: senderName,
        verifiedAt: new Date().toISOString(),
      });
      // Refresh
      const brandIds = myBrands.map(b => b.id);
      getReportsForTL(brandIds).then(setAllReports);
      if (selectedBrandId) getReportsForBrand(selectedBrandId).then(setBrandReports);
      setDetailReport(r => r ? { ...r, status: 'verified' } : r);
      notifyReportVerified({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly' });
    } catch (err) { alert('Failed to verify: ' + err.message); }
  };

  const handleRejectToAPC = async (report) => {
    const note = window.prompt('Reason for returning to APC (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'TL';
      await updateReportStatus(report.id, 'draft', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid,
        rejectedByName: senderName,
        rejectedAt: new Date().toISOString(),
      });
      const brandIds = myBrands.map(b => b.id);
      getReportsForTL(brandIds).then(setAllReports);
      if (selectedBrandId) getReportsForBrand(selectedBrandId).then(setBrandReports);
      setDetailReport(r => r ? { ...r, status: 'draft', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly', toRole: 'apc', note: note.trim() });
    } catch (err) { alert('Failed to reject: ' + err.message); }
  };

  const openBrand = (brandId) => {
    setSelectedBrandId(brandId);
    setView('brand');
    setCalYear(now.getFullYear());
    setCalMonth(now.getMonth());
    setFilterWeek('');
  };

  const prevMonth = () => { if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); } else setCalMonth(m => m - 1); setFilterWeek(''); };
  const nextMonth = () => { if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); } else setCalMonth(m => m + 1); setFilterWeek(''); };

  /* ── Detail View ────────────────────────────────────────────────────────── */
  if (view === 'detail' && detailReport) {
    const sourceList = selectedBrandId ? brandReports : allReports.filter(r => r.brandId === detailReport.brandId);
    const prev = findPreviousReport(sourceList, detailReport);
    const rStatus = getReportStatus(detailReport);
    // Always show current brand name in the report view (handles rename/switch)
    const currentBrand = brands.find(b => b.id === detailReport.brandId);
    const viewReport = currentBrand
      ? { ...detailReport, brandName: currentBrand.brandName || currentBrand.name || detailReport.brandName }
      : detailReport;
    // Edit is allowed based on role + status:
    //   - APC: can edit only their own drafts (before they submit).
    //          Once submitted, ownership moved to TL.
    //   - TL : can edit while the report is in their stage — that's
    //          'draft' (TL drafted it themselves, hasn't submitted to
    //          the OL queue yet) AND 'submitted' (APC submitted, TL is
    //          reviewing). Once TL clicks Verify the report moves on
    //          to OL and TL no longer edits.
    const canEdit = (userRole === 'apc' && rStatus === 'draft') ||
                    (userRole === 'tl'  && (rStatus === 'draft' || rStatus === 'submitted'));
    const canVerify = userRole === 'tl' && rStatus === 'submitted';
    // TL can only return to APC while the report is still at the TL stage
    // (status: submitted). Once they've verified it, the report has moved on
    // to OL — TL no longer owns it. To send it back to APC at that point, OL
    // must first return-to-TL (verified → submitted), then TL can return-to-APC.
    const canReject = userRole === 'tl' && rStatus === 'submitted';
    return (
      <div>
        <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
          <button className="btn btn-sm btn-link text-muted p-0" onClick={() => { setView(selectedBrandId ? 'brand' : 'overview'); setDetailReport(null); }}>
            <i className="bi bi-arrow-left me-1" /> Back
          </button>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <StatusBadge status={rStatus} />
            {canEdit && (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem' }}
                onClick={() => handleEdit(detailReport.id)}>
                <i className="bi bi-pencil" /> Edit
              </button>
            )}
            {canVerify && (
              <button className="btn btn-sm d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem', background: '#7c3aed', color: 'white', border: 'none' }}
                onClick={() => handleVerify(detailReport)}>
                <i className="bi bi-patch-check-fill" /> Verify
              </button>
            )}
            {canReject && (
              <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem' }}
                onClick={() => handleRejectToAPC(detailReport)}>
                <i className="bi bi-arrow-counterclockwise" /> Return to APC
              </button>
            )}
          </div>
        </div>
        {detailReport.rejectionNote && rStatus === 'draft' && (
          <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
            style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10, color: 'var(--danger)' }}>
            <i className="bi bi-exclamation-triangle-fill flex-shrink-0 mt-1" />
            <div>
              <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Returned for revision</div>
              <div style={{ fontSize: '0.78rem', marginTop: 2 }}>{detailReport.rejectionNote}</div>
            </div>
          </div>
        )}
        <WeeklyReportView report={viewReport} previousReport={prev} allReports={sourceList} />
      </div>
    );
  }

  /* ── New / Edit Form ────────────────────────────────────────────────────── */
  if (view === 'new' || view === 'edit') {
    return (
      <WeeklyReportForm
        editReportId={view === 'edit' ? editId : null}
        // When TL clicks "New Report" from inside a brand-detail page,
        // selectedBrandId is set — pre-select that brand on the form so
        // they don't have to pick it again.
        prefillBrandId={view === 'new' ? selectedBrandId : null}
        onSaved={handleSaved}
        onCancel={() => { setView(selectedBrandId ? 'brand' : 'overview'); setEditId(null); }}
      />
    );
  }

  /* ── Brand Detail View (single brand drill-down) ───────────────────────── */
  if (view === 'brand' && selectedBrandId) {
    const brandObj = myBrands.find(b => b.id === selectedBrandId);
    const brandColor = brandSummaries.find(s => s.brand.id === selectedBrandId)?.color || '#3b82f6';
    return (
      <div>
        <button className="btn btn-sm btn-link text-muted p-0 mb-3" onClick={() => { setView('overview'); setSelectedBrandId(''); setBrandReports([]); }}>
          <i className="bi bi-arrow-left me-1" /> Back to all brands
        </button>

        <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
          <div className="d-flex align-items-center gap-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
              style={{ width: 48, height: 48, fontSize: '0.85rem', background: brandColor }}>
              {(brandObj?.brandName || brandObj?.name || '??').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h5 className="fw-bold mb-0">{brandObj?.brandName || brandObj?.name}</h5>
              <p className="text-muted small mb-0">{brandReports.length} total reports</p>
            </div>
          </div>
          <button className="btn btn-dark btn-sm px-4 d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 10 }} onClick={() => setView('new')}>
            <i className="bi bi-plus-circle" /> New Report
          </button>
        </div>

        {/* Month picker */}
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
          <div className="card-body p-3 d-flex flex-wrap gap-3 align-items-center justify-content-between">
            <div className="d-flex align-items-center gap-2">
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={prevMonth} style={{ width: 32, height: 32, padding: 0 }}>
                <i className="bi bi-chevron-left" style={{ fontSize: '0.8rem' }} />
              </button>
              <div className="fw-bold" style={{ fontSize: '0.92rem', minWidth: 140, textAlign: 'center' }}>
                {MONTH_NAMES[calMonth]} {calYear}
              </div>
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={nextMonth} style={{ width: 32, height: 32, padding: 0 }}>
                <i className="bi bi-chevron-right" style={{ fontSize: '0.8rem' }} />
              </button>
              <button className="btn btn-sm btn-outline-secondary ms-1" style={{ borderRadius: 8, fontSize: '0.72rem' }}
                onClick={() => { setCalYear(now.getFullYear()); setCalMonth(now.getMonth()); setFilterWeek(''); }}>Today</button>
            </div>
            <div className="d-flex align-items-center gap-2">
              <select className="form-select form-select-sm" value={filterWeek} onChange={e => setFilterWeek(e.target.value)} style={{ width: 160, borderRadius: 8 }}>
                <option value="">All Weeks ({filteredReports.length})</option>
                {calWeeks.map(w => <option key={w.week} value={String(w.week)}>Week {w.week}</option>)}
              </select>
              {filterWeek && (
                <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={() => setFilterWeek('')}>
                  <i className="bi bi-x-circle" /> Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Calendar week grid */}
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14 }}>
          <div className="card-body p-3">
            <div className="row g-2">
              {calWeeks.map(w => {
                const report = brandReports.find(r => r.weekStart === w.startDate);
                const hasReport = !!report;
                const perf = report?.overallPerformance || {};
                return (
                  <div key={w.week} className="col-md-6 col-lg-4 col-xl-3">
                    <div className={`rounded-3 p-3 h-100 ${hasReport ? '' : 'opacity-50'}`}
                      style={{ background: hasReport ? 'var(--success-soft)' : 'var(--surface-2)', border: `1px solid ${hasReport ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'var(--border-subtle)'}`, cursor: hasReport ? 'pointer' : 'default' }}
                      onClick={() => hasReport && handleViewReport(report)}>
                      <div className="d-flex align-items-center gap-2 mb-1">
                        <i className={`bi ${hasReport ? 'bi-check-circle-fill text-success' : 'bi-circle text-muted'}`} style={{ fontSize: '0.75rem' }} />
                        <span className="fw-bold" style={{ fontSize: '0.8rem' }}>Week {w.week}</span>
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                        {MONTH_NAMES[calMonth].slice(0, 3)} {w.startDay} – {w.endDay}
                      </div>
                      {hasReport ? (
                        <div className="d-flex gap-3 mt-2">
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem', fontWeight: 600 }}>GMV</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{currencySymbol(report?.currency || DEFAULT_CURRENCY)}{Number(num(perf.gmv)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem', fontWeight: 600 }}>ROI</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{num(perf.roi).toFixed(2)}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-muted mt-1" style={{ fontSize: '0.65rem' }}>No report</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Report cards list */}
        {loadingBrand ? (
          <div className="d-flex align-items-center justify-content-center py-5 text-muted">
            <span className="spinner-border spinner-border-sm me-2" /> Loading…
          </div>
        ) : filteredReports.length === 0 ? (
          <div className="text-center py-4">
            <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2rem', color: 'var(--text-muted)' }} />
            <p className="text-muted mt-2 mb-0" style={{ fontSize: '0.85rem' }}>No reports for {MONTH_NAMES[calMonth]} {calYear}.</p>
          </div>
        ) : (
          <div className="row g-3">
            {filteredReports.map(r => {
              const prev = findPreviousReport(brandReports, r);
              const perf = r.overallPerformance || {};
              const prevPerf = prev?.overallPerformance || {};
              const gmvChange = pctChange(num(perf.gmv), num(prevPerf.gmv), !!prev);
              const changeDir = pctChangeDir(gmvChange);
              const changeColor = changeDir == null ? 'var(--text-muted)'
                : changeDir > 0 ? 'var(--success)' : changeDir < 0 ? 'var(--danger)' : 'var(--text-secondary)';
              return (
                <div key={r.id} className="col-12 col-md-6 col-lg-4">
                  <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, cursor: 'pointer', transition: 'transform 0.15s' }}
                    onClick={() => handleViewReport(r)}
                    onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'none'}>
                    <div className="card-body p-3">
                      <div className="d-flex align-items-center justify-content-between mb-2">
                        <div className="d-flex align-items-center gap-2">
                          <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 32, height: 32, background: 'var(--info-soft)' }}>
                            <i className="bi bi-calendar-week" style={{ fontSize: '0.85rem', color: 'var(--info)' }} />
                          </div>
                          <div>
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>{r.weekLabel}</div>
                            <div className="d-flex align-items-center gap-2 flex-wrap">
                              <span className="text-muted" style={{ fontSize: '0.65rem' }}>by {r.createdByName}</span>
                              <StatusBadge status={getReportStatus(r)} />
                            </div>
                          </div>
                        </div>
                        <div className="dropdown" onClick={e => e.stopPropagation()}>
                          <button className="btn btn-sm btn-light border-0 rounded-circle" data-bs-toggle="dropdown" style={{ width: 28, height: 28, padding: 0 }}>
                            <i className="bi bi-three-dots" style={{ fontSize: '0.8rem' }} />
                          </button>
                          <ul className="dropdown-menu dropdown-menu-end" style={{ fontSize: '0.78rem' }}>
                            <li><button className="dropdown-item" onClick={() => handleViewReport(r)}><i className="bi bi-eye me-2" />View Report</button></li>
                            {(() => {
                              const s = getReportStatus(r);
                              const can = (userRole === 'apc' && s === 'draft') ||
                                          (userRole === 'tl'  && (s === 'draft' || s === 'submitted'));
                              return can ? (
                                <li><button className="dropdown-item" onClick={() => handleEdit(r.id)}><i className="bi bi-pencil me-2" />Edit</button></li>
                              ) : null;
                            })()}
                            {userRole === 'tl' && getReportStatus(r) === 'submitted' && (
                              <li><button className="dropdown-item" style={{ color: '#7c3aed' }} onClick={e => { e.stopPropagation(); handleVerify(r); }}><i className="bi bi-patch-check-fill me-2" />Verify</button></li>
                            )}
                            <li><hr className="dropdown-divider" /></li>
                            <li><button className="dropdown-item text-danger" onClick={() => handleDelete(r.id)}><i className="bi bi-trash3 me-2" />Delete</button></li>
                          </ul>
                        </div>
                      </div>
                      <div className="d-flex flex-wrap gap-3 mb-2">
                        <div>
                          <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>GMV</div>
                          <div className="fw-bold" style={{ fontSize: '0.88rem' }}>{currencySymbol(r.currency || DEFAULT_CURRENCY)}{Number(num(perf.gmv)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          {num(r.overallNotes?.gmv) > 0 && (
                            <div className="text-muted" style={{ fontSize: '0.6rem', marginTop: 1 }}>MTD {currencySymbol(r.currency || DEFAULT_CURRENCY)}{Number(num(r.overallNotes.gmv)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          )}
                        </div>
                        <div><div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>ORDERS</div><div className="fw-bold" style={{ fontSize: '0.88rem' }}>{Number(num(perf.orders)).toLocaleString()}</div></div>
                        <div><div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>ROI</div><div className="fw-bold" style={{ fontSize: '0.88rem' }}>{num(perf.roi).toFixed(2)}</div></div>
                      </div>
                      {gmvChange !== null && (
                        <div style={{ fontSize: '0.68rem', color: changeColor, fontWeight: 600 }}>
                          <i className={`bi bi-arrow-${changeDir > 0 ? 'up' : changeDir < 0 ? 'down' : 'right'}-short`} />
                          {formatPctChange(gmvChange, { withSign: changeDir !== 0 })} GMV vs prev week
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /* ── OVERVIEW VIEW (default landing) ───────────────────────────────────── */
  if (loadingOverview) {
    return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading…</div>;
  }

  return (
    <div>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>Weekly Reports</h5>
          <p className="text-muted small mb-0">Overview of your brands and report submission status</p>
        </div>
        <button className="btn btn-dark btn-sm px-4 d-inline-flex align-items-center gap-1"
          style={{ borderRadius: 10 }} onClick={() => setView('new')}>
          <i className="bi bi-plus-circle" /> New Report
        </button>
      </div>

      {/* Stats cards */}
      <div className="row g-3 mb-4">
        <div className="col-6 col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
            <div className="card-body p-3 d-flex align-items-center gap-2">
              <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 36, height: 36, background: 'var(--info-soft)' }}>
                <i className="bi bi-shop" style={{ color: 'var(--info)' }} />
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{stats.totalBrands}</div>
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Total Brands</div>
              </div>
            </div>
          </div>
        </div>
        <div className="col-6 col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
            <div className="card-body p-3 d-flex align-items-center gap-2">
              <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 36, height: 36, background: 'var(--success-soft)' }}>
                <i className="bi bi-check-circle-fill" style={{ color: 'var(--success)' }} />
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{stats.submittedThisWeek}</div>
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Submitted (This Week)</div>
              </div>
            </div>
          </div>
        </div>
        <div className="col-6 col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
            <div className="card-body p-3 d-flex align-items-center gap-2">
              <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 36, height: 36, background: 'var(--warning-soft)' }}>
                <i className="bi bi-clock-fill" style={{ color: 'var(--warning)' }} />
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{stats.pending}</div>
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Pending (This Week)</div>
              </div>
            </div>
          </div>
        </div>
        {userRole === 'tl' ? (
          <div className="col-6 col-lg-3">
            <div className="card border-0 shadow-sm" style={{ borderRadius: 12, cursor: 'pointer' }}
              onClick={() => setOverviewFilter(f => f === 'needs_review' ? '' : 'needs_review')}>
              <div className="card-body p-3 d-flex align-items-center gap-2">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 36, height: 36, background: 'color-mix(in srgb, #7c3aed 18%, transparent)' }}>
                  <i className="bi bi-hourglass-split" style={{ color: '#7c3aed' }} />
                </div>
                <div>
                  <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{stats.needsReview}</div>
                  <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Needs My Review</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="col-6 col-lg-3">
            <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
              <div className="card-body p-3 d-flex align-items-center gap-2">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 36, height: 36, background: 'var(--danger-soft)' }}>
                  <i className="bi bi-exclamation-triangle-fill" style={{ color: 'var(--danger)' }} />
                </div>
                <div>
                  <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{stats.overdue}</div>
                  <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Overdue</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3 d-flex flex-wrap gap-2 align-items-center">
          <div className="position-relative" style={{ flex: '1 1 200px', minWidth: 160 }}>
            <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search brands…"
              style={{ paddingLeft: 28, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="form-select form-select-sm" value={overviewFilter} onChange={e => setOverviewFilter(e.target.value)} style={{ width: 220, borderRadius: 8 }}>
            <option value="">All Brands</option>
            <option value="submitted">Submitted This Week</option>
            <option value="pending">Pending / Draft</option>
            {userRole === 'tl' && <option value="needs_review">Needs My Review</option>}
          </select>
          {clientOptions.length > 0 && (
            <select className="form-select form-select-sm" value={filterClient}
              onChange={(e) => setFilterClient(e.target.value)}
              style={{ width: 200, borderRadius: 8 }}
              title="Filter brands by client">
              <option value="">All Clients</option>
              {clientOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
          <span className="text-muted small">{filteredBrandSummaries.length} brand{filteredBrandSummaries.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Brand cards grid */}
      {filteredBrandSummaries.length === 0 ? (
        <div className="text-center py-5">
          <i className="bi bi-shop" style={{ fontSize: '2.5rem', color: 'var(--text-muted)' }} />
          <p className="text-muted mt-3 mb-0">No brands match your filters.</p>
        </div>
      ) : (
        <div className="row g-3">
          {filteredBrandSummaries.map(s => {
            const b = s.brand;
            const name = b.brandName || b.name;
            const latestPerf = s.latest?.overallPerformance || {};
            return (
              <div key={b.id} className="col-12 col-md-6 col-lg-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, cursor: 'pointer', overflow: 'hidden', transition: 'transform 0.15s' }}
                  onClick={() => openBrand(b.id)}
                  onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'none'}>
                  <div style={{ height: 4, background: s.color }} />
                  <div className="card-body p-3">
                    <div className="d-flex align-items-start justify-content-between mb-2">
                      <div className="d-flex align-items-center gap-2">
                        <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                          style={{ width: 38, height: 38, fontSize: '0.7rem', background: s.color }}>
                          {(name || '??').slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="fw-bold" style={{ fontSize: '0.88rem' }}>{name}</div>
                          <div className="text-muted" style={{ fontSize: '0.65rem' }}>{s.totalReports} report{s.totalReports !== 1 ? 's' : ''} total</div>
                        </div>
                      </div>
                      {s.thisWeekStatus ? (
                        <StatusBadge status={s.thisWeekStatus} />
                      ) : s.isOverdue ? (
                        <span className="badge rounded-pill" style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.62rem' }}>
                          <i className="bi bi-exclamation-triangle me-1" />Overdue
                        </span>
                      ) : (
                        <span className="badge rounded-pill" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.62rem' }}>
                          <i className="bi bi-clock me-1" />Pending
                        </span>
                      )}
                    </div>

                    {s.currentWeekDue && (
                      <div className="text-muted mb-2" style={{ fontSize: '0.7rem' }}>
                        <i className="bi bi-calendar-week me-1" />Current: {s.currentWeekDue.label}
                      </div>
                    )}

                    {s.latest ? (
                      <div className="p-2 rounded-2 mb-2" style={{ background: 'var(--surface-2)' }}>
                        <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>LAST REPORT — {s.latest.weekLabel}</div>
                        <div className="d-flex gap-3 mt-1">
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem' }}>GMV</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{currencySymbol(s.latest?.currency || DEFAULT_CURRENCY)}{Number(num(latestPerf.gmv)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem' }}>ORDERS</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{Number(num(latestPerf.orders)).toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem' }}>ROI</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{num(latestPerf.roi).toFixed(2)}</div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2 rounded-2 mb-2 text-center text-muted" style={{ background: 'var(--surface-2)', fontSize: '0.72rem' }}>
                        No reports yet
                      </div>
                    )}

                    <button className="btn btn-sm btn-outline-dark w-100 d-inline-flex align-items-center justify-content-center gap-1"
                      style={{ borderRadius: 8, fontSize: '0.72rem' }}>
                      <i className="bi bi-bar-chart-line" /> View Reports
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
