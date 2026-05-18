import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useBrands } from '../../contexts/BrandsContext';
import {
  getAllReports, getReportsForTL, findPreviousReport, num,
  getWeeksForMonth, getAnchorDate,
  REPORT_STATUSES, getReportStatus, updateReportStatus, deleteReport,
} from '../../utils/reportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import WeeklyReportForm from './WeeklyReportForm';
import WeeklyReportView from './WeeklyReportView';
import ReportFiltersPopover from './ReportFiltersPopover';
import EditReportDatesModal from './EditReportDatesModal';
import { notifyReportApproved, notifyReportRejected, notifyReportSubmitted, notifyReportVerified } from '../../utils/reportNotifications';

function StatusBadge({ status, style }) {
  const cfg = REPORT_STATUSES[status] || REPORT_STATUSES.approved;
  return (
    <span className="badge rounded-pill d-inline-flex align-items-center gap-1"
      style={{ background: cfg.bg, color: cfg.color, fontSize: '0.62rem', ...style }}>
      <i className={`bi ${cfg.icon}`} />{cfg.label}
    </span>
  );
}

// Compact dollar formatter: $1.154M / $812K / $342
function fmtCompactDollars(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 1 : 3) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Tiny inline bar chart used in the stat cards
function Sparkbars({ values = [], color = 'var(--text-muted)', muted = 'var(--border-subtle)', highlightLast = false }) {
  if (!values.length) return <div style={{ height: 18, marginTop: 12 }} />;
  return (
    <div className="d-flex align-items-end gap-1" style={{ height: 18, marginTop: 12 }}>
      {values.map((v, i) => {
        const isLast = highlightLast && i === values.length - 1;
        return (
          <div key={i} style={{
            flex: 1, minWidth: 4, height: `${Math.max(8, v)}%`,
            background: isLast ? color : muted, borderRadius: 2,
          }} />
        );
      })}
    </div>
  );
}

// Light-card stat block (Reports / Brands / etc)
function StatCard({ icon, iconBg, iconColor, value, subtitle, label, trendDelta, bars, barColor }) {
  const sign = trendDelta != null && trendDelta !== 0
    ? (trendDelta > 0 ? `+${trendDelta}` : `${trendDelta}`)
    : null;
  return (
    <div className="rounded-3 h-100" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', padding: '14px 16px' }}>
      <div className="d-flex align-items-start justify-content-between mb-3">
        <div className="rounded-2 d-flex align-items-center justify-content-center"
          style={{ width: 30, height: 30, background: iconBg }}>
          <i className={`bi ${icon}`} style={{ color: iconColor, fontSize: '0.85rem' }} />
        </div>
        {sign && (
          <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
            style={{ background: trendDelta >= 0 ? '#f0fdf4' : '#fef2f2',
                     color:      trendDelta >= 0 ? '#15803d' : '#dc2626',
                     fontSize: '0.66rem', fontWeight: 600 }}>
            <i className={`bi bi-arrow-${trendDelta >= 0 ? 'up' : 'down'}-right`} />
            {sign}
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</div>
      <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
        {value} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>{subtitle}</span>
      </div>
      <Sparkbars values={bars || []} highlightLast color={barColor || '#94a3b8'} muted="#e2e8f0" />
    </div>
  );
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }

export default function AllWeeklyReportsPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const { brands } = useBrands();

  const [rawReports, setRawReports] = useState([]);
  const [loading, setLoading] = useState(true);
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

  // Month picker
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth());

  // Filters
  const [filterBrand, setFilterBrand] = useState('');
  const [filterClient, setFilterClient] = useState('');
  const [filterTeam, setFilterTeam] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterCreator, setFilterCreator] = useState('');
  const [filterWeek, setFilterWeek] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [viewReport, setViewReport] = useState(null);
  const [editDatesReport, setEditDatesReport] = useState(null);
  const [editReportId, setEditReportId] = useState(null);

  const loadReports = async () => {
    try {
      let data;
      if (userRole === 'tl') {
        // useBrands() already returns brands owned by this TL (role-scoped in v2)
        const brandIds = (brands || []).map((b) => b.id);
        data = await getReportsForTL(brandIds);
      } else {
        data = await getAllReports();
      }
      setRawReports(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadReports(); /* eslint-disable-next-line */ }, [currentUser.uid, userRole]);

  // Overwrite stored brandName with the CURRENT brand name so renames/switches propagate to report UI
  const reports = useMemo(() => {
    const nameById = new Map(brands.map(b => [b.id, b.brandName || b.name]));
    return rawReports.map(r => {
      const current = r.brandId ? nameById.get(r.brandId) : null;
      return current ? { ...r, brandName: current } : r;
    });
  }, [rawReports, brands]);

  // Map brandId → clientName (for client filter)
  const clientByBrandId = useMemo(() => {
    const m = new Map();
    brands.forEach(b => { if (b.clientName) m.set(b.id, b.clientName); });
    return m;
  }, [brands]);

  // Map brandId → ownerId (TL uid) for team filter
  const ownerByBrandId = useMemo(() => {
    const m = new Map();
    brands.forEach(b => { if (b.ownerId) m.set(b.id, { id: b.ownerId, name: b.ownerName || 'Team Lead' }); });
    return m;
  }, [brands]);

  // Anchor from earliest report
  const anchor = useMemo(() => getAnchorDate(reports), [reports]);

  // Weeks in selected calendar month, aligned to anchor
  const calWeeks = useMemo(() => getWeeksForMonth(calYear, calMonth, anchor), [calYear, calMonth, anchor]);

  // Filter options derived from data
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

  // Filtered reports
  const filtered = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    return reports.filter(r => {
      if (!r.weekStart) return false;
      if (!r.weekStart.startsWith(mk)) return false;
      if (filterBrand && r.brandName !== filterBrand) return false;
      if (filterClient && clientByBrandId.get(r.brandId) !== filterClient) return false;
      if (filterTeam && ownerByBrandId.get(r.brandId)?.id !== filterTeam) return false;
      if (filterSearch && !(r.brandName || '').toLowerCase().includes(filterSearch.toLowerCase())) return false;
      if (filterCreator && r.createdByName !== filterCreator) return false;
      if (filterWeek && String(r.week) !== filterWeek) return false;
      if (filterStatus && getReportStatus(r) !== filterStatus) return false;
      return true;
    }).sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || ''));
  }, [reports, calYear, calMonth, filterBrand, filterClient, clientByBrandId, filterTeam, ownerByBrandId, filterSearch, filterCreator, filterWeek, filterStatus]);

  // Grouped by brand
  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach(r => {
      const key = r.brandName || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    map.forEach((list) => list.sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || '')));
    return map;
  }, [filtered]);

  // Summary stats for the month + previous-period comparison + per-week mini bars
  const monthStats = useMemo(() => {
    let totalGmv = 0, totalOrders = 0, reportCount = filtered.length, brandSet = new Set();
    let pendingApproval = 0, approved = 0, pendingOverdue = 0;
    const now24h = Date.now() - 24 * 60 * 60 * 1000;
    filtered.forEach(r => {
      const p = r.overallPerformance || {};
      totalGmv += num(p.gmv);
      totalOrders += num(p.orders);
      brandSet.add(r.brandName);
      const s = getReportStatus(r);
      if (s === 'verified') {
        pendingApproval++;
        const ts = r.verifiedAt ? new Date(r.verifiedAt).getTime() : 0;
        if (ts && ts < now24h) pendingOverdue++;
      }
      if (s === 'approved') approved++;
    });

    // Previous-period stats (same calendar month previous)
    const prevDate = new Date(calYear, calMonth - 1, 1);
    const prevMk = monthKey(prevDate.getFullYear(), prevDate.getMonth());
    let prevGmv = 0, prevReports = 0; const prevBrands = new Set();
    reports.forEach(r => {
      if (!r.weekStart || !r.weekStart.startsWith(prevMk)) return;
      prevReports++;
      prevGmv += num(r.overallPerformance?.gmv);
      if (r.brandName) prevBrands.add(r.brandName);
    });
    const pct = (cur, prev) => prev > 0 ? ((cur - prev) / prev) * 100 : null;
    const gmvTrend     = pct(totalGmv, prevGmv);
    const reportsTrend = reportCount - prevReports;
    const brandsTrend  = brandSet.size - prevBrands.size;

    // Mini sparkline bars: GMV by week within the selected month
    const bars = (calWeeks || []).map(w => {
      const weekTotal = filtered
        .filter(r => String(r.week) === String(w.week))
        .reduce((s, r) => s + num(r.overallPerformance?.gmv), 0);
      return weekTotal;
    });
    const maxBar = Math.max(1, ...bars);
    const barPcts = bars.map(b => Math.round((b / maxBar) * 100));

    const approvalRate = reportCount > 0 ? Math.round((approved / reportCount) * 100) : 0;

    return { totalGmv, totalOrders, reportCount, brandCount: brandSet.size,
      pendingApproval, pendingOverdue, approved, approvalRate,
      gmvTrend, reportsTrend, brandsTrend, barPcts };
  }, [filtered, reports, calYear, calMonth, calWeeks]);

  // Live indicator
  const [syncedAt] = useState(() => new Date());
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSyncTick(x => x + 1), 60000);
    return () => clearInterval(t);
  }, []);
  const syncedAgo = (() => {
    const mins = Math.floor((Date.now() - syncedAt.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    return `${mins} min ago`;
  })();
  // touch to silence unused-var lint
  void syncTick;

  const hasFilters = filterBrand || filterClient || filterTeam || filterSearch || filterCreator || filterWeek || filterStatus;

  const clearAllFilters = () => {
    setFilterBrand(''); setFilterClient(''); setFilterTeam('');
    setFilterSearch(''); setFilterCreator(''); setFilterWeek(''); setFilterStatus('');
  };

  // Popover filter specs (everything except the inline search box)
  const popoverFilters = [
    { key: 'brand', label: 'Brand', value: filterBrand, setValue: setFilterBrand,
      options: brandOptions.map(b => ({ value: b, label: b })) },
    // Client filter — visible whenever any brand in the current
    // result set has a client_name set. Previously gated to boss/ol
    // only, but TLs and PCTLs equally benefit from grouping their
    // own brands by client. Keep the data-driven length check so we
    // don't show an empty dropdown.
    ...(clientOptions.length > 0
      ? [{ key: 'client', label: 'Client', value: filterClient, setValue: setFilterClient,
          options: clientOptions.map(c => ({ value: c, label: c })) }]
      : []),
    ...((userRole === 'boss' || userRole === 'ol') && teamOptions.length > 0
      ? [{ key: 'team', label: 'Team', value: filterTeam, setValue: setFilterTeam,
          options: teamOptions.map(t => ({ value: t.id, label: `Team ${t.name}` })) }]
      : []),
    { key: 'reporter', label: 'Reporter', value: filterCreator, setValue: setFilterCreator,
      options: creatorOptions.map(c => ({ value: c, label: c })) },
    { key: 'week', label: 'Week', value: filterWeek, setValue: setFilterWeek,
      options: calWeeks.map(w => ({ value: String(w.week), label: `Week ${w.week}` })) },
    { key: 'status', label: 'Status', value: filterStatus, setValue: setFilterStatus,
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'submitted', label: 'Submitted' },
        { value: 'verified', label: 'Verified' },
        { value: 'approved', label: 'Approved' },
      ] },
  ];

  // Month navigation
  const prevMonth = () => {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11); }
    else setCalMonth(m => m - 1);
    setFilterWeek('');
  };
  const nextMonth = () => {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0); }
    else setCalMonth(m => m + 1);
    setFilterWeek('');
  };

  /* ── OL acting as APC: submit a draft report ──────────────────────────── */
  // When the APC is unavailable, OL can move a draft straight to "submitted"
  // so the workflow keeps moving. Audit trail records OL as the submitter.
  const handleSubmitAsApc = async (report) => {
    if (!window.confirm(`Submit this draft (${report.weekLabel}) on the APC's behalf? It will move to "submitted" for TL verification.`)) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'submitted', {
        submittedBy: currentUser.uid, submittedByName: senderName, submittedAt: new Date().toISOString(),
        submittedActingAs: 'apc',
        rejectionNote: null,
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'submitted', rejectionNote: null } : r));
      setViewReport(r => r ? { ...r, status: 'submitted', rejectionNote: null } : r);
      notifyReportSubmitted({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly' });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  /* ── OL acting as TL: verify a submitted report ───────────────────────── */
  const handleVerifyAsTl = async (report) => {
    if (!window.confirm(`Verify this report (${report.weekLabel}) on the TL's behalf? It will move to "verified" for OL approval.`)) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'verified', {
        verifiedBy: currentUser.uid, verifiedByName: senderName, verifiedAt: new Date().toISOString(),
        verifiedActingAs: 'tl',
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'verified' } : r));
      setViewReport(r => r ? { ...r, status: 'verified' } : r);
      notifyReportVerified({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly' });
    } catch (err) { alert('Failed: ' + err.message); }
  };

  /* ── Approve / Reject (OL only) ────────────────────────────────────────── */
  const handleApprove = async (report) => {
    if (!window.confirm(`Approve this report (${report.weekLabel})? This is the final approval.`)) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'approved', {
        approvedBy: currentUser.uid,
        approvedByName: senderName,
        approvedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'approved' } : r));
      setViewReport(r => r ? { ...r, status: 'approved' } : r);
      notifyReportApproved({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly' });
    } catch (err) { alert('Failed to approve: ' + err.message); }
  };

  const handleRejectToTL = async (report) => {
    const note = window.prompt('Reason for returning to Team Lead (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'submitted', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid,
        rejectedByName: senderName,
        rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly', toRole: 'tl', note: note.trim() });
    } catch (err) { alert('Failed to reject: ' + err.message); }
  };

  /* ── Reopen approved reports (OL only) ─────────────────────────────────── */
  const handleReopenToAPC = async (report) => {
    const note = window.prompt('Reason for sending this approved report back to APC (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'draft', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid,
        rejectedByName: senderName,
        rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'draft', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'draft', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly', toRole: 'apc', note: note.trim(), isReopen: true });
    } catch (err) { alert('Failed to reopen: ' + err.message); }
  };

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

  const handleDeleteReport = async (report) => {
    if (!window.confirm(`Delete this report for ${report.brandName} (${report.weekLabel})? This cannot be undone.`)) return;
    try {
      await deleteReport(report.id);
      setRawReports(prev => prev.filter(r => r.id !== report.id));
      setViewReport(null);
    } catch (err) { alert('Failed to delete: ' + err.message); }
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} weekly report${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const failures = [];
      await Promise.all(ids.map((id) => deleteReport(id).catch((err) => failures.push({ id, msg: err.message }))));
      const removedIds = new Set(ids.filter((id) => !failures.some((f) => f.id === id)));
      setRawReports((prev) => prev.filter((r) => !removedIds.has(r.id)));
      clearSelected();
      if (failures.length) alert(`${failures.length} of ${ids.length} could not be deleted:\n` + failures.map((f) => f.msg).join('\n'));
    } finally { setBulkBusy(false); }
  };

  const handleReopenToTL = async (report) => {
    const note = window.prompt('Reason for sending this approved report back to Team Lead (required):');
    if (!note || !note.trim()) return;
    try {
      const senderName = currentUser.displayName || 'OL';
      await updateReportStatus(report.id, 'submitted', {
        rejectionNote: note.trim(),
        rejectedBy: currentUser.uid,
        rejectedByName: senderName,
        rejectedAt: new Date().toISOString(),
      });
      setRawReports(prev => prev.map(r => r.id === report.id ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r));
      setViewReport(r => r ? { ...r, status: 'submitted', rejectionNote: note.trim() } : r);
      notifyReportRejected({ report, sender: { uid: currentUser.uid, name: senderName }, type: 'weekly', toRole: 'tl', note: note.trim(), isReopen: true });
    } catch (err) { alert('Failed to reopen: ' + err.message); }
  };

  /* ── Edit view ──────────────────────────────────────────────────────────── */
  if (editReportId) {
    return (
      <WeeklyReportForm
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

  /* ── Detail view ────────────────────────────────────────────────────────── */
  if (viewReport) {
    const brandReports = reports.filter(r => r.brandId === viewReport.brandId);
    const prev = findPreviousReport(brandReports, viewReport);
    const rStatus = getReportStatus(viewReport);
    // OL can edit any non-approved report. A TL can also open the
    // editor for their team's submitted/verified reports — needed so
    // they can manage (toggle / delete) the custom sections their
    // APCs created. The list is already scoped to the TL's team.
    const canEdit = (userRole === 'ol' && rStatus !== 'approved')
      || (userRole === 'tl' && (rStatus === 'submitted' || rStatus === 'verified'));
    const canEditDates = userRole === 'ol' || userRole === 'boss';
    const canSubmitAsApc = userRole === 'ol' && rStatus === 'draft';
    const canVerifyAsTl = userRole === 'ol' && rStatus === 'submitted';
    const canApprove = userRole === 'ol' && rStatus === 'verified';
    const canReject = userRole === 'ol' && (rStatus === 'verified' || rStatus === 'submitted');
    const canReopen = userRole === 'ol' && rStatus === 'approved';
    const canDelete = userRole === 'boss' || userRole === 'ol';
    return (
      <div>
        <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
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
                title="Change just this report's start/end dates without touching siblings">
                <i className="bi bi-calendar-event" /> Edit Dates
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
              <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.78rem' }}
                onClick={() => handleRejectToTL(viewReport)}>
                <i className="bi bi-arrow-counterclockwise" /> Return to TL
              </button>
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
                onClick={() => handleDeleteReport(viewReport)}
                title="Permanently delete this report">
                <i className="bi bi-trash3" /> Delete
              </button>
            )}
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
        <WeeklyReportView report={viewReport} previousReport={prev} allReports={brandReports} />

        {editDatesReport && (
          <EditReportDatesModal
            report={editDatesReport}
            type="weekly"
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
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>Weekly Reports</h4>
          <div className="d-flex align-items-center gap-2 flex-wrap" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            <span>{userRole === 'tl' ? 'Reports from your team' : 'All brand reports across the organization'}</span>
            <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
              style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.72rem', fontWeight: 600 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
              Live · synced {syncedAgo}
            </span>
          </div>
        </div>
      </div>

      {/* Stat cards row */}
      <div className="row g-3 mb-4">
        {/* Total GMV — dark prominent card */}
        <div className="col-12 col-md-6 col-xl">
          <div className="rounded-3 h-100 position-relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg,#0a0a0a,#1a1a1f)', color: '#fff', padding: '14px 16px' }}>
            <div className="d-flex align-items-start justify-content-between mb-3">
              <div className="rounded-2 d-flex align-items-center justify-content-center"
                style={{ width: 30, height: 30, background: 'rgba(255,255,255,0.1)' }}>
                <i className="bi bi-currency-dollar" style={{ fontSize: '0.8rem' }} />
              </div>
              <div className="d-flex align-items-center gap-2">
                {monthStats.gmvTrend != null && (
                  <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                    style={{ background: monthStats.gmvTrend >= 0 ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)',
                             color: monthStats.gmvTrend >= 0 ? '#86efac' : '#fca5a5', fontSize: '0.66rem', fontWeight: 600 }}>
                    <i className={`bi bi-arrow-${monthStats.gmvTrend >= 0 ? 'up' : 'down'}-right`} />
                    {monthStats.gmvTrend >= 0 ? '+' : ''}{monthStats.gmvTrend.toFixed(1)}%
                  </span>
                )}
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
              </div>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Total GMV this period</div>
            <div className="fw-bold" style={{ fontSize: '1.6rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2 }}>
              {fmtCompactDollars(monthStats.totalGmv)}
            </div>
            <Sparkbars values={monthStats.barPcts} highlightLast color="rgba(255,255,255,0.85)" muted="rgba(255,255,255,0.18)" />
          </div>
        </div>

        {/* Reports submitted */}
        <div className="col-6 col-xl">
          <StatCard
            icon="bi-file-earmark-text" iconBg="#eff6ff" iconColor="#3b82f6"
            value={monthStats.reportCount} subtitle="this period" label="Reports submitted"
            trendDelta={monthStats.reportsTrend} bars={monthStats.barPcts} barColor="#3b82f6"
          />
        </div>

        {/* Active brands */}
        <div className="col-6 col-xl">
          <StatCard
            icon="bi-grid" iconBg="#f0fdf4" iconColor="#10b981"
            value={monthStats.brandCount} subtitle="tracked" label="Active brands"
            trendDelta={monthStats.brandsTrend} bars={monthStats.barPcts} barColor="#10b981"
          />
        </div>

        {/* Approved */}
        <div className="col-6 col-xl">
          <button className="rounded-3 h-100 w-100 text-start p-0 border-0 bg-transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => setFilterStatus(filterStatus === 'approved' ? '' : 'approved')}
            title="Click to filter approved reports">
            <div className="rounded-3 h-100 p-3" style={{ background: 'var(--surface-1)', border: filterStatus === 'approved' ? '1.5px solid #16a34a' : '1px solid #e2e8f0' }}>
              <div className="d-flex align-items-start justify-content-between mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center"
                  style={{ width: 30, height: 30, background: 'var(--success-soft)' }}>
                  <i className="bi bi-check2" style={{ color: 'var(--success)', fontSize: '0.85rem' }} />
                </div>
                <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                  style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.66rem', fontWeight: 600 }}>
                  {monthStats.approvalRate}% rate
                </span>
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Approved</div>
              <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
                {monthStats.approved} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>of {monthStats.reportCount}</span>
              </div>
              <Sparkbars values={monthStats.barPcts} highlightLast color="#16a34a" muted="#e2e8f0" />
            </div>
          </button>
        </div>

        {/* Pending approval */}
        <div className="col-6 col-xl">
          <button className="rounded-3 h-100 w-100 text-start p-0 border-0 bg-transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => setFilterStatus(filterStatus === 'verified' ? '' : 'verified')}
            title="Click to filter pending approval">
            <div className="rounded-3 h-100 p-3" style={{ background: 'var(--surface-1)', border: filterStatus === 'verified' ? '1.5px solid #ea580c' : '1px solid #e2e8f0' }}>
              <div className="d-flex align-items-start justify-content-between mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center"
                  style={{ width: 30, height: 30, background: '#fff7ed' }}>
                  <i className="bi bi-hourglass-split" style={{ color: 'var(--warning)', fontSize: '0.85rem' }} />
                </div>
                {monthStats.pendingOverdue > 0 && (
                  <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                    style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.66rem', fontWeight: 600 }}>
                    <i className="bi bi-arrow-up-right" />
                    {monthStats.pendingOverdue} over 24h
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Pending approval</div>
              <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
                {monthStats.pendingApproval} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>awaiting</span>
              </div>
              <Sparkbars values={monthStats.barPcts} highlightLast color="#ea580c" muted="#e2e8f0" />
            </div>
          </button>
        </div>
      </div>

      {/* Month navigator + filters — sleek inline pill row */}
      <div className="rounded-3 mb-4" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', padding: '10px 12px' }}>
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <button className="btn btn-sm btn-light border d-inline-flex align-items-center justify-content-center rounded-circle" onClick={prevMonth}
            style={{ width: 30, height: 30, padding: 0 }}>
            <i className="bi bi-chevron-left" style={{ fontSize: '0.78rem' }} />
          </button>
          <div className="d-inline-flex align-items-center gap-2 rounded-3 px-3 py-1"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            <i className="bi bi-calendar3" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} />
            {MONTH_NAMES[calMonth]} {calYear}
          </div>
          <button className="btn btn-sm btn-light border d-inline-flex align-items-center justify-content-center rounded-circle" onClick={nextMonth}
            style={{ width: 30, height: 30, padding: 0 }}>
            <i className="bi bi-chevron-right" style={{ fontSize: '0.78rem' }} />
          </button>
          <button className="btn btn-sm btn-light border rounded-3 px-3"
            style={{ fontSize: '0.78rem', fontWeight: 500 }}
            onClick={() => { setCalYear(now.getFullYear()); setCalMonth(now.getMonth()); setFilterWeek(''); }}>
            Today
          </button>

          <div className="position-relative" style={{ flex: '1 1 240px', minWidth: 200, maxWidth: 360 }}>
            <i className="bi bi-search position-absolute text-muted" style={{ left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', pointerEvents: 'none' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search brand…"
              style={{ paddingLeft: 32, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}
              value={filterSearch} onChange={e => setFilterSearch(e.target.value)} />
          </div>

          {/* Status filter pills */}
          <div className="d-inline-flex gap-1">
            {[
              { v: '', label: 'All' },
              { v: 'approved', label: 'Approved' },
              { v: 'verified', label: 'Pending' },
              { v: 'submitted', label: 'Needs Review' },
            ].map(opt => {
              const active = filterStatus === opt.v;
              return (
                <button key={opt.v} type="button"
                  onClick={() => setFilterStatus(opt.v)}
                  className="btn btn-sm rounded-3 px-3 d-inline-flex align-items-center gap-1"
                  style={{
                    fontSize: '0.78rem', fontWeight: 600,
                    background: active ? 'var(--accent)'      : 'var(--surface-1)',
                    color:      active ? 'var(--on-accent)'   : 'var(--text-secondary)',
                    border:     active ? '1px solid var(--accent)' : '1px solid var(--border-subtle)',
                  }}>
                  {opt.v === '' && <i className="bi bi-funnel" style={{ fontSize: '0.72rem' }} />}
                  {opt.label}
                </button>
              );
            })}
          </div>

          <ReportFiltersPopover filters={popoverFilters} onClear={clearAllFilters} />

          {hasFilters && (
            <button className="btn btn-sm btn-light border d-inline-flex align-items-center gap-1 rounded-3"
              style={{ fontSize: '0.74rem' }}
              onClick={clearAllFilters}>
              <i className="bi bi-x-circle" /> Clear
            </button>
          )}

          <span className="ms-auto text-muted" style={{ fontSize: '0.78rem' }}>
            {filtered.length} reports
          </span>
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

      {/* Results — polished card grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-5 rounded-3" style={{ background: 'var(--surface-1)', border: '1px dashed #e2e8f0' }}>
          <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2.5rem', color: '#cbd5e1' }} />
          <p className="text-muted mt-3 mb-0">No reports for {MONTH_NAMES[calMonth]} {calYear}.</p>
        </div>
      ) : (
        <div className="row g-3">
          {filtered.map(r => (
            <ReportCard
              key={r.id} r={r}
              brandReports={reports.filter(rr => rr.brandId === r.brandId)}
              clientName={clientByBrandId.get(r.brandId)}
              onClick={() => setViewReport(r)}
              selectable={canBulkDelete}
              isSelected={selected.has(r.id)}
              onToggleSelect={() => toggleSelected(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Polished report card (used in the redesigned dashboard) ─────────────────
function ReportCard({ r, brandReports, clientName, onClick, selectable = false, isSelected = false, onToggleSelect }) {
  const prev = findPreviousReport(brandReports, r);
  const perf = r.overallPerformance || {};
  const prevPerf = prev?.overallPerformance || {};
  const gmv      = num(perf.gmv);
  const orders   = num(perf.orders);
  const roi      = num(perf.roi);
  const videos   = num(perf.videosPosted);
  const gmvChange = num(prevPerf.gmv) ? (((gmv - num(prevPerf.gmv)) / num(prevPerf.gmv)) * 100) : null;
  const aov = orders > 0 ? gmv / orders : 0;
  const sym = currencySymbol(r.currency || DEFAULT_CURRENCY);
  const roiNote = roi <= 0 ? 'organic' : roi < 1 ? 'paid mix' : roi < 2 ? 'paid mix' : 'strong';
  const status  = getReportStatus(r);
  const brandName = r.brandName || 'Unknown';
  const initials  = brandName.slice(0, 2).toUpperCase();
  const avatarColor = avatarColorFor(brandName);

  // Status pill style — match the screenshot's lavender "APPROVED"
  const statusPillStyle = (() => {
    if (status === 'approved')  return { bg: '#ede9fe', color: '#6d28d9' };
    if (status === 'verified')  return { bg: '#ffedd5', color: '#c2410c' };
    if (status === 'submitted') return { bg: '#dbeafe', color: 'var(--info)' };
    return { bg: '#f1f5f9', color: 'var(--text-secondary)' };
  })();

  // Mini sparkline of brand's recent GMV (last 6 weeks ending at this report)
  const seriesBars = (() => {
    const sorted = [...brandReports].filter(x => x.weekStart).sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || ''));
    const idx = sorted.findIndex(x => x.id === r.id);
    if (idx === -1) return [];
    const slice = sorted.slice(Math.max(0, idx - 5), idx + 1);
    const vals = slice.map(x => num(x.overallPerformance?.gmv));
    const max = Math.max(1, ...vals);
    return vals.map(v => Math.round((v / max) * 100));
  })();

  return (
    <div className="col-12 col-md-6 col-xl-4">
      <div className="rounded-3 h-100 position-relative" style={{
        background: 'var(--surface-1)',
        border: isSelected ? '2px solid #ef4444' : '1px solid #e2e8f0',
        cursor: 'pointer',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
      }}
        onClick={onClick}
        onMouseEnter={e => {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 8px 20px rgba(15,23,42,0.08)';
          if (!isSelected) e.currentTarget.style.borderColor = '#cbd5e1';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.transform = 'none';
          e.currentTarget.style.boxShadow = 'none';
          if (!isSelected) e.currentTarget.style.borderColor = 'var(--border-subtle)';
        }}>
        {selectable && (
          <label
            className="position-absolute d-flex align-items-center justify-content-center"
            style={{
              top: 8, left: 8, width: 24, height: 24,
              background: isSelected ? '#ef4444' : 'rgba(255,255,255,0.95)',
              border: `1.5px solid ${isSelected ? '#ef4444' : '#cbd5e1'}`,
              borderRadius: 6, cursor: 'pointer', zIndex: 2,
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
            }}
            onClick={(e) => { e.stopPropagation(); onToggleSelect && onToggleSelect(); }}
            title={isSelected ? 'Unselect' : 'Select'}
          >
            {isSelected && <i className="bi bi-check-lg text-white" style={{ fontSize: '0.95rem', lineHeight: 1 }} />}
          </label>
        )}
        {/* Header row — avatar, brand, "by …", status pill, chevron */}
        <div className="d-flex align-items-start gap-2 p-3 pb-2" style={{ paddingLeft: selectable ? 40 : undefined }}>
          <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
            style={{ width: 36, height: 36, fontSize: '0.78rem', background: avatarColor }}>
            {initials}
          </div>
          <div className="flex-grow-1" style={{ minWidth: 0 }}>
            <div className="fw-bold text-truncate" style={{ fontSize: '0.95rem', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{brandName}</div>
            <div className="text-muted text-truncate" style={{ fontSize: '0.7rem' }}>
              by {r.createdByName || '—'}
              {clientName && <span> · {clientName}</span>}
            </div>
          </div>
          <span className="rounded-pill text-uppercase fw-bold flex-shrink-0"
            style={{ background: statusPillStyle.bg, color: statusPillStyle.color,
                     fontSize: '0.6rem', letterSpacing: '0.05em', padding: '4px 10px' }}>
            {status}
          </span>
          <i className="bi bi-chevron-right text-muted flex-shrink-0" style={{ fontSize: '0.75rem', marginTop: 4 }} />
        </div>

        {/* Week + platform line */}
        <div className="d-flex align-items-center gap-2 px-3 pb-2 pt-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <span className="fw-semibold" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{r.weekLabel || `Week ${r.week}`}</span>
          {(r.year || (r.weekStart && r.weekStart.length >= 4)) && (
            <span className="text-muted" style={{ fontSize: '0.72rem' }}>
              · {r.year || r.weekStart.slice(0, 4)}
            </span>
          )}
          <span className="ms-auto rounded-pill d-inline-flex align-items-center gap-1"
            style={{ background: 'var(--success-soft)', color: '#166534', fontSize: '0.62rem', fontWeight: 600, padding: '3px 8px' }}>
            <i className="bi bi-tiktok" style={{ fontSize: '0.62rem' }} />
            TikTok
          </span>
        </div>

        {/* Stats row */}
        <div className="px-3 pb-2 pt-1">
          <div className="d-flex justify-content-between gap-2">
            <CardStat label="GMV" value={sym + gmv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              note={gmvChange != null
                ? `${gmvChange >= 0 ? '+' : ''}${gmvChange.toFixed(1)}%`
                : null}
              noteColor={gmvChange != null ? (gmvChange >= 0 ? '#16a34a' : '#dc2626') : '#94a3b8'} />
            <CardStat label="ORDERS" value={orders.toLocaleString()} note={aov > 0 ? `${sym}${aov.toFixed(0)} AOV` : null} />
            <CardStat label="ROAS" value={roi.toFixed(2)} note={roiNote}
              noteColor={roi >= 2 ? '#16a34a' : roi <= 0 ? '#94a3b8' : '#64748b'} />
            <CardStat label="VIDEOS" value={videos.toLocaleString()} note={videos > 0 ? `${Math.max(1, Math.round(videos * 0.05))} viral` : null} />
          </div>
        </div>

        {/* Sparkline footer (vs prev week) */}
        {gmvChange != null && seriesBars.length > 1 && (
          <div className="d-flex align-items-center gap-2 px-3 py-2"
            style={{ borderTop: '1px solid var(--border-subtle)', background: '#fafafa', borderRadius: '0 0 12px 12px' }}>
            <span className="text-muted" style={{ fontSize: '0.7rem' }}>vs prev week</span>
            <div className="flex-grow-1">
              <Sparkbars values={seriesBars} highlightLast color={gmvChange >= 0 ? '#16a34a' : '#dc2626'} muted="#e2e8f0" />
            </div>
            <span className="d-inline-flex align-items-center gap-1 fw-bold" style={{ fontSize: '0.72rem',
                color: gmvChange >= 0 ? '#16a34a' : '#dc2626' }}>
              <i className={`bi bi-arrow-${gmvChange >= 0 ? 'up' : 'down'}-right`} />
              {gmvChange >= 0 ? '+' : ''}{gmvChange.toFixed(1)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CardStat({ label, value, note, noteColor }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em' }}>{label}</div>
      <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: 1.1, marginTop: 2 }}>{value}</div>
      {note && (
        <div style={{ fontSize: '0.65rem', color: noteColor || '#64748b', fontWeight: 600, marginTop: 2 }}>{note}</div>
      )}
    </div>
  );
}

function avatarColorFor(name) {
  const palette = ['#7c3aed', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#8b5cf6'];
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

