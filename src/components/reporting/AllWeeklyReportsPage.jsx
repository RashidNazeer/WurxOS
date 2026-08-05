import React, { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useBrands } from '../../contexts/BrandsContext';
import { useReportsRealtime } from '../../lib/useReportsRealtime';
import {
  getAllReports, getReportsForTL, findPreviousReport, num,
  getWeeksForMonth, getAnchorDate,
  REPORT_STATUSES, getReportStatus, updateReportStatus, deleteReport,
} from '../../utils/reportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import { deductPrompt } from '../../lib/tlPerfApi';
import { formatPctChange, pctChange, pctChangeDir } from '../../utils/formatPctChange';
import WeeklyReportForm from './WeeklyReportForm';
import ReportActionsMenu from './ReportActionsMenu';
import WeeklyReportView from './WeeklyReportView';
import ReportPeriodStrip from './ReportPeriodStrip';
import ReportRatingBar from './ReportRatingBar';
import ReportFiltersPopover from './ReportFiltersPopover';
import EditReportDatesModal from './EditReportDatesModal';
import { notifyReportApproved, notifyReportRejected, notifyReportSubmitted, notifyReportVerified } from '../../utils/reportNotifications';
import { remindReports } from '../../lib/reportsApi';

function StatusBadge({ status, style }) {
  const cfg = REPORT_STATUSES[status] || REPORT_STATUSES.approved;
  return (
    <span className="badge rounded-pill d-inline-flex align-items-center gap-1"
      style={{ background: cfg.bg, color: cfg.color, fontSize: '0.62rem', ...style }}>
      <i className={`bi ${cfg.icon}`} />{cfg.label}
    </span>
  );
}

// Compact money formatter: £1.154M / £812K / £342. Symbol is passed in (the
// brand-resolved currency of the reports in scope) rather than hardcoded.
function fmtCompactDollars(n, sym = '$') {
  const v = Number(n) || 0;
  if (v >= 1e6) return sym + (v / 1e6).toFixed(v >= 1e7 ? 1 : 3) + 'M';
  if (v >= 1e3) return sym + (v / 1e3).toFixed(1) + 'K';
  return sym + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
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
            style={{ background: trendDelta >= 0 ? 'var(--success-soft)' : 'var(--danger-soft)',
                     color:      trendDelta >= 0 ? 'var(--success)' : 'var(--danger)',
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
      <Sparkbars values={bars || []} highlightLast color={barColor || 'var(--text-muted)'} muted="var(--border-subtle)" />
    </div>
  );
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }

export default function AllWeeklyReportsPage() {
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
  const canNotify = userRole === 'boss' || userRole === 'ol';
  // Reminder toast + which stat card's notify is in flight ('draft' | 'submitted').
  const [flash, setFlash] = useState('');
  const [notifyBusy, setNotifyBusy] = useState('');
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
  const [sortBy, setSortBy] = useState('newest');

  const [viewReport, setViewReport] = useState(null);
  const [editDatesReport, setEditDatesReport] = useState(null);
  const [editReportId, setEditReportId] = useState(null);
  // Report-view actions (highlighter / exports), lifted up so they
  // sit in the sticky bar's "Other options" menu while reviewing.
  const [reportActions, setReportActions] = useState(null);

  // Cached load: on revisit the list paints INSTANTLY from cache (no spinner),
  // while a background refetch runs to keep it fresh — so it self-heals even if
  // a report was created/edited from another page. Optimistic status mutations
  // still patch `rawReports` locally below; the query only supplies the
  // initial/refreshed data. (TL branch keys by brand list — the query re-runs
  // when this TL's owned brands change.)
  const isTL = userRole === 'tl';
  const brandIds = useMemo(() => (brands || []).map((b) => b.id).sort(), [brands]);
  const {
    data: queryReports, isLoading, error: queryError, refetch,
  } = useQuery({
    queryKey: ['reports-list', 'weekly', 'all', userRole, currentUser?.uid, isTL ? brandIds.join(',') : ''],
    queryFn: () => (isTL ? getReportsForTL(brandIds) : getAllReports()),
    enabled: !!currentUser?.uid && !!userRole && (!isTL || !brandsLoading),
    staleTime: 30_000,
    refetchOnMount: true,
  });
  useEffect(() => { if (queryReports) setRawReports(queryReports); }, [queryReports]);
  useEffect(() => { if (queryError) setError(queryError.message || 'Failed to load reports'); }, [queryError]);
  // Spinner only on the very first load (no cached data yet); revisits skip it.
  const loading = (isLoading || (isTL && brandsLoading)) && rawReports.length === 0;
  const loadReports = refetch; // legacy callers below just want a refresh

  // Live-sync: when any report changes (status, new, deleted) — by anyone —
  // the list auto-refreshes in the background, no manual refresh needed.
  useReportsRealtime(refetch, { enabled: !!currentUser?.uid });

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

  // Week filter options — derived DYNAMICALLY from the reports that actually
  // exist in the selected month (so it never shows phantom weeks and grows on
  // its own as new weeks are reported), sorted DESCENDING (newest week first).
  // Falls back to the calendar weeks for the month if no reports yet.
  const weekOptions = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    const weeks = new Set();
    reports.forEach(r => {
      if (r.weekStart && r.weekStart.startsWith(mk) && r.week != null) weeks.add(Number(r.week));
    });
    if (weeks.size === 0) calWeeks.forEach(w => weeks.add(Number(w.week)));
    return [...weeks].sort((a, b) => b - a).map(w => ({ value: String(w), label: `Week ${w}` }));
  }, [reports, calYear, calMonth, calWeeks]);

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
    }).sort((a, b) => {
      switch (sortBy) {
        case 'oldest':   return (a.weekStart || '').localeCompare(b.weekStart || '');
        case 'gmv_desc': return num(b.overallPerformance?.gmv) - num(a.overallPerformance?.gmv);
        case 'gmv_asc':  return num(a.overallPerformance?.gmv) - num(b.overallPerformance?.gmv);
        case 'brand_az': return (a.brandName || '').localeCompare(b.brandName || '')
                             || (b.weekStart || '').localeCompare(a.weekStart || '');
        case 'newest':
        default:         return (b.weekStart || '').localeCompare(a.weekStart || '');
      }
    });
  }, [reports, calYear, calMonth, filterBrand, filterClient, clientByBrandId, filterTeam, ownerByBrandId, filterSearch, filterCreator, filterWeek, filterStatus, sortBy]);

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

    // Currency symbol for the aggregate total: use the reports' shared currency
    // when they all match (the common case, incl. a single-brand filter); fall
    // back to the default only when the scope genuinely mixes currencies.
    const curSet = new Set(filtered.map(r => r.currency || DEFAULT_CURRENCY));
    const currency = curSet.size === 1 ? [...curSet][0] : DEFAULT_CURRENCY;

    return { totalGmv, totalOrders, reportCount, brandCount: brandSet.size,
      pendingApproval, pendingOverdue, approved, approvalRate,
      gmvTrend, reportsTrend, brandsTrend, barPcts, currency };
  }, [filtered, reports, calYear, calMonth, calWeeks]);

  // Status breakdown over the month scope but INDEPENDENT of the active status
  // filter, so the Draft / Submitted / Pending / Approved cards always show the
  // true month counts and behave as filter toggles (clicking one never zeroes
  // out the others). Honours the brand/team/week/search/reporter filters.
  const statusScope = useMemo(() => {
    const mk = monthKey(calYear, calMonth);
    return reports.filter(r => {
      if (!r.weekStart || !r.weekStart.startsWith(mk)) return false;
      if (filterBrand && r.brandName !== filterBrand) return false;
      if (filterClient && clientByBrandId.get(r.brandId) !== filterClient) return false;
      if (filterTeam && ownerByBrandId.get(r.brandId)?.id !== filterTeam) return false;
      if (filterSearch && !(r.brandName || '').toLowerCase().includes(filterSearch.toLowerCase())) return false;
      if (filterCreator && r.createdByName !== filterCreator) return false;
      if (filterWeek && String(r.week) !== filterWeek) return false;
      return true;
    });
  }, [reports, calYear, calMonth, filterBrand, filterClient, clientByBrandId, filterTeam, ownerByBrandId, filterSearch, filterCreator, filterWeek]);

  const statusStats = useMemo(() => {
    const c = { draft: 0, submitted: 0, verified: 0, approved: 0, pendingOverdue: 0, total: statusScope.length };
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    statusScope.forEach(r => {
      const s = getReportStatus(r);
      if (s === 'draft' || s === 'submitted' || s === 'verified' || s === 'approved') c[s]++;
      if (s === 'verified' && r.verifiedAt) {
        const ts = new Date(r.verifiedAt).getTime();
        if (ts && ts < cutoff) c.pendingOverdue++;
      }
    });
    c.approvalRate = c.total > 0 ? Math.round((c.approved / c.total) * 100) : 0;
    return c;
  }, [statusScope]);

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

  // OL/Boss fires a reminder from the Draft / Submitted card: draft → nudge the
  // APC authors to submit; submitted → nudge the TLs to verify. Scoped to the
  // reports in view (statusScope); the server re-checks each report's status.
  const handleRemind = async (kind) => {
    const targets = statusScope.filter(r => getReportStatus(r) === kind);
    if (!targets.length) return;
    const who  = kind === 'draft' ? 'APC' : 'Team Lead';
    const verb = kind === 'draft' ? 'submit' : 'verify';
    if (!window.confirm(`Send a reminder to the ${who}s to ${verb} ${targets.length} ${kind} report${targets.length === 1 ? '' : 's'}?`)) return;
    setNotifyBusy(kind);
    try {
      const res = await remindReports(targets.map(r => r.id));
      const n = res?.sent ?? 0;
      setFlash(n > 0
        ? `Reminder sent to ${n} ${who}${n === 1 ? '' : 's'}.`
        : `No active ${who} to notify for those reports.`);
      setTimeout(() => setFlash(''), 4000);
    } catch (e) {
      setFlash('Failed to send reminders: ' + (e.message || 'unknown'));
      setTimeout(() => setFlash(''), 5000);
    } finally { setNotifyBusy(''); }
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
      options: weekOptions },
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
      try { await deductPrompt(report.id); } catch { /* deduction is best-effort; the return already happened */ }
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
      try { await deductPrompt(report.id); } catch { /* deduction is best-effort */ }
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
        {/* Sticky action bar — stays pinned while reviewing a long
            report so the OL never has to scroll back up for actions. */}
        <div style={{
            position: 'sticky', top: 'var(--topbar-h, 68px)', zIndex: 10,
            background: 'var(--surface-0)',
            borderBottom: '1px solid var(--border-subtle)',
            padding: '12px 28px 8px', margin: '0 -28px 10px',
          }}>
          <div className="d-flex align-items-center justify-content-between flex-wrap gap-2">
          <div className="d-flex align-items-center gap-2" style={{ minWidth: 0 }}>
            <button className="btn btn-sm btn-link text-muted p-0 flex-shrink-0" onClick={() => setViewReport(null)}>
              <i className="bi bi-arrow-left me-1" /> Back to all reports
            </button>
            <span className="text-muted flex-shrink-0" aria-hidden="true">·</span>
            <span className="fw-bold text-truncate" style={{ fontSize: '0.92rem', color: 'var(--text-primary)' }} title={viewReport.brandName}>{viewReport.brandName}</span>
          </div>
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
                style={{ borderRadius: 8, fontSize: '0.78rem', background: 'var(--success)', color: 'white', border: 'none' }}
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
            {/* Most-used report actions as quick icon buttons. */}
            {reportActions && (
              <>
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center"
                  style={{ borderRadius: 8, fontSize: '0.9rem', color: reportActions.highlighterActive ? 'var(--warning)' : undefined, borderColor: reportActions.highlighterActive ? 'var(--warning)' : undefined }}
                  onClick={reportActions.onToggleHighlighter}
                  title={reportActions.highlighterActive ? 'Highlighter on — click to stop' : 'Highlighter'}>
                  <i className="bi bi-highlighter" />
                </button>
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center"
                  style={{ borderRadius: 8, fontSize: '0.9rem' }}
                  onClick={reportActions.onExportPdf} disabled={reportActions.pdfBusy}
                  title={reportActions.pdfBusy ? 'Exporting PDF…' : 'Export PDF'}>
                  <i className={`bi ${reportActions.pdfBusy ? 'bi-hourglass-split' : 'bi-file-earmark-pdf'}`} />
                </button>
              </>
            )}
            {/* Less-used / destructive actions tucked into the menu. */}
            <ReportActionsMenu actions={reportActions} hidePrimaryExports
              extraItems={[
                canSubmitAsApc && { key: 'submit', label: 'Submit as APC', icon: 'bi-send-fill', iconColor: 'var(--info)', onClick: () => handleSubmitAsApc(viewReport) },
                canDelete && { key: 'delete', label: 'Delete report', icon: 'bi-trash3', iconColor: 'var(--danger)', danger: true, onClick: () => handleDeleteReport(viewReport) },
              ]} />
          </div>
          </div>
          <ReportPeriodStrip reports={brandReports} currentId={viewReport.id} onSelect={setViewReport} type="weekly" />
        </div>
        <ReportRatingBar
          report={viewReport}
          viewerRole={userRole}
          isBrandOwner={brands.find((b) => b.id === viewReport.brandId)?.ownerId === user?.id}
          onRated={(updated) => setViewReport((r) => (r ? { ...r, ...updated } : updated))}
        />
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
        <WeeklyReportView report={viewReport} previousReport={prev} allReports={brandReports}
          onActions={setReportActions} />

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

      {/* Reminder toast */}
      {flash && (
        <div className="d-inline-flex align-items-center gap-2 rounded-3 px-3 py-2 mb-3"
          style={{ background: 'var(--info-soft)', color: 'var(--info)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', fontSize: '0.8rem', fontWeight: 600 }}>
          <i className="bi bi-bell-fill" />{flash}
        </div>
      )}

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
                    {formatPctChange(monthStats.gmvTrend)}
                  </span>
                )}
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
              </div>
            </div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Total GMV this period</div>
            <div className="fw-bold" style={{ fontSize: '1.6rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2 }}>
              {fmtCompactDollars(monthStats.totalGmv, currencySymbol(monthStats.currency))}
            </div>
            <Sparkbars values={monthStats.barPcts} highlightLast color="rgba(255,255,255,0.85)" muted="rgba(255,255,255,0.18)" />
          </div>
        </div>

        {/* Reports submitted */}
        <div className="col-6 col-xl">
          <StatCard
            icon="bi-file-earmark-text" iconBg="var(--info-soft)" iconColor="var(--info)"
            value={monthStats.reportCount} subtitle="this period" label="Reports submitted"
            trendDelta={monthStats.reportsTrend} bars={monthStats.barPcts} barColor="var(--info)"
          />
        </div>

        {/* Active brands */}
        <div className="col-6 col-xl">
          <StatCard
            icon="bi-grid" iconBg="var(--success-soft)" iconColor="var(--success)"
            value={monthStats.brandCount} subtitle="tracked" label="Active brands"
            trendDelta={monthStats.brandsTrend} bars={monthStats.barPcts} barColor="var(--success)"
          />
        </div>

        {/* Drafts — click to filter; OL/Boss can nudge the APC authors to submit */}
        <div className="col-6 col-xl">
          <div className="rounded-3 h-100 p-3" role="button" tabIndex={0}
            style={{ background: 'var(--surface-1)', cursor: 'pointer', position: 'relative',
                     border: filterStatus === 'draft' ? '1.5px solid var(--text-secondary)' : '1px solid var(--border-subtle)' }}
            onClick={() => setFilterStatus(filterStatus === 'draft' ? '' : 'draft')}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFilterStatus(filterStatus === 'draft' ? '' : 'draft'); } }}
            title="Click to show only draft reports">
            <div className="d-flex align-items-start justify-content-between mb-3">
              <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 30, height: 30, background: 'var(--surface-2)' }}>
                <i className="bi bi-pencil-square" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }} />
              </div>
              {canNotify && statusStats.draft > 0 && (
                <button type="button"
                  className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1 border-0"
                  style={{ fontSize: '0.62rem', fontWeight: 700, background: 'var(--info-soft)', color: 'var(--info)', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); handleRemind('draft'); }}
                  disabled={notifyBusy === 'draft'}
                  title="Notify the APCs to submit their draft reports">
                  {notifyBusy === 'draft'
                    ? <span className="spinner-border spinner-border-sm" style={{ width: 11, height: 11 }} />
                    : <i className="bi bi-bell" />}
                  Notify APCs
                </button>
              )}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Drafts</div>
            <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
              {statusStats.draft} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>in progress</span>
            </div>
          </div>
        </div>

        {/* Submitted — click to filter; OL/Boss can nudge the TLs to verify */}
        <div className="col-6 col-xl">
          <div className="rounded-3 h-100 p-3" role="button" tabIndex={0}
            style={{ background: 'var(--surface-1)', cursor: 'pointer', position: 'relative',
                     border: filterStatus === 'submitted' ? '1.5px solid var(--info)' : '1px solid var(--border-subtle)' }}
            onClick={() => setFilterStatus(filterStatus === 'submitted' ? '' : 'submitted')}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFilterStatus(filterStatus === 'submitted' ? '' : 'submitted'); } }}
            title="Click to show only submitted reports">
            <div className="d-flex align-items-start justify-content-between mb-3">
              <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 30, height: 30, background: 'var(--info-soft)' }}>
                <i className="bi bi-inbox" style={{ color: 'var(--info)', fontSize: '0.85rem' }} />
              </div>
              {canNotify && statusStats.submitted > 0 && (
                <button type="button"
                  className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1 border-0"
                  style={{ fontSize: '0.62rem', fontWeight: 700, background: 'var(--warning-soft)', color: 'var(--warning)', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); handleRemind('submitted'); }}
                  disabled={notifyBusy === 'submitted'}
                  title="Notify the Team Leads to verify these reports">
                  {notifyBusy === 'submitted'
                    ? <span className="spinner-border spinner-border-sm" style={{ width: 11, height: 11 }} />
                    : <i className="bi bi-bell" />}
                  Notify TLs
                </button>
              )}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Submitted</div>
            <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
              {statusStats.submitted} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>awaiting review</span>
            </div>
          </div>
        </div>

        {/* Approved */}
        <div className="col-6 col-xl">
          <button className="rounded-3 h-100 w-100 text-start p-0 border-0 bg-transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => setFilterStatus(filterStatus === 'approved' ? '' : 'approved')}
            title="Click to filter approved reports">
            <div className="rounded-3 h-100 p-3" style={{ background: 'var(--surface-1)', border: filterStatus === 'approved' ? '1.5px solid var(--success)' : '1px solid var(--border-subtle)' }}>
              <div className="d-flex align-items-start justify-content-between mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center"
                  style={{ width: 30, height: 30, background: 'var(--success-soft)' }}>
                  <i className="bi bi-check2" style={{ color: 'var(--success)', fontSize: '0.85rem' }} />
                </div>
                <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                  style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.66rem', fontWeight: 600 }}>
                  {statusStats.approvalRate}% rate
                </span>
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Approved</div>
              <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
                {statusStats.approved} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>of {statusStats.total}</span>
              </div>
              <Sparkbars values={monthStats.barPcts} highlightLast color="var(--success)" muted="var(--border-subtle)" />
            </div>
          </button>
        </div>

        {/* Pending approval */}
        <div className="col-6 col-xl">
          <button className="rounded-3 h-100 w-100 text-start p-0 border-0 bg-transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => setFilterStatus(filterStatus === 'verified' ? '' : 'verified')}
            title="Click to filter pending approval">
            <div className="rounded-3 h-100 p-3" style={{ background: 'var(--surface-1)', border: filterStatus === 'verified' ? '1.5px solid var(--warning)' : '1px solid var(--border-subtle)' }}>
              <div className="d-flex align-items-start justify-content-between mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center"
                  style={{ width: 30, height: 30, background: 'var(--warning-soft)' }}>
                  <i className="bi bi-hourglass-split" style={{ color: 'var(--warning)', fontSize: '0.85rem' }} />
                </div>
                {statusStats.pendingOverdue > 0 && (
                  <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                    style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.66rem', fontWeight: 600 }}>
                    <i className="bi bi-arrow-up-right" />
                    {statusStats.pendingOverdue} over 24h
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Pending approval</div>
              <div className="fw-bold" style={{ fontSize: '1.5rem', letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 2, color: 'var(--text-primary)' }}>
                {statusStats.verified} <span className="text-muted fw-normal" style={{ fontSize: '0.78rem' }}>awaiting</span>
              </div>
              <Sparkbars values={monthStats.barPcts} highlightLast color="var(--warning)" muted="var(--border-subtle)" />
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

          <div className="ms-auto d-inline-flex align-items-center gap-2">
            <label className="text-muted d-inline-flex align-items-center" style={{ fontSize: '0.74rem', fontWeight: 600 }}>
              <i className="bi bi-sort-down me-1" />Sort
            </label>
            <select className="form-select form-select-sm" value={sortBy} onChange={e => setSortBy(e.target.value)}
              style={{ width: 158, borderRadius: 8, fontSize: '0.78rem' }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="gmv_desc">GMV: high → low</option>
              <option value="gmv_asc">GMV: low → high</option>
              <option value="brand_az">Brand A → Z</option>
            </select>
            <span className="text-muted" style={{ fontSize: '0.78rem' }}>{filtered.length} reports</span>
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

      {/* Results — polished card grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-5 rounded-3" style={{ background: 'var(--surface-1)', border: '1px dashed var(--border-subtle)' }}>
          <i className="bi bi-file-earmark-bar-graph" style={{ fontSize: '2.5rem', color: 'var(--text-muted)' }} />
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
  const gmvMtd   = num(r.overallNotes?.gmv);   // APC-entered month-to-date GMV
  const orders   = num(perf.orders);
  const roi      = num(perf.roi);
  const videos   = num(perf.videosPosted);
  // Always computable when a previous report exists — incl. growth/drop from
  // $0 (was returning null before, which hid the whole "vs prev week" footer).
  const gmvChange = pctChange(gmv, num(prevPerf.gmv), !!prev);
  const changeDir = pctChangeDir(gmvChange); // 1 up · -1 down · 0 flat · null none
  const changeColor = changeDir == null ? 'var(--text-muted)'
    : changeDir > 0 ? 'var(--success)' : changeDir < 0 ? 'var(--danger)' : 'var(--text-secondary)';
  const changeArrow = changeDir > 0 ? 'up-right' : changeDir < 0 ? 'down-right' : 'right';
  const changeText = gmvChange == null ? null
    : formatPctChange(gmvChange, { withSign: changeDir !== 0 });
  const aov = orders > 0 ? gmv / orders : 0;
  const sym = currencySymbol(r.currency || DEFAULT_CURRENCY);
  const roiNote = roi <= 0 ? 'organic' : roi < 1 ? 'paid mix' : roi < 2 ? 'paid mix' : 'strong';
  const status  = getReportStatus(r);
  const brandName = r.brandName || 'Unknown';
  const initials  = brandName.slice(0, 2).toUpperCase();
  const avatarColor = avatarColorFor(brandName);

  // Status pill style — match the screenshot's lavender "APPROVED"
  const statusPillStyle = (() => {
    if (status === 'approved')  return { bg: 'var(--purple-soft)', color: 'var(--purple)' };
    if (status === 'verified')  return { bg: 'var(--warning-soft)', color: 'var(--warning)' };
    if (status === 'submitted') return { bg: 'var(--info-soft)', color: 'var(--info)' };
    return { bg: 'var(--surface-2)', color: 'var(--text-secondary)' };
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
        border: isSelected ? '2px solid var(--danger)' : '1px solid var(--border-subtle)',
        cursor: 'pointer',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
      }}
        onClick={onClick}
        onMouseEnter={e => {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 8px 20px rgba(15,23,42,0.08)';
          if (!isSelected) e.currentTarget.style.borderColor = 'var(--border-default)';
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
              background: isSelected ? 'var(--danger)' : 'rgba(255,255,255,0.95)',
              border: `1.5px solid ${isSelected ? 'var(--danger)' : 'var(--border-default)'}`,
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
            style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.62rem', fontWeight: 600, padding: '3px 8px' }}>
            <i className="bi bi-tiktok" style={{ fontSize: '0.62rem' }} />
            TikTok
          </span>
        </div>

        {/* Stats row */}
        <div className="px-3 pb-2 pt-1">
          <div className="d-flex justify-content-between gap-2">
            <CardStat label="GMV" value={sym + gmv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              subNote={gmvMtd > 0 ? `MTD ${sym}${gmvMtd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : null}
              note={changeText}
              noteColor={changeColor} />
            <CardStat label="ORDERS" value={orders.toLocaleString()} note={aov > 0 ? `${sym}${aov.toFixed(0)} AOV` : null} />
            <CardStat label="ROAS" value={roi.toFixed(2)} note={roiNote}
              noteColor={roi >= 2 ? 'var(--success)' : roi <= 0 ? 'var(--text-muted)' : 'var(--text-secondary)'} />
            <CardStat label="VIDEOS" value={videos.toLocaleString()} />
          </div>
        </div>

        {/* Sparkline footer (vs prev week) — shown whenever a previous report
            exists, including growth/drop from $0 (capped to ±100%+). */}
        {gmvChange != null && seriesBars.length > 1 && (
          <div className="d-flex align-items-center gap-2 px-3 py-2"
            style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-0)', borderRadius: '0 0 12px 12px' }}>
            <span className="text-muted" style={{ fontSize: '0.7rem' }}>vs prev week</span>
            <div className="flex-grow-1">
              <Sparkbars values={seriesBars} highlightLast color={changeColor} muted="var(--border-subtle)" />
            </div>
            <span className="d-inline-flex align-items-center gap-1 fw-bold" style={{ fontSize: '0.72rem', color: changeColor }}>
              <i className={`bi bi-arrow-${changeArrow}`} />
              {changeText}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CardStat({ label, value, note, noteColor, subNote }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-muted" style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em' }}>{label}</div>
      <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: 1.1, marginTop: 2 }}>{value}</div>
      {subNote && (
        <div className="text-muted" style={{ fontSize: '0.58rem', marginTop: 2 }}>{subNote}</div>
      )}
      {note && (
        <div style={{ fontSize: '0.65rem', color: noteColor || 'var(--text-secondary)', fontWeight: 600, marginTop: 2 }}>{note}</div>
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

