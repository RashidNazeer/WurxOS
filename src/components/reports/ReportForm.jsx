import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { parsePdfToReport } from '../../utils/pdfReportParser';
import { getBrandSections } from '../../lib/brandReportSectionsApi';
import RichTextEditor from '../common/RichTextEditor';
import {
  EMPTY_REPORT_DATA,
  emptyCreator, emptyVideo, emptyGmvMax, emptyProduct,
  upsertDraft, submitReport, verifyReport, approveReport,
  rejectReport, reopenReport, reportPermissions,
  findDuplicateReport,
  STATUS_LABEL, STATUS_COLOR,
  listUserCustomFields,
} from '../../lib/reportsApi';
import { CURRENCIES, currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import {
  XIcon, AlertIcon, CheckIcon, PlusIcon, ArrowRightIcon, RefreshIcon,
  UserIcon, StoreIcon, SettingsIcon, ChevronRightIcon,
} from '../common/Icon';
import BrandAvatar from '../brands/BrandAvatar';
import '../../styles/reports.css';

/**
 * Unified form for create / edit / verify / approve of a Report.
 * Matches v1 section-for-section.
 *
 * Props:
 *   brand   — brand object (for create & display header)
 *   period  — period object with startDate, endDate, label, year, month, number
 *   type    — 'weekly' | 'biweekly'
 *   report  — existing report or null (create mode)
 *   onClose
 *   onSaved — (report) => void
 */
export default function ReportForm({ brand, period, type, report, onClose, onSaved }) {
  const { user, profile } = useAuth();
  const role = profile?.role;

  const [data, setData] = useState(() => ({
    ...EMPTY_REPORT_DATA(),
    ...(report?.data || {}),
  }));
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  const [brandSectionDefs, setBrandSectionDefs] = useState([]);
  const [error, setError]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenTarget, setReopenTarget] = useState('verified');
  const [reopenNote, setReopenNote] = useState('');
  const [importing, setImporting]   = useState(false);
  const [importToast, setImportToast] = useState(null);
  const pdfInputRef = useRef(null);

  const perms = reportPermissions({
    report, role, uid: user?.id,
    brandOwnerId: brand?.owner_id || report?.brand?.owner_id,
  });
  const readOnly = !perms.canEditContent;

  // ---- Duplicate-week guard --------------------------------------
  // One non-draft report per (brand, type, week). Without this, the
  // upsert in upsertDraft would silently overwrite an existing approved
  // report when the user creates a "new" one for the same week.
  const periodStart = period?.startDate || report?.period_start;
  const reportType  = type || report?.type;
  const brandId     = brand?.id || report?.brand_id;
  const dupQ = useQuery({
    queryKey: ['report', 'dup-check', brandId, reportType, periodStart, report?.id],
    queryFn: () => findDuplicateReport({
      brandId, type: reportType, periodStart, excludeId: report?.id,
    }),
    enabled: !!brandId && !!reportType && !!periodStart && !readOnly,
    staleTime: 30_000,
  });
  const duplicate = dupQ.data || null;

  // Load custom fields template for the report author (falls back to current user when creating)
  useEffect(() => {
    const templateOwner = report?.author_id || user?.id;
    if (!templateOwner) return;
    let cancelled = false;
    listUserCustomFields(templateOwner)
      .then((list) => { if (!cancelled) setCustomFieldDefs(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [report?.author_id, user?.id]);

  // Load brand-level custom sections — these auto-appear in every report
  // for this brand. Stored alongside user customFieldDefs in the report's
  // data.customFields map under a deterministic id, so the View renders
  // them with the existing custom-fields path.
  useEffect(() => {
    if (!brandId) { setBrandSectionDefs([]); return; }
    let cancelled = false;
    getBrandSections(brandId)
      .then((list) => { if (!cancelled) setBrandSectionDefs(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [brandId]);

  // ---------------- Save / submit / stage actions ----------------
  async function handleSaveDraft() {
    try {
      setSaving(true); setError('');
      const saved = await upsertDraft({
        id: report?.id,
        brandId: brand?.id || report?.brand_id,
        authorId: report?.author_id || user.id,
        type: type || report?.type,
        period: period || {
          startDate: report.period_start, endDate: report.period_end,
          year: report.period_year, month: report.period_month,
          label: report.period_label, week: report.period_number, period: report.period_number,
        },
        data,
      });
      onSaved(saved);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function handleSubmit() {
    try {
      setSaving(true); setError('');
      // Save as draft first (if not saved yet) then flip to submitted
      let id = report?.id;
      if (!id) {
        const saved = await upsertDraft({
          id: null,
          brandId: brand?.id || report?.brand_id,
          authorId: report?.author_id || user.id,
          type: type || report?.type,
          period,
          data,
        });
        id = saved.id;
      }
      const submitted = await submitReport(id, data);
      onSaved(submitted);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function handleVerify() {
    try {
      setSaving(true); setError('');
      const saved = await verifyReport(report.id);
      onSaved(saved);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  async function handleApprove() {
    try {
      setSaving(true); setError('');
      const saved = await approveReport(report.id);
      onSaved(saved);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  async function handleReject() {
    try {
      setSaving(true); setError('');
      if (!rejectNote.trim()) { setError('Please add a reason for sending this back.'); setSaving(false); return; }
      const saved = await rejectReport(report.id, { note: rejectNote.trim() });
      setRejectOpen(false); setRejectNote('');
      onSaved(saved);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  async function handleReopen() {
    try {
      setSaving(true); setError('');
      if (reopenTarget !== 'verified' && !reopenNote.trim()) {
        setError('Please add a note for the person you\'re reopening to.');
        setSaving(false);
        return;
      }
      const saved = await reopenReport(report.id, {
        target: reopenTarget,
        note: reopenTarget === 'verified' ? null : reopenNote.trim(),
      });
      setReopenOpen(false); setReopenNote(''); setReopenTarget('verified');
      onSaved(saved);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  // ---------------- PDF import ----------------
  // Parse a Google-Doc-style PDF and merge the recognised fields into
  // form state. Only keys the parser actually filled are overwritten —
  // the user's existing data wins for anything the parser missed.
  async function handleImportPdf(file) {
    if (!file) return;
    setImporting(true);
    setImportToast(null);
    try {
      const parsed = await parsePdfToReport(file);
      const diag = parsed.__diagnostics || {};
      delete parsed.__diagnostics;

      setData((d) => {
        const next = { ...d };
        if (parsed.overallPerformance) {
          next.overallPerformance = { ...d.overallPerformance, ...parsed.overallPerformance };
        }
        if (parsed.offsitePerformance) {
          next.offsitePerformance = { ...d.offsitePerformance, ...parsed.offsitePerformance };
        }
        if (parsed.topCreators?.length)       next.topCreators       = parsed.topCreators;
        if (parsed.topVideos?.length)         next.topVideos         = parsed.topVideos;
        if (parsed.gmvMax?.length)            next.gmvMax            = parsed.gmvMax;
        if (parsed.productHighlights?.length) next.productHighlights = parsed.productHighlights;
        if (parsed.upcomingCampaigns)         next.upcomingCampaigns  = parsed.upcomingCampaigns;
        if (parsed.operationalUpdates)        next.operationalUpdates = parsed.operationalUpdates;
        if (parsed.recommendations)           next.recommendations    = parsed.recommendations;
        return next;
      });

      const filled = [];
      if (diag.overallFields > 0) filled.push(`${diag.overallFields} performance metrics`);
      if (diag.creators > 0)      filled.push(`${diag.creators} creator${diag.creators === 1 ? '' : 's'}`);
      if (diag.videos > 0)        filled.push(`${diag.videos} video${diag.videos === 1 ? '' : 's'}${diag.videosWithLink > 0 ? ` (${diag.videosWithLink} with links)` : ''}`);
      if (diag.gmvMax > 0)        filled.push(`${diag.gmvMax} GMV Max row${diag.gmvMax === 1 ? '' : 's'}`);
      if (diag.products > 0)      filled.push(`${diag.products} product${diag.products === 1 ? '' : 's'}`);
      if (diag.hasNarrative)      filled.push('narrative sections');

      setImportToast({
        kind: filled.length ? 'success' : 'warn',
        msg: filled.length
          ? `Imported: ${filled.join(', ')}. Review and edit before submitting.`
          : 'PDF read but nothing matched the report sections — check the section headings in the doc.',
      });
    } catch (err) {
      console.error(err);
      setImportToast({ kind: 'error', msg: 'Failed to read PDF: ' + (err.message || 'unknown error') });
    } finally {
      setImporting(false);
      if (pdfInputRef.current) pdfInputRef.current.value = '';
    }
  }

  // ---------------- Data helpers ----------------
  const upd = (path, value) => setData((d) => setByPath(d, path, value));
  const updArr = (key, idx, field, value) => setData((d) => {
    const arr = [...(d[key] || [])];
    arr[idx] = { ...(arr[idx] || {}), [field]: value };
    return { ...d, [key]: arr };
  });
  const addRow = (key, empty) => setData((d) => ({ ...d, [key]: [...(d[key] || []), empty()] }));
  const delRow = (key, idx)  => setData((d) => ({ ...d, [key]: (d[key] || []).filter((_, i) => i !== idx) }));

  // Render
  const status = report?.status || 'draft';
  const currency = data.currency || DEFAULT_CURRENCY;
  const curSym = currencySymbol(currency);
  const color = STATUS_COLOR[status] || STATUS_COLOR.draft;
  const typeLabel = (type || report?.type) === 'biweekly' ? 'Bi-Weekly' : 'Weekly';
  const periodLabel = period?.label || report?.period_label;

  return (
    <div className="report-page">
      <button type="button" className="report-back" onClick={onClose}>
        <ChevronRightIcon width="14" height="14" style={{ transform: 'rotate(180deg)' }} />
        Back to reports
      </button>

      <div className="report-page-hero">
        {(brand || report?.brand) && <BrandAvatar brand={brand || report?.brand} size={44} />}
        <div className="report-page-hero-main">
          <h1 className="report-page-title">
            {typeLabel} Report · {brand?.brand_name || report?.brand?.brand_name}
          </h1>
          <div className="report-page-sub">{periodLabel}</div>
        </div>
        <span className="report-status-badge" style={{ background: color.bg, color: color.fg, flex: '0 0 auto' }}>
          <span className="report-status-badge-dot" /> {STATUS_LABEL[status]}
        </span>
      </div>

      <div className="report-form-step">
          {/* PDF import — fills the form from a Google-Doc-style PDF
              export. User reviews and edits before saving. Hidden file
              input is triggered by the button below. */}
          {!readOnly && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, flexWrap: 'wrap',
              padding: '10px 14px',
              background: 'var(--surface-2)',
              border: '1px dashed var(--border-default)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Importing from a Google Doc?
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  Export the doc as PDF and drop it here — we'll auto-fill metrics, creators, videos, campaigns, and narrative.
                </div>
              </div>
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                style={{ display: 'none' }}
                onChange={(e) => handleImportPdf(e.target.files?.[0])}
              />
              <button
                type="button"
                className="wx-btn wx-btn-ghost"
                onClick={() => pdfInputRef.current?.click()}
                disabled={importing}
              >
                {importing
                  ? <><span className="wx-spinner" /> Reading PDF…</>
                  : <>📄 Import from PDF</>}
              </button>
            </div>
          )}

          {/* PDF import result toast */}
          {importToast && (
            <div className={`wx-alert ${
              importToast.kind === 'success' ? 'wx-alert-success'
              : importToast.kind === 'warn' ? 'wx-alert-info'
              : 'wx-alert-danger'
            }`} style={{ alignItems: 'flex-start' }}>
              {importToast.kind === 'success'
                ? <CheckIcon width="16" height="16" />
                : <AlertIcon width="16" height="16" />}
              <div style={{ flex: 1 }}>{importToast.msg}</div>
              <button type="button" onClick={() => setImportToast(null)}
                style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 4 }}>
                <XIcon width="14" height="14" />
              </button>
            </div>
          )}

          {error && (
            <div className="wx-alert wx-alert-danger">
              <AlertIcon width="16" height="16" /> <span>{error}</span>
            </div>
          )}

          {/* Duplicate-week guard — fires when this brand already has a
              non-draft report for the same week. Prevents the upsert from
              silently overwriting the existing record. */}
          {duplicate && (
            <div className="wx-alert wx-alert-danger" style={{ alignItems: 'flex-start' }}>
              <AlertIcon width="16" height="16" />
              <div>
                <strong>This week already has a report.</strong>
                <div style={{ fontSize: 12.5, marginTop: 2 }}>
                  {brand?.brand_name || report?.brand?.brand_name} · {periodLabel} was already submitted by{' '}
                  {duplicate.author?.display_name || 'someone'} ({STATUS_LABEL[duplicate.status] || duplicate.status}).
                  Saving here would overwrite it. Cancel and edit the existing report instead, or pick a different week.
                </div>
              </div>
            </div>
          )}

          {/* Rejection note banner */}
          {status === 'draft' && report?.rejection_note && (
            <div className="report-rejection-note">
              <strong>Returned for revision:</strong> {report.rejection_note}
            </div>
          )}

          {/* Approved banner */}
          {status === 'approved' && (
            <div className="report-approved-banner">
              <CheckIcon width="18" height="18" />
              Approved by {report.approved_by ? 'OL' : '—'} on {report.approved_at ? new Date(report.approved_at).toLocaleDateString() : ''}
            </div>
          )}

          {/* Currency picker — applies to every monetary field below.
              Stored on the report's data jsonb; reports created before
              this feature default to USD via DEFAULT_CURRENCY. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: 18 }}>💱</span>
            <label className="wx-label" style={{ margin: 0, fontWeight: 600, color: 'var(--text-secondary)' }}>
              Report currency:
            </label>
            <select className="wx-input" style={{ width: 240 }}
              value={currency} disabled={readOnly}
              onChange={(e) => upd('currency', e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.symbol}  ·  {c.code} — {c.label}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              All monetary fields ({curSym} GMV, Spend, etc.) below use this currency.
            </span>
          </div>

          {/* Overall Performance */}
          <Section icon={<i>📊</i>} title="Overall Performance">
            <Grid>
              <NumInput label={`GMV (${curSym})`}                v={data.overallPerformance.gmv}                  onCh={(v)=>upd('overallPerformance.gmv', v)}                  readOnly={readOnly} />
              <NumInput label={`Affiliate GMV (${curSym})`}      v={data.overallPerformance.affiliateGmv}         onCh={(v)=>upd('overallPerformance.affiliateGmv', v)}         readOnly={readOnly} />
              <NumInput label="Orders"               v={data.overallPerformance.orders}               onCh={(v)=>upd('overallPerformance.orders', v)}               readOnly={readOnly} />
              <NumInput label="Samples Approved"     v={data.overallPerformance.samplesApproved}      onCh={(v)=>upd('overallPerformance.samplesApproved', v)}      readOnly={readOnly} />
              <NumInput label="ROI"                  v={data.overallPerformance.roi}                  onCh={(v)=>upd('overallPerformance.roi', v)}                  readOnly={readOnly} />
              <NumInput label="Shop Perf. Score"     v={data.overallPerformance.shopPerformanceScore} onCh={(v)=>upd('overallPerformance.shopPerformanceScore', v)} readOnly={readOnly} />
              <NumInput label="Videos Posted"        v={data.overallPerformance.videosPosted}         onCh={(v)=>upd('overallPerformance.videosPosted', v)}         readOnly={readOnly} />
            </Grid>
            <Grid cols={2}>
              <TextArea label="Notes — MTD Approved" rows={2} v={data.overallNotes.samplesApproved} onCh={(v)=>upd('overallNotes.samplesApproved', v)} readOnly={readOnly} />
              <TextArea label="Notes — Total Videos" rows={2} v={data.overallNotes.videosPosted}    onCh={(v)=>upd('overallNotes.videosPosted', v)}    readOnly={readOnly} />
            </Grid>
            <RichArea label="Insights" rows={3} v={data.overallInsights} onCh={(v)=>upd('overallInsights', v)} readOnly={readOnly} />
          </Section>

          {/* Top Creators */}
          <Section icon={<i>👥</i>} title="Top Creators">
            <RowTable
              rows={data.topCreators || []}
              onAdd={() => addRow('topCreators', emptyCreator)}
              onDel={(i) => delRow('topCreators', i)}
              readOnly={readOnly}
              cols={[
                { f: 'name',          ph: 'Creator name', flex: 2 },
                { f: 'videosPosted',  ph: 'Videos',       flex: 1 },
                { f: 'itemsSold',     ph: 'Items sold',   flex: 1 },
                { f: 'gmv',           ph: `GMV (${curSym})`,          flex: 1 },
                { f: 'notes',         ph: 'Notes',        flex: 2 },
              ]}
              onChange={(i, f, v) => updArr('topCreators', i, f, v)}
            />
            <RichArea label="Insights" rows={3} v={data.topCreatorsInsights} onCh={(v)=>upd('topCreatorsInsights', v)} readOnly={readOnly} />
          </Section>

          {/* Top Videos */}
          <Section icon={<i>🎥</i>} title="Top Videos">
            <RowTable
              rows={data.topVideos || []}
              onAdd={() => addRow('topVideos', emptyVideo)}
              onDel={(i) => delRow('topVideos', i)}
              readOnly={readOnly}
              cols={[
                { f: 'creatorName',   ph: 'Creator name', flex: 2 },
                { f: 'videoLink',     ph: 'Video URL (https://…)', flex: 2 },
                { f: 'itemsSold',     ph: 'Items sold',   flex: 1 },
                { f: 'gmv',           ph: `GMV (${curSym})`,          flex: 1 },
                { f: 'views',         ph: 'Views',        flex: 1 },
                { f: 'productClicks', ph: 'Clicks',       flex: 1 },
                { f: 'notes',         ph: 'Notes',        flex: 2 },
              ]}
              onChange={(i, f, v) => updArr('topVideos', i, f, v)}
            />
            <RichArea label="Insights" rows={3} v={data.topVideosInsights} onCh={(v)=>upd('topVideosInsights', v)} readOnly={readOnly} />
          </Section>

          {/* GMV Max */}
          <Section icon={<i>📈</i>} title="GMV Max — Best Performing Campaigns">
            <RowTable
              rows={data.gmvMax || []}
              onAdd={() => addRow('gmvMax', emptyGmvMax)}
              onDel={(i) => delRow('gmvMax', i)}
              readOnly={readOnly}
              cols={[
                { f: 'campaign', ph: 'Campaign', flex: 2 },
                { f: 'spend',    ph: `Spend (${curSym})`,    flex: 1 },
                { f: 'roi',      ph: 'ROI',      flex: 1 },
                { f: 'orders',   ph: 'Orders',   flex: 1 },
                { f: 'cpo',      ph: `CPO (${curSym})`,      flex: 1 },
                { f: 'gmv',      ph: `GMV (${curSym})`,      flex: 1 },
                { f: 'notes',    ph: 'Notes',    flex: 2 },
              ]}
              onChange={(i, f, v) => updArr('gmvMax', i, f, v)}
            />
            <RichArea label="Insights" rows={3} v={data.gmvMaxInsights} onCh={(v)=>upd('gmvMaxInsights', v)} readOnly={readOnly} />
          </Section>

          {/* Product Highlights */}
          <Section icon={<i>📦</i>} title="Product Highlights">
            <RowTable
              rows={data.productHighlights || []}
              onAdd={() => addRow('productHighlights', emptyProduct)}
              onDel={(i) => delRow('productHighlights', i)}
              readOnly={readOnly}
              cols={[
                { f: 'productId',   ph: 'Product ID',   flex: 1 },
                { f: 'productName', ph: 'Product name', flex: 2 },
                { f: 'unitsSold',   ph: 'Units sold',   flex: 1 },
                { f: 'gmv',         ph: `GMV (${curSym})`,          flex: 1 },
                { f: 'newVideos',   ph: 'New videos',   flex: 1 },
                { f: 'notes',       ph: 'Notes',        flex: 2 },
              ]}
              onChange={(i, f, v) => updArr('productHighlights', i, f, v)}
            />
            <RichArea label="Insights" rows={3} v={data.productHighlightsInsights} onCh={(v)=>upd('productHighlightsInsights', v)} readOnly={readOnly} />
          </Section>

          {/* Offsite Performance */}
          <Section icon={<i>🌐</i>} title="Offsite Performance">
            <Grid cols={3}>
              <NumInput label={`Offsite GMV (${curSym})`}      v={data.offsitePerformance.offsiteGmv}     onCh={(v)=>upd('offsitePerformance.offsiteGmv', v)}     readOnly={readOnly} />
              <NumInput label={`TikTok Shop GMV (${curSym})`}  v={data.offsitePerformance.tiktokShopGmv}  onCh={(v)=>upd('offsitePerformance.tiktokShopGmv', v)}  readOnly={readOnly} />
              <NumInput label="Offsite Effect"   v={data.offsitePerformance.offsiteEffect}  onCh={(v)=>upd('offsitePerformance.offsiteEffect', v)}  readOnly={readOnly} />
            </Grid>
            <RichArea label="Insights" rows={3} v={data.offsiteInsights} onCh={(v)=>upd('offsiteInsights', v)} readOnly={readOnly} />
          </Section>

          {/* Current & Upcoming Campaigns */}
          <Section icon={<i>📅</i>} title="Current & Upcoming Campaigns">
            <RichArea rows={5} v={data.upcomingCampaigns} onCh={(v)=>upd('upcomingCampaigns', v)} readOnly={readOnly}
              placeholder="Campaigns running this period and what's coming up next…" />
          </Section>

          {/* Operational Updates */}
          <Section icon={<i>⚙️</i>} title="Operational Updates">
            <RichArea rows={5} v={data.operationalUpdates} onCh={(v)=>upd('operationalUpdates', v)} readOnly={readOnly}
              placeholder="Process changes, blockers, internal updates…" />
          </Section>

          {/* Recommendations */}
          <Section icon={<i>💡</i>} title="Recommendations">
            <RichArea rows={5} v={data.recommendations} onCh={(v)=>upd('recommendations', v)} readOnly={readOnly}
              placeholder="What you recommend going forward…" />
          </Section>

          {/* Action Items — concrete next steps. Optional. v1 keeps these
              separate from Recommendations so the report has a clear
              "do this" list below the narrative. */}
          <Section icon={<i>✅</i>} title="Action Items">
            <RichArea rows={4} v={data.actionItems} onCh={(v)=>upd('actionItems', v)} readOnly={readOnly}
              placeholder="Concrete next steps — what's getting done and by whom…" />
          </Section>

          {/* Brand-level sections — defined per-brand on the brand page,
              show up here on every weekly/biweekly report for this brand.
              Author fills the value; it persists in data.customFields[id]
              alongside user-level custom fields. */}
          {brandSectionDefs.length > 0 && (
            <Section icon={<i>📌</i>} title="Brand Sections">
              {brandSectionDefs.map((s) => (
                <RichArea
                  key={s.id}
                  label={s.name}
                  rows={3}
                  v={data.customFields?.[s.id]?.value || ''}
                  onCh={(v) => setData((d) => ({
                    ...d,
                    customFields: {
                      ...(d.customFields || {}),
                      [s.id]: { name: s.name, value: v, source: 'brand' },
                    },
                  }))}
                  readOnly={readOnly}
                />
              ))}
            </Section>
          )}

          {/* Custom fields */}
          {customFieldDefs.length > 0 && (
            <Section icon={<i>🧩</i>} title="Custom Fields">
              {customFieldDefs.map((f) => (
                <RichArea
                  key={f.id}
                  label={f.field_name}
                  rows={3}
                  v={data.customFields?.[f.id]?.value || ''}
                  onCh={(v) => setData((d) => ({
                    ...d,
                    customFields: {
                      ...(d.customFields || {}),
                      [f.id]: { name: f.field_name, value: v },
                    },
                  }))}
                  readOnly={readOnly}
                />
              ))}
            </Section>
          )}

          {/* Reject popover */}
          {rejectOpen && (
            <div className="wx-card" style={{ padding: 14, border: '1px solid var(--danger)' }}>
              <div style={{ fontWeight: 700, color: 'var(--danger)', marginBottom: 6 }}>Send back for revision</div>
              <TextArea label="Reason (required)" rows={3} v={rejectNote} onCh={setRejectNote} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button className="wx-btn wx-btn-ghost" onClick={() => { setRejectOpen(false); setRejectNote(''); }}>Cancel</button>
                <button className="wx-btn wx-btn-primary" onClick={handleReject} disabled={saving}>
                  {saving ? <><span className="wx-spinner" /> Sending…</> : 'Send back'}
                </button>
              </div>
            </div>
          )}

          {/* Reopen popover */}
          {reopenOpen && (
            <div className="wx-card" style={{ padding: 14, border: '1px solid var(--accent)' }}>
              <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 8 }}>Reopen approved report</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {[
                  { v: 'verified',  label: 'Keep verified (I\'ll edit)' },
                  { v: 'submitted', label: 'Send back to TL' },
                  { v: 'draft',     label: 'Send back to APC' },
                ].map((o) => (
                  <button key={o.v} type="button" onClick={() => setReopenTarget(o.v)}
                    className={`wx-role-chip ${reopenTarget === o.v ? 'wx-role-chip-active' : ''}`}
                    style={{ padding: '7px 12px' }}>
                    {o.label}
                  </button>
                ))}
              </div>
              {reopenTarget !== 'verified' && (
                <TextArea label="Note (required)" rows={3} v={reopenNote} onCh={setReopenNote} />
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button className="wx-btn wx-btn-ghost" onClick={() => { setReopenOpen(false); setReopenNote(''); setReopenTarget('verified'); }}>Cancel</button>
                <button className="wx-btn wx-btn-primary" onClick={handleReopen} disabled={saving}>
                  {saving ? <><span className="wx-spinner" /> Reopening…</> : 'Reopen'}
                </button>
              </div>
            </div>
          )}
        </div>

      <div className="report-page-actions">
        <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Close</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {perms.canEditContent && (
            <button className="wx-btn wx-btn-ghost" onClick={handleSaveDraft}
              disabled={saving || !!duplicate}
              title={duplicate ? 'A report already exists for this week — saving would overwrite it.' : ''}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save draft'}
            </button>
          )}
          {perms.canSubmit && (
            <button className="wx-btn wx-btn-primary" onClick={handleSubmit}
              disabled={saving || !!duplicate}
              title={duplicate ? 'A report already exists for this week.' : ''}>
              <ArrowRightIcon width="15" height="15" /> Submit for review
            </button>
          )}
          {perms.canReject && !rejectOpen && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setRejectOpen(true)} disabled={saving}>
              Send back
            </button>
          )}
          {perms.canVerify && (
            <button className="wx-btn wx-btn-primary" onClick={handleVerify} disabled={saving}>
              <CheckIcon width="15" height="15" /> Verify
            </button>
          )}
          {perms.canApprove && (
            <button className="wx-btn wx-btn-primary" onClick={handleApprove} disabled={saving}>
              <CheckIcon width="15" height="15" /> Approve
            </button>
          )}
          {perms.canReopen && !reopenOpen && (
            <button className="wx-btn wx-btn-primary" onClick={() => setReopenOpen(true)} disabled={saving}>
              <RefreshIcon width="15" height="15" /> Reopen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ Layout helpers ============
function Section({ icon, title, children }) {
  return (
    <div className="report-section">
      <div className="report-section-head">
        <div className="report-section-title">
          <span className="report-section-title-icon">{icon}</span>
          {title}
        </div>
      </div>
      <div className="report-section-body">{children}</div>
    </div>
  );
}

function Grid({ cols = 4, children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fit, minmax(${Math.floor(640 / cols)}px, 1fr))`,
      gap: 10,
    }}>{children}</div>
  );
}

function NumInput({ label, v, onCh, readOnly }) {
  return (
    <div>
      <label className="wx-label" style={{ fontSize: 12 }}>{label}</label>
      <input
        type="text"
        inputMode="decimal"
        className="wx-input"
        value={v || ''}
        onChange={(e) => onCh(e.target.value)}
        disabled={readOnly}
        style={{ padding: '8px 10px', fontSize: 13 }}
      />
    </div>
  );
}

function TextArea({ label, rows = 3, v, onCh, readOnly, placeholder }) {
  return (
    <div>
      {label && <label className="wx-label" style={{ fontSize: 12 }}>{label}</label>}
      <textarea
        className="wx-input"
        rows={rows}
        value={v || ''}
        onChange={(e) => onCh(e.target.value)}
        disabled={readOnly}
        placeholder={placeholder}
        style={{ padding: '8px 10px', fontSize: 13, resize: 'vertical', minHeight: rows * 22 }}
      />
    </div>
  );
}

// Rich-text wrapper matching TextArea's API. Used for long-form fields
// (insights, narrative sections, brand sections, custom fields) so users
// can format text and highlight key bits. Persists raw HTML in the same
// data field as the plain-text version did — RichContent on the view
// side detects HTML and renders it correctly, falls back to plain text
// for legacy reports.
function RichArea({ label, rows = 4, v, onCh, readOnly, placeholder }) {
  return (
    <div>
      {label && <label className="wx-label" style={{ fontSize: 12 }}>{label}</label>}
      <RichTextEditor
        value={v || ''}
        onChange={(html) => onCh(html)}
        readOnly={readOnly}
        minHeight={Math.max(120, rows * 22)}
        placeholder={placeholder}
      />
    </div>
  );
}

function RowTable({ rows, cols, onChange, onAdd, onDel, readOnly }) {
  return (
    <div className="report-row-table">
      {(rows || []).map((row, i) => (
        <div key={i} className="report-row">
          {cols.map((c) => (
            <div key={c.f} style={{ flex: c.flex, minWidth: 0 }}>
              <input
                className="wx-input"
                placeholder={c.ph}
                value={row[c.f] || ''}
                onChange={(e) => onChange(i, c.f, e.target.value)}
                disabled={readOnly}
              />
            </div>
          ))}
          {!readOnly && rows.length > 1 && (
            <button type="button" className="report-row-del" onClick={() => onDel(i)} title="Remove row">
              <XIcon width="14" height="14" />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" className="report-add-row" onClick={onAdd}>
          <PlusIcon width="13" height="13" /> Add row
        </button>
      )}
    </div>
  );
}

// ============ utility ============
function setByPath(obj, path, value) {
  const parts = path.split('.');
  const next = { ...obj };
  let cur = next;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = { ...(cur[parts[i]] || {}) };
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}
