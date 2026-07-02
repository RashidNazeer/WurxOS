import React, { useEffect, useState } from 'react';
import WeeklyReportView from '../../components/reporting/WeeklyReportView';
import { makeWeekFromStart, EMPTY_REPORT_DATA } from '../../lib/reportsApi';
import { buildEukaAutofillData } from '../../lib/eukaAnalyticsApi';
import { Section } from './EukaKit';

// Snap any picked date to the Sunday that starts its week (Solid Gold's
// weeks run Sun–Sat, matching the APC's "Week N (Jun 7-13)" labels).
function weekFromPicked(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  const y = sunday.getFullYear();
  const m = String(sunday.getMonth() + 1).padStart(2, '0');
  const da = String(sunday.getDate()).padStart(2, '0');
  return makeWeekFromStart(`${y}-${m}-${da}`, 1);
}

// Overlay the exact Euka fields onto a full empty weekly-report shape so
// WeeklyReportView renders (it expects every section to exist).
function toFullReport(week, storeName, autofill) {
  const base = EMPTY_REPORT_DATA();
  const d = autofill?.data || {};
  return {
    ...base,
    ...d,
    overallPerformance: { ...base.overallPerformance, ...(d.overallPerformance || {}) },
    topCreators: d.topCreators || base.topCreators,
    productHighlights: d.productHighlights || base.productHighlights,
    id: null, brandId: null, brandName: storeName || 'Store',
    status: 'draft', currency: base.currency,
    weekLabel: week.label, weekStart: week.startDate, weekEnd: week.endDate,
    week: week.week, year: week.year, month: week.month,
  };
}

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return <div className="alert alert-warning py-2 small mb-0">Preview couldn’t render: {String(this.state.err?.message || this.state.err)}</div>;
    return this.props.children;
  }
}

// Preview-only: pulls a week's exact Euka stats into the weekly-report
// layout so the Boss can eyeball a brand's numbers. Nothing is saved — this
// is a live dashboard view, NOT a real report. (The real report is created
// by the APC through the normal reporting flow; that's separate work.)
export default function EukaReportPreview({ storeId, store }) {
  const [anchor, setAnchor] = useState('2026-06-07'); // seed to a valid week
  const [autofill, setAutofill] = useState(null);     // { data, meta }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const week = weekFromPicked(anchor);

  // A change of week/store invalidates a previously-generated preview.
  useEffect(() => { setAutofill(null); setErr(''); }, [anchor, storeId]);

  async function generate() {
    if (!storeId || !week) return;
    setBusy(true); setErr(''); setAutofill(null);
    try {
      const result = await buildEukaAutofillData({ storeId, week });
      setAutofill(result);
    } catch (ex) {
      setErr(ex?.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  const preview = autofill ? toFullReport(week, store?.name, autofill) : null;

  return (
    <Section span={12} title="Weekly report — Euka preview" icon="bi-magic" color="#7c3aed"
      eyebrow="Boss-only preview. Pick a week to pull the exact stats Euka provides into the weekly-report layout. Nothing is saved — this is a live view, not a real report.">
      <div className="d-flex align-items-center flex-wrap gap-3 mb-2">
        <div className="d-inline-flex align-items-center gap-2">
          <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>Week anchor</span>
          <input type="date" className="form-control form-control-sm" style={{ width: 'auto', borderRadius: 9 }}
            value={anchor} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setAnchor(e.target.value)} />
        </div>
        {week && (
          <span className="rounded-pill px-3 py-1" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600 }}>
            {week.label}
          </span>
        )}
        <button className="btn btn-sm btn-primary d-inline-flex align-items-center gap-2" style={{ borderRadius: 9 }}
          disabled={busy || !storeId || !week} onClick={generate}>
          {busy ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-magic" />}
          Generate preview
        </button>
      </div>

      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
        <i className="bi bi-check-circle me-1 text-success" />
        Auto-filled (verified exact): <b>GMV, Affiliate GMV, Orders, Top creators (name/videos/GMV), Products by affiliate GMV + units</b>.
        Left blank: ROI, Shop Score, Samples, Videos Posted, Top videos, GMV Max, Off-site.
        <span className="d-block mt-1"><i className="bi bi-info-circle me-1" />Euka scopes days in US-Pacific time; report weeks are Pakistan time — edge-day totals may differ by up to a day.</span>
      </div>

      {err && <div className="alert alert-danger py-2 small mt-3 mb-0">{err}</div>}

      {preview && (
        <div className="mt-3" style={{ border: '1px dashed var(--border-default)', borderRadius: 12, padding: 4 }}>
          <div className="px-3 pt-2 pb-1 text-muted" style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <i className="bi bi-eye me-1" />Preview · not saved
          </div>
          <Boundary>
            <WeeklyReportView report={preview} previousReport={null} allReports={[]} clientView={false} />
          </Boundary>
        </div>
      )}
    </Section>
  );
}
