import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { getReport, listReportsForBrandTrend, reportPermissions } from '../../lib/reportsApi';
import { getBrand } from '../../lib/brandsApi';
import ReportForm from '../../components/reports/ReportForm';
import ReportView from '../../components/reports/ReportView';
import { AlertIcon } from '../../components/common/Icon';

/**
 * Full-page Report view/edit.
 *
 *   /reports/new?brandId=<uuid>&type=<weekly|biweekly>
 *                &start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
 *                &num=<1..>&label=<string>
 *     → create mode. Brand + period passed via query, report is null.
 *
 *   /reports/:id
 *     → open report. Renders ReportView with charts + deltas by default.
 *       The author can tap "Edit draft" to switch to ReportForm when the
 *       report is still a draft.
 */
export default function ReportPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, profile } = useAuth();
  const [forceEdit, setForceEdit] = useState(false);

  const isNew = !id;

  const { data: report, isLoading: loadingReport, error: reportErr } = useQuery({
    queryKey: ['report', id],
    queryFn: () => getReport(id),
    enabled: !isNew,
  });

  const brandId = isNew ? sp.get('brandId') : null;
  const { data: brand, isLoading: loadingBrand, error: brandErr } = useQuery({
    queryKey: ['brand', brandId],
    queryFn: () => getBrand(brandId),
    enabled: !!brandId,
  });

  // Trend data — last 8 reports of the same brand + type, for charts and prev-period deltas.
  // Skip for drafts (nothing meaningful to chart yet) and when creating a brand-new report.
  const shouldFetchTrend = !isNew && report && report.status !== 'draft';
  const { data: trendReports = [] } = useQuery({
    queryKey: ['reports', 'trend', report?.brand_id, report?.type],
    queryFn: () => listReportsForBrandTrend(report.brand_id, report.type, { limit: 8 }),
    enabled: !!shouldFetchTrend,
  });

  const period = useMemo(() => {
    if (!isNew) return null;
    const startDate = sp.get('start');
    const endDate   = sp.get('end');
    const num       = Number(sp.get('num')) || 1;
    const label     = sp.get('label') || '';
    if (!startDate || !endDate) return null;
    const d = new Date(startDate);
    return {
      startDate, endDate,
      year:  d.getFullYear(),
      month: d.getMonth(),
      week: num, period: num,
      label,
    };
  }, [isNew, sp]);

  const type = isNew ? (sp.get('type') || 'weekly') : (report?.type || 'weekly');
  const loading = isNew ? loadingBrand : loadingReport;
  const error   = (isNew ? brandErr : reportErr)?.message;

  // Build the "previous report" for delta math from the trend list.
  // These must run every render (before any early return) so hook
  // ordering stays stable across loading → loaded transitions.
  const previousReport = useMemo(() => {
    if (!report || !trendReports?.length) return null;
    const idx = trendReports.findIndex((r) => r.id === report.id);
    if (idx > 0) return trendReports[idx - 1];
    // If current report isn't in the trend (e.g. still submitted), use the latest.
    return trendReports[trendReports.length - 1] || null;
  }, [report, trendReports]);

  // Ensure current report is in the trend array even if not approved/verified
  // — so DeltaBadge and chart include it.
  const trendWithCurrent = useMemo(() => {
    if (!report) return trendReports;
    if (trendReports.some((r) => r.id === report.id)) return trendReports;
    const merged = [...trendReports, {
      id: report.id, period_label: report.period_label,
      period_start: report.period_start, period_end: report.period_end,
      data: report.data, status: report.status, type: report.type,
      created_at: report.created_at,
    }];
    // Sort by created_at — matches listReportsForBrandTrend order so
    // sibling lookup stays consistent when dates have been edited.
    // Fall back to period_start for legacy rows.
    merged.sort((a, b) => {
      const ac = a.created_at || a.period_start || '';
      const bc = b.created_at || b.period_start || '';
      return ac.localeCompare(bc);
    });
    return merged;
  }, [report, trendReports]);

  if (loading) {
    return <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>;
  }
  if (error) {
    return (
      <div className="wx-alert wx-alert-danger" style={{ marginTop: 20 }}>
        <AlertIcon width="16" height="16" /> <span>{error}</span>
      </div>
    );
  }
  if (isNew && (!brand || !period)) {
    return (
      <div className="wx-card" style={{ padding: 24, textAlign: 'center', marginTop: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Missing report context</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Open a new report from the Reports page so the brand and period are picked first.
        </div>
      </div>
    );
  }
  if (!isNew && !report) {
    return (
      <div className="wx-card" style={{ padding: 24, textAlign: 'center', marginTop: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Report not found</div>
      </div>
    );
  }

  // ---- Decide: Form (editable) or View (charts + deltas) ------------
  // - Creating a new report → Form
  // - Draft report author/admin with edit rights AND they asked to edit
  //   (default) → Form
  // - Otherwise → View (read-only, with charts)
  const perms = !isNew ? reportPermissions({
    report, role: profile?.role, uid: user?.id,
    brandOwnerId: report?.brand?.owner_id,
  }) : { canEditContent: true };

  const showForm = isNew || (perms.canEditContent && (report.status === 'draft'));
  // Allow the author to jump from View back into the editor via the
  // "Edit draft" button we render on ReportView. Same-page toggle so
  // Cmd+Enter save lands back on the view.
  const finalShowForm = forceEdit ? true : showForm;

  if (finalShowForm) {
    return (
      <ReportForm
        brand={brand || report?.brand}
        period={period}
        type={type}
        report={report || null}
        onClose={() => { setForceEdit(false); navigate('/reports'); }}
        onSaved={(saved) => {
          if (isNew && saved?.id) navigate(`/reports/${saved.id}`, { replace: true });
          // Stay in edit mode after subsequent saves; user can tap Back / Close.
          qc.invalidateQueries({ queryKey: ['report', saved?.id] });
        }}
      />
    );
  }

  return (
    <ReportView
      report={report}
      allReports={trendWithCurrent}
      previousReport={previousReport}
      onBack={() => navigate('/reports')}
      onEditDraft={() => setForceEdit(true)}
      onSaved={(saved) => {
        qc.invalidateQueries({ queryKey: ['report', saved?.id || id] });
        qc.invalidateQueries({ queryKey: ['reports'] });
        qc.invalidateQueries({ queryKey: ['reports', 'trend'] });
      }}
    />
  );
}
