import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { useReportLeaveGuard } from './useReportLeaveGuard';
import { useStickyHeaderOffset } from '../../hooks/useStickyHeaderOffset';
import { useBrands } from '../../contexts/BrandsContext';
import {
  detectNextWeek, emptyReport, makeWeekFromStart,
  saveReport, getReportsForBrand, getReport, changeReportWeek,
  getUserCustomFields, saveUserCustomFields,
  REPORT_STATUSES, cleanNumericInput,
  WEEKLY_SECTIONS, resolveWeeklySectionsEnabled,
} from '../../utils/reportingService';
import {
  generateOverallInsight, generateCreatorsInsight, generateVideosInsight,
  generateGmvMaxInsight, generateProductsInsight, generateOffsiteInsight,
  generateAllInsights,
} from '../../utils/aiInsights';
import { findPreviousReport } from '../../lib/reportsApi';
import { runEukaReportAutofill, mergeAutofill } from '../../lib/eukaReportAutofillApi';
import { productUnitsLabel } from '../../lib/reportUnitsLabel';
import { notifyReportSubmitted } from '../../utils/reportNotifications';
import { parsePdfToReport } from '../../utils/pdfReportParser';
import { CURRENCIES, currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import RichTextEditor from '../shared/RichTextEditor';
import ReportReturnNotice from './ReportReturnNotice';
import { useReportAutosave, loadDraft } from '../../utils/reportDraftAutosave';
import { useBrandSections, cleanCustomFields } from './useBrandSections';
import {
  SectionHeader, BrandSectionsBlock, BuiltinExtras, AddCustomSectionInline,
} from './BrandCustomSections';
import { formatPctChange } from '../../utils/formatPctChange';
import '../../styles/reportImmersive.css';

/* ── Tiny reusable pieces ─────────────────────────────────────────────────── */

// "Last: $X +Y%" chip under a money field — same as the monthly form's.
function ComparisonChip({ thisVal, lastVal, format = 'num' }) {
  if (lastVal == null || lastVal === '') return null;
  const c = parseFloat(thisVal) || 0;
  const p = parseFloat(lastVal) || 0;
  if (!c && !p) return null;
  const fmt = (v) => format === 'usd'
    ? '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
    : Number(v).toLocaleString();
  let pct = null;
  if (p !== 0) pct = ((c - p) / Math.abs(p)) * 100;
  const color = pct == null ? 'var(--text-muted)' : pct >= 0 ? 'var(--success)' : 'var(--danger)';
  return (
    <div style={{ fontSize: '0.66rem', color: 'var(--text-secondary)', marginTop: 2 }}>
      Last: <strong>{fmt(p)}</strong>
      {pct != null && (
        <span style={{ color, marginLeft: 6, fontWeight: 600 }}>
          {formatPctChange(pct)}
        </span>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder, note, width, readOnly }) {
  // Use type="text" + inputMode="decimal" for numeric fields so users can paste
  // formatted strings like "$3,456.9" — type="number" silently rejects them.
  // Live-clean via cleanNumericInput so currency, commas, and % drop out.
  const isNum = type === 'number';
  return (
    <div style={{ flex: width ? `0 0 ${width}` : '1 1 140px', minWidth: 100 }}>
      <label className="form-label mb-1" style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      <input type={isNum ? 'text' : type}
        inputMode={isNum ? 'decimal' : undefined}
        readOnly={readOnly}
        className="form-control form-control-sm" placeholder={placeholder || label}
        value={value} onChange={readOnly ? undefined : (e => onChange(isNum ? cleanNumericInput(e.target.value) : e.target.value))}
        style={{ borderRadius: 8, ...(readOnly ? { background: 'var(--surface-2)', cursor: 'not-allowed' } : null) }} />
      {note && <div className="text-muted" style={{ fontSize: '0.6rem' }}>{note}</div>}
    </div>
  );
}

// Auto-growing textarea: resizes to fit content as user types, and stays
// manually resizable via the drag handle in the bottom-right corner.
function AutoGrowTextarea({ value, minRows = 3, placeholder, onChange, style }) {
  const ref = React.useRef(null);
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };
  React.useEffect(() => { resize(); }, [value]);
  return (
    <textarea ref={ref}
      className="form-control form-control-sm"
      rows={minRows}
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      onInput={resize}
      style={{ borderRadius: 8, resize: 'vertical', overflow: 'hidden', ...(style || {}) }}
    />
  );
}

function TextArea({ label, value, onChange, rows = 3, placeholder }) {
  return (
    <div className="mt-2">
      <label className="form-label mb-1" style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      <AutoGrowTextarea value={value} minRows={rows}
        placeholder={placeholder || 'Add insights for this section…'}
        onChange={onChange} />
    </div>
  );
}

function InsightArea({ value, onChange, onGenerate, loading, rows = 3 }) {
  return (
    <div className="mt-2">
      <div className="d-flex align-items-center justify-content-between mb-1">
        <label className="form-label mb-0" style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Insights</label>
        {onGenerate && (
        <button type="button" className="btn btn-sm d-inline-flex align-items-center gap-1"
          style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)', color: 'white', borderRadius: 8, fontSize: '0.68rem', padding: '3px 10px', border: 'none' }}
          onClick={onGenerate} disabled={loading}>
          {loading ? <><span className="spinner-border spinner-border-sm" style={{ width: 10, height: 10 }} /> Generating…</>
            : <><i className="bi bi-stars" /> Generate with AI</>}
        </button>
        )}
      </div>
      <RichTextEditor value={value || ''} onChange={onChange}
        minHeight={Math.max(100, rows * 28)}
        placeholder="Add insights for this section or click ✨ to auto-generate…" />
    </div>
  );
}

// "Copy from previous report" icon button shown above each rich-text
// editor. Disabled (with tooltip) when no previous report exists or
// when the previous report's value for this field is visually empty.
// Confirms before overwriting non-empty current text.
function isHtmlEmpty(html) {
  if (!html) return true;
  if (typeof html !== 'string') return true;
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim() === '';
}
function FetchPreviousButton({ previousValue, currentValue, onPaste, sourceLabel }) {
  const prevEmpty = isHtmlEmpty(previousValue);
  const curEmpty = isHtmlEmpty(currentValue);
  const disabled = prevEmpty;
  const handleClick = () => {
    if (disabled) return;
    if (!curEmpty) {
      const ok = window.confirm(
        `Replace current text with the content from ${sourceLabel}?\n\nYour current text will be lost.`
      );
      if (!ok) return;
    }
    onPaste(previousValue);
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={
        disabled
          ? 'No previous report to copy from yet'
          : `Copy from ${sourceLabel}`
      }
      className="btn btn-sm d-inline-flex align-items-center gap-1"
      style={{
        background: disabled ? 'var(--surface-2)' : 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        borderRadius: 8,
        fontSize: '0.68rem',
        padding: '3px 10px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <i className="bi bi-clock-history" />
      <span>Copy from previous</span>
    </button>
  );
}

function ArraySection({ items, setItems, fields, addLabel }) {
  const add = () => {
    const empty = {};
    fields.forEach(f => { empty[f.key] = ''; });
    setItems([...items, empty]);
  };
  const remove = (i) => setItems(items.filter((_, idx) => idx !== i));
  const update = (i, key, val) => {
    const copy = [...items];
    copy[i] = { ...copy[i], [key]: val };
    setItems(copy);
  };

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} className="d-flex flex-wrap gap-2 align-items-end mb-2 p-2 rounded-3" style={{ background: 'var(--surface-2)' }}>
          <div className="text-muted fw-bold" style={{ fontSize: '0.68rem', width: 20, textAlign: 'center', paddingBottom: 8 }}>
            {i + 1}
          </div>
          {fields.map(f => (
            <Field key={f.key} label={f.label} value={item[f.key] || ''} type={f.type || 'text'}
              onChange={v => update(i, f.key, v)} width={f.width} placeholder={f.placeholder} />
          ))}
          {items.length > 1 && (
            <button className="btn btn-sm btn-outline-danger border-0 mb-1" onClick={() => remove(i)}
              style={{ padding: '2px 8px', fontSize: '0.75rem' }}>
              <i className="bi bi-trash3" />
            </button>
          )}
        </div>
      ))}
      <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 mt-1"
        style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={add}>
        <i className="bi bi-plus-circle" /> {addLabel || 'Add Row'}
      </button>
    </div>
  );
}

/* ── Main Form ────────────────────────────────────────────────────────────── */

export default function WeeklyReportForm({ editReportId, onSaved, onCancel, prefillBrandId = null }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '' } : null;
  const userProfile = { displayName: profile?.display_name || '' };
  const { brands } = useBrands();

  const [selectedBrand, setSelectedBrand] = useState(null);
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [existingReports, setExistingReports] = useState([]);
  const [data, setData] = useState(emptyReport());
  // Which section panel the immersive editor is showing (one at a time).
  // Declared at the top (before the step early-returns) to keep hook order
  // stable across renders.
  const [activeSection, setActiveSection] = useState('seller');

  // Auto-save to localStorage every 30s so a mid-edit sign-out, tab
  // crash, deploy, or any of the bugs analyzed in the report-editor
  // investigation (Brands realtime wipe, profile-null unmount, SW
  // nav) doesn't destroy work. Enabled for BOTH new and edit modes;
  // editId in the key prevents drafts of different reports from
  // colliding. Edit-mode drafts are restored only if newer than the
  // server data the load-effect just pulled.
  const draftKey = {
    type: 'weekly',
    uid: currentUser?.uid,
    brandId: selectedBrand?.id,
    periodStart: selectedWeek?.startDate,
    editId: editReportId || null,
  };
  const { clear: clearLocalDraft } = useReportAutosave({
    ...draftKey,
    data,
  });
  // Restore any locally-saved draft once we know brand + period.
  // For new reports: restore directly. For edits: only restore if
  // the local draft is newer than the server's updated_at (or close
  // — within 10s of the load — since server time can drift). This
  // way a stale draft from a previous session doesn't clobber what
  // someone else may have legitimately saved in the meantime.
  const restoredKeyRef = useRef('');
  useEffect(() => {
    if (!draftKey.uid || !draftKey.brandId || !draftKey.periodStart) return;
    const k = `${draftKey.uid}|${draftKey.brandId}|${draftKey.periodStart}|${draftKey.editId || ''}`;
    if (restoredKeyRef.current === k) return;
    restoredKeyRef.current = k;
    const saved = loadDraft(draftKey);
    if (saved?.data) {
      setData((d) => ({ ...d, ...saved.data }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey.uid, draftKey.brandId, draftKey.periodStart, draftKey.editId]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!editReportId);
  // Unsaved-changes guard — flips true on the first edit, back to
  // false after a successful save. While true, a stale-deploy
  // auto-reload is suppressed and a beforeunload prompt is armed so
  // in-progress report data can't be silently lost.
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  // P5 — reference-equality dirty tracking. The onInput={() => setDirty(true)}
  // catch-all in the form body only fires on native input bubbles, so
  // PDF Import, AI Generate, RichTextEditor onChange, date pickers and
  // section toggles all bypass it. Here we capture the data baseline
  // once loading completes and flip dirty=true whenever the `data`
  // ref changes from that baseline — covering every setData path with
  // no deep-equality cost (ref compare is O(1)).
  const initialDataRef = useRef(null);
  useEffect(() => {
    if (loading) return;
    if (initialDataRef.current === null) initialDataRef.current = data;
  }, [loading, data]);
  useEffect(() => {
    if (initialDataRef.current === null) return;
    if (data === initialDataRef.current) return;
    setDirty(true);
  }, [data]);
  const [detectingWeek, setDetectingWeek] = useState(false);
  const [aiLoading, setAiLoading] = useState({}); // per-section loading state
  const [customFieldDefs, setCustomFieldDefs] = useState([]); // [{id, name}]
  // Per-brand custom sections defined on the Brand → Report Sections panel.
  // Brand-scoped custom sections + per-built-in-section extras, loaded and
  // persisted by the shared hook (also used by the Monthly form). Values live
  // in data.customFields keyed by field id (table) or section id (long_text).
  const {
    brandSectionDefs, brandSectionExtras,
    addExtraField, removeExtraField, addBrandCustomSection, deleteBrandCustomSection,
  } = useBrandSections({ brandId: selectedBrand?.id, setData, reportType: 'weekly' });
  const [reportStatus, setReportStatus] = useState('draft');
  const [rejectionNote, setRejectionNote] = useState('');
  const [importing, setImporting] = useState(false);
  const [importToast, setImportToast] = useState(null);
  const pdfInputRef = React.useRef(null);

  // ── Auto Generate from Euka ──────────────────────────────────────
  // eukaModal: 'period' (pick the 7-day stats window) | 'running' (non-
  // dismissable progress) | 'done' (success summary) | 'error' (copyable).
  const [eukaModal, setEukaModal]   = useState(null);
  const [eukaStart, setEukaStart]   = useState('');   // stats window start (YYYY-MM-DD)
  const [eukaEnd, setEukaEnd]       = useState('');   // stats window end (start+6)
  const [eukaResult, setEukaResult] = useState(null); // { meta, period }
  const [eukaError, setEukaError]   = useState(null); // { message, copyText }

  // Step: 0=brand, 1=first-time week pick, 2=form
  const [step, setStep] = useState(editReportId ? 2 : 0);

  const myBrands = brands;

  // Auto-select brand:
  //   1. If parent passed a prefillBrandId (e.g. TL clicked "New Report"
  //      from inside a brand-detail page), pre-select that brand and
  //      skip the brand-picker step entirely.
  //   2. Otherwise, if the user only has ONE brand to choose from,
  //      auto-select it (no point in showing a picker with one option).
  useEffect(() => {
    if (editReportId || selectedBrand) return;
    if (prefillBrandId) {
      const match = myBrands.find((b) => b.id === prefillBrandId);
      if (match) { setSelectedBrand(match); return; }
    }
    if (myBrands.length === 1) {
      setSelectedBrand(myBrands[0]);
    }
  }, [myBrands, selectedBrand, editReportId, prefillBrandId]);

  // Load user's custom field templates ONCE per uid.
  // Earlier the dep was the whole `currentUser` object, which gets
  // a fresh identity on every render (rebuilt from {user, profile}).
  // That re-fired this effect on every render — including the one
  // right after addCustomField/renameCustomField/deleteCustomField
  // called setCustomFieldDefs. Firestore still held the previous
  // value (the persist is async), so the freshly added section got
  // clobbered back to the old list. Refresh "worked" because by then
  // the persist had landed.
  //
  // Depending on the stable `uid` primitive makes this fire exactly
  // once per user, letting our local optimistic updates stick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!currentUser?.uid) return;
    getUserCustomFields(currentUser.uid).then(setCustomFieldDefs).catch(() => {});
  }, [currentUser?.uid]);

  // (Brand-section load + CRUD handlers now come from useBrandSections above.)

  // When brand is selected: load reports, detect next week, advance step — all in one effect
  useEffect(() => {
    if (!selectedBrand || editReportId) return;
    let cancelled = false;
    setDetectingWeek(true);

    getReportsForBrand(selectedBrand.id).then(reports => {
      if (cancelled) return;
      setExistingReports(reports);
      setDetectingWeek(false);

      if (reports.length === 0) {
        // First report ever — let APC pick the starting week
        setStep(1);
      } else {
        // Auto-detect next week: last report's end + 1 day
        const next = detectNextWeek(reports);
        if (next) {
          setSelectedWeek(next);
          setStep(2);
        } else {
          setStep(1);
        }
      }
    });

    return () => { cancelled = true; };
  }, [selectedBrand, editReportId]);

  // Always load existing reports when brand is selected (needed for edit mode AI comparison)
  useEffect(() => {
    if (!selectedBrand || !editReportId) return;
    getReportsForBrand(selectedBrand.id).then(setExistingReports);
  }, [selectedBrand, editReportId]);

  // First-time anchor date picker (replaces hardcoded week options)
  const [weekStartInput, setWeekStartInput] = useState('');
  // Starting week number for the first-time anchor. Defaults to 1
  // (fresh brand). Brands that were tracked outside the app before
  // launch (Google Docs etc.) can start at any number — e.g. enter 7
  // here and the next report will pick up at week 8 automatically.
  const [startWeekNumInput, setStartWeekNumInput] = useState(1);

  // Load report for editing.
  //
  // CRITICAL: deps are [editReportId] ONLY — NOT [editReportId, brands].
  // BrandsContext subscribes to Supabase Realtime on the entire brands
  // table; any brand mutation anywhere in the org produces a new
  // `brands` array reference, which would re-fire this effect, call
  // setLoading(true), re-fetch the report, and setData(...) over the
  // user's typed edits. That manifested as "I was editing and my
  // changes disappeared" — root cause analyzed 2026-06-01.
  //
  // The brand object is captured ONCE at load time; subsequent brand
  // mutations don't affect the editor's in-progress data.
  useEffect(() => {
    if (!editReportId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await getReport(editReportId);
        if (cancelled) return;
        if (r) {
          // brands may not be loaded yet on a deep-link refresh —
          // fall back to a stub with the report's own brand fields
          // so the editor renders. A later brands fetch won't
          // re-trigger this effect (intentional), and the stub
          // carries enough info (id + name) for save/display.
          const brand = brands.find(b => b.id === r.brandId);
          setSelectedBrand(brand || { id: r.brandId, name: r.brandName });
          setSelectedWeek({ week: r.week, startDate: r.weekStart, endDate: r.weekEnd, label: r.weekLabel, year: r.year, month: r.month });
          setData({
            overallPerformance: r.overallPerformance || emptyReport().overallPerformance,
            overallNotes: r.overallNotes || {},
            overallInsights: r.overallInsights || '',
            topCreators: r.topCreators || emptyReport().topCreators,
            topCreatorsInsights: r.topCreatorsInsights || '',
            topVideos: r.topVideos || emptyReport().topVideos,
            topVideosInsights: r.topVideosInsights || '',
            gmvMax: r.gmvMax || emptyReport().gmvMax,
            gmvMaxMtd: r.gmvMaxMtd || emptyReport().gmvMaxMtd,
            gmvMaxInsights: r.gmvMaxInsights || '',
            productHighlights: r.productHighlights || emptyReport().productHighlights,
            productHighlightsInsights: r.productHighlightsInsights || '',
            offsitePerformance: r.offsitePerformance || emptyReport().offsitePerformance,
            offsiteInsights: r.offsiteInsights || '',
            upcomingCampaigns: r.upcomingCampaigns || '',
            operationalUpdates: r.operationalUpdates || '',
            recommendations: [r.recommendations, r.actionItems].filter(s => s && s.trim()).join('\n\n') || '',
            actionItems: '',
            // Consolidated single insights. For a report authored on the new
            // form use its own reportInsights; for a legacy report being
            // edited, non-destructively seed it from the six per-section
            // fields (which are ALSO kept above, so nothing is dropped).
            reportInsights: r.reportInsights ?? [r.overallInsights, r.topCreatorsInsights, r.topVideosInsights, r.gmvMaxInsights, r.productHighlightsInsights, r.offsiteInsights].filter(s => s && String(s).trim()).join('\n\n'),
            insightsSingle: true,
            customFields: r.customFields || {},
            sectionsEnabled: resolveWeeklySectionsEnabled(r.sectionsEnabled),
          });
          setReportStatus(r.status || 'approved');
          setRejectionNote(r.rejectionNote || '');
          setStep(2);
        }
      } catch (e) {
        // Don't wedge on the loading spinner if getReport throws
        // (RLS hiccup, JWT rotation, transient network). The caller's
        // Cancel button still works; the editor falls back to its
        // initial state and at least the user isn't stuck.
        console.warn('Failed to load report for editing:', e?.message || e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editReportId]);

  // Immersive full-viewport editor: request native fullscreen while the
  // data-entry form (step 2) is open so the report gets a distraction-free
  // canvas. Best-effort only — fullscreen is commonly blocked when not tied
  // to a user gesture; always swallow the rejection and never throw. Exit on
  // unmount if we're still in fullscreen.
  useEffect(() => {
    if (step !== 2) return undefined;
    try { document.documentElement.requestFullscreen?.()?.catch?.(() => {}); } catch { /* ignore */ }
    return () => {
      try { if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* ignore */ }
    };
  }, [step]);

  const handleBrandSelect = (brand) => {
    setSelectedBrand(brand);
    // Step will be set by the useEffect after reports load
  };

  const handleWeekSelect = (w) => {
    setSelectedWeek(w);
    setStep(2);
  };

  const handleSetWeeklyAnchor = () => {
    if (!weekStartInput) return;
    const num = Math.max(1, Math.floor(Number(startWeekNumInput) || 1));
    const w = makeWeekFromStart(weekStartInput, num);
    setSelectedWeek(w);
    setStep(2);
  };

  // Data updaters
  const setPerf = useCallback((key, val) => {
    setData(d => ({ ...d, overallPerformance: { ...d.overallPerformance, [key]: val } }));
  }, []);
  const setPerfNote = useCallback((key, val) => {
    setData(d => ({ ...d, overallNotes: { ...d.overallNotes, [key]: val } }));
  }, []);
  const setOffsite = useCallback((key, val) => {
    setData(d => ({ ...d, offsitePerformance: { ...d.offsitePerformance, [key]: val } }));
  }, []);

  // Previous report = the one created *before* this one for the same brand.
  // Previous report = the closest earlier week for this brand. Routed
  // through findPreviousReport (lib/reportsApi.js) so the Edit screen
  // agrees with the View screen — both compare by weekStart, not by
  // createdAt. createdAt-based ordering produced visible mismatches:
  // a report created out-of-order (OL backfill, fixed week edit) made
  // Edit pick a different "previous" than the View, so the two showed
  // contradictory WoW deltas to the same user on the same report.
  const previousReport = useMemo(() => {
    if (!existingReports.length || !selectedWeek) return null;
    const current = editReportId
      ? existingReports.find(r => r.id === editReportId)
      : { id: '__pending__', brandId: selectedBrand?.id, weekStart: selectedWeek.startDate };
    if (!current) return null;
    return findPreviousReport(existingReports, current);
  }, [existingReports, selectedWeek, editReportId, selectedBrand?.id]);

  // "Total Videos (all-time)" auto-accumulates: the previous report's all-time
  // total + this week's "Videos Posted". We only auto-compute when the prior
  // report actually has a numeric all-time; otherwise the field stays editable
  // so the FIRST report can set the historical baseline (the chain takes over
  // from the next week on). Computed for display + injected at save (see
  // _doSave) rather than written live, so loading a report never falsely marks
  // the form dirty.
  const prevAllTimeRaw = previousReport?.overallNotes?.videosPosted;
  const prevAllTimeVideos = (prevAllTimeRaw === '' || prevAllTimeRaw == null) ? NaN : Number(prevAllTimeRaw);
  const hasPrevAllTime = Number.isFinite(prevAllTimeVideos);
  const weeklyVideos = Number(data.overallPerformance.videosPosted) || 0;
  const autoTotalVideos = hasPrevAllTime ? prevAllTimeVideos + weeklyVideos : null;

  // Pre-fill Product Highlights from the most recent prior report that
  // actually has products (new-report path only — never on edit). Walk
  // back through history because the immediately previous report may
  // itself be empty.
  useEffect(() => {
    if (editReportId) return;
    if (!existingReports.length || !selectedWeek) return;
    const tsOf = (r) => r.createdAt?.toMillis ? r.createdAt.toMillis()
      : r.createdAt?.seconds ? r.createdAt.seconds * 1000
      : null;
    const ordered = [...existingReports]
      .filter((r) => (r.weekStart || '') < selectedWeek.startDate)
      .sort((a, b) => {
        const aTs = tsOf(a), bTs = tsOf(b);
        if (aTs != null && bTs != null) return bTs - aTs;
        return (b.weekStart || '').localeCompare(a.weekStart || '');
      });
    let prevProducts = [];
    for (const r of ordered) {
      const found = (r.productHighlights || []).filter((p) =>
        (p.productId && p.productId.trim()) ||
        (p.productName && p.productName.trim())
      );
      if (found.length > 0) { prevProducts = found; break; }
    }
    if (prevProducts.length === 0) return;
    setData((d) => {
      const current = d.productHighlights || [];
      const userTyped = current.some((p) =>
        (p.productId && p.productId.trim()) ||
        (p.productName && p.productName.trim()) ||
        p.unitsSold || p.gmv || p.newVideos || p.notes
      );
      if (userTyped) return d;
      return {
        ...d,
        productHighlights: prevProducts.map((p) => ({
          productId:   p.productId || '',
          productName: p.productName || '',
          unitsSold:   '',
          gmv:         '',
          newVideos:   '',
          videosMtd:   '',
          samplesApprovedWeek: '',
          samplesApprovedMtd:  '',
          notes:       '',
        })),
      };
    });
  }, [existingReports, selectedWeek, editReportId]);

  // Duplicate prevention applies to ALL roles — one report per (brand, week).
  // Without this, a Save Draft would merge into and overwrite an existing
  // approved report (since the doc ID is `${brandId}_${weekStart}`).
  // pendingPrior remains APC-only as a workflow guard, not a data guard.
  const isApc = userRole === 'apc';
  // Product figure was "units/items sold" on older reports, "orders" going
  // forward. Label by when THIS report was authored (new report → 'Orders').
  const productUnitsLbl = useMemo(() => {
    const edited = editReportId ? existingReports.find(r => r.id === editReportId) : null;
    return productUnitsLabel(edited?.createdAt);
  }, [editReportId, existingReports]);
  const duplicateForThisWeek = useMemo(() => {
    if (!existingReports.length || !selectedWeek) return null;
    return existingReports.find(r =>
      r.weekStart === selectedWeek.startDate &&
      r.id !== editReportId &&
      r.status && r.status !== 'draft'
    ) || null;
  }, [existingReports, selectedWeek, editReportId]);
  // APC can submit the next report once the previous one is at least VERIFIED
  // by the Team Lead (status 'verified' or 'approved'). Block only while a prior
  // report is still unverified — draft / submitted / returned.
  const priorPendingApproval = useMemo(() => {
    if (!isApc || !previousReport) return null;
    const s = previousReport.status;
    return (s && s !== 'verified' && s !== 'approved') ? previousReport : null;
  }, [isApc, previousReport]);
  const submitBlock = duplicateForThisWeek
    ? { kind: 'duplicate', report: duplicateForThisWeek }
    : priorPendingApproval
      ? { kind: 'pendingPrior', report: priorPendingApproval }
      : null;

  const brandName = selectedBrand?.name || selectedBrand?.brandName || 'Unknown';

  // AI insight generator for a single section
  const runAi = async (section, fn, insightKey) => {
    setAiLoading(s => ({ ...s, [section]: true }));
    try {
      const text = await fn(data, previousReport, brandName, selectedWeek?.label || '');
      setData(d => ({ ...d, [insightKey]: text }));
    } catch (err) {
      alert('AI generation failed: ' + err.message);
    } finally {
      setAiLoading(s => ({ ...s, [section]: false }));
    }
  };

  // Custom field management (persisted to user's template).
  //
  // Earlier version captured `customFieldDefs` from the closure and
  // wrote `[...customFieldDefs, newField]` straight back. Two problems:
  //   1. If the user clicks Add twice quickly, the second handler reads
  //      stale `customFieldDefs` (React hadn't committed the first
  //      update yet) and writes only ONE of the two new fields — the
  //      other gets lost. Same flaw on rename/delete.
  //   2. `cf_${Date.now()}` collides if two adds happen in the same
  //      millisecond, breaking React's key reconciliation.
  // Fix: use the functional `setState(prev => ...)` form so we always
  // operate on the freshest array. Persist the SAME computed array
  // back to Firestore from inside the updater closure. Add randomness
  // to the id so back-to-back clicks never collide.
  function nextFieldId() {
    return `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
  const persistDefs = async (defs) => {
    try { await saveUserCustomFields(currentUser.uid, defs); }
    catch (e) { console.error('saveUserCustomFields failed:', e); }
  };

  const addCustomField = () => {
    // Prompt OUTSIDE the state updater — StrictMode runs the updater
    // twice in dev, which would fire the prompt twice.
    const name = window.prompt('Name for new custom field:', 'Notes');
    if (!name || !name.trim()) return;
    const trimmedName = name.trim();
    const newField = { id: nextFieldId(), name: trimmedName };
    setCustomFieldDefs((prev) => {
      // Guard against duplicate names (case-insensitive). Returning the
      // same array reference is fine — React will bail out of the render.
      if (prev.some((f) => f.name.trim().toLowerCase() === trimmedName.toLowerCase())) {
        return prev;
      }
      const next = [...prev, newField];
      persistDefs(next);
      return next;
    });
  };

  const renameCustomField = (fieldId) => {
    // Prompt OUTSIDE the updater — putting it inside would fire twice
    // under React 18 StrictMode (updaters are called twice in dev).
    const current = customFieldDefs.find((f) => f.id === fieldId);
    const name = window.prompt('Rename field:', current?.name || '');
    if (!name || !name.trim()) return;
    setCustomFieldDefs((prev) => {
      const next = prev.map((f) => (f.id === fieldId ? { ...f, name: name.trim() } : f));
      persistDefs(next);
      return next;
    });
  };

  const deleteCustomField = (fieldId) => {
    if (!window.confirm('Remove this custom field from all future reports? (Existing reports keep their data)')) return;
    setCustomFieldDefs((prev) => {
      const next = prev.filter((f) => f.id !== fieldId);
      persistDefs(next);
      return next;
    });
  };

  const setCustomFieldValue = useCallback((fieldId, val, name) => {
    setData(d => ({
      ...d,
      customFields: { ...(d.customFields || {}), [fieldId]: { name, value: val } },
    }));
  }, []);

  // Validation — return array of missing field names. Disabled sections
  // (via the inline toggle on each SectionHeader) are skipped entirely so
  // hiding a section also hides its required-field checks.
  const validate = () => {
    const missing = [];
    const en = resolveWeeklySectionsEnabled(data.sectionsEnabled);
    if (en.overallPerformance) {
      const op = data.overallPerformance || {};
      const opRequired = {
        gmv: 'GMV', affiliateGmv: 'Affiliate GMV', orders: 'Orders',
        samplesApproved: 'Samples Approved', roi: 'ROI',
        shopPerformanceScore: 'Shop Performance Score', videosPosted: 'Videos Posted',
      };
      Object.entries(opRequired).forEach(([k, label]) => {
        if (op[k] === '' || op[k] == null) missing.push(`Overall: ${label}`);
      });
      if (!data.overallNotes?.samplesApproved) missing.push('Overall: MTD Approved');
      // Total Videos (all-time) is auto-computed when a prior all-time exists
      // (injected at save), so only require manual entry on the first report.
      if (!hasPrevAllTime && !data.overallNotes?.videosPosted) missing.push('Overall: Total Videos');
    }

    if (en.topCreators && !(data.topCreators || []).some(c => c.name && c.name.trim()))
      missing.push('Top Creators (at least 1 with name)');
    if (en.topVideos) {
      if (!(data.topVideos || []).some(v => v.creatorName && v.creatorName.trim()))
        missing.push('Top Videos (at least 1 with creator name)');
      // Every video row that has a creator name must also have a (valid-looking) video link.
      (data.topVideos || []).forEach((v, i) => {
        const hasName = v.creatorName && v.creatorName.trim();
        const link = (v.videoLink || '').trim();
        if (hasName && !link) missing.push(`Top Videos row ${i + 1}: Video Link is required`);
        else if (hasName && !/^https?:\/\//i.test(link)) missing.push(`Top Videos row ${i + 1}: Video Link must start with http:// or https://`);
      });
    }
    if (en.gmvMax && !(data.gmvMax || []).some(g => g.campaign && g.campaign.trim()))
      missing.push('GMV Max (at least 1 with campaign)');
    if (en.productHighlights && !(data.productHighlights || []).some(p => p.productName && p.productName.trim()))
      missing.push('Product Highlights (at least 1 with product name)');

    if (en.upcomingCampaigns && (!data.upcomingCampaigns || !data.upcomingCampaigns.trim()))
      missing.push('Current & Upcoming Campaigns');
    if (en.operationalUpdates && (!data.operationalUpdates || !data.operationalUpdates.trim()))
      missing.push('Operational Updates');
    // Offsite Performance, Recommendations & Action Items are optional

    return missing;
  };

  const handleImportPdf = async (file) => {
    if (!file) return;
    setImporting(true);
    setImportToast(null);
    try {
      const parsed = await parsePdfToReport(file);
      const diag = parsed.__diagnostics || {};
      delete parsed.__diagnostics;

      // Merge into form: only overwrite keys the parser actually filled.
      setData(d => {
        const next = { ...d };
        if (parsed.overallPerformance) {
          next.overallPerformance = { ...d.overallPerformance, ...parsed.overallPerformance };
        }
        if (parsed.offsitePerformance) {
          next.offsitePerformance = { ...d.offsitePerformance, ...parsed.offsitePerformance };
        }
        if (parsed.topCreators?.length)       next.topCreators = parsed.topCreators;
        if (parsed.topVideos?.length)         next.topVideos = parsed.topVideos;
        if (parsed.gmvMax?.length)            next.gmvMax = parsed.gmvMax;
        if (parsed.productHighlights?.length) next.productHighlights = parsed.productHighlights;
        if (parsed.recommendations)           next.recommendations = parsed.recommendations;
        return next;
      });

      const filled = [];
      if (diag.overallFields > 0)  filled.push(`${diag.overallFields} performance metrics`);
      if (diag.creators > 0)       filled.push(`${diag.creators} creators`);
      if (diag.videos > 0)         filled.push(`${diag.videos} videos${diag.videosWithLink > 0 ? ` (${diag.videosWithLink} with links)` : ''}`);
      if (diag.gmvMax > 0)         filled.push(`${diag.gmvMax} GMV Max rows`);
      if (diag.products > 0)       filled.push(`${diag.products} products`);
      if (diag.hasNarrative)       filled.push('narrative content (in Recommendations — split as needed)');

      setImportToast({
        kind: filled.length ? 'success' : 'warn',
        msg: filled.length
          ? `Imported: ${filled.join(', ')}. Review and edit before submitting.`
          : 'PDF read but nothing matched the report sections — please check section headings in the doc.',
      });
    } catch (err) {
      console.error(err);
      setImportToast({ kind: 'error', msg: 'Failed to read PDF: ' + (err.message || 'unknown error') });
    } finally {
      setImporting(false);
      if (pdfInputRef.current) pdfInputRef.current.value = '';
    }
  };

  // ── Auto Generate from Euka ──────────────────────────────────────
  const brandHasEuka = !!selectedBrand?.euka_store_id;

  const addDaysStr = (d, n) => {
    const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  // Open the period picker, defaulting the stats window to the report's week.
  const openEukaAutofill = () => {
    const s = selectedWeek?.startDate || '';
    setEukaStart(s);
    setEukaEnd(s ? addDaysStr(s, 6) : (selectedWeek?.endDate || ''));
    setEukaError(null);
    setEukaModal('period');
  };
  // Keep the window a 7-day span: end auto-follows the start.
  const onEukaStartChange = (v) => { setEukaStart(v); if (v) setEukaEnd(addDaysStr(v, 6)); };

  const runEukaAutofill = async () => {
    if (!brandHasEuka || !eukaStart || !eukaEnd) return;
    setEukaModal('running');
    setEukaError(null);
    try {
      const res = await runEukaReportAutofill({
        brandId: selectedBrand.id, startDate: eukaStart, endDate: eukaEnd,
      });
      setData((d) => mergeAutofill(d, res.data));
      setDirty(true);
      setEukaResult({ meta: res.meta, period: res.period });
      setEukaModal('done');
    } catch (err) {
      // Build a copy-for-Discord block: human message + machine detail.
      const stamp = new Date().toISOString();
      const copyText = [
        'WurxOS · Auto Generate from Euka — error',
        `Brand: ${brandLabel} (${selectedBrand?.id})`,
        `Report week: ${selectedWeek?.label || '—'}`,
        `Stats period: ${eukaStart} → ${eukaEnd}`,
        `When: ${stamp}`,
        `Message: ${err?.message || 'unknown'}`,
        `Detail: ${JSON.stringify(err?.detail ?? null)}`,
      ].join('\n');
      setEukaError({ message: err?.message || 'Auto-fill failed.', copyText });
      setEukaModal('error');
    }
  };

  const copyEukaError = () => {
    if (!eukaError?.copyText) return;
    try { navigator.clipboard?.writeText(eukaError.copyText); } catch { /* ignore */ }
  };

  const handleGenerateAll = async () => {
    setAiLoading({ all: true });
    try {
      const insights = await generateAllInsights(data, previousReport, brandName, selectedWeek?.label || '');
      setData(d => ({ ...d, ...insights }));
    } catch (err) {
      alert('AI generation failed: ' + err.message);
    } finally {
      setAiLoading({});
    }
  };

  // Allow user to change the week of a report being edited
  const handleChangeWeek = async () => {
    if (!editReportId || !selectedBrand) return;
    const input = window.prompt(
      `Enter the new starting date for this report (YYYY-MM-DD).\n\nCurrent: ${selectedWeek?.label}`,
      selectedWeek?.startDate || ''
    );
    if (!input) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) { alert('Invalid date format. Use YYYY-MM-DD.'); return; }
    const newWeek = makeWeekFromStart(input, selectedWeek?.week || 1);
    if (newWeek.startDate === selectedWeek?.startDate) return;
    if (!window.confirm(`Change week to: ${newWeek.label}? The report will be re-saved under the new date.`)) return;
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      const newId = await changeReportWeek(editReportId, newWeek, {
        brandId: selectedBrand.id,
        brandName: selectedBrand.name || selectedBrand.brandName || 'Unknown',
        ...data,
        createdBy: currentUser.uid,
        createdByName: userName,
      });
      alert('Week changed successfully. The report list will refresh.');
      if (onSaved) onSaved({ id: newId, brandId: selectedBrand.id });
    } catch (err) {
      alert('Failed to change week: ' + err.message);
    }
  };

  const _doSave = async (status, extra = {}, opts = {}) => {
    if (!selectedBrand || !selectedWeek) return;
    setSaving(true);
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      // Strip user-level custom fields whose def the user has deleted —
      // otherwise the view would keep rendering them from the stored
      // report doc. Brand-defined sections and built-in section extras
      // live on a different template and are preserved by their entry's
      // own metadata (kind / source), not by membership in customFieldDefs.
      const userFieldIds = new Set(customFieldDefs.map(f => f.id));
      const cleanedCustomFields = cleanCustomFields(data.customFields, userFieldIds);
      const cleanedData = { ...data, customFields: cleanedCustomFields };
      // Persist the auto-accumulated all-time video total (previous all-time +
      // this week's Videos Posted) so the next week reads it as its baseline.
      if (hasPrevAllTime) {
        cleanedData.overallNotes = { ...(data.overallNotes || {}), videosPosted: autoTotalVideos };
      }
      const savedId = await saveReport({
        brandId: selectedBrand.id,
        brandName,
        weekInfo: selectedWeek,
        data: cleanedData,
        uid: currentUser.uid,
        userName,
        status,
        extraFields: extra,
      });
      // Successful save — drop the local auto-save backup. The
      // server now has the canonical copy.
      clearLocalDraft();
      setDirty(false); // changes are persisted — release the guard
      setReportStatus(status); // keep the form's status pill in sync
      // `opts.stay` (used by the leave-guard draft save) persists silently
      // without bubbling the navigate-away that onSaved triggers.
      if (!opts.stay && onSaved) onSaved({
        id: savedId,
        brandId: selectedBrand.id,
        brandName,
        weekLabel: selectedWeek.label,
        weekStart: selectedWeek.startDate,
        weekEnd: selectedWeek.endDate,
        week: selectedWeek.week,
        year: selectedWeek.year,
        month: selectedWeek.month,
        createdByName: userName,
        status,
        ...data,
        ...extra,
      });
      return savedId;
    } catch (err) {
      alert('Failed to save report: ' + err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Save progress without validation — keeps current draft status */
  const handleSaveDraft = () => _doSave('draft', { rejectionNote: rejectionNote || null });

  // Leave-guard: persist the current state as a draft WITHOUT navigating
  // (preserves the report's current status — 'draft' for a new report).
  const onSaveDraft = () => _doSave(reportStatus, { rejectionNote: rejectionNote || null }, { stay: true });
  const { guardModal, guardAction } = useReportLeaveGuard({ dirty, onSaveDraft });
  const { headerRef, rteTopStyle } = useStickyHeaderOffset();

  /** Save without status change — used by TL/OL editing a non-draft report */
  const handleSaveChanges = () => _doSave(reportStatus);

  /** Validate then submit — sets status to 'submitted' and locks APC editing */
  const handleSubmitReport = async () => {
    if (!selectedBrand || !selectedWeek) return;
    if (submitBlock?.kind === 'duplicate') {
      alert(`You've already submitted a report for ${selectedWeek.label}. You can't submit another one for the same week.`);
      return;
    }
    if (submitBlock?.kind === 'pendingPrior') {
      const prev = submitBlock.report;
      alert(`Your previous report (${prev.weekLabel}) hasn't been verified by the Team Lead yet. It must be verified before you can submit a new one.`);
      return;
    }
    const missing = validate();
    if (missing.length > 0) {
      alert('Please fill in all required fields before submitting:\n\n• ' + missing.join('\n• '));
      return;
    }
    if (!window.confirm('Submit this report for Team Lead review?\n\nOnce submitted you will not be able to edit it unless the TL rejects it back to you.')) return;
    const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
    await _doSave('submitted', {
      rejectionNote: null,
      submittedAt: new Date().toISOString(),
      submittedBy: currentUser.uid,
      submittedByName: userName,
    });
    notifyReportSubmitted({
      report: {
        id: `${selectedBrand.id}_${selectedWeek.startDate}`,
        brandId: selectedBrand.id,
        brandName: selectedBrand.name || selectedBrand.brandName,
        weekLabel: selectedWeek.label,
        createdBy: currentUser.uid,
      },
      sender: { uid: currentUser.uid, name: userName },
      type: 'weekly',
    });
  };

  if (loading) {
    return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading report…</div>;
  }

  /* ── Step 0: Brand selection ──────────────────────────────────────────── */
  if (step === 0) {
    // If brand auto-selected but still detecting week, show loading
    if (detectingWeek) {
      return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Detecting next week…</div>;
    }

    return (
      <div>
        {guardModal}
        {onCancel && (
          <button className="btn btn-sm btn-link text-muted p-0 mb-3" onClick={() => guardAction(onCancel)}>
            <i className="bi bi-arrow-left me-1" /> Back to reports
          </button>
        )}
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>New Weekly Report</h5>
        <p className="text-muted small mb-4">Select the brand you're reporting for</p>
        <div className="row g-3">
          {myBrands.map(b => (
            <div key={b.id} className="col-md-6 col-lg-4">
              <button className="card border-0 shadow-sm w-100 text-start" style={{ borderRadius: 14, cursor: 'pointer' }}
                onClick={() => handleBrandSelect(b)}>
                <div className="card-body p-3 d-flex align-items-center gap-3">
                  <div className="rounded-2 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                    style={{ width: 42, height: 42, fontSize: '0.7rem', background: '#3b82f6' }}>
                    {(b.name || b.brandName || '??').slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="fw-bold" style={{ fontSize: '0.9rem' }}>{b.name || b.brandName}</div>
                    <div className="text-muted" style={{ fontSize: '0.7rem' }}>Select to report</div>
                  </div>
                  <i className="bi bi-chevron-right ms-auto text-muted" />
                </div>
              </button>
            </div>
          ))}
          {myBrands.length === 0 && (
            <div className="text-center py-4 text-muted">
              <i className="bi bi-shop" style={{ fontSize: '2rem' }} />
              <p className="mt-2">No brands assigned to you.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Step 1: First-time week anchor picker (only when no reports exist) ── */
  if (step === 1) {
    let previewEnd = '';
    let startDisplay = '';
    if (weekStartInput) {
      const d = new Date(weekStartInput + 'T00:00:00');
      const e = new Date(d); e.setDate(e.getDate() + 6);
      startDisplay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      previewEnd = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return (
      <div>
        <button className="btn btn-sm btn-link text-muted p-0 mb-3"
          onClick={() => { setStep(0); setSelectedBrand(null); setWeekStartInput(''); setStartWeekNumInput(1); }}>
          <i className="bi bi-arrow-left me-1" /> Back to brands
        </button>
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          {selectedBrand?.name || selectedBrand?.brandName} — Set Weekly Anchor
        </h5>
        <p className="text-muted small mb-4">
          This is the first weekly report for this brand. Pick the starting date and
          which week number you&apos;re on — all future reports follow from here.
        </p>
        <div className="card border-0 shadow-sm" style={{ borderRadius: 14, maxWidth: 460 }}>
          <div className="card-body p-4">
            <div className="row g-2">
              <div className="col-7">
                <label className="form-label fw-semibold" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <i className="bi bi-calendar-week me-1 text-primary" /> Starting date
                </label>
                <input
                  type="date"
                  className="form-control"
                  value={weekStartInput}
                  onChange={e => setWeekStartInput(e.target.value)}
                  style={{ borderRadius: 8, fontSize: '0.85rem' }}
                />
              </div>
              <div className="col-5">
                <label className="form-label fw-semibold" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <i className="bi bi-hash me-1 text-primary" />Week #
                </label>
                <input
                  type="number"
                  min="1"
                  className="form-control"
                  value={startWeekNumInput}
                  onChange={e => setStartWeekNumInput(e.target.value)}
                  style={{ borderRadius: 8, fontSize: '0.85rem' }}
                />
              </div>
            </div>
            <div className="text-muted small mt-2 mb-3" style={{ fontSize: '0.7rem' }}>
              Use <strong>1</strong> for a brand new chain. If you&apos;ve been reporting outside the app
              (e.g. Google Docs) and you&apos;re currently on week 7, enter <strong>7</strong> — the next report will pick up at week 8.
            </div>
            {weekStartInput && (
              <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)' }}>
                <div className="fw-semibold" style={{ fontSize: '0.8rem', color: 'var(--info)' }}>
                  <i className="bi bi-calendar-check me-1" /> Week {Math.max(1, Math.floor(Number(startWeekNumInput) || 1))} Preview
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--info)', marginTop: 4 }}>
                  {startDisplay} — {previewEnd}
                </div>
                <div className="text-muted mt-1" style={{ fontSize: '0.7rem' }}>
                  Week {Math.max(1, Math.floor(Number(startWeekNumInput) || 1)) + 1} will start 7 days later, and so on automatically.
                </div>
              </div>
            )}
            <button
              className="btn btn-primary w-100"
              style={{ borderRadius: 8, fontSize: '0.85rem' }}
              onClick={handleSetWeeklyAnchor}
              disabled={!weekStartInput}
            >
              <i className="bi bi-check2-circle me-1" /> Confirm Starting Week & Begin Report
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Step 2: Data entry form ──────────────────────────────────────────── */
  const brandLabel = selectedBrand?.name || selectedBrand?.brandName || '';
  const curSym = currencySymbol(data.currency || DEFAULT_CURRENCY);
  const sectEnabled = resolveWeeklySectionsEnabled(data.sectionsEnabled);
  const toggleSection = (key) => (val) => setData(d => ({
    ...d,
    sectionsEnabled: { ...resolveWeeklySectionsEnabled(d.sectionsEnabled), [key]: val },
  }));

  // ── Section navigation + per-section completion % (immersive editor) ──────
  // Progress bars are a UI nicety derived from `data` + the section toggles;
  // they NEVER gate save/submit — validate() remains the only source of truth.
  const _op = data.overallPerformance || {};
  const _on = data.overallNotes || {};
  const _filled = (v) => v != null && String(v).trim() !== '';
  const _ratio = (reqs) => (reqs.length ? Math.round(reqs.filter(Boolean).length / reqs.length * 100) : 100);

  const sellerReqs = [];
  if (sectEnabled.overallPerformance) sellerReqs.push(_filled(_op.gmv), _filled(_op.orders), _filled(_op.samplesApproved), _filled(_on.gmv), _filled(_op.roi), _filled(_op.shopPerformanceScore), _filled(_on.samplesApproved));
  if (sectEnabled.gmvMax) sellerReqs.push((data.gmvMax || []).some(g => g.campaign && g.campaign.trim()));
  if (sectEnabled.productHighlights) sellerReqs.push((data.productHighlights || []).some(p => p.productName && p.productName.trim()));
  if (sectEnabled.upcomingCampaigns) sellerReqs.push(!isHtmlEmpty(data.upcomingCampaigns));
  const sellerPct = _ratio(sellerReqs);

  const affiliateReqs = [];
  if (sectEnabled.overallPerformance) affiliateReqs.push(_filled(_op.affiliateGmv), _filled(_op.videosPosted), _filled(_on.videosMtd), hasPrevAllTime || _filled(_on.videosPosted));
  if (sectEnabled.topCreators) affiliateReqs.push((data.topCreators || []).some(c => c.name && c.name.trim()));
  if (sectEnabled.topVideos) affiliateReqs.push((data.topVideos || []).some(v => v.creatorName && v.creatorName.trim()));
  const affiliatePct = _ratio(affiliateReqs);

  const operationalPct = !sectEnabled.operationalUpdates ? 100 : (!isHtmlEmpty(data.operationalUpdates) ? 100 : 0);
  const recommendationsPct = !sectEnabled.recommendations ? 100 : (!isHtmlEmpty(data.recommendations) ? 100 : 0);
  const insightsPct = !isHtmlEmpty(data.reportInsights) ? 100 : 0;

  let _custTotal = 0, _custDone = 0;
  customFieldDefs.forEach((fd) => {
    _custTotal += 1;
    const cv = data.customFields?.[fd.id];
    const cval = cv == null ? '' : (typeof cv === 'string' ? cv : (cv.value || ''));
    if (!isHtmlEmpty(cval)) _custDone += 1;
  });
  const customPct = _custTotal ? Math.round(_custDone / _custTotal * 100) : 100;

  const showCustom = brandSectionDefs.length > 0 || !!selectedBrand?.id || customFieldDefs.length > 0;
  // Fall back to Seller if the Custom nav disappears while it's active.
  const active = (activeSection === 'custom' && !showCustom) ? 'seller' : activeSection;

  const SECTION_HUES = { seller: '#4f46e5', affiliate: '#0d9488', custom: '#475569', operational: '#d97706', recommendations: '#e11d48', insights: '#7c3aed' };
  const navGroups = [
    { cap: 'Report sections', items: [
      { key: 'seller', name: 'Seller Center', icon: 'bi-bag-check-fill', pct: sellerPct },
      { key: 'affiliate', name: 'Affiliate Center', icon: 'bi-people-fill', pct: affiliatePct },
    ] },
    ...(showCustom ? [{ cap: 'Custom', items: [
      { key: 'custom', name: 'Custom Sections', icon: 'bi-grid-1x2-fill', pct: customPct },
    ] }] : []),
    { cap: 'Wrap up', items: [
      { key: 'operational', name: 'Operational Updates', icon: 'bi-gear-fill', pct: operationalPct },
      { key: 'recommendations', name: 'Recommendations', icon: 'bi-lightbulb-fill', pct: recommendationsPct },
      { key: 'insights', name: 'Insights', icon: 'bi-stars', pct: insightsPct },
    ] },
  ];
  const _overallList = [sellerPct, affiliatePct, operationalPct, recommendationsPct, insightsPct, ...(showCustom ? [customPct] : [])];
  const overallPct = Math.round(_overallList.reduce((a, b) => a + b, 0) / _overallList.length);
  const panelHue = SECTION_HUES[active] || 'var(--accent)';

  return (
    // Immersive full-viewport editor — a fixed shell (z-1200) covering the
    // app's own top bar + side menu. Form modals (guardModal, Euka) use
    // zIndex 2000 so they render above it. The onInput catch-all keeps the
    // dirty flag armed for native input events (RTE/pickers/toggles are also
    // covered by the ref-equality effect on `data`).
    <div className="wri-root" onInput={() => setDirty(true)}>
      {guardModal}

      {/* ─── Auto Generate from Euka — modals ──────────────────────────── */}
      {eukaModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,18,24,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          {/* Period picker */}
          {eukaModal === 'period' && (
            <div className="wx-card" style={{ padding: 24, width: 460, maxWidth: '92vw' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <i className="bi bi-lightning-charge-fill" style={{ color: '#0f6e6a' }} />
                <h5 className="fw-bold mb-0" style={{ fontSize: 17 }}>Auto Generate from Euka</h5>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>
                Fetch the exact stats Euka provides for <strong>{brandLabel}</strong> and fill this report. Everything Euka can't verify stays blank for you to enter.
              </div>

              <label className="wx-label">Stats period (7 days)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="date" className="wx-input" value={eukaStart}
                  onChange={(e) => onEukaStartChange(e.target.value)} style={{ maxWidth: 190 }} />
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <span className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{eukaEnd || '—'}</span>
              </div>

              {/* Warning shown only when the stats window differs from the report's week */}
              {(eukaStart !== selectedWeek?.startDate || eukaEnd !== selectedWeek?.endDate) && (
                <div className="alert d-flex align-items-start gap-2 mt-3 mb-0 py-2"
                  style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', borderRadius: 10, color: 'var(--warning)' }}>
                  <i className="bi bi-exclamation-triangle-fill flex-shrink-0 mt-1" />
                  <div style={{ fontSize: 12 }}>
                    You're pulling stats for a <strong>different</strong> period than this report's week
                    (<strong>{selectedWeek?.label}</strong>). The numbers will be for the selected days, but
                    the report stays dated to its own week — only the stats change.
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
                <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 10 }}
                  onClick={() => setEukaModal(null)}>Cancel</button>
                <button className="btn btn-sm d-inline-flex align-items-center gap-1"
                  style={{ background: '#0f6e6a', color: 'white', border: 'none', borderRadius: 10 }}
                  onClick={runEukaAutofill} disabled={!eukaStart || !eukaEnd}>
                  <i className="bi bi-lightning-charge-fill" /> Fetch &amp; auto-fill
                </button>
              </div>
            </div>
          )}

          {/* Running — non-dismissable */}
          {eukaModal === 'running' && (
            <div className="wx-card" style={{ padding: 30, width: 380, maxWidth: '90vw', textAlign: 'center' }}>
              <div className="spinner-border" style={{ color: '#0f6e6a', width: 34, height: 34, marginBottom: 14 }} />
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
                Fetching stats from Euka…
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Pulling overall performance, top creators, and product stats. This can take up to a minute — please keep this open.
              </div>
            </div>
          )}

          {/* Done */}
          {eukaModal === 'done' && eukaResult && (
            <div className="wx-card" style={{ padding: 24, width: 440, maxWidth: '92vw' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div className="rounded-circle d-flex align-items-center justify-content-center" style={{ width: 30, height: 30, background: 'var(--success-soft)' }}>
                  <i className="bi bi-check-lg" style={{ color: 'var(--success)' }} />
                </div>
                <h5 className="fw-bold mb-0" style={{ fontSize: 16 }}>Auto-filled from Euka</h5>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 14 }}>
                Filled the exact-match stats for <strong>{eukaResult.period?.startDate} → {eukaResult.period?.endDate}</strong>:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li>Overall: GMV, Affiliate GMV, Orders{eukaResult.meta?.mtdGmv != null ? ', GMV Month-to-Date' : ''}</li>
                  <li>Top {eukaResult.meta?.creatorCount || 0} creators (handle, videos, GMV)</li>
                  <li>Top {eukaResult.meta?.productCount || 0} products (name, ID, orders, GMV)</li>
                </ul>
                <div style={{ marginTop: 10, color: 'var(--text-muted)' }}>
                  Please <strong>verify these</strong> and fill in the remaining fields (ROI, SPS, samples, videos posted, offsite, GMV Max, per-creator units) manually.
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-sm" style={{ background: '#0f6e6a', color: 'white', border: 'none', borderRadius: 10 }}
                  onClick={() => setEukaModal(null)}>Got it</button>
              </div>
            </div>
          )}

          {/* Error — copyable for Discord */}
          {eukaModal === 'error' && eukaError && (
            <div className="wx-card" style={{ padding: 24, width: 480, maxWidth: '92vw' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div className="rounded-circle d-flex align-items-center justify-content-center" style={{ width: 30, height: 30, background: 'var(--danger-soft)' }}>
                  <i className="bi bi-exclamation-triangle-fill" style={{ color: 'var(--danger)' }} />
                </div>
                <h5 className="fw-bold mb-0" style={{ fontSize: 16 }}>Couldn't auto-fill from Euka</h5>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>{eukaError.message}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                If it keeps failing, copy this and send it to the developer on Discord:
              </div>
              <pre style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 10, fontSize: 10.5, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>{eukaError.copyText}</pre>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ borderRadius: 10 }}
                  onClick={copyEukaError}><i className="bi bi-clipboard" /> Copy for Discord</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 10 }} onClick={() => setEukaModal(null)}>Close</button>
                  <button className="btn btn-sm" style={{ background: '#0f6e6a', color: 'white', border: 'none', borderRadius: 10 }} onClick={openEukaAutofill}>Try again</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ Left rail — brand mark, section nav, pinned actions ═══════ */}
      <nav className="wri-rail">
        <div className="wri-railtop">
          <span className="wri-brandmark"><i className="bi bi-clipboard-data" /></span>
          <div>
            <div className="wri-rt-title">WurxOS</div>
            <div className="wri-rt-sub">Weekly report</div>
          </div>
        </div>
        <div className="wri-navscroll">
          {navGroups.map((grp) => (
            <React.Fragment key={grp.cap}>
              <div className="wri-railcap">{grp.cap}</div>
              {grp.items.map((it) => (
                <button key={it.key} type="button"
                  className={`wri-navitem${active === it.key ? ' active' : ''}${it.pct === 100 ? ' done' : ''}`}
                  style={{ '--hue': SECTION_HUES[it.key] }}
                  onClick={() => setActiveSection(it.key)}>
                  <span className="wri-chip"><i className={`bi ${it.icon}`} /></span>
                  <span className="wri-nm">{it.name}</span>
                  <span className="wri-track"><i style={{ width: `${it.pct}%` }} /></span>
                  <span className="wri-pc">{it.pct}%</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
        <div className="wri-actions">
          <input ref={pdfInputRef} type="file" accept="application/pdf" style={{ display: 'none' }}
            onChange={e => handleImportPdf(e.target.files?.[0])} />
          {brandHasEuka && (
            <button type="button" className="wri-btn wri-btn-euka" onClick={openEukaAutofill} disabled={saving}
              title="Fetch this week's exact stats from Euka and auto-fill the form">
              <i className="bi bi-lightning-charge-fill" /> Auto Generate from Euka
            </button>
          )}
          <button type="button" className="wri-btn" onClick={() => pdfInputRef.current?.click()} disabled={importing}
            title="Upload a PDF (Google Doc export) to auto-fill this form">
            {importing ? <><span className="spinner-border spinner-border-sm" /> Reading PDF…</>
              : <><i className="bi bi-file-earmark-pdf-fill" /> Import from PDF</>}
          </button>
          {(reportStatus === 'draft' || !editReportId) ? (
            <div className="wri-actrow">
              <button type="button" className="wri-btn" onClick={handleSaveDraft}
                disabled={saving || !!duplicateForThisWeek}
                title={duplicateForThisWeek ? 'A report already exists for this week — saving here would overwrite it.' : ''}>
                {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-floppy" />} Save Draft
              </button>
              <button type="button" className="wri-btn wri-btn-primary" onClick={handleSubmitReport} disabled={saving || !!submitBlock}
                title={submitBlock?.kind === 'duplicate' ? 'A report already exists for this week.' : submitBlock?.kind === 'pendingPrior' ? 'The previous report must be verified by the Team Lead first' : ''}>
                {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-send-fill" /> Submit Report</>}
              </button>
            </div>
          ) : (
            <button type="button" className="wri-btn wri-btn-primary" onClick={handleSaveChanges} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save Changes</>}
            </button>
          )}
        </div>
      </nav>

      {/* ═══ Main — top strip + scrolling section panels ══════════════ */}
      <div className="wri-main">
        <div className="wri-topstrip">
          {onCancel && (
            <button type="button" className="wri-back" onClick={() => guardAction(onCancel)}>
              <i className="bi bi-arrow-left" /> {editReportId ? 'Cancel editing' : 'Back to reports'}
            </button>
          )}
          <div className="wri-headmeta">
            <div className="wri-title">{editReportId ? 'Edit' : 'New'} Weekly Report</div>
            <div className="wri-sub">
              <span style={{ overflowWrap: 'anywhere' }}>{brandLabel} — {selectedWeek?.label}</span>
              {editReportId && userRole === 'ol' && (
                <button type="button" className="wri-changeweek" onClick={handleChangeWeek}
                  title="Move this report to a different week">
                  <i className="bi bi-calendar-event" /> Change Week
                </button>
              )}
            </div>
          </div>
          <div className="wri-topright">
            <div className="wri-overall" title="Overall completion">
              <span className="lbl">Complete</span>
              <span className="wri-obar"><i style={{ width: `${overallPct}%` }} /></span>
              <span className="pct">{overallPct}%</span>
            </div>
            <div className="wri-curr" title="Report currency — applies to every monetary field below">
              <i className="bi bi-currency-exchange" />
              <select value={data.currency || DEFAULT_CURRENCY}
                onChange={e => setData(d => ({ ...d, currency: e.target.value }))}>
                {CURRENCIES.map(c => (
                  <option key={c.code} value={c.code}>{c.symbol}  ·  {c.code} — {c.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="wri-scroll">
          {/* ─── Duplicate week guard ─────────────────────────────────────── */}
          {duplicateForThisWeek && (
        <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
          style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10, color: 'var(--danger)' }}>
          <i className="bi bi-exclamation-triangle-fill flex-shrink-0 mt-1" />
          <div className="flex-grow-1" style={{ fontSize: '0.78rem' }}>
            <div className="fw-bold" style={{ fontSize: '0.85rem' }}>This week already has a report</div>
            <div style={{ marginTop: 2 }}>
              {brandLabel} — {selectedWeek?.label} was already submitted by {duplicateForThisWeek.createdByName || 'someone'}{' '}
              ({REPORT_STATUSES[duplicateForThisWeek.status]?.label || duplicateForThisWeek.status}).
              Saving here would overwrite it. Cancel and edit the existing report instead, or pick a different week.
            </div>
          </div>
        </div>
      )}

      {/* ─── PDF import toast ──────────────────────────────────────────── */}
      {importToast && (
        <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
          style={{
            background: importToast.kind === 'success' ? 'var(--success-soft)' : importToast.kind === 'warn' ? 'var(--warning-soft)' : 'var(--danger-soft)',
            border: `1px solid ${importToast.kind === 'success' ? 'color-mix(in srgb, var(--success) 35%, transparent)' : importToast.kind === 'warn' ? 'color-mix(in srgb, var(--warning) 35%, transparent)' : 'color-mix(in srgb, var(--danger) 35%, transparent)'}`,
            borderRadius: 10,
            color: importToast.kind === 'success' ? 'var(--success)' : importToast.kind === 'warn' ? 'var(--warning)' : 'var(--danger)',
          }}>
          <i className={`bi ${importToast.kind === 'success' ? 'bi-check-circle-fill' : importToast.kind === 'warn' ? 'bi-exclamation-circle-fill' : 'bi-x-circle-fill'} flex-shrink-0 mt-1`} />
          <div className="flex-grow-1" style={{ fontSize: '0.78rem' }}>{importToast.msg}</div>
          <button type="button" className="btn-close btn-close-sm" onClick={() => setImportToast(null)} style={{ fontSize: '0.6rem' }} />
        </div>
      )}

      {/* Return notice — visible to the recipient at any returned stage, with full history (mig 203). */}
      <ReportReturnNotice report={{ id: editReportId, status: reportStatus }} />

      {/* ─── Submission gate banner (APC only) ───────────────────────────── */}
      {submitBlock?.kind === 'duplicate' && (
        <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', borderRadius: 10, color: 'var(--warning)' }}>
          <i className="bi bi-lock-fill flex-shrink-0 mt-1" />
          <div>
            <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Already submitted for {selectedWeek.label}</div>
            <div style={{ fontSize: '0.78rem', marginTop: 2 }}>You can't submit another report for the same week.</div>
          </div>
        </div>
      )}
      {submitBlock?.kind === 'pendingPrior' && (
        <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', borderRadius: 10, color: 'var(--warning)' }}>
          <i className="bi bi-hourglass-split flex-shrink-0 mt-1" />
          <div>
            <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Previous report not yet verified</div>
            <div style={{ fontSize: '0.78rem', marginTop: 2 }}>
              Your {submitBlock.report.weekLabel} report is still <strong>{REPORT_STATUSES[submitBlock.report.status]?.label || submitBlock.report.status}</strong>.
              It needs to be verified by the Team Lead before you can submit a new one. You can keep drafting this report in the meantime.
            </div>
          </div>
        </div>
      )}

      {/* ─── Panel header (only the active section's header renders) ───── */}
      {(() => {
        const heads = {
          seller:         { icon: 'bi-bag-check-fill', title: 'Seller Center',                  pct: sellerPct,         desc: <>Everything from TikTok Shop <b>Seller Center</b> — fill it all here without switching tabs.</> },
          affiliate:      { icon: 'bi-people-fill',    title: 'Affiliate Center',               pct: affiliatePct,      desc: <>Everything from TikTok Shop <b>Affiliate Center</b> — creators, videos and affiliate GMV.</> },
          custom:         { icon: 'bi-grid-1x2-fill',  title: 'Custom Sections',                pct: customPct,         desc: <>Brand-specific sections and your own custom fields for this report.</> },
          operational:    { icon: 'bi-gear-fill',      title: 'Operational Updates',            pct: operationalPct,    desc: <>What changed this week behind the scenes — staffing, blockers, process.</> },
          recommendations:{ icon: 'bi-lightbulb-fill', title: 'Recommendations & Action Items', pct: recommendationsPct, desc: <>Where to focus next — recommendations and concrete action items.</> },
          insights:       { icon: 'bi-stars',          title: 'Insights',                       pct: insightsPct,       desc: <>Write your read on the whole week here — cover every section in your own words, all in one place.</> },
        };
        const h = heads[active];
        if (!h) return null;
        return (
          <>
            <div className="wri-phead" style={{ '--hue': panelHue }}>
              <span className="wri-picon"><i className={`bi ${h.icon}`} /></span>
              <h1>{h.title}</h1>
              <div className="wri-meter"><span className="t"><i style={{ width: `${h.pct}%` }} /></span><b>{h.pct}%</b></div>
            </div>
            {h.desc && <p className="wri-pdesc">{h.desc}</p>}
          </>
        );
      })()}

      {/* ═══ SELLER CENTER ══════════════════════════════════════════════ */}
      {/* ─── Seller Overview (Seller-Center half of the old Overall card) ─ */}
      {active === 'seller' && (
      <>
      <SectionHeader icon="bi-bag-check-fill" title="Seller Overview" color="#4f46e5" required
        enabled={sectEnabled.overallPerformance} onToggle={toggleSection('overallPerformance')} />
      {sectEnabled.overallPerformance && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex flex-wrap gap-2 mb-2">
            <Field label={`GMV ${curSym} (This Week)`} value={data.overallPerformance.gmv} onChange={v => setPerf('gmv', v)} type="number" placeholder="55834.62" />
            <Field label="Orders" value={data.overallPerformance.orders} onChange={v => setPerf('orders', v)} type="number" placeholder="813" />
            <Field label="Samples Approved (This week)" value={data.overallPerformance.samplesApproved} onChange={v => setPerf('samplesApproved', v)} type="number" placeholder="488" />
          </div>
          <div className="d-flex flex-wrap gap-2 mb-2">
            <Field label="ROI" value={data.overallPerformance.roi} onChange={v => setPerf('roi', v)} type="number" placeholder="2.76" />
            <Field label="Shop Performance Score" value={data.overallPerformance.shopPerformanceScore} onChange={v => setPerf('shopPerformanceScore', v)} type="number" placeholder="4.7" />
          </div>
          <div className="d-flex flex-wrap gap-2">
            <Field label={`GMV Month-to-Date (${curSym})`} value={data.overallNotes.gmv || ''} onChange={v => setPerfNote('gmv', v)} type="number" placeholder="231714.01" width="240px" />
            <Field label="Sample Approved (month to date)" value={data.overallNotes.samplesApproved || ''} onChange={v => setPerfNote('samplesApproved', v)} type="number" placeholder="854" width="240px" />
          </div>
          <BuiltinExtras sectionKey="overallPerformance" sectionTitle="Overall Performance"
            fields={brandSectionExtras.overallPerformance || []}
            data={data} setData={setData} curSym={curSym}
            previousReport={previousReport}
            disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('overallPerformance', f)}
            onRemoveField={(id) => removeExtraField('overallPerformance', id)} />
        </div>
      </div>
      )}
      </>
      )}

      {/* ═══ AFFILIATE CENTER ═══════════════════════════════════════════ */}
      {/* ─── Affiliate Overview (Affiliate-Center half of old Overall) ──── */}
      {active === 'affiliate' && (
      <>
      <SectionHeader icon="bi-people-fill" title="Affiliate Overview" color="#0d9488" required
        enabled={sectEnabled.overallPerformance} onToggle={toggleSection('overallPerformance')} />
      {sectEnabled.overallPerformance && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex flex-wrap gap-2 mb-2">
            <Field label={`Affiliate GMV (${curSym})`} value={data.overallPerformance.affiliateGmv} onChange={v => setPerf('affiliateGmv', v)} type="number" placeholder="49494.24" />
            <Field label="Video Posted (This week)" value={data.overallPerformance.videosPosted} onChange={v => setPerf('videosPosted', v)} type="number" placeholder="1377" />
          </div>
          <div className="d-flex flex-wrap gap-2">
            <Field label="Videos Posted (Month-to-Date)" value={data.overallNotes.videosMtd || ''} onChange={v => setPerfNote('videosMtd', v)} type="number" placeholder="2140" width="240px" />
            {hasPrevAllTime ? (
              <Field label="Total Videos (all-time)" value={autoTotalVideos} type="number" width="220px" readOnly
                note={`Auto: ${prevAllTimeVideos.toLocaleString()} previous + ${weeklyVideos.toLocaleString()} this week`} />
            ) : (
              <Field label="Total Videos (all-time)" value={data.overallNotes.videosPosted || ''} onChange={v => setPerfNote('videosPosted', v)} type="number" placeholder="25703" width="220px"
                note="First report: enter the all-time total. Future weeks add automatically." />
            )}
          </div>
        </div>
      </div>
      )}
      </>
      )}

      {active === 'affiliate' && (
      <>
      {/* ─── Top Creators ───────────────────────────────────────────────── */}
      <SectionHeader icon="bi-star-fill" title="Top Creators" color="#f59e0b" required
        enabled={sectEnabled.topCreators} onToggle={toggleSection('topCreators')} />
      {sectEnabled.topCreators && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <ArraySection items={data.topCreators} setItems={v => setData(d => ({ ...d, topCreators: v }))}
            addLabel="Add Creator"
            fields={[
              { key: 'name', label: 'Creator Name', width: '160px' },
              { key: 'videosPosted', label: 'Videos', type: 'number', width: '80px' },
              { key: 'itemsSold', label: 'Items Sold', type: 'number', width: '90px' },
              { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '100px' },
              { key: 'notes', label: 'Notes', width: '140px' },
            ]} />
          <BuiltinExtras sectionKey="topCreators" sectionTitle="Top Creators"
            fields={brandSectionExtras.topCreators || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('topCreators', f)}
            onRemoveField={(id) => removeExtraField('topCreators', id)} />
        </div>
      </div>
      )}

      {/* ─── Top Videos ─────────────────────────────────────────────────── */}
      <SectionHeader icon="bi-play-circle-fill" title="Top Videos" color="#8b5cf6" required
        enabled={sectEnabled.topVideos} onToggle={toggleSection('topVideos')} />
      {sectEnabled.topVideos && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <ArraySection items={data.topVideos} setItems={v => setData(d => ({ ...d, topVideos: v }))}
            addLabel="Add Video"
            fields={[
              { key: 'creatorName', label: 'Creator', width: '140px' },
              { key: 'videoLink', label: 'Video Link *', type: 'url', width: '220px', placeholder: 'https://www.tiktok.com/@user/video/...' },
              { key: 'itemsSold', label: 'Items Sold', type: 'number', width: '90px' },
              { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '100px' },
              { key: 'views', label: 'Views', type: 'number', width: '90px' },
              { key: 'productClicks', label: 'Product Clicks', width: '110px', placeholder: '3.97K or 3970' },
              { key: 'notes', label: 'Notes', width: '120px' },
            ]} />
          <BuiltinExtras sectionKey="topVideos" sectionTitle="Top Videos"
            fields={brandSectionExtras.topVideos || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('topVideos', f)}
            onRemoveField={(id) => removeExtraField('topVideos', id)} />
        </div>
      </div>
      )}
      </>
      )}

      {active === 'seller' && (
      <>
      {/* ─── GMV Max Performance (Seller Center) ─────────────────────────── */}

      {/* ─── Section 4: GMV Max Performance ─────────────────────────────── */}
      <SectionHeader icon="bi-rocket-takeoff-fill" title="GMV Max Performance" color="#ef4444" required
        enabled={sectEnabled.gmvMax} onToggle={toggleSection('gmvMax')} />
      {sectEnabled.gmvMax && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <ArraySection items={data.gmvMax} setItems={v => setData(d => ({ ...d, gmvMax: v }))}
            addLabel="Add Campaign"
            fields={[
              { key: 'campaign', label: 'Campaign', width: '130px' },
              { key: 'spend', label: `Spend (${curSym})`, type: 'number', width: '100px' },
              { key: 'roi', label: 'ROI', type: 'number', width: '70px' },
              { key: 'orders', label: 'Orders', type: 'number', width: '80px' },
              { key: 'cpo', label: `CPO (${curSym})`, type: 'number', width: '80px' },
              { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '100px' },
              { key: 'notes', label: 'Notes', width: '140px' },
            ]} />
          <BuiltinExtras sectionKey="gmvMax" sectionTitle="GMV Max Performance"
            fields={brandSectionExtras.gmvMax || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('gmvMax', f)}
            onRemoveField={(id) => removeExtraField('gmvMax', id)} />
        </div>
      </div>
      )}

      {/* ─── Month-to-Date GMV Max (same shape; app auto-calcs MTD overall) ── */}
      {sectEnabled.gmvMax && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex align-items-center gap-2 mb-2">
            <i className="bi bi-calendar-range-fill" style={{ color: '#ef4444' }} />
            <span className="fw-semibold" style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>Month-to-Date GMV Max Campaigns</span>
          </div>
          <p className="text-muted mb-2" style={{ fontSize: '0.72rem' }}>
            Enter each campaign's spend / GMV / orders for the month so far. The overall MTD totals are calculated automatically, like the weekly section above.
          </p>
          <ArraySection items={data.gmvMaxMtd || []} setItems={v => setData(d => ({ ...d, gmvMaxMtd: v }))}
            addLabel="Add MTD Campaign"
            fields={[
              { key: 'campaign', label: 'Campaign', width: '130px' },
              { key: 'spend', label: `Spend (${curSym})`, type: 'number', width: '100px' },
              { key: 'roi', label: 'ROI', type: 'number', width: '70px' },
              { key: 'orders', label: 'Orders', type: 'number', width: '80px' },
              { key: 'cpo', label: `CPO (${curSym})`, type: 'number', width: '80px' },
              { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '100px' },
              { key: 'notes', label: 'Notes', width: '140px' },
            ]} />
        </div>
      </div>
      )}

      {/* ─── Section 5: Product Highlights ──────────────────────────────── */}
      <SectionHeader icon="bi-box-seam-fill" title="Product Highlights" color="#06b6d4" required
        enabled={sectEnabled.productHighlights} onToggle={toggleSection('productHighlights')} />
      {sectEnabled.productHighlights && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <ArraySection items={data.productHighlights} setItems={v => setData(d => ({ ...d, productHighlights: v }))}
            addLabel="Add Product"
            fields={[
              { key: 'productId', label: 'Product ID', width: '140px' },
              { key: 'productName', label: 'Product Name', width: '160px' },
              { key: 'unitsSold', label: productUnitsLbl, type: 'number', width: '90px' },
              { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '100px' },
              { key: 'newVideos', label: 'Videos (wk)', type: 'number', width: '90px' },
              { key: 'videosMtd', label: 'Videos MTD', type: 'number', width: '90px' },
              { key: 'samplesApprovedWeek', label: 'Samples (wk)', type: 'number', width: '95px' },
              { key: 'samplesApprovedMtd', label: 'Samples MTD', type: 'number', width: '95px' },
              { key: 'notes', label: 'Notes', width: '130px' },
            ]} />
          <BuiltinExtras sectionKey="productHighlights" sectionTitle="Product Highlights"
            fields={brandSectionExtras.productHighlights || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('productHighlights', f)}
            onRemoveField={(id) => removeExtraField('productHighlights', id)} />
        </div>
      </div>
      )}

      {/* ─── Section 6: Offsite Performance (optional) ──────────────────── */}
      <SectionHeader icon="bi-globe2" title="Offsite Performance" color="#10b981"
        enabled={sectEnabled.offsitePerformance} onToggle={toggleSection('offsitePerformance')} />
      {sectEnabled.offsitePerformance && (
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex flex-wrap gap-2 mb-2">
            <Field label={`Offsite GMV (${curSym})`} value={data.offsitePerformance.offsiteGmv} onChange={v => setOffsite('offsiteGmv', v)} type="number" placeholder="1725.49" />
            <Field label={`TikTok Shop GMV (${curSym})`} value={data.offsitePerformance.tiktokShopGmv} onChange={v => setOffsite('tiktokShopGmv', v)} type="number" placeholder="55834.62" />
            <Field label="Off-site Effect (%)" value={data.offsitePerformance.offsiteEffect} onChange={v => setOffsite('offsiteEffect', v)} type="number" placeholder="3.09" />
          </div>
          <BuiltinExtras sectionKey="offsitePerformance" sectionTitle="Offsite Performance"
            fields={brandSectionExtras.offsitePerformance || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('offsitePerformance', f)}
            onRemoveField={(id) => removeExtraField('offsitePerformance', id)} />
        </div>
      </div>
      )}

      {/* ─── Current & Upcoming Campaigns (mandatory) ───────────────────── */}
      <SectionHeader icon="bi-megaphone-fill" title="Current & Upcoming Campaigns" color="#ec4899" required
        enabled={sectEnabled.upcomingCampaigns} onToggle={toggleSection('upcomingCampaigns')} />
      {sectEnabled.upcomingCampaigns && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex justify-content-end mb-2">
            <FetchPreviousButton
              previousValue={previousReport?.upcomingCampaigns}
              currentValue={data.upcomingCampaigns}
              onPaste={(v) => setData(d => ({ ...d, upcomingCampaigns: v }))}
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
          </div>
          <RichTextEditor value={data.upcomingCampaigns || ''}
            onChange={v => setData(d => ({ ...d, upcomingCampaigns: v }))}
            minHeight={140}
            placeholder="List any upcoming campaigns, launches or planned promotions" />
          <BuiltinExtras sectionKey="upcomingCampaigns" sectionTitle="Current & Upcoming Campaigns"
            fields={brandSectionExtras.upcomingCampaigns || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('upcomingCampaigns', f)}
            onRemoveField={(id) => removeExtraField('upcomingCampaigns', id)} />
        </div>
      </div>
      )}
      </>
      )}

      {/* ═══ WRAP UP ═════════════════════════════════════════════════════ */}
      {active === 'operational' && (
      <>
      {/* ─── Operational Updates (mandatory) ─────────────────────────────── */}
      <SectionHeader icon="bi-gear-fill" title="Operational Updates" color="#6366f1" required
        enabled={sectEnabled.operationalUpdates} onToggle={toggleSection('operationalUpdates')} />
      {sectEnabled.operationalUpdates && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex justify-content-end mb-2">
            <FetchPreviousButton
              previousValue={previousReport?.operationalUpdates}
              currentValue={data.operationalUpdates}
              onPaste={(v) => setData(d => ({ ...d, operationalUpdates: v }))}
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
          </div>
          <RichTextEditor value={data.operationalUpdates || ''}
            onChange={v => setData(d => ({ ...d, operationalUpdates: v }))}
            minHeight={140}
            placeholder="Describe the workflow and operational tasks completed this week" />
          <BuiltinExtras sectionKey="operationalUpdates" sectionTitle="Operational Updates"
            fields={brandSectionExtras.operationalUpdates || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('operationalUpdates', f)}
            onRemoveField={(id) => removeExtraField('operationalUpdates', id)} />
        </div>
      </div>
      )}
      </>
      )}

      {active === 'recommendations' && (
      <>
      {/* ─── Recommendations & Action Items (optional) ───────────────────── */}
      <SectionHeader icon="bi-lightbulb-fill" title="Recommendations & Action Items" color="#f59e0b"
        enabled={sectEnabled.recommendations} onToggle={toggleSection('recommendations')} />
      {sectEnabled.recommendations && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex justify-content-end mb-2">
            <FetchPreviousButton
              previousValue={previousReport?.recommendations}
              currentValue={data.recommendations}
              onPaste={(v) => setData(d => ({ ...d, recommendations: v }))}
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
          </div>
          <RichTextEditor value={data.recommendations || ''}
            onChange={v => setData(d => ({ ...d, recommendations: v }))}
            minHeight={160}
            placeholder="Share your recommendations and action items for next steps" />
          <BuiltinExtras sectionKey="recommendations" sectionTitle="Recommendations & Action Items"
            fields={brandSectionExtras.recommendations || []} data={data} setData={setData} curSym={curSym}
            previousReport={previousReport} disabled={!selectedBrand?.id}
            onAddField={(f) => addExtraField('recommendations', f)}
            onRemoveField={(id) => removeExtraField('recommendations', id)} />
        </div>
      </div>
      )}
      </>
      )}

      {active === 'custom' && (
      <>
      {/* ─── Brand Sections (custom per-brand, defined on the brand page) ── */}
      {(brandSectionDefs.length > 0 || selectedBrand?.id) && (
        <>
          <SectionHeader icon="bi-pin-fill" title="Brand Sections" color="#0ea5e9" />
          {brandSectionDefs.length > 0 && (
            <BrandSectionsBlock
              sections={brandSectionDefs}
              data={data}
              setData={setData}
              previousReport={previousReport}
              sectEnabled={sectEnabled}
              toggleSection={toggleSection}
              onDelete={deleteBrandCustomSection}
            />
          )}
          {selectedBrand?.id && (
            <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12, borderStyle: 'dashed' }}>
              <div className="card-body p-3">
                <AddCustomSectionInline
                  disabled={!selectedBrand?.id}
                  defaultReportType="weekly"
                  onAdd={addBrandCustomSection} />
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── Custom Fields (per-user, LEGACY — retired add) ────────────────
          The per-USER mechanism leaked across brands and could silently strip
          filled-in text on save (see useBrandSections.cleanCustomFields + the
          monthly form). New sections must use the per-BRAND "Add custom
          section" block above. We still render EXISTING per-user fields so
          nothing a user relies on disappears, the add button is gone, and each
          field renders as its OWN section titled by the field name so edit
          mode matches the saved view exactly (no generic wrapper header). */}
      {customFieldDefs.map((field) => (
        <div key={field.id} className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
          <div className="card-body p-3">
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="d-flex align-items-center gap-2">
                <div className="rounded-2 d-flex align-items-center justify-content-center"
                  style={{ width: 32, height: 32, background: '#8b5cf618' }}>
                  <i className="bi bi-sliders" style={{ fontSize: '0.9rem', color: '#8b5cf6' }} />
                </div>
                <h6 className="fw-bold mb-0" style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                  {field.name}
                </h6>
              </div>
              <div className="d-flex gap-1">
                <button className="btn btn-sm btn-light border-0" style={{ padding: '2px 8px', fontSize: '0.68rem' }}
                  onClick={() => renameCustomField(field.id)} title="Rename">
                  <i className="bi bi-pencil" />
                </button>
                <button className="btn btn-sm btn-light border-0 text-danger" style={{ padding: '2px 8px', fontSize: '0.68rem' }}
                  onClick={() => deleteCustomField(field.id)} title="Delete from my template">
                  <i className="bi bi-trash3" />
                </button>
              </div>
            </div>
            {(() => {
              // Find previous value by id first, then fall back to a name
              // match — custom-field templates are per-user and ids can rotate
              // when a field is renamed or recreated.
              const prevCustom = previousReport?.customFields || {};
              const byId = prevCustom[field.id];
              const byName = !byId
                ? Object.values(prevCustom).find((v) =>
                    typeof v === 'object' && v?.name && v.name === field.name)
                : null;
              const prevEntry = byId || byName;
              const prevValue = prevEntry == null ? ''
                : (typeof prevEntry === 'string' ? prevEntry : (prevEntry.value || ''));
              const curEntry = data.customFields?.[field.id];
              const curValue = curEntry == null ? ''
                : (typeof curEntry === 'string' ? curEntry : (curEntry.value || ''));
              return (
                <div className="d-flex justify-content-end mb-2">
                  <FetchPreviousButton
                    previousValue={prevValue}
                    currentValue={curValue}
                    onPaste={(v) => setCustomFieldValue(field.id, v, field.name)}
                    sourceLabel={previousReport?.weekLabel || 'previous week'} />
                </div>
              );
            })()}
            <RichTextEditor
              value={(() => {
                const v = data.customFields?.[field.id];
                if (!v) return '';
                return typeof v === 'string' ? v : (v.value || '');
              })()}
              onChange={v => setCustomFieldValue(field.id, v, field.name)}
              minHeight={120}
              placeholder={`Add notes for ${field.name}…`} />
          </div>
        </div>
      ))}
      </>
      )}

      {/* ─── Insights (single consolidated editor — Wrap up) ─────────────── */}
      {active === 'insights' && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex justify-content-end mb-2">
            <FetchPreviousButton
              previousValue={previousReport?.reportInsights}
              currentValue={data.reportInsights}
              onPaste={(v) => setData(d => ({ ...d, reportInsights: v }))}
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
          </div>
          <RichTextEditor value={data.reportInsights || ''}
            onChange={v => setData(d => ({ ...d, reportInsights: v }))}
            minHeight={320}
            placeholder="Write your insights for the whole report here — cover every section in your own words. What drove performance across Seller and Affiliate this week: the wins, the misses, standout creators and videos, product movement, ad efficiency, and anything the team should act on." />
        </div>
      </div>
      )}

        </div>{/* .wri-scroll */}
      </div>{/* .wri-main */}
    </div>
  );
}
