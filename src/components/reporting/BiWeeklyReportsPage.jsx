import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useBrands } from '../../contexts/BrandsContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  getBiWeeklyReportsForBrand, getBiWeeklyReportsForTL, getAllBiWeeklyReports,
  deleteBiWeeklyReport, getBiWeeklyAnchor,
  REPORT_STATUSES, getReportStatus, updateReportStatus,
} from '../../utils/biWeeklyReportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import { formatPctChange } from '../../utils/formatPctChange';
import BiWeeklyReportForm from './BiWeeklyReportForm';
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

export default function BiWeeklyReportsPage() {
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
  const [filterPeriod, setFilterPeriod] = useState('');

  // Filters for overview
  const [overviewFilter, setOverviewFilter] = useState(''); // '', 'submitted', 'pending'
  const [search, setSearch] = useState('');

  const myBrands = brands;

  // Load all reports for overview (across all brands)
  useEffect(() => {
    if (myBrands.length === 0) { setAllReports([]); setLoadingOverview(false); return; }
    setLoadingOverview(true);
    const brandIds = myBrands.map(b => b.id);
    getBiWeeklyReportsForTL(brandIds)
      .then(data => { setAllReports(data); setLoadingOverview(false); })
      .catch(() => setLoadingOverview(false));
  }, [myBrands]);

  // Load reports for a specific brand when drilled in
  const loadBrandReports = useCallback((brandId) => {
    if (!brandId) return;
    setLoadingBrand(true);
    getBiWeeklyReportsForBrand(brandId)
      .then(data => { setBrandReports(data); setLoadingBrand(false); })
      .catch(() => setLoadingBrand(false));
  }, []);

  useEffect(() => {
    if (view === 'brand' && selectedBrandId) {
      loadBrandReports(selectedBrandId);
    }
  }, [view, selectedBrandId, loadBrandReports]);

  // Filtered brand reports for selected month
  const filteredReports = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    let list = brandReports.filter(r => r.periodStart && r.periodStart.startsWith(mk));
    if (filterPeriod) list = list.filter(r => String(r.period) === filterPeriod);
    return list.sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || ''));
  }, [brandReports, calYear, calMonth, filterPeriod]);

  /* ── Overview computations ─────────────────────────────────────────────── */

  // For each brand: latest report + workflow status for current period
  const brandSummaries = useMemo(() => {
    const today = todayStr();

    return myBrands.map((b, i) => {
      const reports = allReports.filter(r => r.brandId === b.id);
      const sorted = [...reports].sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''));
      const latest = sorted[0] || null;

      // Find the most recent past or current bi-weekly period from actual reports
      // "Current period" = the period whose periodStart is <= today and periodEnd >= today,
      // or the most recently ended period
      const pastOrCurrent = sorted.filter(r => r.periodStart && r.periodStart <= today);
      const currentReportablePeriod = pastOrCurrent.length > 0
        ? { startDate: pastOrCurrent[0].periodStart, endDate: pastOrCurrent[0].periodEnd, label: pastOrCurrent[0].periodLabel }
        : null;

      // Report for the current/most-recent reportable period
      const thisWeekReport = currentReportablePeriod
        ? reports.find(r => r.periodStart === currentReportablePeriod.startDate)
        : null;
      const thisWeekStatus = thisWeekReport ? getReportStatus(thisWeekReport) : null;

      // "Submitted this period" = APC has at least submitted (not just draft)
      const submittedThisWeek = thisWeekStatus && thisWeekStatus !== 'draft';
      // Overdue = period has ended (14 days ago or more) with no report or only a draft
      const isOverdue = (() => {
        if (!currentReportablePeriod) return false;
        const endDate = currentReportablePeriod.endDate;
        if (!endDate) return false;
        // Check if the period ended (endDate < today) and not submitted
        return endDate < today && !submittedThisWeek;
      })();
      // Needs TL review = submitted but not yet verified/approved
      const needsReview = thisWeekStatus === 'submitted';

      return {
        brand: b,
        color: BRAND_COLORS[i % BRAND_COLORS.length],
        totalReports: reports.length,
        latest,
        currentWeekDue: currentReportablePeriod,
        thisWeekReport,
        thisWeekStatus,
        submittedThisWeek,
        isOverdue,
        needsReview,
      };
    });
  }, [myBrands, allReports]);

  // Filter brand cards
  const filteredBrandSummaries = useMemo(() => {
    const q = search.toLowerCase();
    return brandSummaries.filter(s => {
      const name = (s.brand.brandName || s.brand.name || '').toLowerCase();
      if (q && !name.includes(q)) return false;
      if (overviewFilter === 'submitted' && !s.submittedThisWeek) return false;
      if (overviewFilter === 'pending' && s.submittedThisWeek) return false;
      if (overviewFilter === 'needs_review' && !s.needsReview) return false;
      return true;
    });
  }, [brandSummaries, search, overviewFilter]);

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
    await deleteBiWeeklyReport(reportId);
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
      getBiWeeklyReportsForTL(brandIds).then(setAllReports);
      if (savedReport.brandId) {
        setSelectedBrandId(savedReport.brandId);
        getBiWeeklyReportsForBrand(savedReport.brandId).then(data => {
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
    if (!window.confirm(`Verify this bi-weekly report (${report.periodLabel})? It will be sent to the Operation Lead for approval.`)) return;
    try {
      const senderName = currentUser.displayName || 'TL';
      await updateReportStatus(report.id, 'verified', {
        verifiedBy: currentUser.uid,
        verifiedByName: senderName,
        verifiedAt: new Date().toISOString(),
      });
      // Refresh
      const brandIds = myBrands.map(b => b.id);
      getBiWeeklyReportsForTL(brandIds).then(setAllReports);
      if (selectedBrandId) getBiWeeklyReportsForBrand(selectedBrandId).then(setBrandReports);
      setDetailReport(r => r ? { ...r, status: 'verified' } : r);
      notifyReportVerified({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'biweekly' });
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
      getBiWeeklyReportsForTL(brandIds).then(setAllReports);
      if (selectedBrandId) getBiWeeklyReportsForBrand(selectedBrandId).then(setBrandReports);
      setDetailReport(r => r ? { ...r, status: 'draft', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'biweekly', toRole: 'apc', note: note.trim() });
    } catch (err) { alert('Failed to reject: ' + err.message); }
  };

  const openBrand = (brandId) => {
    setSelectedBrandId(brandId);
    setView('brand');
    setCalYear(now.getFullYear());
    setCalMonth(now.getMonth());
    setFilterPeriod('');
  };

  const prevMonth = () => { if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); } else setCalMonth(m => m - 1); setFilterPeriod(''); };
  const nextMonth = () => { if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); } else setCalMonth(m => m + 1); setFilterPeriod(''); };

  // Unique periods in the filtered month for the dropdown
  const calPeriods = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    const inMonth = brandReports.filter(r => r.periodStart && r.periodStart.startsWith(mk));
    const seen = new Set();
    return inMonth
      .filter(r => { if (seen.has(r.period)) return false; seen.add(r.period); return true; })
      .sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || ''))
      .map(r => ({ period: r.period, label: r.periodLabel || `Period ${r.period}` }));
  }, [brandReports, calYear, calMonth]);

  /* ── Detail View ────────────────────────────────────────────────────────── */
  if (view === 'detail' && detailReport) {
    const sourceList = selectedBrandId ? brandReports : allReports.filter(r => r.brandId === detailReport.brandId);
    // Find previous report by periodStart
    const sortedSource = [...sourceList].sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || ''));
    const detailIdx = sortedSource.findIndex(r => r.id === detailReport.id);
    const prev = detailIdx > 0 ? sortedSource[detailIdx - 1] : null;
    const rStatus = getReportStatus(detailReport);
    // Edit is allowed based on role + status:
    //   - APC: only their own drafts (before submitting).
    //   - TL : while still at their stage (draft OR submitted).
    //          Once they Verify the report moves to OL, locking TL out.
    const canEdit = (userRole === 'apc' && rStatus === 'draft') ||
                    (userRole === 'tl'  && (rStatus === 'draft' || rStatus === 'submitted'));
    const canVerify = userRole === 'tl' && rStatus === 'submitted';
    // TL can only return to APC while the report is at the TL stage
    // (status: submitted). Once verified, ownership has passed to OL —
    // see WeeklyReportsPage for the full reasoning.
    const canReject = userRole === 'tl' && rStatus === 'submitted';
    // Always show current brand name in the report view (handles rename/switch)
    const currentBrand = brands.find(b => b.id === detailReport.brandId);
    const currentBrandName = currentBrand ? (currentBrand.brandName || currentBrand.name || detailReport.brandName) : detailReport.brandName;
    // Map periodStart/periodEnd to weekStart/weekEnd for WeeklyReportView compatibility
    const reportForView = { ...detailReport, brandName: currentBrandName, weekStart: detailReport.periodStart, weekEnd: detailReport.periodEnd };
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
        <WeeklyReportView report={reportForView} previousReport={prev} allReports={sourceList} />
      </div>
    );
  }

  /* ── New / Edit Form ────────────────────────────────────────────────────── */
  if (view === 'new' || view === 'edit') {
    return (
      <BiWeeklyReportForm
        editReportId={view === 'edit' ? editId : null}
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
            <i className="bi bi-plus-circle" /> New Bi-Weekly Report
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
                onClick={() => { setCalYear(now.getFullYear()); setCalMonth(now.getMonth()); setFilterPeriod(''); }}>Today</button>
            </div>
            <div className="d-flex align-items-center gap-2">
              <select className="form-select form-select-sm" value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)} style={{ width: 180, borderRadius: 8 }}>
                <option value="">All Periods ({filteredReports.length})</option>
                {calPeriods.map(p => <option key={p.period} value={String(p.period)}>{p.label}</option>)}
              </select>
              {filterPeriod && (
                <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={() => setFilterPeriod('')}>
                  <i className="bi bi-x-circle" /> Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Period cards grid (reports in month) */}
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14 }}>
          <div className="card-body p-3">
            <div className="row g-2">
              {filteredReports.length === 0 && calPeriods.length === 0 ? (
                <div className="col-12 text-center text-muted py-3" style={{ fontSize: '0.8rem' }}>
                  No bi-weekly reports in {MONTH_NAMES[calMonth]} {calYear}.
                </div>
              ) : (
                filteredReports.map(report => {
                  const perf = report?.overallPerformance || {};
                  return (
                    <div key={report.id} className="col-md-6 col-lg-4 col-xl-3">
                      <div className="rounded-3 p-3 h-100"
                        style={{ background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)', cursor: 'pointer' }}
                        onClick={() => handleViewReport(report)}>
                        <div className="d-flex align-items-center gap-2 mb-1">
                          <i className="bi bi-check-circle-fill text-success" style={{ fontSize: '0.75rem' }} />
                          <span className="fw-bold" style={{ fontSize: '0.8rem' }}>{report.periodLabel || `Period ${report.period}`}</span>
                        </div>
                        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                          {report.periodStart} – {report.periodEnd}
                        </div>
                        <div className="d-flex gap-3 mt-2">
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem', fontWeight: 600 }}>GMV</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{currencySymbol(report?.currency || DEFAULT_CURRENCY)}{Number(perf.gmv || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem', fontWeight: 600 }}>ROI</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{Number(perf.roi || 0).toFixed(2)}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
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
              const sortedBrand = [...brandReports].sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || ''));
              const rIdx = sortedBrand.findIndex(x => x.id === r.id);
              const prevR = rIdx > 0 ? sortedBrand[rIdx - 1] : null;
              const perf = r.overallPerformance || {};
              const prevPerf = prevR?.overallPerformance || {};
              const gmvChange = Number(prevPerf.gmv || 0) ? (((Number(perf.gmv || 0) - Number(prevPerf.gmv || 0)) / Number(prevPerf.gmv || 0)) * 100) : null;
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
                            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>{r.periodLabel}</div>
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
                              return ((userRole === 'apc' && s === 'draft') ||
                                      (userRole === 'tl'  && (s === 'draft' || s === 'submitted')));
                            })() && (
                              <li><button className="dropdown-item" onClick={() => handleEdit(r.id)}><i className="bi bi-pencil me-2" />Edit</button></li>
                            )}
                            {userRole === 'tl' && getReportStatus(r) === 'submitted' && (
                              <li><button className="dropdown-item" style={{ color: '#7c3aed' }} onClick={e => { e.stopPropagation(); handleVerify(r); }}><i className="bi bi-patch-check-fill me-2" />Verify</button></li>
                            )}
                            <li><hr className="dropdown-divider" /></li>
                            <li><button className="dropdown-item text-danger" onClick={() => handleDelete(r.id)}><i className="bi bi-trash3 me-2" />Delete</button></li>
                          </ul>
                        </div>
                      </div>
                      <div className="d-flex flex-wrap gap-3 mb-2">
                        <div><div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>GMV</div><div className="fw-bold" style={{ fontSize: '0.88rem' }}>{currencySymbol(r.currency || DEFAULT_CURRENCY)}{Number(perf.gmv || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
                        <div><div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>ORDERS</div><div className="fw-bold" style={{ fontSize: '0.88rem' }}>{Number(perf.orders || 0).toLocaleString()}</div></div>
                        <div><div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>ROI</div><div className="fw-bold" style={{ fontSize: '0.88rem' }}>{Number(perf.roi || 0).toFixed(2)}</div></div>
                      </div>
                      {gmvChange !== null && (
                        <div style={{ fontSize: '0.68rem', color: gmvChange >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                          <i className={`bi bi-arrow-${gmvChange >= 0 ? 'up' : 'down'}-short`} />
                          {formatPctChange(gmvChange)} GMV vs prev period
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
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>Bi-Weekly Reports</h5>
          <p className="text-muted small mb-0">Overview of your brands and bi-weekly report submission status</p>
        </div>
        <button className="btn btn-dark btn-sm px-4 d-inline-flex align-items-center gap-1"
          style={{ borderRadius: 10 }} onClick={() => setView('new')}>
          <i className="bi bi-plus-circle" /> New Bi-Weekly Report
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
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Submitted (This Period)</div>
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
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Pending (This Period)</div>
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
          <select className="form-select form-select-sm" value={overviewFilter} onChange={e => setOverviewFilter(e.target.value)} style={{ width: 240, borderRadius: 8 }}>
            <option value="">All Brands</option>
            <option value="submitted">Submitted This Period</option>
            <option value="pending">Pending / Draft</option>
            {userRole === 'tl' && <option value="needs_review">Needs My Review</option>}
          </select>
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
                        <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>LAST REPORT — {s.latest.periodLabel}</div>
                        <div className="d-flex gap-3 mt-1">
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem' }}>GMV</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{currencySymbol(s.latest?.currency || DEFAULT_CURRENCY)}{Number(latestPerf.gmv || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem' }}>ORDERS</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{Number(latestPerf.orders || 0).toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-muted" style={{ fontSize: '0.55rem' }}>ROI</div>
                            <div className="fw-bold" style={{ fontSize: '0.78rem' }}>{Number(latestPerf.roi || 0).toFixed(2)}</div>
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
