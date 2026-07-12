import React, { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useBrands } from '../../contexts/BrandsContext';
import { useReportsRealtime } from '../../lib/useReportsRealtime';
import {
  getAllMonthlyReports, getMonthlyReportsForTL, deleteMonthlyReport,
  REPORT_STATUSES, getReportStatus, updateReportStatus,
  num, findPreviousMonthlyReport,
} from '../../utils/monthlyReportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import MonthlyReportForm from './MonthlyReportForm';
import ReportActionsMenu from './ReportActionsMenu';
import MonthlyReportView from './MonthlyReportView';
import ReportFiltersPopover from './ReportFiltersPopover';
import EditReportDatesModal from './EditReportDatesModal';
import { notifyReportApproved, notifyReportRejected, notifyReportSubmitted, notifyReportVerified } from '../../utils/reportNotifications';

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

export default function AllMonthlyReportsPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const { brands, loading: brandsLoading } = useBrands();

  const [rawReports, setRawReports] = useState([]);
  const [error, setError] = useState('');
  // Bulk selection — Boss/OL only.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const canBulkDelete = userRole === 'boss' || userRole === 'ol';
  const toggleSelected = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelected = () => setSelected(new Set());

  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());

  const [filterBrand, setFilterBrand] = useState('');
  const [filterClient, setFilterClient] = useState('');
  const [filterTeam, setFilterTeam] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterCreator, setFilterCreator] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [viewReport, setViewReport] = useState(null);
  const [editReportId, setEditReportId] = useState(null);
  // Report-view actions (highlighter / export) lifted into the
  // sticky bar's "Other options" menu.
  const [reportActions, setReportActions] = useState(null);
  const [editDatesReport, setEditDatesReport] = useState(null);

  // Cached load + live-sync — identical pattern to the weekly list: paint
  // instantly from cache on revisit (no spinner) with a background refetch to
  // stay fresh; optimistic mutations still patch rawReports locally below.
  const isTL = userRole === 'tl';
  const brandIds = useMemo(() => (brands || []).map((b) => b.id).sort(), [brands]);
  const {
    data: queryReports, isLoading, error: queryError, refetch,
  } = useQuery({
    queryKey: ['reports-list', 'monthly', 'all', userRole, currentUser?.uid, isTL ? brandIds.join(',') : ''],
    queryFn: () => (isTL ? getMonthlyReportsForTL(brandIds) : getAllMonthlyReports()),
    enabled: !!currentUser?.uid && !!userRole && (!isTL || !brandsLoading),
    staleTime: 30_000,
    refetchOnMount: true,
  });
  useEffect(() => { if (queryReports) setRawReports(queryReports); }, [queryReports]);
  useEffect(() => { if (queryError) setError(queryError.message || 'Failed to load reports'); }, [queryError]);
  const loading = (isLoading || (isTL && brandsLoading)) && rawReports.length === 0;
  const loadReports = refetch; // legacy callers below just want a refresh

  // Live-sync: auto-refresh when any report changes (status/new/deleted).
  useReportsRealtime(refetch, { enabled: !!currentUser?.uid });

  const reports = useMemo(() => {
    const nameById = new Map(brands.map(b => [b.id, b.brandName || b.name]));
    return rawReports.map(r => {
      const current = r.brandId ? nameById.get(r.brandId) : null;
      return current ? { ...r, brandName: current } : r;
    });
  }, [rawReports, brands]);

  const clientByBrandId = useMemo(() => {
    const m = new Map();
    brands.forEach(b => { if (b.clientName) m.set(b.id, b.clientName); });
    return m;
  }, [brands]);

  const ownerByBrandId = useMemo(() => {
    const m = new Map();
    brands.forEach(b => { if (b.ownerId) m.set(b.id, { id: b.ownerId, name: b.ownerName || 'Team Lead' }); });
    return m;
  }, [brands]);

  const brandOptions = useMemo(() => {
    const s = new Set();
    reports.forEach(r => { if (r.brandName) s.add(r.brandName); });
    return [...s].sort();
  }, [reports]);

  const creatorOptions = useMemo(() => {
    const s = new Set();
    reports.forEach(r => { if (r.createdByName) s.add(r.createdByName); });
    return [...s].sort();
  }, [reports]);

  const clientOptions = useMemo(() => {
    const s = new Set();
    reports.forEach(r => {
      const c = clientByBrandId.get(r.brandId);
      if (c) s.add(c);
    });
    return [...s].sort();
  }, [reports, clientByBrandId]);

  const teamOptions = useMemo(() => {
    const m = new Map();
    reports.forEach(r => {
      const owner = ownerByBrandId.get(r.brandId);
      if (owner && owner.id) m.set(owner.id, owner.name);
    });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [reports, ownerByBrandId]);

  const filtered = useMemo(() => {
    return reports.filter(r => {
      if (calYear && r.year !== calYear) return false;
      if (filterBrand && r.brandName !== filterBrand) return false;
      if (filterClient && clientByBrandId.get(r.brandId) !== filterClient) return false;
      if (filterTeam && ownerByBrandId.get(r.brandId)?.id !== filterTeam) return false;
      if (filterSearch && !(r.brandName || '').toLowerCase().includes(filterSearch.toLowerCase())) return false;
      if (filterCreator && r.createdByName !== filterCreator) return false;
      if (filterMonth !== '' && r.month !== Number(filterMonth)) return false;
      if (filterStatus && getReportStatus(r) !== filterStatus) return false;
      return true;
    }).sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''));
  }, [reports, calYear, filterBrand, filterClient, clientByBrandId, filterTeam, ownerByBrandId,
      filterSearch, filterCreator, filterMonth, filterStatus]);

  const yearOptions = useMemo(() => {
    const set = new Set([now.getFullYear(), now.getFullYear() - 1, now.getFullYear() + 1]);
    reports.forEach(r => { if (r.year) set.add(r.year); });
    return [...set].sort((a, b) => b - a);
  }, [reports]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthStats = useMemo(() => {
    let totalGmv = 0, reportCount = filtered.length, brandSet = new Set();
    let pendingApproval = 0, approved = 0;
    filtered.forEach(r => {
      totalGmv += num(r.totalSales?.monthGmv);
      brandSet.add(r.brandName);
      const s = getReportStatus(r);
      if (s === 'verified') pendingApproval++;
      if (s === 'approved') approved++;
    });
    return { totalGmv, reportCount, brandCount: brandSet.size, pendingApproval, approved };
  }, [filtered]);

  const hasFilters = filterBrand || filterClient || filterTeam || filterSearch || filterCreator || filterMonth !== '' || filterStatus;

  const clearAllFilters = () => {
    setFilterBrand(''); setFilterClient(''); setFilterTeam('');
    setFilterSearch(''); setFilterCreator(''); setFilterMonth(''); setFilterStatus('');
  };

  const popoverFilters = [
    { key: 'brand', label: 'Brand', value: filterBrand, setValue: setFilterBrand,
      options: brandOptions.map(b => ({ value: b, label: b })) },
    ...((userRole === 'boss' || userRole === 'ol') && clientOptions.length > 0
      ? [{ key: 'client', label: 'Client', value: filterClient, setValue: setFilterClient,
          options: clientOptions.map(c => ({ value: c, label: c })) }]
      : []),
    ...((userRole === 'boss' || userRole === 'ol') && teamOptions.length > 0
      ? [{ key: 'team', label: 'Team', value: filterTeam, setValue: setFilterTeam,
          options: teamOptions.map(t => ({ value: t.id, label: `Team ${t.name}` })) }]
      : []),
    { key: 'reporter', label: 'Reporter', value: filterCreator, setValue: setFilterCreator,
      options: creatorOptions.map(c => ({ value: c, label: c })) },
    { key: 'month', label: 'Month', value: filterMonth, setValue: setFilterMonth,
      options: MONTH_NAMES.map((m, i) => ({ value: String(i), label: m })) },
    { key: 'status', label: 'Status', value: filterStatus, setValue: setFilterStatus,
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'submitted', label: 'Submitted' },
        { value: 'verified', label: 'Verified' },
        { value: 'approved', label: 'Approved' },
      ] },
  ];

  const prevYear = () => setCalYear(y => y - 1);
  const nextYear = () => setCalYear(y => y + 1);

  /* ── OL acting as APC: submit a draft report ──────────────────────────── */
  const handleSubmitAsApc = async (report) => {
    if (!window.confirm(`Submit this draft (${report.monthLabel}) on the APC's behalf? It will move to "submitted" for TL verification.`)) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'submitted', {
        submittedBy: currentUser.uid, submittedByName: senderName, submittedAt: new Date().toISOString(),
        submittedActingAs: 'apc',
        rejectionNote: null,
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'submitted', rejectionNote: null } : r));
      setViewReport(r => r ? { ...r, status: 'submitted', rejectionNote: null } : r);
      notifyReportSubmitted({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly' });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  /* ── OL acting as TL: verify a submitted report ───────────────────────── */
  const handleVerifyAsTl = async (report) => {
    if (!window.confirm(`Verify this report (${report.monthLabel}) on the TL's behalf? It will move to "verified" for OL approval.`)) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'verified', {
        verifiedBy: currentUser.uid, verifiedByName: senderName, verifiedAt: new Date().toISOString(),
        verifiedActingAs: 'tl',
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'verified' } : r));
      setViewReport(r => r ? { ...r, status: 'verified' } : r);
      notifyReportVerified({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly' });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  /* ── Approve / Reject (OL only) ───────────────────────────────────────── */
  const handleApprove = async (report) => {
    if (!window.confirm(`Approve this monthly report (${report.monthLabel})? This is the final approval.`)) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'approved', {
        approvedBy: currentUser.uid, approvedByName: senderName, approvedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'approved' } : r));
      setViewReport(r => r ? { ...r, status: 'approved' } : r);
      notifyReportApproved({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly' });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleRejectToTL = async (report) => {
    const note = window.prompt('Reason for returning to Team Lead (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'submitted', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid, rejectedByName: senderName, rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly', toRole: 'tl', note: note.trim() });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleRejectToAPC = async (report) => {
    const note = window.prompt('Reason for returning to APC (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'draft', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid, rejectedByName: senderName, rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'draft', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'draft', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly', toRole: 'apc', note: note.trim() });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  /* ── Reopen approved reports (OL only) ─────────────────────────────────── */
  const handleReopenForEdit = async (report) => {
    if (!window.confirm('Reopen this approved report for your own edits? It will move back to "verified" so you can edit and re-approve.')) return;
    try {
      await updateReportStatus(report.id, 'verified', {
        reopenedBy: currentUser.uid,
        reopenedByName: currentUser.displayName || 'OL',
        reopenedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'verified' } : r));
      setViewReport(r => r ? { ...r, status: 'verified' } : r);
    } catch (err) { alert('Failed to reopen: ' + err.message); }
  };

  const handleReopenToTL = async (report) => {
    const note = window.prompt('Reason for sending this approved report back to Team Lead (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'submitted', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid, rejectedByName: senderName, rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly', toRole: 'tl', note: note.trim(), isReopen: true });
    } catch (err) { alert('Failed to reopen: ' + err.message); }
  };

  const handleReopenToAPC = async (report) => {
    const note = window.prompt('Reason for sending this approved report back to APC (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'draft', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid, rejectedByName: senderName, rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'draft', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'draft', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'monthly', toRole: 'apc', note: note.trim(), isReopen: true });
    } catch (err) { alert('Failed to reopen: ' + err.message); }
  };

  const handleDeleteReport = async (report) => {
    if (!window.confirm(`Delete this monthly report for ${report.brandName} (${report.monthLabel})? This cannot be undone.`)) return;
    try {
      await deleteMonthlyReport(report.id);
      setRawReports(prev => prev.filter(r => r.id !== report.id));
      setViewReport(null);
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} monthly report${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const failures = [];
      await Promise.all(ids.map((id) => deleteMonthlyReport(id).catch((err) => failures.push({ id, msg: err.message }))));
      const removedIds = new Set(ids.filter((id) => !failures.some((f) => f.id === id)));
      setRawReports((prev) => prev.filter((r) => !removedIds.has(r.id)));
      clearSelected();
      if (failures.length) alert(`${failures.length} of ${ids.length} could not be deleted:\n` + failures.map((f) => f.msg).join('\n'));
    } finally { setBulkBusy(false); }
  };

  /* ── Edit ─────────────────────────────────────────────────────────────── */
  if (editReportId) {
    return (
      <MonthlyReportForm
        editReportId={editReportId}
        onSaved={(saved) => {
          if (saved) {
            setRawReports(prev => prev.map(r => r.id === saved.id ? { ...r, ...saved } : r));
            setViewReport(saved);
          }
          setEditReportId(null);
        }}
        onCancel={() => setEditReportId(null)}
      />
    );
  }

  /* ── Detail ───────────────────────────────────────────────────────────── */
  if (viewReport) {
    const brandReports = reports.filter(r => r.brandId === viewReport.brandId);
    const prev = findPreviousMonthlyReport(brandReports, viewReport);
    const rStatus = getReportStatus(viewReport);
    const canEdit = userRole === 'ol' && rStatus !== 'approved';
    const canEditDates = userRole === 'ol' || userRole === 'boss';
    const canSubmitAsApc = userRole === 'ol' && rStatus === 'draft';
    const canVerifyAsTl = userRole === 'ol' && rStatus === 'submitted';
    const canApprove = userRole === 'ol' && rStatus === 'verified';
    const canReject = userRole === 'ol' && (rStatus === 'verified' || rStatus === 'submitted');
    const canReopen = userRole === 'ol' && rStatus === 'approved';
    const canDelete = userRole === 'boss' || userRole === 'ol';
    return (
      <div>
        {/* Sticky action bar — stays pinned while reviewing a long
            report so the OL never has to scroll back up for actions. */}
        <div className="d-flex align-items-center justify-content-between flex-wrap gap-2"
          style={{
            position: 'sticky', top: 'var(--topbar-h, 68px)', zIndex: 10,
            background: 'var(--surface-0)',
            borderBottom: '1px solid var(--border-subtle)',
            padding: '12px 28px', margin: '0 -28px 12px',
          }}>
          <button className="btn btn-sm btn-link text-muted p-0" onClick={() => setViewReport(null)}>
            <i className="bi bi-arrow-left me-1" /> Back to all reports
          </button>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <StatusBadge status={rStatus} />
            {canEdit && (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem' }}
                onClick={() => setEditReportId(viewReport.id)}>
                <i className="bi bi-pencil" /> Edit
              </button>
            )}
            {canEditDates && (
              <button className="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem' }}
                onClick={() => setEditDatesReport(viewReport)}
                title="Change just this report's month without touching siblings">
                <i className="bi bi-calendar-event" /> Edit Month
              </button>
            )}
            {canSubmitAsApc && (
              <button className="btn btn-sm d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem', background: '#0ea5e9', color: 'white', border: 'none' }}
                onClick={() => handleSubmitAsApc(viewReport)}
                title="Move this draft to submitted (acting on behalf of the APC)">
                <i className="bi bi-send-fill" /> Submit as APC
              </button>
            )}
            {canVerifyAsTl && (
              <button className="btn btn-sm d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem', background: '#7c3aed', color: 'white', border: 'none' }}
                onClick={() => handleVerifyAsTl(viewReport)}
                title="Verify this submitted report (acting on behalf of the TL)">
                <i className="bi bi-patch-check-fill" /> Verify as TL
              </button>
            )}
            {canApprove && (
              <button className="btn btn-sm d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem', background: '#16a34a', color: 'white', border: 'none' }}
                onClick={() => handleApprove(viewReport)}>
                <i className="bi bi-shield-check-fill" /> Approve
              </button>
            )}
            {canReject && (
              <>
                <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem' }}
                  onClick={() => handleRejectToTL(viewReport)}>
                  <i className="bi bi-arrow-counterclockwise" /> Return to TL
                </button>
                <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem' }}
                  onClick={() => handleRejectToAPC(viewReport)}
                  title="Send back to APC for revision">
                  <i className="bi bi-arrow-counterclockwise" /> Return to APC
                </button>
              </>
            )}
            {canReopen && (
              <>
                <button className="btn btn-sm btn-outline-warning d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem' }}
                  onClick={() => handleReopenForEdit(viewReport)}
                  title="Move back to verified so you can edit and re-approve">
                  <i className="bi bi-pencil-square" /> Reopen to Edit
                </button>
                <button className="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem' }}
                  onClick={() => handleReopenToTL(viewReport)}
                  title="Send back to Team Lead for revision">
                  <i className="bi bi-arrow-counterclockwise" /> Send Back to TL
                </button>
                <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem' }}
                  onClick={() => handleReopenToAPC(viewReport)}
                  title="Send back to APC for revision">
                  <i className="bi bi-arrow-counterclockwise" /> Send Back to APC
                </button>
              </>
            )}
            {canDelete && (
              <button className="btn btn-sm d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem', background: '#dc2626', color: 'white', border: 'none' }}
                onClick={() => handleDeleteReport(viewReport)}>
                <i className="bi bi-trash3" /> Delete
              </button>
            )}
            {/* Highlighter / Export PDF — lifted from the report view
                so they stay reachable while scrolling. */}
            <ReportActionsMenu actions={reportActions} />
          </div>
        </div>
        {viewReport.rejectionNote && (rStatus === 'submitted' || rStatus === 'draft') && (
          <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
            style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10, color: 'var(--danger)' }}>
            <i className="bi bi-exclamation-triangle-fill flex-shrink-0 mt-1" />
            <div>
              <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Returned for revision</div>
              <div style={{ fontSize: '0.78rem', marginTop: 2 }}>{viewReport.rejectionNote}</div>
            </div>
          </div>
        )}
        <MonthlyReportView report={viewReport} previousReport={prev}
          onActions={setReportActions} />

        {editDatesReport && (
          <EditReportDatesModal
            report={editDatesReport}
            type="monthly"
            siblings={brandReports.filter(r => r.id !== editDatesReport.id)}
            onClose={() => setEditDatesReport(null)}
            onSaved={() => { setEditDatesReport(null); setViewReport(null); loadReports(); }}
          />
        )}
      </div>
    );
  }

  if (loading) return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading reports…</div>;
  if (error) return <div className="alert alert-danger m-4">{error}</div>;

  return (
    <div>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>Monthly Reports</h5>
          <p className="text-muted small mb-0">
            {userRole === 'tl' ? 'Reports from your team' : 'All monthly brand reports'} · {reports.length} total
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="row g-3 mb-4">
        <div className="col-6 col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
            <div className="card-body p-3 d-flex align-items-center gap-2">
              <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                style={{ width: 36, height: 36, background: 'var(--info-soft)' }}>
                <i className="bi bi-file-earmark-bar-graph" style={{ color: 'var(--info)' }} />
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{monthStats.reportCount}</div>
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Reports</div>
              </div>
            </div>
          </div>
        </div>
        <div className="col-6 col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
            <div className="card-body p-3 d-flex align-items-center gap-2">
              <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                style={{ width: 36, height: 36, background: 'var(--success-soft)' }}>
                <i className="bi bi-shop" style={{ color: 'var(--success)' }} />
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{monthStats.brandCount}</div>
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Brands</div>
              </div>
            </div>
          </div>
        </div>
        <div className="col-6 col-lg-3">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
            <div className="card-body p-3 d-flex align-items-center gap-2">
              <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                style={{ width: 36, height: 36, background: 'var(--warning-soft)' }}>
                <i className="bi bi-currency-dollar" style={{ color: 'var(--warning)' }} />
              </div>
              <div>
                <div className="fw-bold" style={{ fontSize: '1.2rem' }}>
                  ${monthStats.totalGmv >= 1000 ? (monthStats.totalGmv / 1000).toFixed(1) + 'K' : monthStats.totalGmv.toFixed(0)}
                </div>
                <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Total GMV</div>
              </div>
            </div>
          </div>
        </div>
        {userRole === 'ol' ? (
          <div className="col-6 col-lg-3">
            <div className="card border-0 shadow-sm" style={{ borderRadius: 12, cursor: 'pointer' }}
              onClick={() => setFilterStatus(f => f === 'verified' ? '' : 'verified')}>
              <div className="card-body p-3 d-flex align-items-center gap-2">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                  style={{ width: 36, height: 36, background: 'color-mix(in srgb, #7c3aed 18%, transparent)' }}>
                  <i className="bi bi-hourglass-split" style={{ color: '#7c3aed' }} />
                </div>
                <div>
                  <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{monthStats.pendingApproval}</div>
                  <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Pending Approval</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="col-6 col-lg-3">
            <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
              <div className="card-body p-3 d-flex align-items-center gap-2">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                  style={{ width: 36, height: 36, background: 'var(--success-soft)' }}>
                  <i className="bi bi-shield-check-fill" style={{ color: 'var(--success)' }} />
                </div>
                <div>
                  <div className="fw-bold" style={{ fontSize: '1.2rem' }}>{monthStats.approved}</div>
                  <div className="text-muted" style={{ fontSize: '0.65rem', fontWeight: 600 }}>Approved</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Year navigator + filters */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex flex-wrap gap-3 align-items-center justify-content-between mb-2">
            <div className="d-flex align-items-center gap-2">
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={prevYear}
                style={{ width: 32, height: 32, padding: 0 }}>
                <i className="bi bi-chevron-left" style={{ fontSize: '0.8rem' }} />
              </button>
              <div className="fw-bold" style={{ fontSize: '0.92rem', minWidth: 80, textAlign: 'center' }}>
                {calYear}
              </div>
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={nextYear}
                style={{ width: 32, height: 32, padding: 0 }}>
                <i className="bi bi-chevron-right" style={{ fontSize: '0.8rem' }} />
              </button>
              <button className="btn btn-sm btn-outline-secondary ms-1"
                style={{ borderRadius: 8, fontSize: '0.72rem' }}
                onClick={() => setCalYear(now.getFullYear())}>
                Current
              </button>
            </div>
            <span className="text-muted small">{filtered.length} reports</span>
          </div>
          <div className="d-flex flex-wrap gap-2 align-items-center">
            <div className="position-relative flex-grow-1" style={{ minWidth: 200, maxWidth: 320 }}>
              <i className="bi bi-search position-absolute text-muted"
                style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
              <input type="text" className="form-control form-control-sm" placeholder="Search brand…"
                style={{ paddingLeft: 28, borderRadius: 8 }} value={filterSearch} onChange={e => setFilterSearch(e.target.value)} />
            </div>
            <ReportFiltersPopover filters={popoverFilters} onClear={clearAllFilters} />
            {hasFilters && (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.72rem' }}
                onClick={clearAllFilters}>
                <i className="bi bi-x-circle" /> Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {canBulkDelete && selected.size > 0 && (
        <div className="d-flex align-items-center gap-3 px-3 py-2 mb-3"
          style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10 }}>
          <span className="fw-bold" style={{ color: 'var(--danger)', fontSize: '0.82rem' }}>
            <i className="bi bi-check2-square me-1" />
            {selected.size} selected
          </span>
          <button className="btn btn-sm btn-outline-secondary ms-auto" style={{ borderRadius: 8, fontSize: '0.75rem' }}
            onClick={clearSelected} disabled={bulkBusy}>
            Clear
          </button>
          <button className="btn btn-sm btn-danger d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.78rem' }}
            onClick={handleBulkDelete} disabled={bulkBusy}>
            {bulkBusy ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-trash3" />}
            Delete {selected.size}
          </button>
        </div>
      )}

      {/* Report cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-5">
          <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2.5rem', color: 'var(--text-muted)' }} />
          <p className="text-muted mt-3 mb-0">No reports for {calYear}.</p>
        </div>
      ) : (
        <div className="row g-3">
          {filtered.map(r => {
            const totalGmv = r.totalSales?.monthGmv;
            const orders = r.keyMetrics?.orders;
            const clientName = clientByBrandId.get(r.brandId);
            const brandName = r.brandName || 'Unknown';
            const monthLabel = r.monthLabel || r.label
              || (r.year != null && r.month != null ? `${MONTH_NAMES_LONG[r.month]} ${r.year}` : '—');
            const isSel = selected.has(r.id);
            return (
              <div key={r.id} className="col-12 col-md-6 col-lg-4">
                <div className="card h-100 position-relative" style={{
                    borderRadius: 14, cursor: 'pointer',
                    border: isSel ? '2px solid #ef4444' : '1px solid var(--border-subtle)',
                    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
                    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
                  }}
                  onClick={() => setViewReport(r)}
                  onMouseEnter={e => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 8px 20px rgba(15, 23, 42, 0.08)';
                    if (!isSel) e.currentTarget.style.borderColor = 'var(--border-default)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.transform = 'none';
                    e.currentTarget.style.boxShadow = '0 1px 3px rgba(15, 23, 42, 0.04)';
                    if (!isSel) e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  }}>
                  {canBulkDelete && (
                    <label
                      className="position-absolute d-flex align-items-center justify-content-center"
                      style={{
                        top: 8, left: 8, width: 24, height: 24,
                        background: isSel ? '#ef4444' : 'var(--surface-1)',
                        border: `1.5px solid ${isSel ? '#ef4444' : 'var(--border-default)'}`,
                        borderRadius: 6, cursor: 'pointer', zIndex: 2,
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      }}
                      onClick={(e) => { e.stopPropagation(); toggleSelected(r.id); }}
                      title={isSel ? 'Unselect' : 'Select'}
                    >
                      {isSel && <i className="bi bi-check-lg text-white" style={{ fontSize: '0.95rem', lineHeight: 1 }} />}
                    </label>
                  )}
                  <div className="card-body p-3">
                    <div className="d-flex align-items-center gap-2 mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)', paddingLeft: canBulkDelete ? 28 : 0 }}>
                      <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                        style={{ width: 26, height: 26, fontSize: '0.58rem', background: '#3b82f6' }}>
                        {brandName.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="fw-bold text-truncate" style={{ fontSize: '0.85rem', minWidth: 0 }}>{brandName}</div>
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
                          {clientName && (
                            <span className="badge rounded-pill d-inline-flex align-items-center gap-1 flex-shrink-0"
                              style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.6rem', fontWeight: 600, border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', padding: '2px 7px' }}
                              title={`Client: ${clientName}`}>
                              <i className="bi bi-person-badge" style={{ fontSize: '0.6rem' }} />
                              {clientName}
                            </span>
                          )}
                          <StatusBadge status={getReportStatus(r)} />
                        </div>
                      </div>
                    </div>
                    <div className="d-flex flex-wrap gap-3">
                      <div>
                        <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>GMV</div>
                        <div className="fw-bold" style={{ fontSize: '0.92rem', color: 'var(--success)' }}>{fmt$(totalGmv, r.currency)}</div>
                      </div>
                      <div>
                        <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>ORDERS</div>
                        <div className="fw-bold" style={{ fontSize: '0.92rem' }}>{orders ? Number(orders).toLocaleString() : '—'}</div>
                      </div>
                      {r.kpis?.completedCollabs && (
                        <div>
                          <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 600 }}>COLLABS</div>
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
