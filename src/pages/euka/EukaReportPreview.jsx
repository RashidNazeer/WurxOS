import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import WeeklyReportView from '../../components/reporting/WeeklyReportView';
import {
  makeWeekFromStart, saveReport, findAnyReport, listBrandsForEukaReport,
  EMPTY_REPORT_DATA,
} from '../../lib/reportsApi';
import { buildEukaAutofillData, getEukaBrand } from '../../lib/eukaAnalyticsApi';
import { useAuth } from '../../contexts/AuthContext';
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
// WeeklyReportView renders (it expects every section to exist) and so the
// saved draft has the standard structure with everything-else blank.
function toFullReport(week, storeName, brandName, autofill) {
  const base = EMPTY_REPORT_DATA();
  const d = autofill?.data || {};
  return {
    ...base,
    ...d,
    // arrays/objects: prefer the autofilled ones when present
    overallPerformance: { ...base.overallPerformance, ...(d.overallPerformance || {}) },
    topCreators: d.topCreators || base.topCreators,
    productHighlights: d.productHighlights || base.productHighlights,
    // view-only display fields
    id: null, brandId: null, brandName: brandName || storeName || 'Store',
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

export default function EukaReportPreview({ storeId, store }) {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const currentSlug = getEukaBrand();

  const [anchor, setAnchor] = useState('2026-06-07'); // seed to a valid week
  const [brandId, setBrandId] = useState('');
  const [autofill, setAutofill] = useState(null);     // { data, meta }
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [existing, setExisting] = useState(null);     // an existing report (any status) that blocks create
  const [saved, setSaved] = useState(null);           // saved report id

  const week = weekFromPicked(anchor);

  // WurxOS brands + their Euka mapping (Boss-only). Used to attach a real
  // brand_id to the saved report and to auto-match the current Euka store.
  const brandsQ = useQuery({
    queryKey: ['euka', 'reportBrands'],
    queryFn: listBrandsForEukaReport,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
  const brands = brandsQ.data || [];

  // Auto-select the WurxOS brand that maps to the Euka store/slug currently
  // being viewed: prefer an exact euka_store_id match, else euka_slug match.
  // Keyed on storeId (which changes whenever the Euka brand changes) so the
  // suggested brand follows the store the Boss is looking at, rather than a
  // stale carry-over. Runs only when nothing is selected — a manual pick or
  // an existing auto-pick for THIS store is left alone.
  useEffect(() => {
    if (brandId || !brands.length) return;
    const byStore = storeId && brands.find((b) => b.euka_store_id && b.euka_store_id === storeId);
    const bySlug = currentSlug && brands.find((b) => (b.euka_slug || '').toLowerCase() === currentSlug.toLowerCase());
    const match = byStore || bySlug;
    if (match) setBrandId(match.id);
  }, [brands, storeId, currentSlug, brandId]);

  // When the Euka store changes (Boss switched Euka brand on the page), drop
  // the current WurxOS-brand selection so the auto-match re-runs for the new
  // store instead of leaving a mismatched brand selected.
  const prevStoreRef = React.useRef(storeId);
  useEffect(() => {
    if (prevStoreRef.current !== storeId) {
      prevStoreRef.current = storeId;
      setBrandId('');
    }
  }, [storeId]);

  const selectedBrand = useMemo(() => brands.find((b) => b.id === brandId) || null, [brands, brandId]);

  // Any change of week/brand/store invalidates a previously-generated draft
  // preview + existence check.
  useEffect(() => { setAutofill(null); setSaved(null); setExisting(null); setErr(''); }, [anchor, brandId, storeId]);

  async function generate() {
    if (!storeId || !week) return;
    setBusy(true); setErr(''); setAutofill(null); setSaved(null); setExisting(null);
    try {
      const result = await buildEukaAutofillData({ storeId, week });
      setAutofill(result);
      // This is a CREATE-ONLY flow. If ANY report already exists for this
      // brand + week (draft OR further along), block the save — the
      // period-keyed upsert would otherwise silently overwrite that row's
      // content (and revert a non-draft one to draft). Point the Boss at the
      // existing report instead of clobbering it.
      if (brandId) {
        const ex = await findAnyReport({ brandId, type: 'weekly', periodStart: week.startDate }).catch(() => null);
        if (ex) setExisting(ex);
      }
    } catch (ex) {
      setErr(ex?.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    if (!uid || !brandId || !week || !autofill) return;
    setSaving(true); setErr('');
    try {
      // Create-only: re-check right before writing (the button is also
      // disabled when `existing` is set, but this closes the race where a
      // report was created between generate() and the click). Never overwrite.
      const clash = await findAnyReport({ brandId, type: 'weekly', periodStart: week.startDate }).catch(() => null);
      if (clash) { setExisting(clash); setSaving(false); return; }
      // The persisted `data` is a full empty weekly-report overlaid with
      // ONLY the exact Euka fields — everything else stays blank for the
      // APC. (_saveReportV1 also strips any stray display keys, but we
      // don't include them here.) period_* comes from weekInfo, not data.
      const base = EMPTY_REPORT_DATA();
      const d = autofill.data || {};
      const data = {
        ...base,
        overallPerformance: { ...base.overallPerformance, ...(d.overallPerformance || {}) },
        overallInsights: d.overallInsights || base.overallInsights,
        topCreators: d.topCreators || base.topCreators,
        productHighlights: d.productHighlights || base.productHighlights,
      };
      const id = await saveReport({
        brandId,
        weekInfo: week,
        data,
        uid,
        userName: profile?.display_name || '',
        status: 'draft',
        createOnly: true, // never overwrite an existing report for this week
      });
      setSaved(id);
    } catch (ex) {
      // createOnly guard fired (a report appeared for this week) → show the
      // block instead of a raw error, and re-surface which report exists.
      if (ex?.code === 'REPORT_EXISTS') {
        const clash = await findAnyReport({ brandId, type: 'weekly', periodStart: week.startDate }).catch(() => null);
        setExisting(clash || { status: 'existing' });
      } else {
        setErr(ex?.message || String(ex));
      }
    } finally {
      setSaving(false);
    }
  }

  const preview = autofill ? toFullReport(week, store?.name, selectedBrand?.brand_name, autofill) : null;

  return (
    <Section span={12} title="Weekly report — create from Euka" icon="bi-magic" color="#7c3aed"
      eyebrow="Boss-only. Pick the brand + week, pull the exact stats Euka provides, and save a real weekly DRAFT the APC can finish.">
      <div className="d-flex align-items-center flex-wrap gap-3 mb-2">
        {/* WurxOS brand — where the saved report lands */}
        <div className="d-inline-flex align-items-center gap-2">
          <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>Report brand</span>
          <select className="form-select form-select-sm" style={{ width: 'auto', borderRadius: 9, minWidth: 180 }}
            value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">Select WurxOS brand…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.brand_name}{b.euka_slug ? '' : ' (no Euka link)'}</option>
            ))}
          </select>
        </div>
        {/* Anchor date → the Sun–Sat week */}
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
          Fetch from Euka
        </button>
      </div>

      <div className="text-muted" style={{ fontSize: '0.7rem' }}>
        <i className="bi bi-check-circle me-1 text-success" />
        Auto-filled (verified exact): <b>GMV, Affiliate GMV, Orders, Top creators (name/videos/GMV), Products by affiliate GMV + units</b>.
        Left blank for manual entry: ROI, Shop Score, Samples, Videos Posted, Top videos, GMV Max, Off-site.
        <span className="d-block mt-1"><i className="bi bi-info-circle me-1" />Euka scopes days in US-Pacific time; report weeks are Pakistan time — edge-day totals may differ by up to a day. Verify before submitting.</span>
      </div>

      {err && <div className="alert alert-danger py-2 small mt-3 mb-0">{err}</div>}

      {existing && !saved && (
        <div className="alert alert-warning py-2 small mt-3 mb-0">
          A <b>{existing.status}</b> weekly report already exists for this brand &amp; week
          {existing.author?.display_name ? <> (by {existing.author.display_name})</> : null}.
          Creating is disabled so it isn’t overwritten — open <b>Weekly Reports</b> and edit that report instead.
        </div>
      )}

      {saved && (
        <div className="alert alert-success py-2 small mt-3 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-check-circle-fill" />
          Draft created for <b>{selectedBrand?.brand_name}</b> — {week.label}. The APC can now open it under Weekly Reports and fill the remaining fields.
        </div>
      )}

      {preview && (
        <>
          <div className="d-flex align-items-center gap-2 mt-3">
            <button className="btn btn-sm btn-success d-inline-flex align-items-center gap-2" style={{ borderRadius: 9 }}
              disabled={saving || !brandId || !!saved || !!existing} onClick={createDraft}>
              {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-save" />}
              {saved ? 'Draft created' : 'Create draft report'}
            </button>
            {!brandId && <span className="text-muted" style={{ fontSize: '0.72rem' }}>Select a report brand above to enable saving.</span>}
            {existing && !saved && <span className="text-muted" style={{ fontSize: '0.72rem' }}>A report already exists for this week — edit it under Weekly Reports.</span>}
          </div>

          <div className="mt-3" style={{ border: '1px dashed var(--border-default)', borderRadius: 12, padding: 4 }}>
            <div className="px-3 pt-2 pb-1 text-muted" style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <i className="bi bi-eye me-1" />Preview · {saved ? 'saved as draft' : 'not yet saved'}
            </div>
            <Boundary>
              <WeeklyReportView report={preview} previousReport={null} allReports={[]} clientView={false} />
            </Boundary>
          </div>
        </>
      )}
    </Section>
  );
}
