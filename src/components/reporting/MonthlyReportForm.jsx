import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { useReportLeaveGuard } from './useReportLeaveGuard';
import { useStickyHeaderOffset } from '../../hooks/useStickyHeaderOffset';
import { useBrandSections, cleanCustomFields } from './useBrandSections';
import { BrandSectionsBlock, AddCustomSectionInline } from './BrandCustomSections';
import { useReportAutosave, loadDraft } from '../../utils/reportDraftAutosave';
import { useBrands } from '../../contexts/BrandsContext';
import {
  emptyMonthlyReport, makeMonthInfo, detectNextMonth, getFirstTimeMonthOptions,
  saveMonthlyReport, getMonthlyReport, getMonthlyReportsForBrand, changeMonthlyReportMonth,
  REPORT_STATUSES,
  getUserCustomFields, saveUserCustomFields,
  MONTHLY_SECTIONS, resolveSectionsEnabled,
  cleanNumericInput,
} from '../../utils/monthlyReportingService';
import { findPreviousMonthlyReport } from '../../lib/reportsApi';
import { generateMonthlyKeyWinsInsight } from '../../utils/aiInsights';
import { notifyReportSubmitted } from '../../utils/reportNotifications';
import { parseMonthlyPdfToReport } from '../../utils/pdfReportParser';
import { CURRENCIES, currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import { formatPctChange } from '../../utils/formatPctChange';
import RichTextEditor from '../shared/RichTextEditor';
import ReportReturnNotice from './ReportReturnNotice';

/* ── Tiny reusable pieces ─────────────────────────────────────────────────── */

function Field({ label, value, onChange, type = 'text', placeholder, width = '100%' }) {
  // Use type="text" + inputMode="decimal" for numeric fields so users can paste
  // formatted strings like "$3,456.9" — type="number" silently rejects them.
  const isNum = type === 'number';
  return (
    <div style={{ width, minWidth: 100 }}>
      {label && (
        <label className="form-label mb-1" style={{ fontSize: '0.66rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      )}
      <input type={isNum ? 'text' : type}
        inputMode={isNum ? 'decimal' : undefined}
        className="form-control form-control-sm"
        style={{ borderRadius: 8 }}
        placeholder={placeholder} value={value || ''}
        onChange={e => onChange(isNum ? cleanNumericInput(e.target.value) : e.target.value)} />
    </div>
  );
}

// Auto-grows vertically, manually resizable
function AutoGrowTextarea({ value, minRows = 6, placeholder, onChange }) {
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
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      onInput={resize}
      style={{ borderRadius: 8, resize: 'vertical', overflow: 'hidden' }} />
  );
}

function ArraySection({ items, setItems, fields, addLabel, minRows = 1 }) {
  const add = () => {
    const empty = {};
    fields.forEach(f => { empty[f.key] = ''; });
    setItems([...items, empty]);
  };
  const remove = (i) => {
    if (items.length <= minRows) return;
    setItems(items.filter((_, idx) => idx !== i));
  };
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
          {items.length > minRows && (
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

/* Render a small "vs last month" chip next to a value field */
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
  const color = pct == null ? '#64748b' : pct >= 0 ? '#16a34a' : '#dc2626';
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

/* ── Section header helper ────────────────────────────────────────────────── */
function SectionCard({ icon, title, children, color = '#3b82f6', actions }) {
  return (
    <div className="card mb-3" style={{
      borderRadius: 12,
      border: '1px solid var(--border-subtle)',
      boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
    }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="d-flex align-items-center gap-2">
            <div className="rounded-2 d-flex align-items-center justify-content-center"
              style={{ width: 28, height: 28, background: `${color}15` }}>
              <i className={`bi ${icon}`} style={{ color, fontSize: '0.85rem' }} />
            </div>
            <h6 className="fw-bold mb-0" style={{ fontSize: '0.92rem' }}>{title}</h6>
          </div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Main Form ────────────────────────────────────────────────────────────── */

export default function MonthlyReportForm({ editReportId, onSaved, onCancel }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '' } : null;
  const userProfile = { displayName: profile?.display_name || '' };
  const { brands } = useBrands();

  const [selectedBrand, setSelectedBrand] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [existingReports, setExistingReports] = useState([]);
  const [data, setData] = useState(emptyMonthlyReport());
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

  // Auto-save to localStorage every 30s — same pattern as the
  // weekly / bi-weekly forms. Monthly was missing autosave entirely
  // before this; an APC editing a monthly report had ZERO safety
  // net if the editor got remounted. Now enabled for both new and
  // edit modes, with editReportId in the key to keep drafts of
  // different reports isolated.
  const periodStartForKey = selectedMonth ? `${selectedMonth.year}-${String(selectedMonth.month).padStart(2,'0')}-01` : null;
  const draftKey = {
    type: 'monthly',
    uid: currentUser?.uid,
    brandId: selectedBrand?.id,
    periodStart: periodStartForKey,
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
  const [detecting, setDetecting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [reportStatus, setReportStatus] = useState('draft');
  const [rejectionNote, setRejectionNote] = useState('');
  const [customFieldDefs, setCustomFieldDefs] = useState([]); // [{id, name}] — shared with weekly
  const [importing, setImporting] = useState(false);
  const [importToast, setImportToast] = useState(null);
  const pdfInputRef = React.useRef(null);

  // Step: 0=brand, 1=first-time month pick, 2=form
  const [step, setStep] = useState(editReportId ? 2 : 0);

  const myBrands = brands;

  // Auto-select if single brand
  useEffect(() => {
    if (!editReportId && myBrands.length === 1 && !selectedBrand) {
      setSelectedBrand(myBrands[0]);
    }
  }, [myBrands, selectedBrand, editReportId]);

  // Load this user's custom field templates (shared with weekly reports)
  useEffect(() => {
    if (!currentUser?.uid) return;
    getUserCustomFields(currentUser.uid).then(setCustomFieldDefs).catch(() => {});
  }, [currentUser?.uid]);

  // When brand selected: load reports, detect next month, advance step
  useEffect(() => {
    if (!selectedBrand || editReportId) return;
    let cancelled = false;
    setDetecting(true);
    getMonthlyReportsForBrand(selectedBrand.id).then(reports => {
      if (cancelled) return;
      setExistingReports(reports);
      setDetecting(false);
      if (reports.length === 0) {
        setStep(1);
      } else {
        const next = detectNextMonth(reports);
        if (next) {
          setSelectedMonth(next);
          setStep(2);
        } else {
          setStep(1);
        }
      }
    });
    return () => { cancelled = true; };
  }, [selectedBrand, editReportId]);

  useEffect(() => {
    if (!selectedBrand || !editReportId) return;
    getMonthlyReportsForBrand(selectedBrand.id).then(setExistingReports);
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
        const r = await getMonthlyReport(editReportId);
        if (cancelled) return;
        if (r) {
          const brand = brands.find(b => b.id === r.brandId);
          setSelectedBrand(brand || { id: r.brandId, name: r.brandName });
          setSelectedMonth(makeMonthInfo(r.year, r.month));
          const empty = emptyMonthlyReport();
          setData({
            currency: r.currency || empty.currency,
            sectionsEnabled: resolveSectionsEnabled(r.sectionsEnabled),
            totalSales: r.totalSales || empty.totalSales,
            keyMetrics: r.keyMetrics || empty.keyMetrics,
            kpis: r.kpis || empty.kpis,
            gmvBreakdown: r.gmvBreakdown || empty.gmvBreakdown,
            topCreators: r.topCreators?.length ? r.topCreators : empty.topCreators,
            topVideos:   r.topVideos?.length   ? r.topVideos   : empty.topVideos,
            videoPerformance: r.videoPerformance || empty.videoPerformance,
            creatorsPerformance: r.creatorsPerformance || empty.creatorsPerformance,
            productAnalytics: r.productAnalytics?.length ? r.productAnalytics : empty.productAnalytics,
            gmvMax: r.gmvMax?.length ? r.gmvMax : empty.gmvMax,
            customers: r.customers || empty.customers,
            keyWinsInsights: r.keyWinsInsights || '',
            campaignsText: r.campaignsText || '',
            recommendations: r.recommendations || '',
            customFields: r.customFields || {},
          });
          setReportStatus(r.status || 'draft');
          setRejectionNote(r.rejectionNote || '');
        }
      } catch (e) {
        console.warn('Failed to load monthly report for editing:', e?.message || e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editReportId]);

  // Previous report = the closest earlier calendar month for this brand.
  // Routed through findPreviousMonthlyReport so the Edit screen agrees
  // with the View screen — both now compare by monthKey, never by
  // createdAt. (createdAt ordering produced visible inconsistencies:
  // a report created out-of-order, e.g. an OL backfill, could pick a
  // different "previous" than what the View showed → user saw
  // contradictory MoM deltas.)
  const previousReport = useMemo(() => {
    if (!existingReports.length || !selectedMonth) return null;
    const current = editReportId
      ? existingReports.find(r => r.id === editReportId)
      : { id: '__pending__', brandId: selectedBrand?.id, monthKey: selectedMonth.monthKey };
    if (!current) return null;
    return findPreviousMonthlyReport(existingReports, current);
  }, [existingReports, selectedMonth, editReportId, selectedBrand?.id]);

  // APC-only submission gates: duplicate month or prior not yet OL-approved
  const isApc = userRole === 'apc';
  const duplicateForThisMonth = useMemo(() => {
    if (!isApc || !existingReports.length || !selectedMonth) return null;
    return existingReports.find(r =>
      r.monthKey === selectedMonth.monthKey &&
      r.id !== editReportId &&
      r.status && r.status !== 'draft'
    ) || null;
  }, [isApc, existingReports, selectedMonth, editReportId]);
  const priorPendingApproval = useMemo(() => {
    if (!isApc || !previousReport) return null;
    return (previousReport.status && previousReport.status !== 'approved') ? previousReport : null;
  }, [isApc, previousReport]);
  const submitBlock = duplicateForThisMonth
    ? { kind: 'duplicate', report: duplicateForThisMonth }
    : priorPendingApproval
      ? { kind: 'pendingPrior', report: priorPendingApproval }
      : null;

  const brandName = selectedBrand?.name || selectedBrand?.brandName || 'Unknown';
  const curSym = currencySymbol(data.currency || DEFAULT_CURRENCY);
  const sectEnabled = resolveSectionsEnabled(data.sectionsEnabled);

  const handleBrandSelect = (b) => {
    setSelectedBrand(b);
    setData(emptyMonthlyReport());
    setSelectedMonth(null);
  };

  const handleFirstMonthPick = (mInfo) => {
    setSelectedMonth(mInfo);
    setStep(2);
  };

  const handleImportPdf = async (file) => {
    if (!file) return;
    setImporting(true);
    setImportToast(null);
    try {
      const parsed = await parseMonthlyPdfToReport(file);
      const diag = parsed.__diagnostics || {};
      delete parsed.__diagnostics;

      // Merge: only overwrite keys the parser actually filled. For nested
      // objects (totalSales, keyMetrics, kpis, etc.) we shallow-merge so
      // the user's manually-typed fields aren't blown away.
      setData(d => {
        const next = { ...d };
        const objKeys = [
          'totalSales', 'keyMetrics', 'kpis', 'gmvBreakdown',
          'videoPerformance', 'creatorsPerformance', 'customers',
        ];
        for (const k of objKeys) {
          if (parsed[k]) next[k] = { ...(d[k] || {}), ...parsed[k] };
        }
        if (parsed.topCreators?.length)      next.topCreators      = parsed.topCreators;
        if (parsed.topVideos?.length)        next.topVideos        = parsed.topVideos;
        if (parsed.productAnalytics?.length) next.productAnalytics = parsed.productAnalytics;
        if (parsed.gmvMax?.length)           next.gmvMax           = parsed.gmvMax;
        if (parsed.keyWinsInsights)          next.keyWinsInsights  = parsed.keyWinsInsights;
        if (parsed.recommendations)          next.recommendations  = parsed.recommendations;
        return next;
      });

      const filled = [];
      const metricCount =
        (diag.totalSalesFields || 0) + (diag.keyMetricFields || 0) +
        (diag.kpiFields || 0) + (diag.gmvBreakdownFields || 0) +
        (diag.videoPerformanceFields || 0) + (diag.creatorsPerformanceFields || 0) +
        (diag.customerFields || 0);
      if (metricCount > 0)            filled.push(`${metricCount} metric fields`);
      if (diag.creators > 0)          filled.push(`${diag.creators} creators`);
      if (diag.videos > 0)            filled.push(`${diag.videos} videos${diag.videosWithLink > 0 ? ` (${diag.videosWithLink} with links)` : ''}`);
      if (diag.products > 0)          filled.push(`${diag.products} product${diag.products === 1 ? '' : 's'}`);
      if (diag.gmvMax > 0)            filled.push(`${diag.gmvMax} GMV Max row${diag.gmvMax === 1 ? '' : 's'}`);
      if (diag.hasInsights)           filled.push('Strategy & Insights');
      if (diag.hasRecommendations)    filled.push('Action Items');

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

  // Setters for nested objects
  const setObj = (key, field, val) => setData(d => ({ ...d, [key]: { ...(d[key] || {}), [field]: val } }));

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

  // Per-section visibility toggle for brand custom sections (keyed by the
  // section's id in data.sectionsEnabled), matching the weekly form's shape
  // so BrandSectionsBlock can drive show/hide.
  const toggleBrandSection = useCallback((key) => (val) => setData(d => ({
    ...d,
    sectionsEnabled: { ...resolveSectionsEnabled(d.sectionsEnabled), [key]: val },
  })), []);

  // AI: generate Key Wins narrative
  const runKeyWinsAi = async () => {
    setAiLoading(true);
    try {
      const text = await generateMonthlyKeyWinsInsight(data, previousReport, brandName, selectedMonth?.label || '');
      setData(d => ({ ...d, keyWinsInsights: text }));
    } catch (err) {
      alert('AI generation failed: ' + err.message);
    } finally {
      setAiLoading(false);
    }
  };

  // Validation — only required fields from sections that are still enabled.
  // If user has unticked a section, we don't enforce its required fields.
  const validate = () => {
    const missing = [];
    const en = resolveSectionsEnabled(data.sectionsEnabled);
    if (en.totalSales) {
      if (!data.totalSales?.monthGmv) missing.push('Total Sales: Month GMV');
      if (!data.totalSales?.allTimeGmv) missing.push('Total Sales: All-time GMV');
    }
    if (en.keyMetrics) {
      const km = data.keyMetrics || {};
      if (!km.gmv) missing.push('Key Metrics: GMV');
      if (!km.orders) missing.push('Key Metrics: Orders');
    }
    if (en.kpis) {
      const k = data.kpis || {};
      if (k.completedCollabs === '' || k.completedCollabs == null) missing.push('KPI: Completed Collabs');
      if (k.totalOrders === '' || k.totalOrders == null) missing.push('KPI: Total Orders');
    }
    if (en.topCreators && !(data.topCreators || []).some(c => c.username && c.username.trim()))
      missing.push('Top Creators (at least 1)');
    if (en.topVideos && !(data.topVideos || []).some(v => v.videoLink && v.videoLink.trim()))
      missing.push('Top Videos (at least 1)');
    if (en.productAnalytics && !(data.productAnalytics || []).some(p => (p.productName && p.productName.trim()) || (p.productId && p.productId.trim())))
      missing.push('Product Analytics (at least 1)');
    if (en.gmvMax && !(data.gmvMax || []).some(g => g.campaign && g.campaign.trim()))
      missing.push('GMV Max Performance (at least 1 campaign)');
    return missing;
  };

  const handleChangeMonth = async () => {
    if (!editReportId || !selectedBrand) return;
    const input = window.prompt(
      `Enter the new month for this report (YYYY-MM, e.g. 2026-03).\n\nCurrent: ${selectedMonth?.label}`,
      selectedMonth?.monthKey || ''
    );
    if (!input) return;
    const m = input.match(/^(\d{4})-(\d{2})$/);
    if (!m) { alert('Invalid format. Use YYYY-MM.'); return; }
    const newMonth = makeMonthInfo(Number(m[1]), Number(m[2]) - 1);
    if (newMonth.monthKey === selectedMonth?.monthKey) return;
    if (!window.confirm(`Change month to ${newMonth.label}? The report will be re-saved under the new month.`)) return;
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      const newId = await changeMonthlyReportMonth(editReportId, newMonth, {
        brandId: selectedBrand.id,
        brandName,
        ...data,
        createdBy: currentUser.uid,
        createdByName: userName,
        status: reportStatus,
      });
      alert('Month changed. Report list will refresh.');
      if (onSaved) onSaved({ id: newId, brandId: selectedBrand.id });
    } catch (err) {
      alert('Failed to change month: ' + err.message);
    }
  };

  const _doSave = async (status, extra = {}, opts = {}) => {
    if (!selectedBrand || !selectedMonth) return;
    setSaving(true);
    try {
      const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
      // Strip deleted per-user custom fields so the view doesn't render
      // orphans — but KEEP brand-scoped entries (long_text / table /
      // builtin_extra), which are owned by the brand template, not this
      // user. Using validIds alone would wipe every brand section on save.
      const validIds = new Set(customFieldDefs.map(f => f.id));
      const cleanedCustomFields = cleanCustomFields(data.customFields, validIds);
      const cleanedData = { ...data, customFields: cleanedCustomFields };
      const savedId = await saveMonthlyReport({
        brandId: selectedBrand.id,
        brandName,
        monthInfo: selectedMonth,
        data: cleanedData,
        uid: currentUser.uid,
        userName,
        status,
        extraFields: extra,
      });
      setDirty(false); // changes are persisted — release the guard
      clearLocalDraft();  // discard the localStorage safety-net for this report
      setReportStatus(status); // mirror the saved status into the pill so it
                               // doesn't show the stale loaded value (e.g.
                               // 'approved' lingering after Save-as-Draft).
      // `opts.stay` (used by the leave-guard draft save) persists silently
      // without bubbling the navigate-away that onSaved triggers.
      if (!opts.stay && onSaved) onSaved({
        id: savedId,
        brandId: selectedBrand.id,
        brandName,
        year: selectedMonth.year,
        month: selectedMonth.month,
        monthKey: selectedMonth.monthKey,
        monthLabel: selectedMonth.label,
        createdByName: userName,
        status,
        ...cleanedData,
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

  const handleSaveDraft = () => _doSave('draft', { rejectionNote: rejectionNote || null });

  // Leave-guard: persist the current state as a draft WITHOUT navigating
  // (preserves the report's current status — 'draft' for a new report).
  const onSaveDraft = () => _doSave(reportStatus, { rejectionNote: rejectionNote || null }, { stay: true });
  const { guardModal, guardAction } = useReportLeaveGuard({ dirty, onSaveDraft });
  const { headerRef, rteTopStyle } = useStickyHeaderOffset();
  // Brand-scoped custom sections (shared with the weekly form). These replace
  // the old per-USER custom fields as the brand-specific mechanism, so a
  // section added for one brand no longer leaks onto other brands' reports.
  const {
    brandSectionDefs, brandSectionExtras,
    addBrandCustomSection, deleteBrandCustomSection,
  } = useBrandSections({ brandId: selectedBrand?.id, setData, reportType: 'monthly' });

  const handleSaveChanges = () => _doSave(reportStatus);

  const handleSubmitReport = async () => {
    if (!selectedBrand || !selectedMonth) return;
    if (submitBlock?.kind === 'duplicate') {
      alert(`You've already submitted a report for ${selectedMonth.label}. You can't submit another one for the same month.`);
      return;
    }
    if (submitBlock?.kind === 'pendingPrior') {
      const prev = submitBlock.report;
      alert(`Your previous report (${prev.monthLabel}) is still waiting for OL approval. It needs to be approved before you can submit a new one.`);
      return;
    }
    const missing = validate();
    if (missing.length > 0) {
      alert('Please fill in all required fields:\n\n• ' + missing.join('\n• '));
      return;
    }
    if (!window.confirm('Submit this monthly report for review?\n\nOnce submitted you cannot edit unless it is sent back.')) return;
    const userName = userProfile?.displayName || apcProfile?.userName || currentUser.displayName || 'Unknown';
    await _doSave('submitted', {
      rejectionNote: null,
      submittedAt: new Date().toISOString(),
      submittedBy: currentUser.uid,
      submittedByName: userName,
    });
    notifyReportSubmitted({
      report: {
        id: `${selectedBrand.id}_m_${selectedMonth.monthKey}`,
        brandId: selectedBrand.id,
        brandName,
        weekLabel: selectedMonth.label,
        createdBy: currentUser.uid,
      },
      sender: { uid: currentUser.uid, name: userName },
      type: 'monthly',
    });
  };

  if (loading) {
    return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading report…</div>;
  }

  /* ── Step 0: Brand selection ──────────────────────────────────────────── */
  if (step === 0) {
    if (detecting) {
      return <div className="d-flex align-items-center justify-content-center py-5 text-muted"><span className="spinner-border spinner-border-sm me-2" />Detecting next month…</div>;
    }
    return (
      <div>
        {guardModal}
        {onCancel && (
          <button className="btn btn-sm btn-link text-muted p-0 mb-3" onClick={() => guardAction(onCancel)}>
            <i className="bi bi-arrow-left me-1" /> Back to reports
          </button>
        )}
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>New Monthly Report</h5>
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

  /* ── Step 1: First-time month picker ──────────────────────────────────── */
  if (step === 1) {
    const opts = getFirstTimeMonthOptions();
    return (
      <div>
        <button className="btn btn-sm btn-link text-muted p-0 mb-3" onClick={() => setStep(0)}>
          <i className="bi bi-arrow-left me-1" /> Change brand
        </button>
        <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>First Monthly Report — {brandName}</h5>
        <p className="text-muted small mb-4">Pick the month you want to report on. After this, the next month will be auto-detected.</p>
        <div className="row g-2" style={{ maxWidth: 720 }}>
          {opts.map(m => (
            <div key={m.monthKey} className="col-md-4 col-sm-6">
              <button className="btn btn-outline-secondary w-100 text-start"
                style={{ borderRadius: 10, fontSize: '0.84rem' }}
                onClick={() => handleFirstMonthPick(m)}>
                <i className="bi bi-calendar3 me-2" />{m.label}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── Step 2: Main form ───────────────────────────────────────────────── */

  const isEditMode = !!editReportId;
  const sCfg = REPORT_STATUSES[reportStatus] || REPORT_STATUSES.draft;

  return (
    // Pin each rich-text toolbar BELOW this sticky header (topbar + measured
    // header height) so it doesn't collide with the header when a text section
    // scrolls up. Report header is z-index 4 > toolbar's 3, so it always wins.
    <div onInput={() => setDirty(true)} style={rteTopStyle}>
      {guardModal}
      <div ref={headerRef} className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2"
        style={{
          position: 'sticky', top: 'var(--topbar-h, 68px)', zIndex: 4,
          background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '12px 28px', margin: '0 -28px 16px',
        }}>
        <div style={{ minWidth: 0, flex: '1 1 auto' }}>
          <button className="btn btn-sm btn-link text-muted p-0 mb-1 d-block"
            onClick={() => guardAction(() => onCancel ? onCancel() : setStep(0))}>
            <i className="bi bi-arrow-left me-1" /> Back to reports
          </button>
          <h5 className="fw-bold mb-1" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {brandName} — {selectedMonth?.label}
          </h5>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            {isEditMode && (
              <span className="badge rounded-pill d-inline-flex align-items-center gap-1"
                style={{ background: sCfg.bg, color: sCfg.color, fontSize: '0.66rem' }}>
                <i className={`bi ${sCfg.icon}`} />{sCfg.label}
              </span>
            )}
            {previousReport && (
              <span className="text-muted small" style={{ fontSize: '0.74rem' }}>
                <i className="bi bi-arrow-left-right me-1" />Comparing vs {previousReport.monthLabel}
              </span>
            )}
            {isEditMode && (
              <button className="btn btn-sm btn-link p-0 text-muted" style={{ fontSize: '0.72rem' }}
                onClick={handleChangeMonth}>
                <i className="bi bi-pencil-square me-1" />Change month
              </button>
            )}
          </div>
        </div>
        <div className="d-flex gap-2 flex-wrap">
          <input ref={pdfInputRef} type="file" accept="application/pdf" style={{ display: 'none' }}
            onChange={e => handleImportPdf(e.target.files?.[0])} />
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ background: 'var(--surface-1)', color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 8, fontSize: '0.78rem' }}
            onClick={() => pdfInputRef.current?.click()} disabled={importing}
            title="Upload a Monthly report PDF (Google Doc export) to auto-fill this form">
            {importing ? <><span className="spinner-border spinner-border-sm" /> Reading PDF…</>
              : <><i className="bi bi-file-earmark-pdf-fill" /> Import from PDF</>}
          </button>
          {(reportStatus === 'draft' || !isEditMode) ? (
            <>
              <button className="btn btn-outline-secondary btn-sm px-3 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8 }} onClick={handleSaveDraft} disabled={saving}>
                {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-save" />}
                Save Draft
              </button>
              <button className="btn btn-sm px-3 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, background: submitBlock ? '#94a3b8' : '#0f172a', color: 'white', border: 'none' }}
                onClick={handleSubmitReport} disabled={saving || !!submitBlock}
                title={submitBlock?.kind === 'duplicate' ? 'Already submitted for this month' : submitBlock?.kind === 'pendingPrior' ? 'Waiting for OL approval on the previous report' : ''}>
                <i className="bi bi-send-fill" /> Submit
              </button>
            </>
          ) : (
            <button className="btn btn-dark btn-sm px-3 d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8 }} onClick={handleSaveChanges} disabled={saving}>
              {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-save" />}
              Save Changes
            </button>
          )}
        </div>
      </div>

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
            <div className="fw-bold" style={{ fontSize: '0.8rem' }}>Already submitted for {selectedMonth?.label}</div>
            <div style={{ fontSize: '0.78rem', marginTop: 2 }}>You can't submit another report for the same month.</div>
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
              Your {submitBlock.report.monthLabel} report is still <strong>{REPORT_STATUSES[submitBlock.report.status]?.label || submitBlock.report.status}</strong>.
              It needs to be approved by the Operation Lead before you can submit a new one. You can keep drafting this report in the meantime.
            </div>
          </div>
        </div>
      )}

      {/* ── Currency picker (applies to every monetary field below) ──── */}
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

      {/* ── Sections toggle panel ───────────────────────────────────── */}
      {(() => {
        const enabled = resolveSectionsEnabled(data.sectionsEnabled);
        const enabledCount = MONTHLY_SECTIONS.filter(s => enabled[s.key]).length;
        return (
          <div className="card mb-3" style={{
            borderRadius: 12, border: '1px solid var(--border-subtle)',
            background: 'var(--surface-0)', boxShadow: '0 1px 2px rgba(15,23,42,0.03)',
          }}>
            <div className="card-body p-3">
              <div className="d-flex align-items-center gap-2 mb-2">
                <i className="bi bi-list-check" style={{ color: 'var(--info)' }} />
                <h6 className="fw-bold mb-0" style={{ fontSize: '0.88rem' }}>Sections in this report</h6>
                <span className="text-muted" style={{ fontSize: '0.7rem' }}>
                  ({enabledCount}/{MONTHLY_SECTIONS.length} shown)
                </span>
                <span className="text-muted ms-auto" style={{ fontSize: '0.72rem' }}>
                  Untick any section that doesn't apply to this brand — it'll be hidden in the form and the final report.
                </span>
              </div>
              <div className="row g-2">
                {MONTHLY_SECTIONS.map(s => (
                  <div key={s.key} className="col-6 col-md-4 col-lg-3">
                    <label className="d-flex align-items-center gap-2 p-2 rounded-2"
                      style={{
                        cursor: 'pointer', userSelect: 'none',
                        background: enabled[s.key] ? 'var(--surface-1)' : 'var(--surface-2)',
                        border: `1px solid ${enabled[s.key] ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                        opacity: enabled[s.key] ? 1 : 0.7,
                      }}>
                      <input type="checkbox" className="form-check-input m-0"
                        checked={!!enabled[s.key]}
                        onChange={e => setData(d => ({
                          ...d,
                          sectionsEnabled: { ...resolveSectionsEnabled(d.sectionsEnabled), [s.key]: e.target.checked },
                        }))}
                      />
                      <span style={{ fontSize: '0.78rem', fontWeight: 500, color: enabled[s.key] ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {s.title}
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Section 1: Total Sales ─────────────────────────────────────── */}
      {sectEnabled.totalSales && (
      <SectionCard icon="bi-currency-dollar" color="#16a34a" title="Total Sales">
        <div className="d-flex flex-wrap gap-3">
          <div style={{ width: 220 }}>
            <Field label={`Month GMV (${curSym})`} type="number" placeholder="357869.19"
              value={data.totalSales?.monthGmv}
              onChange={v => setObj('totalSales', 'monthGmv', v)} />
            <ComparisonChip thisVal={data.totalSales?.monthGmv} lastVal={previousReport?.totalSales?.monthGmv} format="usd" />
          </div>
          <div style={{ width: 220 }}>
            <Field label={`All-time GMV (${curSym})`} type="number" placeholder="10168563.71"
              value={data.totalSales?.allTimeGmv}
              onChange={v => setObj('totalSales', 'allTimeGmv', v)} />
          </div>
        </div>
      </SectionCard>
      )}

      {/* ── Section 2: Key Metrics ──────────────────────────────────────── */}
      {sectEnabled.keyMetrics && (
      <SectionCard icon="bi-graph-up" color="#3b82f6" title="Key Metrics">
        <div className="d-flex flex-wrap gap-3">
          {[
            { key: 'gmv', label: `GMV (${curSym})`, placeholder: '357869.19', format: 'usd' },
            { key: 'orders', label: 'Orders', placeholder: '5940' },
            { key: 'customers', label: 'Customers', placeholder: '4977' },
            { key: 'itemsSold', label: 'Items Sold', placeholder: '6730' },
          ].map(f => (
            <div key={f.key} style={{ width: 180 }}>
              <Field label={f.label} type="number" placeholder={f.placeholder}
                value={data.keyMetrics?.[f.key]}
                onChange={v => setObj('keyMetrics', f.key, v)} />
              <ComparisonChip thisVal={data.keyMetrics?.[f.key]} lastVal={previousReport?.keyMetrics?.[f.key]} format={f.format} />
            </div>
          ))}
        </div>
      </SectionCard>
      )}

      {/* ── Section 3: KPIs ─────────────────────────────────────────────── */}
      {sectEnabled.kpis && (
      <SectionCard icon="bi-bar-chart-fill" color="#7c3aed" title="KPI's">
        <div className="d-flex flex-wrap gap-3">
          {[
            { key: 'completedCollabs', label: 'Completed Collabs', placeholder: '7846' },
            { key: 'contentPending', label: 'Content Pending', placeholder: '1037' },
            { key: 'totalOrders', label: 'Total Orders', placeholder: '5940' },
            { key: 'freeSamplesApproved', label: 'Free Samples Approved', placeholder: '2383' },
          ].map(f => (
            <div key={f.key} style={{ width: 180 }}>
              <Field label={f.label} type="number" placeholder={f.placeholder}
                value={data.kpis?.[f.key]}
                onChange={v => setObj('kpis', f.key, v)} />
              <ComparisonChip thisVal={data.kpis?.[f.key]} lastVal={previousReport?.kpis?.[f.key]} />
            </div>
          ))}
        </div>
      </SectionCard>
      )}

      {/* ── Section 4: GMV Breakdown ────────────────────────────────────── */}
      {sectEnabled.gmvBreakdown && (
      <SectionCard icon="bi-pie-chart-fill" color="#0891b2" title="GMV Breakdown">
        <div className="d-flex flex-wrap gap-3">
          {[
            { key: 'affiliateGmv', label: `Affiliate GMV (${curSym})`, placeholder: '321179.79' },
            { key: 'organicGmv', label: `Organic GMV (${curSym})`, placeholder: '36869.40' },
            { key: 'liveGmv', label: `LIVE GMV (${curSym})`, placeholder: '20698.29' },
            { key: 'videoGmv', label: `Video GMV (${curSym})`, placeholder: '229572.45' },
            { key: 'productCardGmv', label: `Product Card GMV (${curSym})`, placeholder: '107598.45' },
          ].map(f => (
            <div key={f.key} style={{ width: 200 }}>
              <Field label={f.label} type="number" placeholder={f.placeholder}
                value={data.gmvBreakdown?.[f.key]}
                onChange={v => setObj('gmvBreakdown', f.key, v)} />
              <ComparisonChip thisVal={data.gmvBreakdown?.[f.key]} lastVal={previousReport?.gmvBreakdown?.[f.key]} format="usd" />
            </div>
          ))}
        </div>
      </SectionCard>
      )}

      {/* ── Section 5: Top Creators ─────────────────────────────────────── */}
      {sectEnabled.topCreators && (
      <SectionCard icon="bi-people-fill" color="#ec4899" title="Top Creators">
        <ArraySection items={data.topCreators}
          setItems={(items) => setData(d => ({ ...d, topCreators: items }))}
          fields={[
            { key: 'username', label: 'Username', width: '40%', placeholder: 'biohacking.babe' },
            { key: 'gmv', label: `GMV Generated (${curSym})`, type: 'number', width: '180px', placeholder: '40135.94' },
          ]}
          addLabel="Add Creator" />
      </SectionCard>
      )}

      {/* ── Section 6: Top Videos ───────────────────────────────────────── */}
      {sectEnabled.topVideos && (
      <SectionCard icon="bi-play-circle-fill" color="#f59e0b" title="Top Videos">
        <ArraySection items={data.topVideos}
          setItems={(items) => setData(d => ({ ...d, topVideos: items }))}
          fields={[
            { key: 'videoLink', label: 'Video Link / Creator', width: '40%', placeholder: 'bkewwwl1507' },
            { key: 'gmv', label: `GMV Generated (${curSym})`, type: 'number', width: '180px', placeholder: '19715.22' },
          ]}
          addLabel="Add Video" />
      </SectionCard>
      )}

      {/* ── Section 7: Video Performance ────────────────────────────────── */}
      {sectEnabled.videoPerformance && (
      <SectionCard icon="bi-camera-reels-fill" color="#6366f1" title="Video Performance">
        <div className="d-flex flex-wrap gap-3">
          {[
            { key: 'productImpressions', label: 'Product Impressions', placeholder: '14.30M' },
            { key: 'productClicks', label: 'Product Clicks', placeholder: '576.23K' },
            { key: 'videoViews', label: 'Video Views', placeholder: '13.20M' },
            { key: 'ctr', label: 'CTR (%)', placeholder: '4.03' },
            { key: 'ctor', label: 'CTOR (%)', placeholder: '0.73' },
            { key: 'skuOrders', label: 'SKU Orders', placeholder: '4.20K' },
            { key: 'gmv', label: `GMV (${curSym})`, placeholder: '229572.45' },
            { key: 'videos1MViews', label: 'Videos 1M+ Views', placeholder: '1' },
            { key: 'videos100kViews', label: 'Videos 100k+ Views', placeholder: '15' },
            { key: 'videos10kViews', label: 'Videos 10k+ Views', placeholder: '85' },
            { key: 'videos1000Gmv', label: 'Videos $1000+ GMV', placeholder: '43' },
            { key: 'videos100Gmv', label: 'Videos $100+ GMV', placeholder: '202' },
            { key: 'newVideosPosted', label: 'New Videos Posted', placeholder: '5552' },
          ].map(f => (
            <div key={f.key} style={{ width: 170 }}>
              <Field label={f.label} placeholder={f.placeholder}
                value={data.videoPerformance?.[f.key]}
                onChange={v => setObj('videoPerformance', f.key, v)} />
              <ComparisonChip thisVal={data.videoPerformance?.[f.key]} lastVal={previousReport?.videoPerformance?.[f.key]} />
            </div>
          ))}
        </div>
      </SectionCard>
      )}

      {/* ── Section 8: Creators' Performance ────────────────────────────── */}
      {sectEnabled.creatorsPerformance && (
      <SectionCard icon="bi-person-video3" color="#a855f7" title="Creators' Performance">
        <div className="d-flex flex-wrap gap-3">
          {[
            { key: 'creators1Plus', label: 'Posted 1+ Videos', placeholder: '1589' },
            { key: 'creators3Plus', label: 'Posted 3+ Videos', placeholder: '531' },
            { key: 'creators10Plus', label: 'Posted 10+ Videos', placeholder: '83' },
            { key: 'creators1kGmv', label: 'Generated $1k+ GMV', placeholder: '51' },
            { key: 'creators100Gmv', label: 'Generated $100+ GMV', placeholder: '161' },
          ].map(f => (
            <div key={f.key} style={{ width: 200 }}>
              <Field label={f.label} type="number" placeholder={f.placeholder}
                value={data.creatorsPerformance?.[f.key]}
                onChange={v => setObj('creatorsPerformance', f.key, v)} />
              <ComparisonChip thisVal={data.creatorsPerformance?.[f.key]} lastVal={previousReport?.creatorsPerformance?.[f.key]} />
            </div>
          ))}
        </div>
      </SectionCard>
      )}

      {/* ── Section 9: Product Analytics ────────────────────────────────── */}
      {sectEnabled.productAnalytics && (
      <SectionCard icon="bi-box-seam" color="#0d9488" title="Product Analytics">
        <ArraySection items={data.productAnalytics}
          setItems={(items) => setData(d => ({ ...d, productAnalytics: items }))}
          fields={[
            { key: 'productId', label: 'Product ID', width: '180px', placeholder: '1729401883...' },
            { key: 'productName', label: 'Product Name', width: '30%', placeholder: 'NuDerma Professional Wand' },
            { key: 'unitsSold', label: 'Units Sold', type: 'number', width: '110px', placeholder: '1997' },
            { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '120px', placeholder: '93194.86' },
            { key: 'samplesApproved', label: 'Samples Approved', type: 'number', width: '120px', placeholder: '376' },
          ]}
          addLabel="Add Product" />
      </SectionCard>
      )}

      {/* ── Section 10: GMV Max Performance ─────────────────────────────── */}
      {sectEnabled.gmvMax && (
      <SectionCard icon="bi-rocket-takeoff-fill" color="#ef4444" title="GMV Max Performance">
        <ArraySection items={data.gmvMax}
          setItems={(items) => setData(d => ({ ...d, gmvMax: items }))}
          fields={[
            { key: 'campaign', label: 'Campaign', width: '30%', placeholder: 'GMV Max_NuDerma Clinical' },
            { key: 'spend', label: `Spend (${curSym})`, type: 'number', width: '110px', placeholder: '51187.03' },
            { key: 'roi', label: 'ROI', type: 'number', width: '90px', placeholder: '3.05' },
            { key: 'orders', label: 'Orders', type: 'number', width: '100px', placeholder: '1234' },
            { key: 'cpo', label: `CPO (${curSym})`, type: 'number', width: '100px', placeholder: '41.48' },
            { key: 'gmv', label: `GMV (${curSym})`, type: 'number', width: '120px', placeholder: '155957.95' },
          ]}
          addLabel="Add Campaign" />
      </SectionCard>
      )}

      {/* ── Section 11: Customers ───────────────────────────────────────── */}
      {sectEnabled.customers && (
      <SectionCard icon="bi-people" color="#0ea5e9" title="Customers">
        <div className="d-flex flex-wrap gap-3">
          {[
            { key: 'awareCustomers', label: 'Aware Customers', placeholder: '513250' },
            { key: 'newCustomers', label: 'New Customers', placeholder: '3156' },
            { key: 'potentialNewCustomers', label: 'Potential New Customers', placeholder: '16273' },
            { key: 'crmMessagesSent', label: 'CRM Messages Sent', placeholder: '995776' },
            { key: 'convertedCustomers', label: 'Converted Customers', placeholder: '387' },
          ].map(f => (
            <div key={f.key} style={{ width: 200 }}>
              <Field label={f.label} type="number" placeholder={f.placeholder}
                value={data.customers?.[f.key]}
                onChange={v => setObj('customers', f.key, v)} />
              <ComparisonChip thisVal={data.customers?.[f.key]} lastVal={previousReport?.customers?.[f.key]} />
            </div>
          ))}
        </div>
      </SectionCard>
      )}

      {/* ── Section 12: Key Wins (narrative + AI) ───────────────────────── */}
      {sectEnabled.keyWinsInsights && (
      <SectionCard icon="bi-trophy-fill" color="#eab308" title="Key Wins / Insights"
        actions={
          <button type="button" className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)', color: 'white', borderRadius: 8, fontSize: '0.7rem', padding: '4px 10px', border: 'none' }}
            onClick={runKeyWinsAi} disabled={aiLoading}>
            {aiLoading ? <><span className="spinner-border spinner-border-sm" style={{ width: 10, height: 10 }} /> Generating…</>
              : <><i className="bi bi-stars" /> Generate with AI</>}
          </button>
        }>
        <RichTextEditor value={data.keyWinsInsights || ''}
          minHeight={220}
          placeholder="Write the narrative summary of this month — key wins, milestones, MoM movements. Or click ✨ to auto-generate from your data."
          onChange={v => setData(d => ({ ...d, keyWinsInsights: v }))} />
      </SectionCard>
      )}

      {/* ── Section 13: Campaigns (free text) ───────────────────────────── */}
      {sectEnabled.campaignsText && (
      <SectionCard icon="bi-megaphone-fill" color="#f97316" title="Campaigns">
        <RichTextEditor value={data.campaignsText || ''}
          minHeight={140}
          placeholder="Notes about active and upcoming campaigns, eligibility, registration, discount ranges, etc."
          onChange={v => setData(d => ({ ...d, campaignsText: v }))} />
      </SectionCard>
      )}

      {/* ── Section 14: Recommendations & Action Items ──────────────────── */}
      {sectEnabled.recommendations && (
      <SectionCard icon="bi-lightbulb-fill" color="#f59e0b" title="Recommendations & Action Items">
        <RichTextEditor value={data.recommendations || ''}
          minHeight={160}
          placeholder="Share your recommendations and action items for next month."
          onChange={v => setData(d => ({ ...d, recommendations: v }))} />
      </SectionCard>
      )}

      {/* ── Brand Sections (per-brand custom sections, shared with weekly) ── */}
      {(brandSectionDefs.length > 0 || selectedBrand?.id) && (
        <>
          {brandSectionDefs.length > 0 && (
            <BrandSectionsBlock
              sections={brandSectionDefs}
              data={data}
              setData={setData}
              previousReport={previousReport}
              sectEnabled={sectEnabled}
              toggleSection={toggleBrandSection}
              onDelete={deleteBrandCustomSection} />
          )}
          {selectedBrand?.id && (
            <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12, borderStyle: 'dashed' }}>
              <div className="card-body p-3">
                <AddCustomSectionInline
                  disabled={!selectedBrand?.id}
                  defaultReportType="monthly"
                  onAdd={addBrandCustomSection} />
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Section 15: My Custom Fields (per-user, LEGACY / retired add) ──
          The per-USER custom-field mechanism leaked: a field added here
          appeared on EVERY brand's report (per-user, not per-brand) and, once
          its def was deleted, its filled-in text was silently stripped from
          every brand's saved report. New sections must use the per-BRAND
          "Add custom section" block above instead. We KEEP rendering any
          EXISTING per-user fields so nothing a user already relies on vanishes,
          but the "Add Custom Field" button is removed so no new leaky ones can
          be created. When a brand has no legacy per-user fields, this whole
          section is hidden. */}
      {sectEnabled.customFields && customFieldDefs.map((field) => (
        // Each legacy per-user field renders as its OWN section titled by the
        // field's name — so edit mode matches exactly what the saved view
        // shows (the view uses the field name as the section header). No more
        // generic "My Custom Fields (legacy)" wrapper that didn't match.
        <SectionCard key={field.id} icon="bi-sliders" color="#8b5cf6" title={field.name}
          actions={
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
          }>
          <RichTextEditor
            value={(() => {
              const v = data.customFields?.[field.id];
              if (!v) return '';
              return typeof v === 'string' ? v : (v.value || '');
            })()}
            minHeight={120}
            placeholder={`Add notes for ${field.name}…`}
            onChange={v => setCustomFieldValue(field.id, v, field.name)} />
        </SectionCard>
      ))}

      {/* Save buttons (bottom) */}
      <div className="d-flex gap-2 justify-content-end mt-4 mb-3">
        {(reportStatus === 'draft' || !isEditMode) ? (
          <>
            <button className="btn btn-outline-secondary px-3" onClick={handleSaveDraft} disabled={saving}>
              {saving ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bi bi-save me-1" />}
              Save Draft
            </button>
            <button className="btn px-4"
              style={{ background: submitBlock ? '#94a3b8' : '#0f172a', color: 'white', border: 'none' }}
              onClick={handleSubmitReport} disabled={saving || !!submitBlock}
              title={submitBlock?.kind === 'duplicate' ? 'Already submitted for this month' : submitBlock?.kind === 'pendingPrior' ? 'Waiting for OL approval on the previous report' : ''}>
              <i className="bi bi-send-fill me-1" /> Submit Report
            </button>
          </>
        ) : (
          <button className="btn btn-dark px-3" onClick={handleSaveChanges} disabled={saving}>
            {saving ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bi bi-save me-1" />}
            Save Changes
          </button>
        )}
      </div>
    </div>
  );
}
