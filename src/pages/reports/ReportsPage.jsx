import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listReports, listBrandsForReporting,
  STATUS_LABEL, STATUS_COLOR,
} from '../../lib/reportsApi';
import ReportShareModal from '../../components/reports/ReportShareModal';
import { LinkIcon } from '../../components/common/Icon';
import PeriodPicker from '../../components/reports/PeriodPicker';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  PlusIcon, SearchIcon, AlertIcon, RefreshIcon,
  ChevronRightIcon, ChevronDownIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/reports.css';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const STATUS_FILTERS = ['all','draft','submitted','verified','approved'];

export default function ReportsPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const navigate = useNavigate();

  const [type, setType]               = useState('weekly');
  const [now]                         = useState(() => new Date());
  const [viewYear, setViewYear]       = useState(now.getFullYear());
  const [viewMonth, setViewMonth]     = useState(now.getMonth());
  const [brandFilter, setBrandFilter] = useState('all');
  const [statusFilter, setStatus]     = useState('all');
  const [search, setSearch]           = useState('');

  // PeriodPicker is the only modal left — short flow, fine as overlay.
  // Creating or editing a report navigates to its own page now.
  const [addBrand, setAddBrand]       = useState(null);  // brand object for PeriodPicker
  const [shareReport, setShareReport] = useState(null);  // open share modal for approved report

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: rowsError } = useQuery({
    queryKey: ['reports', type, viewYear, viewMonth],
    queryFn: () => listReports({ type, year: viewYear, month: viewMonth }),
  });
  const canViewAllBrands = profile?.permissions?.canViewAllBrands === true;
  const { data: brands = [], error: brandsError } = useQuery({
    queryKey: ['reports', 'brands', role, user?.id, canViewAllBrands],
    queryFn: () => listBrandsForReporting({ role, uid: user.id, permissions: profile?.permissions }),
    enabled: !!role && !!user?.id,
  });
  const error = rowsError?.message || brandsError?.message || '';
  const load = () => qc.invalidateQueries({ queryKey: ['reports'] });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (brandFilter !== 'all' && r.brand_id !== brandFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!s) return true;
      return (
        (r.brand?.brand_name || '').toLowerCase().includes(s) ||
        (r.author?.display_name || '').toLowerCase().includes(s) ||
        (r.period_label || '').toLowerCase().includes(s)
      );
    });
  }, [rows, brandFilter, statusFilter, search]);

  function prevMonth() {
    const m = viewMonth - 1;
    if (m < 0) { setViewYear((y) => y - 1); setViewMonth(11); } else setViewMonth(m);
  }
  function nextMonth() {
    const m = viewMonth + 1;
    if (m > 11) { setViewYear((y) => y + 1); setViewMonth(0); } else setViewMonth(m);
  }

  const canCreate = ['boss','ol','developer','tl','apc'].includes(role);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-subtitle">
            {loading ? '' : `${filtered.length} of ${rows.length} in ${MONTH_NAMES[viewMonth]} ${viewYear}`}
          </p>
        </div>
        {canCreate && brands.length > 0 && (
          <AddReportMenu brands={brands} onPick={(brand) => setAddBrand(brand)} />
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Type tabs */}
        <div className="report-tabs">
          <button className={`report-tab ${type === 'weekly'   ? 'report-tab-active' : ''}`}
                  onClick={() => setType('weekly')}>Weekly</button>
          <button className={`report-tab ${type === 'biweekly' ? 'report-tab-active' : ''}`}
                  onClick={() => setType('biweekly')}>Bi-weekly</button>
        </div>

        {/* Month navigator */}
        <div className="report-month-nav">
          <button onClick={prevMonth} title="Previous month">
            <ChevronRightIcon width="16" height="16" style={{ transform: 'rotate(180deg)' }} />
          </button>
          <div className="report-month-nav-label">{MONTH_NAMES[viewMonth]} {viewYear}</div>
          <button onClick={nextMonth} title="Next month">
            <ChevronRightIcon width="16" height="16" />
          </button>
        </div>

        <button
          onClick={() => { setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); }}
          className="wx-btn wx-btn-ghost"
          style={{ padding: '7px 14px', fontSize: 12.5 }}
          title="Jump to current month"
        >
          Today
        </button>
      </div>

      {/* Search + filters */}
      <div className="wx-toolbar">
        <div className="wx-search">
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search by brand, author or period…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {brands.length > 1 && (
          <select
            className="wx-input"
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="all">All brands</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
          </select>
        )}
        <div className="report-status-chips" style={{ display: 'flex', gap: 4 }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`wx-role-chip ${statusFilter === s ? 'wx-role-chip-active' : ''}`}
              style={{ padding: '7px 12px', textTransform: 'capitalize' }}
            >
              {s}
            </button>
          ))}
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={load} disabled={loading} title="Refresh">
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty">
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading reports…
        </div>
      ) : filtered.length === 0 ? (
        <div className="wx-card wx-empty" style={{ padding: 40 }}>
          <div className="wx-empty-title">No reports here</div>
          <div>
            {rows.length === 0
              ? `No ${type === 'biweekly' ? 'bi-weekly' : 'weekly'} reports for ${MONTH_NAMES[viewMonth]} ${viewYear}.`
              : 'Try a different filter.'}
          </div>
        </div>
      ) : (
        <div className="reports-grid">
          {filtered.map((r) => (
            <ReportCard key={r.id} report={r}
              onOpen={() => navigate(`/reports/${r.id}`)}
              onShare={r.status === 'approved' ? () => setShareReport(r) : null} />
          ))}
        </div>
      )}

      {/* Period picker (after brand chosen) — the only remaining modal
          in this flow. On pick, we navigate to /reports/new with the
          brand + period encoded in the query string. */}
      {addBrand && (
        <PeriodPicker
          brand={addBrand}
          type={type}
          onClose={() => setAddBrand(null)}
          onPicked={(p) => {
            const brand = addBrand;
            setAddBrand(null);
            const qs = new URLSearchParams({
              brandId: brand.id,
              type,
              start:   p.startDate,
              end:     p.endDate,
              num:     String(p.week ?? p.period ?? 1),
              label:   p.label || '',
            });
            navigate(`/reports/new?${qs.toString()}`);
          }}
        />
      )}

      {shareReport && (
        <ReportShareModal report={shareReport} onClose={() => setShareReport(null)} />
      )}
    </>
  );
}

// ============ Subcomponents ============

function AddReportMenu({ brands, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="wx-btn wx-btn-primary" onClick={() => setOpen((v) => !v)}>
        <PlusIcon width="16" height="16" /> Add report <ChevronDownIcon width="13" height="13" />
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)',
            background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
            padding: 4, minWidth: 240, maxHeight: 360, overflowY: 'auto', zIndex: 40,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '8px 12px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Pick a brand
          </div>
          {brands.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => { onPick(b); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '8px 10px',
                background: 'transparent', border: 0, cursor: 'pointer',
                borderRadius: 'var(--radius-sm)', textAlign: 'left',
                color: 'var(--text-primary)', fontSize: 13,
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              <BrandAvatar brand={b} size={24} radius={6} />
              <span style={{ fontWeight: 600 }}>{b.brand_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ report, onOpen, onShare }) {
  const color = STATUS_COLOR[report.status] || STATUS_COLOR.draft;
  return (
    <div className="report-card" onClick={onOpen}>
      <div className="report-card-head">
        <BrandAvatar brand={report.brand} size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="report-card-brand-name">{report.brand?.brand_name}</div>
          <div className="report-card-period">{report.period_label}</div>
        </div>
        <span className="report-status-badge" style={{ background: color.bg, color: color.fg, flex: '0 0 auto' }}>
          <span className="report-status-badge-dot" /> {STATUS_LABEL[report.status] || 'Approved'}
        </span>
      </div>

      {report.rejection_note && report.status === 'draft' && (
        <div style={{
          fontSize: 12, color: 'var(--danger)',
          background: 'var(--danger-soft)',
          padding: '6px 10px', borderRadius: 'var(--radius-sm)',
          border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
        }}>
          Returned: {report.rejection_note}
        </div>
      )}

      <div className="report-card-footer">
        <span>by {report.author?.display_name || '—'}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {onShare && (
            <button
              type="button"
              className="wx-btn wx-btn-ghost"
              onClick={(e) => { e.stopPropagation(); onShare(); }}
              style={{ padding: '4px 8px', fontSize: 11.5 }}
              title="Share link"
            >
              <LinkIcon width="12" height="12" /> Share
            </button>
          )}
          <span>{report.type === 'biweekly' ? 'Bi-weekly' : 'Weekly'}</span>
        </span>
      </div>
    </div>
  );
}
