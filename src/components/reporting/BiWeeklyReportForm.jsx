import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { useReportLeaveGuard } from './useReportLeaveGuard';
import { useBrands } from '../../contexts/BrandsContext';
import {
  emptyBiWeeklyReport, getBiWeeklyPeriodsFromAnchor,
  saveBiWeeklyReport, getBiWeeklyReportsForBrand, getBiWeeklyReport,
  changeBiWeeklyReportPeriod, getBiWeeklyAnchor, setBiWeeklyAnchor,
  detectNextBiWeeklyPeriod,
  REPORT_STATUSES,
} from '../../utils/biWeeklyReportingService';
import { getUserCustomFields, saveUserCustomFields, cleanNumericInput, WEEKLY_SECTIONS, resolveWeeklySectionsEnabled } from '../../utils/reportingService';
import {
  generateOverallInsight, generateCreatorsInsight, generateVideosInsight,
  generateGmvMaxInsight, generateProductsInsight, generateOffsiteInsight,
  generateAllInsights,
} from '../../utils/aiInsights';
import { findPreviousReport } from '../../lib/reportsApi';
import { notifyReportSubmitted } from '../../utils/reportNotifications';
import { CURRENCIES, currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import RichTextEditor from '../shared/RichTextEditor';
import ReportReturnNotice from './ReportReturnNotice';
import { useReportAutosave, loadDraft } from '../../utils/reportDraftAutosave';

/* ── Tiny reusable pieces ─────────────────────────────────────────────────── */

function SectionHeader({ icon, title, color, required, enabled = true, onToggle }) {
  const togglable = typeof onToggle === 'function';
  return (
    <div className="d-flex align-items-center gap-2 mb-3 mt-4">
      <div className="rounded-2 d-flex align-items-center justify-content-center"
        style={{
          width: 32, height: 32,
          background: enabled ? color + '18' : 'var(--surface-2)',
          opacity: enabled ? 1 : 0.55,
        }}>
        <i className={`bi ${icon}`} style={{
          fontSize: '0.9rem',
          color: enabled ? color : 'var(--text-muted)',
        }} />
      </div>
      <h6 className="fw-bold mb-0" style={{
        fontSize: '0.95rem',
        color: enabled ? 'var(--text-primary)' : 'var(--text-muted)',
        textDecoration: enabled ? 'none' : 'line-through',
      }}>
        {title}
        {required && enabled && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
      </h6>
      {!enabled && (
        <span className="badge" style={{
          background: 'var(--surface-2)', color: 'var(--text-muted)',
          fontSize: '0.62rem', fontWeight: 600, letterSpacing: 0.3,
        }}>
          HIDDEN
        </span>
      )}
      {togglable && (
        <div className="form-check form-switch mb-0 ms-auto" style={{ paddingLeft: '2.4em' }}>
          <input
            className="form-check-input"
            type="checkbox"
            role="switch"
            checked={!!enabled}
            onChange={(e) => onToggle(e.target.checked)}
            title={enabled ? 'Hide this section in the report' : 'Show this section in the report'}
            style={{ cursor: 'pointer' }}
          />
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder, note, width }) {
  // Use type="text" + inputMode="decimal" for numeric fields so users can paste
  // formatted strings like "$3,456.9" — type="number" silently rejects them.
  const isNum = type === 'number';
  return (
    <div style={{ flex: width ? `0 0 ${width}` : '1 1 140px', minWidth: 100 }}>
      <label className="form-label mb-1" style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      <input type={isNum ? 'text' : type}
        inputMode={isNum ? 'decimal' : undefined}
        className="form-control form-control-sm" placeholder={placeholder || label}
        value={value} onChange={e => onChange(isNum ? cleanNumericInput(e.target.value) : e.target.value)} style={{ borderRadius: 8 }} />
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
        <button type="button" className="btn btn-sm d-inline-flex align-items-center gap-1"
          style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)', color: 'white', borderRadius: 8, fontSize: '0.68rem', padding: '3px 10px', border: 'none' }}
          onClick={onGenerate} disabled={loading}>
          {loading ? <><span className="spinner-border spinner-border-sm" style={{ width: 10, height: 10 }} /> Generating…</>
            : <><i className="bi bi-stars" /> Generate with AI</>}
        </button>
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

export default function BiWeeklyReportForm({ editReportId, onSaved, onCancel, prefillBrandId = null }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '' } : null;
  const userProfile = { displayName: profile?.display_name || '' };
  const { brands } = useBrands();

  const [selectedBrand, setSelectedBrand] = useState(null);
  const [selectedPeriod, setSelectedPeriod] = useState(null);
  const [existingReports, setExistingReports] = useState([]);
  const [data, setData] = useState(emptyBiWeeklyReport());

  // Auto-save to localStorage every 30s for both new and edit modes.
  // Same pattern as WeeklyReportForm — see that file for rationale.
  const draftKey = {
    type: 'biweekly',
    uid: currentUser?.uid,
    brandId: selectedBrand?.id,
    periodStart: selectedPeriod?.startDate,
    editId: editReportId || null,
  };
  const { clear: clearLocalDraft } = useReportAutosave({
    ...draftKey,
    data,
  });
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
  // Unsaved-changes guard — see WeeklyReportForm for the rationale.
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  // P5 — reference-equality dirty tracking. See WeeklyReportForm for
  // the full comment. Captures `data` once loading completes and
  // flips dirty=true on any subsequent `data` ref change.
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
  const [detectingPeriod, setDetectingPeriod] = useState(false);
  const [aiLoading, setAiLoading] = useState({}); // per-section loading state
  const [customFieldDefs, setCustomFieldDefs] = useState([]); // [{id, name}]
  const [reportStatus, setReportStatus] = useState('draft');
  const [rejectionNote, setRejectionNote] = useState('');
  const [anchorData, setAnchorData] = useState(null);
  const [anchorStartInput, setAnchorStartInput] = useState('');

  // Step: 0=brand, 1=anchor setup, 2=form
  const [step, setStep] = useState(editReportId ? 2 : 0);

  const myBrands = brands;

  // Auto-select brand: prefillBrandId wins (TL opened "New Report"
  // from a brand-detail page); otherwise auto-select if only one brand.
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

  // Load user's custom field templates once per uid — see
  // WeeklyReportForm for why depending on the object `currentUser`
  // breaks optimistic add/rename/delete (clobbers local state with
  // pre-persist Firestore data).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!currentUser?.uid) return;
    getUserCustomFields(currentUser.uid).then(setCustomFieldDefs).catch(() => {});
  }, [currentUser?.uid]);

  // When brand is selected: load anchor + reports, detect next period, advance step — all in one effect
  useEffect(() => {
    if (!selectedBrand || editReportId) return;
    let cancelled = false;
    setDetectingPeriod(true);

    (async () => {
      const [anchor, reports] = await Promise.all([
        getBiWeeklyAnchor(selectedBrand.id),
        getBiWeeklyReportsForBrand(selectedBrand.id),
      ]);
      if (cancelled) return;
      setAnchorData(anchor);
      setExistingReports(reports);
      setDetectingPeriod(false);

      if (!anchor && reports.length === 0) {
        // No anchor and no reports — first-time setup, show anchor picker.
        setStep(1);
      } else if (!anchor && reports.length > 0) {
        // Anchor was never saved (or got lost) but the brand already has
        // reports — chain off the latest report's start date instead of
        // forcing the APC back to the anchor-picker. Mirrors weekly's
        // fallback so users aren't stuck re-anchoring an existing brand.
        const next = detectNextBiWeeklyPeriod(reports, null);
        if (next) {
          setSelectedPeriod(next);
          setStep(2);
          // Self-heal: back-compute the anchor (oldest report's start)
          // and persist it so this fallback branch only fires once per
          // brand. Best-effort — RLS may reject for non-OL users, in
          // which case we silently keep going; the helper still works.
          const oldestStart = [...reports]
            .map((r) => r.periodStart || r.period_start)
            .filter(Boolean)
            .sort()[0];
          if (oldestStart) {
            setBiWeeklyAnchor(selectedBrand.id, oldestStart)
              .then((saved) => { if (!cancelled) setAnchorData(saved); })
              .catch(() => {});
          }
        } else {
          setStep(1);
        }
      } else if (reports.length === 0) {
        // Anchor set but no reports yet — first period is anchor start
        const firstPeriod = getBiWeeklyPeriodsFromAnchor(anchor.anchorStart, 1)[0];
        setSelectedPeriod(firstPeriod);
        setStep(2);
      } else {
        // Auto-detect next period
        const next = detectNextBiWeeklyPeriod(reports, anchor.anchorStart);
        if (next) {
          setSelectedPeriod(next);
          setStep(2);
        } else {
          setStep(1);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [selectedBrand, editReportId]);

  // Always load existing reports when brand is selected (needed for edit mode AI comparison)
  useEffect(() => {
    if (!selectedBrand || !editReportId) return;
    getBiWeeklyReportsForBrand(selectedBrand.id).then(setExistingReports);
  }, [selectedBrand, editReportId]);

  // Load report for editing. Deps are [editReportId] only — see the
  // long-form comment in WeeklyReportForm.jsx for the brands-realtime
  // wipe rationale. Same fix applied here.
  useEffect(() => {
    if (!editReportId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await getBiWeeklyReport(editReportId);
        if (cancelled) return;
        if (r) {
          const brand = brands.find(b => b.id === r.brandId);
          setSelectedBrand(brand || { id: r.brandId, name: r.brandName });
          setSelectedPeriod({ period: r.period, startDate: r.periodStart, endDate: r.periodEnd, label: r.periodLabel, year: r.year, month: r.month });
          setData({
            overallPerformance: r.overallPerformance || emptyBiWeeklyReport().overallPerformance,
            overallNotes: r.overallNotes || {},
            overallInsights: r.overallInsights || '',
            topCreators: r.topCreators || emptyBiWeeklyReport().topCreators,
            topCreatorsInsights: r.topCreatorsInsights || '',
            topVideos: r.topVideos || emptyBiWeeklyReport().topVideos,
            topVideosInsights: r.topVideosInsights || '',
            gmvMax: r.gmvMax || emptyBiWeeklyReport().gmvMax,
            gmvMaxMtd: r.gmvMaxMtd || emptyBiWeeklyReport().gmvMaxMtd,
            gmvMaxInsights: r.gmvMaxInsights || '',
            productHighlights: r.productHighlights || emptyBiWeeklyReport().productHighlights,
            productHighlightsInsights: r.productHighlightsInsights || '',
            offsitePerformance: r.offsitePerformance || emptyBiWeeklyReport().offsitePerformance,
            offsiteInsights: r.offsiteInsights || '',
            upcomingCampaigns: r.upcomingCampaigns || '',
            operationalUpdates: r.operationalUpdates || '',
            recommendations: [r.recommendations, r.actionItems].filter(s => s && s.trim()).join('\n\n') || '',
            actionItems: '',
            customFields: r.customFields || {},
            sectionsEnabled: resolveWeeklySectionsEnabled(r.sectionsEnabled),
          });
          setReportStatus(r.status || 'approved');
          setRejectionNote(r.rejectionNote || '');
          setStep(2);
        }
      } catch (e) {
        console.warn('Failed to load bi-weekly report for editing:', e?.message || e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editReportId]);

  const handleBrandSelect = (brand) => {
    setSelectedBrand(brand);
    // Step will be set by the useEffect after anchor + reports load
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

  // Previous report = the closest earlier bi-weekly period for this
  // brand. Routed through findPreviousReport so Edit agrees with View —
  // both compare by periodStart, not by createdAt. createdAt-based
  // ordering produced visible mismatches when reports were created
  // out-of-order (OL backfills, period edits).
  const previousReport = useMemo(() => {
    if (!existingReports.length || !selectedPeriod) return null;
    const current = editReportId
      ? existingReports.find(r => r.id === editReportId)
      : { id: '__pending__', brandId: selectedBrand?.id, periodStart: selectedPeriod.startDate };
    if (!current) return null;
    return findPreviousReport(existingReports, current);
  }, [existingReports, selectedPeriod, editReportId, selectedBrand?.id]);

  // Pre-fill Product Highlights from the most recent prior report that
  // actually has products (new-report path only — never on edit). Walk
  // back through history because the immediately previous report may
  // itself be empty (especially right after a v1→v2 sync).
  useEffect(() => {
    if (editReportId) return;
    if (!existingReports.length || !selectedPeriod) return;
    const tsOf = (r) => r.createdAt?.toMillis ? r.createdAt.toMillis()
      : r.createdAt?.seconds ? r.createdAt.seconds * 1000
      : null;
    const ordered = [...existingReports]
      .filter((r) => (r.periodStart || '') < selectedPeriod.startDate)
      .sort((a, b) => {
        const aTs = tsOf(a), bTs = tsOf(b);
        if (aTs != null && bTs != null) return bTs - aTs;
        return (b.periodStart || '').localeCompare(a.periodStart || '');
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
  }, [existingReports, selectedPeriod, editReportId]);

  // APC-only submission gates: duplicate period or prior not yet OL-approved
  const isApc = userRole === 'apc';
  const duplicateForThisPeriod = useMemo(() => {
    if (!isApc || !existingReports.length || !selectedPeriod) return null;
    return existingReports.find(r =>
      r.periodStart === selectedPeriod.startDate &&
      r.id !== editReportId &&
      r.status && r.status !== 'draft'
    ) || null;
  }, [isApc, existingReports, selectedPeriod, editReportId]);
  // APC can submit the next report once the previous one is at least VERIFIED
  // by the Team Lead (status 'verified' or 'approved'). Block only while a prior
  // report is still unverified — draft / submitted / returned.
  const priorPendingApproval = useMemo(() => {
    if (!isApc || !previousReport) return null;
    const s = previousReport.status;
    return (s && s !== 'verified' && s !== 'approved') ? previousReport : null;
  }, [isApc, previousReport]);
  const submitBlock = duplicateForThisPeriod
    ? { kind: 'duplicate', report: duplicateForThisPeriod }
    : priorPendingApproval
      ? { kind: 'pendingPrior', report: priorPendingApproval }
      : null;

  const brandName = selectedBrand?.name || selectedBrand?.brandName || 'Unknown';

  // AI insight generator for a single section
  const runAi = async (section, fn, insightKey) => {
    setAiLoading(s => ({ ...s, [section]: true }));
    try {
      const text = await fn(data, previousReport, brandName, selectedPeriod?.label || '');
      setData(d => ({ ...d, [insightKey]: text }));
    } catch (err) {
      alert('AI generation failed: ' + err.message);
    } finally {
      setAiLoading(s => ({ ...s, [section]: false }));
    }
  };

  // Custom field management — see WeeklyReportForm for the rationale
  // behind the functional setState + persist-inside-updater pattern.
  function nextFieldId() {
    return `cf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
  const persistDefs = async (defs) => {
    try { await saveUserCustomFields(currentUser.uid, defs); }
    catch (e) { console.error('saveUserCustomFields failed:', e); }
  };

  const addCustomField = () => {
    const name = window.prompt('Name for new custom field:', 'Notes');
    if (!name || !name.trim()) return;
    const trimmedName = name.trim();
    const newField = { id: nextFieldId(), name: trimmedName };
    setCustomFieldDefs((prev) => {
      if (prev.some((f) => f.name.trim().toLowerCase() === trimmedName.toLowerCase())) return prev;
      const next = [...prev, newField];
      persistDefs(next);
      return next;
    });
  };

  const renameCustomField = (fieldId) => {
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
  // (via the inline toggle on each SectionHeader) are skipped entirely.
  const validate = () => {
    const missing = [];
    if (!selectedPeriod) missing.push('Bi-weekly period');
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
      if (!data.overallNotes?.videosPosted) missing.push('Overall: Total Videos');
    }

    if (en.topCreators && !(data.topCreators || []).some(c => c.name && c.name.trim()))
      missing.push('Top Creators (at least 1 with name)');
    if (en.topVideos) {
      if (!(data.topVideos || []).some(v => v.creatorName && v.creatorName.trim()))
        missing.push('Top Videos (at least 1 with creator name)');
      // Every video row with a creator name must also have a (valid-looking) video link.
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

    return missing;
  };

  const handleGenerateAll = async () => {
    setAiLoading({ all: true });
    try {
      const insights = await generateAllInsights(data, previousReport, brandName, selectedPeriod?.label || '');
      setData(d => ({ ...d, ...insights }));
    } catch (err) {
      alert('AI generation failed: ' + err.message);
    } finally {
      setAiLoading({});
    }
  };

  // Allow user to change the period of a report being edited
  const handleChangePeriod = async () => {
    if (!editReportId || !selectedBrand) return;
    const opts = getBiWeeklyPeriodsFromAnchor(anchorData?.anchorStart || selectedPeriod.startDate, 20);
    const labels = opts.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    const choice = window.prompt(
      `Pick the correct period number (1-${opts.length}):\n\n${labels}\n\nCurrent: ${selectedPeriod?.label}`,
      ''
    );
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= opts.length) return;
    const newPeriod = opts[idx];
    if (newPeriod.startDate === selectedPeriod?.startDate) return;
    if (!window.confirm(`Change period to: ${newPeriod.label}? The report will be re-saved under the new date.`)) return;
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      const newId = await changeBiWeeklyReportPeriod(editReportId, newPeriod, {
        brandId: selectedBrand.id,
        brandName: selectedBrand.name || selectedBrand.brandName || 'Unknown',
        ...data,
        createdBy: currentUser.uid,
        createdByName: userName,
      });
      alert('Period changed successfully. The report list will refresh.');
      if (onSaved) onSaved({ id: newId, brandId: selectedBrand.id });
    } catch (err) {
      alert('Failed to change period: ' + err.message);
    }
  };

  // Set the bi-weekly anchor for a brand (first-time setup)
  const handleSetAnchor = async () => {
    if (!anchorStartInput || !selectedBrand) return;
    setSaving(true);
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      await setBiWeeklyAnchor(selectedBrand.id, anchorStartInput, currentUser.uid, userName);
      const anchor = { brandId: selectedBrand.id, anchorStart: anchorStartInput };
      setAnchorData(anchor);
      const firstPeriod = getBiWeeklyPeriodsFromAnchor(anchorStartInput, 1)[0];
      setSelectedPeriod(firstPeriod);
      setStep(2);
    } catch (err) {
      alert('Failed to set anchor: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const _doSave = async (status, extra = {}, opts = {}) => {
    if (!selectedBrand || !selectedPeriod) return;
    setSaving(true);
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      // Strip customFields entries whose field def was deleted — otherwise the view
      // keeps rendering them from the stored report doc.
      const validIds = new Set(customFieldDefs.map(f => f.id));
      const cleanedCustomFields = Object.fromEntries(
        Object.entries(data.customFields || {}).filter(([id]) => validIds.has(id))
      );
      const cleanedData = { ...data, customFields: cleanedCustomFields };
      const savedId = await saveBiWeeklyReport({
        brandId: selectedBrand.id,
        brandName,
        periodInfo: selectedPeriod,
        data: cleanedData,
        uid: currentUser.uid,
        userName,
        status,
        extraFields: extra,
      });
      // Successful save — drop the local auto-save backup.
      clearLocalDraft();
      setDirty(false); // changes are persisted — release the guard
      setReportStatus(status); // keep the form's status pill in sync
      // `opts.stay` (used by the leave-guard draft save) persists silently
      // without bubbling the navigate-away that onSaved triggers.
      if (!opts.stay && onSaved) onSaved({
        id: savedId,
        brandId: selectedBrand.id,
        brandName,
        periodLabel: selectedPeriod.label,
        periodStart: selectedPeriod.startDate,
        periodEnd: selectedPeriod.endDate,
        period: selectedPeriod.period,
        year: selectedPeriod.year,
        month: selectedPeriod.month,
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

  /** Save without status change — used by TL/OL editing a non-draft report */
  const handleSaveChanges = () => _doSave(reportStatus);

  /** Validate then submit — sets status to 'submitted' and locks APC editing */
  const handleSubmitReport = async () => {
    if (!selectedBrand || !selectedPeriod) return;
    if (submitBlock?.kind === 'duplicate') {
      alert(`You've already submitted a report for ${selectedPeriod.label}. You can't submit another one for the same period.`);
      return;
    }
    if (submitBlock?.kind === 'pendingPrior') {
      const prev = submitBlock.report;
      alert(`Your previous report (${prev.periodLabel}) hasn't been verified by the Team Lead yet. It must be verified before you can submit a new one.`);
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
        id: `${selectedBrand.id}_bw_${selectedPeriod.startDate}`,
        brandId: selectedBrand.id,
        brandName: selectedBrand.name || selectedBrand.brandName,
        periodLabel: selectedPeriod.label,
        createdBy: currentUser.uid,
      },
      sender: { uid: currentUser.uid, name: userName },
      type: 'biweekly',
    });
  };

  if (loading) {
    return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading report…</div>;
  }

  /* ── Step 0: Brand selection ──────────────────────────────────────────── */
  if (step === 0) {
    // If brand auto-selected but still detecting period, show loading
    if (detectingPeriod) {
      return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Detecting next period…</div>;
    }

    return (
      <div>
        {guardModal}
        {onCancel && (
          <button className="btn btn-sm btn-link text-muted p-0 mb-3" onClick={() => guardAction(onCancel)}>
            <i className="bi bi-arrow-left me-1" /> Back to reports
          </button>
        )}
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>New Bi-Weekly Report</h5>
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

  /* ── Step 1: Anchor setup (first-time — no anchor exists yet) ─────────── */
  if (step === 1) {
    // Compute preview end date
    let previewEnd = '';
    if (anchorStartInput) {
      const d = new Date(anchorStartInput + 'T00:00:00');
      d.setDate(d.getDate() + 13);
      previewEnd = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    const startDisplay = anchorStartInput
      ? new Date(anchorStartInput + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    return (
      <div>
        <button className="btn btn-sm btn-link text-muted p-0 mb-3"
          onClick={() => { setStep(0); setSelectedBrand(null); setAnchorStartInput(''); }}>
          <i className="bi bi-arrow-left me-1" /> Back to brands
        </button>
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          {selectedBrand?.name || selectedBrand?.brandName} — Set Bi-Weekly Anchor
        </h5>
        <p className="text-muted small mb-4">
          This is the first bi-weekly report for this brand. Select the start date of the first 2-week period.
          All future bi-weekly periods will automatically follow from this date.
        </p>
        <div className="card border-0 shadow-sm" style={{ borderRadius: 14, maxWidth: 420 }}>
          <div className="card-body p-4">
            <label className="form-label fw-semibold" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <i className="bi bi-calendar2-range me-1 text-primary" /> Starting Date of Period 1
            </label>
            <input
              type="date"
              className="form-control mb-3"
              value={anchorStartInput}
              onChange={e => setAnchorStartInput(e.target.value)}
              style={{ borderRadius: 8, fontSize: '0.85rem' }}
            />
            {anchorStartInput && (
              <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)' }}>
                <div className="fw-semibold" style={{ fontSize: '0.8rem', color: 'var(--info)' }}>
                  <i className="bi bi-calendar-check me-1" /> Period 1 Preview
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--info)', marginTop: 4 }}>
                  {startDisplay} — {previewEnd}
                </div>
                <div className="text-muted mt-1" style={{ fontSize: '0.7rem' }}>
                  Period 2 will start 14 days later, and so on automatically.
                </div>
              </div>
            )}
            <button
              className="btn btn-primary w-100"
              style={{ borderRadius: 8, fontSize: '0.85rem' }}
              onClick={handleSetAnchor}
              disabled={!anchorStartInput || saving}
            >
              {saving ? <><span className="spinner-border spinner-border-sm me-2" />Setting…</> : <><i className="bi bi-check2-circle me-1" />Confirm Starting Period & Begin Report</>}
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

  return (
    <div onInput={() => setDirty(true)}>
      {guardModal}
      {onCancel && (
        <button className="btn btn-sm btn-link text-muted p-0 mb-2" onClick={() => guardAction(onCancel)}>
          <i className="bi bi-arrow-left me-1" /> {editReportId ? 'Cancel editing' : 'Back to reports'}
        </button>
      )}
      <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-2"
        style={{
          position: 'sticky', top: 'var(--topbar-h, 68px)', zIndex: 4,
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '12px 28px', margin: '0 -28px 16px',
        }}>
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {editReportId ? 'Edit' : 'New'} Bi-Weekly Report
          </h5>
          <p className="text-muted small mb-0 d-flex align-items-center gap-2 flex-wrap">
            <span style={{ overflowWrap: 'anywhere' }}>{brandLabel} — {selectedPeriod?.label}</span>
            {editReportId && (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 6, fontSize: '0.65rem', padding: '1px 8px' }}
                onClick={handleChangePeriod} title="Move this report to a different period">
                <i className="bi bi-calendar-event" /> Change Period
              </button>
            )}
          </p>
        </div>
        <div className="d-flex gap-2 flex-wrap">
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)', color: 'white', borderRadius: 10, fontSize: '0.78rem', border: 'none' }}
            onClick={handleGenerateAll} disabled={!!aiLoading.all} title="AI generates insights for all 6 sections">
            {aiLoading.all ? <><span className="spinner-border spinner-border-sm" /> Generating All…</>
              : <><i className="bi bi-stars" /> Generate All Insights</>}
          </button>
          {(reportStatus === 'draft' || !editReportId) ? (
            <>
              <button className="btn btn-outline-secondary btn-sm px-3 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 10 }} onClick={handleSaveDraft} disabled={saving}>
                {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-floppy" />} Save Draft
              </button>
              <button className="btn btn-sm px-4 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 10, background: submitBlock ? '#94a3b8' : '#2563eb', color: 'white', border: 'none' }}
                onClick={handleSubmitReport} disabled={saving || !!submitBlock}
                title={submitBlock?.kind === 'duplicate' ? 'Already submitted for this period' : submitBlock?.kind === 'pendingPrior' ? 'The previous report must be verified by the Team Lead first' : ''}>
                {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-send-fill" /> Submit Report</>}
              </button>
            </>
          ) : (
            <button className="btn btn-dark btn-sm px-4 d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 10 }} onClick={handleSaveChanges} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save Changes</>}
            </button>
          )}
        </div>
      </div>

      {/* ─── Submission gate banner (APC only) ───────────────────────────── */}
      {submitBlock?.kind === 'duplicate' && (
        <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', borderRadius: 10, color: 'var(--warning)' }}>
          <i className="bi bi-lock-fill flex-shrink-0 mt-1" />
          <div>
            <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Already submitted for {selectedPeriod.label}</div>
            <div style={{ fontSize: '0.78rem', marginTop: 2 }}>You can't submit another report for the same period.</div>
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
              Your {submitBlock.report.periodLabel} report is still <strong>{REPORT_STATUSES[submitBlock.report.status]?.label || submitBlock.report.status}</strong>.
              It needs to be verified by the Team Lead before you can submit a new one. You can keep drafting this report in the meantime.
            </div>
          </div>
        </div>
      )}

      {/* Return notice — visible to the recipient at any returned stage, with full history (mig 203). */}
      <ReportReturnNotice report={{ id: editReportId, status: reportStatus }} />

      {/* ─── Currency picker (applies to every monetary field below) ──── */}
      <div className="d-flex align-items-center gap-3 mb-3 p-2 rounded-3"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
        <i className="bi bi-currency-exchange" style={{ color: 'var(--text-secondary)' }} />
        <label className="fw-semibold mb-0" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Report currency:
        </label>
        <select className="form-select form-select-sm" style={{ width: 200, borderRadius: 8 }}
          value={data.currency || DEFAULT_CURRENCY}
          onChange={e => setData(d => ({ ...d, currency: e.target.value }))}>
          {CURRENCIES.map(c => (
            <option key={c.code} value={c.code}>
              {c.symbol}  ·  {c.code} — {c.label}
            </option>
          ))}
        </select>
        <span className="text-muted" style={{ fontSize: '0.72rem' }}>
          All monetary fields below use this currency.
        </span>
      </div>

      {/* ─── Section 1: Overall Performance ─────────────────────────────── */}
      <SectionHeader icon="bi-graph-up-arrow" title="Overall Performance" color="#3b82f6" required
        enabled={sectEnabled.overallPerformance} onToggle={toggleSection('overallPerformance')} />
      {sectEnabled.overallPerformance && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex flex-wrap gap-2 mb-2">
            <Field label={`GMV (${curSym})`} value={data.overallPerformance.gmv} onChange={v => setPerf('gmv', v)} type="number" placeholder="55834.62" />
            <Field label={`Affiliate GMV (${curSym})`} value={data.overallPerformance.affiliateGmv} onChange={v => setPerf('affiliateGmv', v)} type="number" placeholder="49494.24" />
            <Field label="Orders" value={data.overallPerformance.orders} onChange={v => setPerf('orders', v)} type="number" placeholder="813" />
            <Field label="Samples Approved" value={data.overallPerformance.samplesApproved} onChange={v => setPerf('samplesApproved', v)} type="number" placeholder="488" />
          </div>
          <div className="d-flex flex-wrap gap-2 mb-2">
            <Field label="ROI" value={data.overallPerformance.roi} onChange={v => setPerf('roi', v)} type="number" placeholder="2.76" />
            <Field label="Shop Performance Score" value={data.overallPerformance.shopPerformanceScore} onChange={v => setPerf('shopPerformanceScore', v)} type="number" placeholder="4.7" />
            <Field label="Videos Posted" value={data.overallPerformance.videosPosted} onChange={v => setPerf('videosPosted', v)} type="number" placeholder="1377" />
          </div>
          <div className="d-flex flex-wrap gap-2">
            <Field label={`GMV Month-to-Date (${curSym})`} value={data.overallNotes.gmv || ''} onChange={v => setPerfNote('gmv', v)} type="number" placeholder="231714.01" width="240px" />
            <Field label="MTD Approved (Samples Month-to-Date)" value={data.overallNotes.samplesApproved || ''} onChange={v => setPerfNote('samplesApproved', v)} type="number" placeholder="854" width="240px" />
            <Field label="Videos Posted (Month-to-Date)" value={data.overallNotes.videosMtd || ''} onChange={v => setPerfNote('videosMtd', v)} type="number" placeholder="2140" width="240px" />
            <Field label="Total Videos (all-time)" value={data.overallNotes.videosPosted || ''} onChange={v => setPerfNote('videosPosted', v)} type="number" placeholder="25703" width="220px" />
          </div>
          <InsightArea value={data.overallInsights} onChange={v => setData(d => ({ ...d, overallInsights: v }))}
            loading={!!aiLoading.overall || !!aiLoading.all}
            onGenerate={() => runAi('overall', generateOverallInsight, 'overallInsights')} />
        </div>
      </div>
      )}

      {/* ─── Section 2: Top Creators ────────────────────────────────────── */}
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
          <InsightArea value={data.topCreatorsInsights} onChange={v => setData(d => ({ ...d, topCreatorsInsights: v }))}
            loading={!!aiLoading.creators || !!aiLoading.all}
            onGenerate={() => runAi('creators', generateCreatorsInsight, 'topCreatorsInsights')} />
        </div>
      </div>
      )}

      {/* ─── Section 3: Top Videos ──────────────────────────────────────── */}
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
          <InsightArea value={data.topVideosInsights} onChange={v => setData(d => ({ ...d, topVideosInsights: v }))}
            loading={!!aiLoading.videos || !!aiLoading.all}
            onGenerate={() => runAi('videos', generateVideosInsight, 'topVideosInsights')} />
        </div>
      </div>
      )}

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
          <InsightArea value={data.gmvMaxInsights} onChange={v => setData(d => ({ ...d, gmvMaxInsights: v }))}
            loading={!!aiLoading.gmvMax || !!aiLoading.all}
            onGenerate={() => runAi('gmvMax', generateGmvMaxInsight, 'gmvMaxInsights')} />
        </div>
      </div>
      )}

      {/* ─── Month-to-Date GMV Max (auto-calcs MTD overall) ──────────────── */}
      {sectEnabled.gmvMax && (
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex align-items-center gap-2 mb-2">
            <i className="bi bi-calendar-range-fill" style={{ color: '#ef4444' }} />
            <span className="fw-semibold" style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>Month-to-Date GMV Max Campaigns</span>
          </div>
          <p className="text-muted mb-2" style={{ fontSize: '0.72rem' }}>
            Enter each campaign's spend / GMV / orders for the month so far. The overall MTD totals are calculated automatically.
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
              { key: 'unitsSold', label: 'Units Sold', type: 'number', width: '90px' },
              { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '100px' },
              { key: 'newVideos', label: 'Videos (wk)', type: 'number', width: '90px' },
              { key: 'videosMtd', label: 'Videos MTD', type: 'number', width: '90px' },
              { key: 'samplesApprovedWeek', label: 'Samples (wk)', type: 'number', width: '95px' },
              { key: 'samplesApprovedMtd', label: 'Samples MTD', type: 'number', width: '95px' },
              { key: 'notes', label: 'Notes', width: '130px' },
            ]} />
          <InsightArea value={data.productHighlightsInsights} onChange={v => setData(d => ({ ...d, productHighlightsInsights: v }))}
            loading={!!aiLoading.products || !!aiLoading.all}
            onGenerate={() => runAi('products', generateProductsInsight, 'productHighlightsInsights')} />
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
          <InsightArea value={data.offsiteInsights} onChange={v => setData(d => ({ ...d, offsiteInsights: v }))}
            loading={!!aiLoading.offsite || !!aiLoading.all}
            onGenerate={() => runAi('offsite', generateOffsiteInsight, 'offsiteInsights')} />
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
              sourceLabel={previousReport?.periodLabel || 'previous period'} />
          </div>
          <RichTextEditor value={data.upcomingCampaigns || ''}
            onChange={v => setData(d => ({ ...d, upcomingCampaigns: v }))}
            minHeight={140}
            placeholder="List any upcoming campaigns, launches or planned promotions" />
        </div>
      </div>
      )}

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
              sourceLabel={previousReport?.periodLabel || 'previous period'} />
          </div>
          <RichTextEditor value={data.operationalUpdates || ''}
            onChange={v => setData(d => ({ ...d, operationalUpdates: v }))}
            minHeight={140}
            placeholder="Describe the workflow and operational tasks completed this period" />
        </div>
      </div>
      )}

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
              sourceLabel={previousReport?.periodLabel || 'previous period'} />
          </div>
          <RichTextEditor value={data.recommendations || ''}
            onChange={v => setData(d => ({ ...d, recommendations: v }))}
            minHeight={160}
            placeholder="Share your recommendations and action items for next steps" />
        </div>
      </div>
      )}

      {/* ─── Optional: Custom Fields (per user) ──────────────────────────── */}
      <div className="d-flex align-items-center justify-content-between mb-3 mt-4">
        <div className="d-flex align-items-center gap-2">
          <div className="rounded-2 d-flex align-items-center justify-content-center"
            style={{ width: 32, height: 32, background: '#8b5cf618' }}>
            <i className="bi bi-sliders" style={{ fontSize: '0.9rem', color: '#8b5cf6' }} />
          </div>
          <h6 className="fw-bold mb-0" style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>
            My Custom Fields (Optional)
          </h6>
        </div>
        <button className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1"
          style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={addCustomField}>
          <i className="bi bi-plus-circle" /> Add Custom Field
        </button>
      </div>
      {customFieldDefs.length === 0 ? (
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
          <div className="card-body p-3 text-center text-muted" style={{ fontSize: '0.78rem' }}>
            No custom fields yet. Click <strong>+ Add Custom Field</strong> to create your own sections.
            These fields are just for you — other users won't see them.
          </div>
        </div>
      ) : (
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
          <div className="card-body p-3">
            {customFieldDefs.map((field, i) => (
              <div key={field.id} className={i > 0 ? 'mt-3 pt-3' : ''}
                style={i > 0 ? { borderTop: '1px solid var(--border-subtle)' } : {}}>
                <div className="d-flex align-items-center justify-content-between mb-1">
                  <label className="form-label mb-0 fw-semibold" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                    {field.name}
                  </label>
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
                        sourceLabel={previousReport?.periodLabel || 'previous period'} />
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
            ))}
          </div>
        </div>
      )}

      {/* ─── Bottom action bar ────────────────────────────────────────────── */}
      <div className="d-flex justify-content-end gap-2 mt-4 pb-4">
        {(reportStatus === 'draft' || !editReportId) ? (
          <>
            <button className="btn btn-outline-secondary btn-sm px-4 d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 10 }} onClick={handleSaveDraft} disabled={saving}>
              {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-floppy" />} Save Draft
            </button>
            <button className="btn btn-sm px-5 d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 10, background: submitBlock ? '#94a3b8' : '#2563eb', color: 'white', border: 'none' }}
              onClick={handleSubmitReport} disabled={saving || !!submitBlock}
              title={submitBlock?.kind === 'duplicate' ? 'Already submitted for this period' : submitBlock?.kind === 'pendingPrior' ? 'The previous report must be verified by the Team Lead first' : ''}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-send-fill" /> Submit Report</>}
            </button>
          </>
        ) : (
          <button className="btn btn-dark btn-sm px-5 d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 10 }} onClick={handleSaveChanges} disabled={saving}>
            {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save Changes</>}
          </button>
        )}
      </div>
    </div>
  );
}
