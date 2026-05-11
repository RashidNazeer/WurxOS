import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
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
import { notifyReportSubmitted } from '../../utils/reportNotifications';
import { parsePdfToReport } from '../../utils/pdfReportParser';
import { CURRENCIES, currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import RichTextEditor from '../shared/RichTextEditor';

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
  // Live-clean via cleanNumericInput so currency, commas, and % drop out.
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
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!!editReportId);
  const [detectingWeek, setDetectingWeek] = useState(false);
  const [aiLoading, setAiLoading] = useState({}); // per-section loading state
  const [customFieldDefs, setCustomFieldDefs] = useState([]); // [{id, name}]
  const [reportStatus, setReportStatus] = useState('draft');
  const [rejectionNote, setRejectionNote] = useState('');
  const [importing, setImporting] = useState(false);
  const [importToast, setImportToast] = useState(null);
  const pdfInputRef = React.useRef(null);

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

  // Load report for editing
  useEffect(() => {
    if (!editReportId) return;
    (async () => {
      setLoading(true);
      const r = await getReport(editReportId);
      if (r) {
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
          gmvMaxInsights: r.gmvMaxInsights || '',
          productHighlights: r.productHighlights || emptyReport().productHighlights,
          productHighlightsInsights: r.productHighlightsInsights || '',
          offsitePerformance: r.offsitePerformance || emptyReport().offsitePerformance,
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
      setLoading(false);
    })();
  }, [editReportId, brands]);

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
    const w = makeWeekFromStart(weekStartInput, 1);
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
  // We sort by createdAt (descending) so OL date-edits don't reshuffle history.
  // Legacy reports without createdAt fall back to weekStart for ordering.
  const previousReport = useMemo(() => {
    if (!existingReports.length || !selectedWeek) return null;
    const tsOf = r => r.createdAt?.toMillis ? r.createdAt.toMillis()
      : r.createdAt?.seconds ? r.createdAt.seconds * 1000
      : null;
    const current = editReportId ? existingReports.find(r => r.id === editReportId) : null;
    const currentTs = current ? tsOf(current) : Date.now();
    const candidates = existingReports.filter(r => {
      if (current && r.id === current.id) return false;
      const ts = tsOf(r);
      if (ts != null && currentTs != null) return ts < currentTs;
      return (r.weekStart || '') < selectedWeek.startDate;
    });
    candidates.sort((a, b) => {
      const aTs = tsOf(a), bTs = tsOf(b);
      if (aTs != null && bTs != null) return bTs - aTs;
      return (b.weekStart || '').localeCompare(a.weekStart || '');
    });
    return candidates[0] || null;
  }, [existingReports, selectedWeek, editReportId]);

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
  const duplicateForThisWeek = useMemo(() => {
    if (!existingReports.length || !selectedWeek) return null;
    return existingReports.find(r =>
      r.weekStart === selectedWeek.startDate &&
      r.id !== editReportId &&
      r.status && r.status !== 'draft'
    ) || null;
  }, [existingReports, selectedWeek, editReportId]);
  const priorPendingApproval = useMemo(() => {
    if (!isApc || !previousReport) return null;
    return (previousReport.status && previousReport.status !== 'approved') ? previousReport : null;
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
      if (!data.overallNotes?.videosPosted) missing.push('Overall: Total Videos');
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

  const _doSave = async (status, extra = {}) => {
    if (!selectedBrand || !selectedWeek) return;
    setSaving(true);
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      // Strip any customFields entries whose field def was deleted — otherwise the view
      // keeps rendering them from the stored report doc.
      const validIds = new Set(customFieldDefs.map(f => f.id));
      const cleanedCustomFields = Object.fromEntries(
        Object.entries(data.customFields || {}).filter(([id]) => validIds.has(id))
      );
      const cleanedData = { ...data, customFields: cleanedCustomFields };
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
      if (onSaved) onSaved({
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
    } catch (err) {
      alert('Failed to save report: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  /** Save progress without validation — keeps current draft status */
  const handleSaveDraft = () => _doSave('draft', { rejectionNote: rejectionNote || null });

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
      alert(`Your previous report (${prev.weekLabel}) is still waiting for OL approval. It needs to be approved before you can submit a new one.`);
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
        {onCancel && (
          <button className="btn btn-sm btn-link text-muted p-0 mb-3" onClick={onCancel}>
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
          onClick={() => { setStep(0); setSelectedBrand(null); setWeekStartInput(''); }}>
          <i className="bi bi-arrow-left me-1" /> Back to brands
        </button>
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          {selectedBrand?.name || selectedBrand?.brandName} — Set Weekly Anchor
        </h5>
        <p className="text-muted small mb-4">
          This is the first weekly report for this brand. Select the start date of your first 7-day reporting week.
          All future weekly reports will automatically follow from this date.
        </p>
        <div className="card border-0 shadow-sm" style={{ borderRadius: 14, maxWidth: 420 }}>
          <div className="card-body p-4">
            <label className="form-label fw-semibold" style={{ fontSize: '0.8rem', color: '#374151' }}>
              <i className="bi bi-calendar-week me-1 text-primary" /> Starting Date of Week 1
            </label>
            <input
              type="date"
              className="form-control mb-3"
              value={weekStartInput}
              onChange={e => setWeekStartInput(e.target.value)}
              style={{ borderRadius: 8, fontSize: '0.85rem' }}
            />
            {weekStartInput && (
              <div className="rounded-3 p-3 mb-3" style={{ background: '#f0f9ff', border: '1px solid #bae6fd' }}>
                <div className="fw-semibold" style={{ fontSize: '0.8rem', color: '#0369a1' }}>
                  <i className="bi bi-calendar-check me-1" /> Week 1 Preview
                </div>
                <div style={{ fontSize: '0.85rem', color: '#0c4a6e', marginTop: 4 }}>
                  {startDisplay} — {previewEnd}
                </div>
                <div className="text-muted mt-1" style={{ fontSize: '0.7rem' }}>
                  Week 2 will start 7 days later, and so on automatically.
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

  return (
    <div>
      {onCancel && (
        <button className="btn btn-sm btn-link text-muted p-0 mb-2" onClick={onCancel}>
          <i className="bi bi-arrow-left me-1" /> {editReportId ? 'Cancel editing' : 'Back to reports'}
        </button>
      )}
      <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>
            {editReportId ? 'Edit' : 'New'} Weekly Report
          </h5>
          <p className="text-muted small mb-0 d-flex align-items-center gap-2 flex-wrap">
            <span>{brandLabel} — {selectedWeek?.label}</span>
            {editReportId && (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 6, fontSize: '0.65rem', padding: '1px 8px' }}
                onClick={handleChangeWeek} title="Move this report to a different week">
                <i className="bi bi-calendar-event" /> Change Week
              </button>
            )}
          </p>
        </div>
        <div className="d-flex gap-2 flex-wrap">
          <input ref={pdfInputRef} type="file" accept="application/pdf" style={{ display: 'none' }}
            onChange={e => handleImportPdf(e.target.files?.[0])} />
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ background: 'var(--surface-1)', color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10, fontSize: '0.78rem' }}
            onClick={() => pdfInputRef.current?.click()} disabled={importing}
            title="Upload a PDF (Google Doc export) to auto-fill this form">
            {importing ? <><span className="spinner-border spinner-border-sm" /> Reading PDF…</>
              : <><i className="bi bi-file-earmark-pdf-fill" /> Import from PDF</>}
          </button>
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)', color: 'white', borderRadius: 10, fontSize: '0.78rem', border: 'none' }}
            onClick={handleGenerateAll} disabled={!!aiLoading.all} title="AI generates insights for all 6 sections">
            {aiLoading.all ? <><span className="spinner-border spinner-border-sm" /> Generating All…</>
              : <><i className="bi bi-stars" /> Generate All Insights</>}
          </button>
          {(reportStatus === 'draft' || !editReportId) ? (
            <>
              <button className="btn btn-outline-secondary btn-sm px-3 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 10 }} onClick={handleSaveDraft}
                disabled={saving || !!duplicateForThisWeek}
                title={duplicateForThisWeek ? 'A report already exists for this week — saving here would overwrite it.' : ''}>
                {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-floppy" />} Save Draft
              </button>
              <button className="btn btn-sm px-4 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 10, background: submitBlock ? '#94a3b8' : '#2563eb', color: 'white', border: 'none' }}
                onClick={handleSubmitReport} disabled={saving || !!submitBlock}
                title={submitBlock?.kind === 'duplicate' ? 'A report already exists for this week.' : submitBlock?.kind === 'pendingPrior' ? 'Waiting for OL approval on the previous report' : ''}>
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
            background: importToast.kind === 'success' ? '#ecfdf5' : importToast.kind === 'warn' ? '#fffbeb' : '#fef2f2',
            border: `1px solid ${importToast.kind === 'success' ? '#a7f3d0' : importToast.kind === 'warn' ? '#fde68a' : '#fecaca'}`,
            borderRadius: 10,
            color: importToast.kind === 'success' ? '#065f46' : importToast.kind === 'warn' ? '#92400e' : '#991b1b',
          }}>
          <i className={`bi ${importToast.kind === 'success' ? 'bi-check-circle-fill' : importToast.kind === 'warn' ? 'bi-exclamation-circle-fill' : 'bi-x-circle-fill'} flex-shrink-0 mt-1`} />
          <div className="flex-grow-1" style={{ fontSize: '0.78rem' }}>{importToast.msg}</div>
          <button type="button" className="btn-close btn-close-sm" onClick={() => setImportToast(null)} style={{ fontSize: '0.6rem' }} />
        </div>
      )}

      {/* ─── Rejection banner (shown when report was rejected back) ────── */}
      {rejectionNote && reportStatus === 'draft' && editReportId && (
        <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
          style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10, color: 'var(--danger)' }}>
          <i className="bi bi-exclamation-triangle-fill flex-shrink-0 mt-1" />
          <div>
            <div className="fw-bold" style={{ fontSize: '0.8rem' }}>This report was returned for revision</div>
            <div style={{ fontSize: '0.78rem', marginTop: 2 }}>{rejectionNote}</div>
          </div>
        </div>
      )}

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
            <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Previous report awaiting OL approval</div>
            <div style={{ fontSize: '0.78rem', marginTop: 2 }}>
              Your {submitBlock.report.weekLabel} report is still <strong>{REPORT_STATUSES[submitBlock.report.status]?.label || submitBlock.report.status}</strong>.
              It needs to be approved by the Operation Lead before you can submit a new one. You can keep drafting this report in the meantime.
            </div>
          </div>
        </div>
      )}

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
          All monetary fields ($, GMV, Spend, etc.) below use this currency.
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
            <Field label="MTD Approved (Samples Month-to-Date)" value={data.overallNotes.samplesApproved || ''} onChange={v => setPerfNote('samplesApproved', v)} type="number" placeholder="854" width="240px" />
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
              { key: 'newVideos', label: 'New Videos', type: 'number', width: '90px' },
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
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
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
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
          </div>
          <RichTextEditor value={data.operationalUpdates || ''}
            onChange={v => setData(d => ({ ...d, operationalUpdates: v }))}
            minHeight={140}
            placeholder="Describe the workflow and operational tasks completed this week" />
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
              sourceLabel={previousReport?.weekLabel || 'previous week'} />
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
                  // Find previous value by id first, then fall back to a
                  // name match — custom-field templates are per-user and
                  // ids can rotate when a field is renamed or recreated.
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
            ))}
          </div>
        </div>
      )}

      {/* ─── Save buttons bottom ────────────────────────────────────────── */}
      <div className="d-flex justify-content-end gap-2 mb-4 flex-wrap">
        {onCancel && (
          <button className="btn btn-outline-secondary btn-sm px-4" style={{ borderRadius: 10 }} onClick={onCancel}>Cancel</button>
        )}
        {(reportStatus === 'draft' || !editReportId) ? (
          <>
            <button className="btn btn-outline-secondary px-4 d-inline-flex align-items-center gap-2"
              style={{ borderRadius: 10 }} onClick={handleSaveDraft} disabled={saving}>
              {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-floppy" />} Save Draft
            </button>
            <button className="btn px-5 d-inline-flex align-items-center gap-2"
              style={{ borderRadius: 10, background: submitBlock ? '#94a3b8' : '#2563eb', color: 'white', border: 'none' }}
              onClick={handleSubmitReport} disabled={saving || !!submitBlock}
              title={submitBlock?.kind === 'duplicate' ? 'Already submitted for this week' : submitBlock?.kind === 'pendingPrior' ? 'Waiting for OL approval on the previous report' : ''}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-send-fill" /> Submit Report</>}
            </button>
          </>
        ) : (
          <button className="btn btn-dark px-5 d-inline-flex align-items-center gap-2"
            style={{ borderRadius: 10 }} onClick={handleSaveChanges} disabled={saving}>
            {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save Changes</>}
          </button>
        )}
      </div>
    </div>
  );
}
