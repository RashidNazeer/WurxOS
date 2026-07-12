import React, { useEffect, useState, useMemo } from 'react';
import { useBrands } from '../../contexts/BrandsContext';
import { useAuth } from '../../contexts/AuthContext';
import { useReportsRealtime } from '../../lib/useReportsRealtime';
import {
  getMonthlyReportsForBrand, getMonthlyReportsForTL, deleteMonthlyReport,
  REPORT_STATUSES, getReportStatus, updateReportStatus,
  num, findPreviousMonthlyReport,
} from '../../utils/monthlyReportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import MonthlyReportForm from './MonthlyReportForm';
import MonthlyReportView from './MonthlyReportView';
import { notifyReportVerified, notifyReportRejected } from '../../utils/reportNotifications';

function StatusBadge({ status }) {
  const cfg = REPORT_STATUSES[status] || REPORT_STATUSES.approved;
  return (
    <span className="badge rounded-pill d-inline-flex align-items-center gap-1"
      style={{ background: cfg.bg, color: cfg.color, fontSize: '0.62rem' }}>
      <i className={`bi ${cfg.icon}`} />{cfg.label}
    </span>
  );
}

function fmt$(v, currency = DEFAULT_CURRENCY) {
  const n = num(v);
  return n ? currencySymbol(currency) + n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_NAMES_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export default function MonthlyReportsPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const { brands } = useBrands();
  const isApc = userRole === 'apc' || userRole === 'ipc';
  const isTL = userRole === 'tl';

  // Views: list | new | edit | detail
  const [view, setView] = useState('list');
  const [editId, setEditId] = useState(null);
  const [detailReport, setDetailReport] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);

  const myBrands = brands;

  // Re-overlay current brand names so brand renames/switches show through
  const reportsWithCurrentNames = useMemo(() => {
    const nameById = new Map(myBrands.map(b => [b.id, b.brandName || b.name]));
    return reports.map(r => {
      const current = r.brandId ? nameById.get(r.brandId) : null;
      return current ? { ...r, brandName: current } : r;
    });
  }, [reports, myBrands]);

  useEffect(() => {
    if (myBrands.length === 0) { setReports([]); setLoading(false); return; }
    setLoading(true);
    getMonthlyReportsForTL(myBrands.map(b => b.id))
      .then(data => { setReports(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [myBrands]);

  const refresh = async () => {
    if (myBrands.length === 0) return;
    const data = await getMonthlyReportsForTL(myBrands.map(b => b.id));
    setReports(data);
  };

  // Live-sync: reload in the background when any report changes (status/new/
  // deleted) — no manual refresh, no spinner.
  useReportsRealtime(refresh, { enabled: (myBrands || []).length > 0 });

  // Filters
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [filterMonth, setFilterMonth] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return reportsWithCurrentNames.filter(r => {
      if (year && r.year !== year) return false;
      if (filterMonth !== '' && r.month !== Number(filterMonth)) return false;
      if (filterBrand && r.brandId !== filterBrand) return false;
      if (filterStatus && getReportStatus(r) !== filterStatus) return false;
      if (search && !(r.brandName || '').toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [reportsWithCurrentNames, year, filterMonth, filterBrand, filterStatus, search]);

  const yearOptions = useMemo(() => {
    const set = new Set([now.getFullYear(), now.getFullYear() - 1, now.getFullYear() + 1]);
    reportsWithCurrentNames.forEach(r => { if (r.year) set.add(r.year); });
    return [...set].sort((a, b) => b - a);
  }, [reportsWithCurrentNames]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Status actions (TL verifies) ─────────────────────────────────────── */
  const handleVerify = async (report) => {
    if (!window.confirm(`Verify this report (${report.monthLabel}) and pass it to OL?`)) return;
    const senderName = currentUser.displayName || 'Team Lead';
    try {
      await updateReportStatus(report.id, 'verified', {
        verifiedBy: currentUser.uid, verifiedByName: senderName, verifiedAt: new Date().toISOString(),
      });
      setReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'verified' } : r));
      setDetailReport(r => r ? { ...r, status: 'verified' } : r);
      notifyReportVerified({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly' });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleRejectToApc = async (report) => {
    const note = window.prompt('Reason for sending back to APC (required):');
    if (!note || !note.trim()) return;
    const senderName = currentUser.displayName || 'Team Lead';
    try {
      await updateReportStatus(report.id, 'draft', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid, rejectedByName: senderName, rejectedAt: new Date().toISOString(),
      });
      setReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'draft', rejectionNote: note.trim() } : r));
      setDetailReport(r => r ? { ...r, status: 'draft', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly', toRole: 'apc', note: note.trim() });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleDelete = async (report) => {
    if (!window.confirm(`Delete the ${report.monthLabel} report for ${report.brandName}? This cannot be undone.`)) return;
    try {
      await deleteMonthlyReport(report.id);
      setReports(prev => prev.filter(r => r.id !== report.id));
      setDetailReport(null);
    } catch (err) { alert('Failed: ' + err.message); }
  };

  /* ── Views ────────────────────────────────────────────────────────────── */

  if (view === 'new') {
    return (
      <MonthlyReportForm
        onSaved={async (saved) => {
          await refresh();
          setView('list');
          if (saved) setDetailReport(saved);
        }}
        onCancel={() => setView('list')}
      />
    );
  }

  if (view === 'edit' && editId) {
    return (
      <MonthlyReportForm
        editReportId={editId}
        onSaved={async (saved) => {
          await refresh();
          setView('list');
          setEditId(null);
          if (saved) setDetailReport(saved);
        }}
        onCancel={() => { setView('list'); setEditId(null); }}
      />
    );
  }

  if (detailReport) {
    const prev = findPreviousMonthlyReport(reports, detailReport);
    const rStatus = getReportStatus(detailReport);
    const isOwner = detailReport.createdBy === currentUser.uid;
    const canApcEdit = isApc && rStatus === 'draft';
    const canTlVerify = isTL && rStatus === 'submitted';
    // TL can only return to APC while the report is at the TL stage
    // (status: submitted). Once verified, ownership has passed to OL —
    // see WeeklyReportsPage for the full reasoning.
    const canTlReject = isTL && rStatus === 'submitted';
    // TL can edit only while the report is still at their stage
    // (draft OR submitted). Once Verified, ownership moved to OL and
    // TL is read-only. Previously `canTlEdit = isTL` let TL edit even
    // approved reports — too permissive.
    const canTlEdit = isTL && (rStatus === 'draft' || rStatus === 'submitted');

    return (
      <div>
        <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
          <button className="btn btn-sm btn-link text-muted p-0" onClick={() => setDetailReport(null)}>
            <i className="bi bi-arrow-left me-1" /> Back to reports
          </button>
          <div className="d-flex gap-2 flex-wrap">
            <StatusBadge status={rStatus} />
            {(canApcEdit || canTlEdit) && (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8 }}
                onClick={() => { setEditId(detailReport.id); setView('edit'); }}>
                <i className="bi bi-pencil" /> Edit
              </button>
            )}
            {canTlVerify && (
              <button className="btn btn-sm d-inline-flex align-items-center gap-1 text-white"
                style={{ borderRadius: 8, background: '#7c3aed', border: 'none' }}
                onClick={() => handleVerify(detailReport)}>
                <i className="bi bi-patch-check-fill" /> Verify
              </button>
            )}
            {canTlReject && (
              <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8 }}
                onClick={() => handleRejectToApc(detailReport)}>
                <i className="bi bi-arrow-counterclockwise" /> Return to APC
              </button>
            )}
            {(isOwner || isTL) && rStatus === 'draft' && (
              <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8 }}
                onClick={() => handleDelete(detailReport)}>
                <i className="bi bi-trash3" /> Delete
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
        <MonthlyReportView report={detailReport} previousReport={prev} />
      </div>
    );
  }

  /* ── List view ──────────────────────────────────────────────────────────── */
  return (
    <div>
      <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>Monthly Reports</h5>
          <p className="text-muted small mb-0">
            {isTL ? 'Reports for your brands' : 'Your monthly brand reports'} · {reports.length} total
          </p>
        </div>
        <button className="btn btn-dark btn-sm d-inline-flex align-items-center gap-1 px-3"
          style={{ borderRadius: 8 }} onClick={() => setView('new')}>
          <i className="bi bi-plus-circle" /> New Monthly Report
        </button>
      </div>

      {/* Filters */}
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <div className="position-relative flex-grow-1" style={{ minWidth: 200, maxWidth: 320 }}>
          <i className="bi bi-search position-absolute text-muted"
            style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
          <input type="text" className="form-control form-control-sm" placeholder="Search brand…"
            style={{ paddingLeft: 28, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="form-select form-select-sm" value={year} onChange={e => setYear(Number(e.target.value))}
          style={{ width: 120, borderRadius: 8 }}>
          {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select className="form-select form-select-sm" value={filterMonth} onChange={e => setFilterMonth(e.target.value)}
          style={{ width: 140, borderRadius: 8 }}>
          <option value="">All Months</option>
          {MONTH_NAMES.map((m, i) => <option key={i} value={i}>{m}</option>)}
        </select>
        {myBrands.length > 1 && (
          <select className="form-select form-select-sm" value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
            style={{ width: 200, borderRadius: 8 }}>
            <option value="">All Brands</option>
            {myBrands.map(b => <option key={b.id} value={b.id}>{b.brandName || b.name}</option>)}
          </select>
        )}
        <select className="form-select form-select-sm" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          style={{ width: 150, borderRadius: 8 }}>
          <option value="">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="verified">Verified</option>
          <option value="approved">Approved</option>
        </select>
        <span className="text-muted small ms-auto" style={{ fontSize: '0.75rem' }}>
          {filtered.length} report{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <div className="text-muted d-flex align-items-center gap-2 small">
          <span className="spinner-border spinner-border-sm" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-5">
          <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2.5rem', color: 'var(--text-muted)' }} />
          <p className="text-muted mt-3 mb-1">No monthly reports yet for {year}.</p>
          <button className="btn btn-sm btn-outline-dark mt-2" onClick={() => setView('new')}>
            <i className="bi bi-plus-circle me-1" /> Create your first
          </button>
        </div>
      ) : (
        <div className="row g-3">
          {filtered.map(r => {
            const totalGmv = r.totalSales?.monthGmv;
            const orders = r.keyMetrics?.orders;
            const monthLabel = r.monthLabel || r.label
              || (r.year != null && r.month != null ? `${MONTH_NAMES_LONG[r.month]} ${r.year}` : '—');
            return (
              <div key={r.id} className="col-12 col-md-6 col-lg-4">
                <div className="card h-100" style={{
                  borderRadius: 14, cursor: 'pointer',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
                  transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
                }}
                  onClick={() => setDetailReport(r)}
                  onMouseEnter={e => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 8px 20px rgba(15, 23, 42, 0.08)';
                    e.currentTarget.style.borderColor = 'var(--border-default)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.transform = 'none';
                    e.currentTarget.style.boxShadow = '0 1px 3px rgba(15, 23, 42, 0.04)';
                    e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  }}>
                  <div className="card-body p-3">
                    <div className="d-flex align-items-center gap-2 mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                        style={{ width: 26, height: 26, fontSize: '0.58rem', background: '#3b82f6' }}>
                        {(r.brandName || '??').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="fw-bold text-truncate" style={{ fontSize: '0.85rem', minWidth: 0 }}>{r.brandName}</div>
                      <span className="badge rounded-pill d-inline-flex align-items-center gap-1 flex-shrink-0 ms-auto"
                        style={{ background: 'var(--info-soft)', color: 'var(--info)', fontSize: '0.7rem', fontWeight: 700, border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', padding: '4px 10px', whiteSpace: 'nowrap' }}
                        title={`Reporting month: ${monthLabel}`}>
                        <i className="bi bi-calendar-month" style={{ fontSize: '0.7rem' }} />
                        {monthLabel}
                      </span>
                      <i className="bi bi-chevron-right text-muted flex-shrink-0" style={{ fontSize: '0.75rem' }} />
                    </div>
                    <div className="d-flex align-items-center gap-2 mb-2">
                      <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                        style={{ width: 32, height: 32, background: 'var(--info-soft)' }}>
                        <i className="bi bi-calendar-month" style={{ fontSize: '0.95rem', color: 'var(--info)' }} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: 1.2 }}>{monthLabel}</div>
                        <div className="d-flex align-items-center gap-2 flex-wrap" style={{ marginTop: 2 }}>
                          <span className="text-muted" style={{ fontSize: '0.68rem' }}>by {r.createdByName}</span>
                          <StatusBadge status={getReportStatus(r)} />
                        </div>
                      </div>
                    </div>
                    <div className="d-flex flex-wrap gap-3">
                      <div>
                        <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>GMV</div>
                        <div className="fw-bold" style={{ fontSize: '0.92rem', color: 'var(--success)' }}>{fmt$(totalGmv, r.currency)}</div>
                      </div>
                      <div>
                        <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>ORDERS</div>
                        <div className="fw-bold" style={{ fontSize: '0.92rem' }}>{orders ? Number(orders).toLocaleString() : '—'}</div>
                      </div>
                      {r.kpis?.completedCollabs && (
                        <div>
                          <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>COLLABS</div>
                          <div className="fw-bold" style={{ fontSize: '0.92rem' }}>{Number(r.kpis.completedCollabs).toLocaleString()}</div>
                        </div>
                      )}
                    </div>
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
