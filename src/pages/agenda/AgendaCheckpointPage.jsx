// ============================================================
// Weekly Performance Checkpoint (APC) — reports-style flow.
//
// Modes: LIST (cards of the brand's checkpoints + create) → VIEW (read-only
// deck preview + Edit / Generate PDF) → EDIT (the form; NO live preview —
// the deck is only shown after saving). Tracked server-side (weekly_checkpoints,
// mig 264), week grid aligned to the brand's reporting weeks.
//
// Safety (same as the report forms): edits autosave to the DB (+ a localStorage
// mirror), and while there are unsaved edits `useUnsavedGuard` arms a
// beforeunload prompt + suppresses the stale-deploy auto-reload, while
// `useReportLeaveGuard` intercepts in-app navigation with a Save/Stay/Discard
// modal.
// ============================================================
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { listBrands } from '../../lib/brandsApi';
import {
  EMPTY_CHECKPOINT, defaultReviewWeekStart, weekLabelForStart, addWeeks,
  alignToGrid, todayISO,
} from '../../lib/checkpointModel';
import { carryForward } from '../../lib/checkpointCarry';
import {
  listCheckpoints, getCheckpoint, findPreviousCheckpoint, saveCheckpoint, listReportWeeks, deleteCheckpoint,
} from '../../lib/checkpointsApi';
import { loadDraft, saveDraft, clearDraft, hydrate } from '../../lib/checkpointDraft';
import { runCheckpointAutofill, applyAutofillPatch, mirrorTargetInvites } from '../../lib/checkpointAutofill';
import { exportCheckpointToPdf, SLIDE_H } from '../../utils/exportCheckpointPdf';
import CheckpointForm from '../../components/checkpoint/CheckpointForm';
import CheckpointDeck from '../../components/checkpoint/CheckpointDeck';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { AlertIcon } from '../../components/common/Icon';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { useReportLeaveGuard } from '../../components/reporting/useReportLeaveGuard';
import '../../styles/checkpoint.css';

const SLIDE_COUNT = 12;
const PREVIEW_GAP = 28;
const MemoDeck = memo(CheckpointDeck);
const raf = () => new Promise((r) => requestAnimationFrame(r));

export default function AgendaCheckpointPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [brandId, setBrandId] = useState('');
  const [weekStart, setWeekStart] = useState(defaultReviewWeekStart);
  const [mode, setMode] = useState('list');            // list | view | edit
  const [data, setData] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [creating, setCreating] = useState(false);
  const [autofilling, setAutofilling] = useState(false);
  const [autofillMsg, setAutofillMsg] = useState('');
  const [saveState, setSaveState] = useState('idle');  // idle|saving|saved|local
  const [savedAt, setSavedAt] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // week_start pending confirm (cards)
  const [deleting, setDeleting] = useState(false);
  const [viewDelete, setViewDelete] = useState(false);      // view-mode confirm

  // Who may delete a checkpoint (RLS is the real gate — mig 264
  // checkpoint_can_write = Boss/OL/dev, the brand's owner TL, or an assigned APC/IPC).
  const canManage = ['boss', 'ol', 'developer', 'tl', 'apc', 'ipc'].includes(profile?.role);

  const deckRef = useRef(null);
  const viewColRef = useRef(null);
  const loadedRef = useRef(false);
  const baselineRef = useRef('');

  const weekLabel = useMemo(() => weekLabelForStart(weekStart), [weekStart]);

  const { data: brands = [], isLoading: brandsLoading, error: brandsErr } = useQuery({
    queryKey: ['checkpoint', 'brands'], queryFn: () => listBrands({ status: 'active' }),
  });
  const selectedBrand = brands.find((b) => b.id === brandId) || null;
  const brandName = selectedBrand?.brand_name || '';

  const { data: manager } = useQuery({
    queryKey: ['checkpoint', 'manager', profile?.reports_to],
    queryFn: async () => {
      const { data: m } = await supabase.from('profiles').select('display_name').eq('id', profile.reports_to).maybeSingle();
      return m || null;
    },
    enabled: !!profile?.reports_to,
  });
  const teamLeadName = selectedBrand?.owner?.display_name || manager?.display_name || '';

  useEffect(() => { if (!brandId && brands.length) setBrandId(brands[0].id); }, [brands, brandId]);
  useEffect(() => { setMode('list'); }, [brandId]);      // brand change → back to list
  useEffect(() => { setPendingDelete(null); setViewDelete(false); }, [mode, brandId, weekStart]); // clear delete confirms

  const existing = useQuery({
    queryKey: ['checkpoint', 'one', brandId, weekStart],
    queryFn: () => getCheckpoint(brandId, weekStart), enabled: !!brandId,
  });
  const { data: weeks = [] } = useQuery({
    queryKey: ['checkpoint', 'weeks', brandId], queryFn: () => listCheckpoints(brandId), enabled: !!brandId,
  });
  const weeksSet = useMemo(() => new Set(weeks.map((w) => w.week_start)), [weeks]);
  const hasPrev = useMemo(() => weeks.some((w) => w.week_start < weekStart), [weeks, weekStart]);

  const reportWeeksQuery = useQuery({
    queryKey: ['checkpoint', 'reportweeks', brandId], queryFn: () => listReportWeeks(brandId), enabled: !!brandId,
  });
  const reportStarts = useMemo(() => (reportWeeksQuery.data || []).map((r) => r.period_start), [reportWeeksQuery.data]);
  const reportSet = useMemo(() => new Set(reportStarts), [reportStarts]);
  const anchor = useMemo(() => (reportStarts.length ? reportStarts.reduce((a, b) => (a < b ? a : b)) : null), [reportStarts]);
  const alignedDefault = useMemo(
    () => (anchor ? addWeeks(alignToGrid(anchor, todayISO()), -1) : defaultReviewWeekStart()), [anchor]);
  const reportForWeek = reportSet.has(weekStart);
  const existsForWeek = weeksSet.has(weekStart);

  const defaultAppliedRef = useRef(null);
  useEffect(() => {
    if (!brandId || !reportWeeksQuery.isSuccess || defaultAppliedRef.current === brandId) return;
    defaultAppliedRef.current = brandId;
    setWeekStart(alignedDefault);
  }, [brandId, reportWeeksQuery.isSuccess, alignedDefault]);

  // reset the loaded checkpoint on key change
  useEffect(() => { setData(null); setDirty(false); loadedRef.current = false; baselineRef.current = ''; setSaveState('idle'); }, [brandId, weekStart]);

  // load once the query settles (DB row → local recovery → none)
  useEffect(() => {
    if (!brandId || !existing.isSuccess || loadedRef.current) return;
    loadedRef.current = true;
    if (existing.data) {
      const d = hydrate(existing.data.data);
      d.cover = { ...d.cover, brandName, weekLabel };
      setData(d); baselineRef.current = JSON.stringify(d); setSaveState('saved');
    } else {
      const local = loadDraft(brandId, weekStart);
      if (local) { local.cover = { ...local.cover, brandName, weekLabel }; setData(local); baselineRef.current = ''; setSaveState('local'); }
      else setData(null);
    }
  }, [existing.isSuccess, existing.data, brandId, weekStart, brandName, weekLabel]);

  // keep cover brand/team in sync (self-correct stale "Team"); null-guard the updater
  useEffect(() => {
    if (!data || !selectedBrand) return;
    const nextTeam = teamLeadName ? `Team ${teamLeadName}` : data.cover.team;
    if (data.cover.brandName !== selectedBrand.brand_name || data.cover.weekLabel !== weekLabel || data.cover.team !== nextTeam) {
      setData((d) => (d ? { ...d, cover: { ...d.cover, brandName: selectedBrand.brand_name, weekLabel, team: teamLeadName ? `Team ${teamLeadName}` : d.cover.team } } : d));
    }
  }, [selectedBrand, weekLabel, data, teamLeadName]);

  // autosave (DB) + instant local mirror + dirty tracking
  useEffect(() => {
    if (!data || !brandId) return;
    const snapshot = JSON.stringify(data);
    if (snapshot === baselineRef.current) { setDirty(false); return; }
    setDirty(true);
    saveDraft(brandId, weekStart, data);
    setSaveState('saving');
    const id = setTimeout(async () => {
      try {
        await saveCheckpoint({ brandId, weekStart, weekLabel, data });
        baselineRef.current = snapshot; setDirty(false); setSaveState('saved'); setSavedAt(Date.now());
        qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
      } catch { setSaveState('local'); }
    }, 1200);
    return () => clearTimeout(id);
  }, [data, brandId, weekStart, weekLabel, qc]);

  // ── unsaved-work protection (same plumbing as the report forms) ─────
  useUnsavedGuard(dirty);
  async function saveNow() {
    if (!data || !brandId) return true;
    const snapshot = JSON.stringify(data);
    saveDraft(brandId, weekStart, data);
    try {
      await saveCheckpoint({ brandId, weekStart, weekLabel, data });
      baselineRef.current = snapshot; setDirty(false); setSaveState('saved'); setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
      qc.invalidateQueries({ queryKey: ['checkpoint', 'one', brandId, weekStart] });
      return true;
    } catch { setSaveState('local'); return false; }
  }
  const { guardModal, guardAction } = useReportLeaveGuard({ dirty, onSaveDraft: saveNow, noun: 'checkpoint' });

  // ── actions ─────────────────────────────────────────────────────────
  async function createNew(fromLast) {
    setCreating(true);
    try {
      let d;
      if (fromLast) {
        const prev = await findPreviousCheckpoint(brandId, weekStart);
        d = carryForward(prev?.data ? hydrate(prev.data) : null);
      } else {
        d = EMPTY_CHECKPOINT();
      }
      const teamName = teamLeadName ? `Team ${teamLeadName}` : (d.cover.team || '');
      d.cover = { brandName, apcName: profile?.display_name || '', team: teamName, weekLabel };
      try { d = mirrorTargetInvites(applyAutofillPatch(d, await runCheckpointAutofill({ brandId, weekStart, brand: selectedBrand }))); } catch { /* best effort */ }
      loadedRef.current = true;
      setData(d);
      try {
        await saveCheckpoint({ brandId, weekStart, weekLabel, data: d });
        baselineRef.current = JSON.stringify(d); setDirty(false); setSaveState('saved'); setSavedAt(Date.now());
        qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
        qc.invalidateQueries({ queryKey: ['checkpoint', 'one', brandId, weekStart] });
      } catch { setSaveState('local'); }
      setMode('edit');
    } finally { setCreating(false); }
  }

  async function onAutofill() {
    if (!data || autofilling) return;
    setAutofilling(true); setAutofillMsg('');
    try {
      const patch = await runCheckpointAutofill({ brandId, weekStart, brand: selectedBrand });
      setData((d) => mirrorTargetInvites(applyAutofillPatch(d, patch)));
      const m = patch.meta;
      const bits = [m.reportFound ? 'report ✓' : 'no report for this week'];
      if (m.reportN2Found) bits.push('N-2 report ✓');
      if (m.eukaTried) bits.push(m.eukaOk ? 'Euka ✓' : 'Euka unavailable');
      setAutofillMsg(`Filled ${m.filled} field${m.filled === 1 ? '' : 's'} — ${bits.join(' · ')}`);
      setTimeout(() => setAutofillMsg(''), 7000);
    } catch (e) { setAutofillMsg(`Auto-fill failed: ${e?.message || e}`); }
    finally { setAutofilling(false); }
  }

  async function onGenerate() {
    if (!data) return;
    setBusy(true); setProgress({ i: 0, total: SLIDE_COUNT });
    await raf(); await raf();
    try {
      await exportCheckpointToPdf(deckRef.current, {
        title: `${brandName || 'Brand'} — Weekly Checkpoint ${weekLabel}`,
        onProgress: (i, total) => setProgress({ i, total }),
      });
    } catch (e) { alert(`Couldn't generate the PDF: ${e?.message || e}`); } // eslint-disable-line no-alert
    finally { setBusy(false); setProgress(null); }
  }

  function openWeek(ws) { setWeekStart(ws); setMode('view'); }
  async function onDone() { await saveNow(); setMode('view'); }

  async function removeCheckpoint(id, ws, after) {
    setDeleting(true);
    try {
      await deleteCheckpoint(id);
      if (ws === weekStart) { setData(null); setDirty(false); loadedRef.current = false; baselineRef.current = ''; }
      clearDraft(brandId, ws); // clear any local mirror for that week
      qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
      qc.invalidateQueries({ queryKey: ['checkpoint', 'one', brandId, ws] });
      after?.();
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Couldn't delete this checkpoint: ${e?.message || e}`);
    } finally { setDeleting(false); }
  }

  // view-mode preview scale
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    if (mode !== 'view') return undefined;
    const el = viewColRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => { const w = entries[0].contentRect.width; if (w > 0) setScale(Math.min(1, w / 1280)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, data]);
  const unscaledH = SLIDE_COUNT * SLIDE_H + (SLIDE_COUNT - 1) * PREVIEW_GAP;

  const saveText = saveState === 'saving' ? 'Saving…'
    : saveState === 'saved' ? `Saved${savedAt ? ` ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : saveState === 'local' ? 'Saved locally — will sync' : '';

  const err = brandsErr?.message || '';

  return (
    <>
      {guardModal}
      <div className="page-header">
        <h1 className="page-title">Weekly Checkpoint</h1>
        <p className="page-subtitle">Build a polished per-brand deck for Tuesday's meeting — it saves as you go.</p>
      </div>

      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}><AlertIcon width="16" height="16" /> <span>{err}</span></div>}

      {/* ─────────────── LIST ─────────────── */}
      {mode === 'list' && (
        <>
          <div className="wx-card" style={{ padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220, flex: '1 1 220px' }}>
              {selectedBrand && <BrandAvatar brand={selectedBrand} size={38} radius={9} />}
              <select className="wx-input" value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={brandsLoading} style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
                {brandsLoading && <option>Loading…</option>}
                {!brandsLoading && brands.length === 0 && <option value="">No brands available</option>}
                {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Previous week" onClick={() => setWeekStart((w) => addWeeks(w, -1))}><i className="bi bi-chevron-left" /></button>
              <div style={{ minWidth: 188, textAlign: 'center' }}>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--text-primary)' }}>Week of {weekLabel}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                  {weekStart === alignedDefault ? 'Last week' : (
                    <button className="wx-btn-link" onClick={() => setWeekStart(alignedDefault)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5 }}>Jump to last week</button>
                  )}
                  <span title="Whether a weekly report exists for this exact week" style={{ fontWeight: 700, color: reportForWeek ? 'var(--success)' : 'var(--text-muted)' }}>· {reportForWeek ? 'report ✓' : 'no report'}</span>
                </div>
              </div>
              <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Next week" onClick={() => setWeekStart((w) => addWeeks(w, 1))}><i className="bi bi-chevron-right" /></button>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              {existsForWeek ? (
                <button className="wx-btn wx-btn-primary" onClick={() => openWeek(weekStart)}><i className="bi bi-folder2-open me-1" /> Open this week</button>
              ) : (
                <>
                  {hasPrev && (
                    <button className="wx-btn wx-btn-primary" disabled={creating} onClick={() => createNew(true)}>
                      {creating ? <><span className="wx-spinner" /> Creating…</> : <><i className="bi bi-arrow-down-up me-1" /> Create from last week</>}
                    </button>
                  )}
                  <button className="wx-btn wx-btn-ghost" disabled={creating} onClick={() => createNew(false)}><i className="bi bi-file-earmark-plus me-1" /> Start blank</button>
                </>
              )}
            </div>
          </div>

          {!brandId ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Pick a brand to begin.</div>
          ) : weeks.length === 0 ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              No checkpoints yet for {brandName}. Use the buttons above to create the first one.
            </div>
          ) : (
            <div className="ck-card-grid">
              {weeks.map((w) => (
                <div key={w.week_start} className="ck-card" role="button" tabIndex={0}
                  onClick={() => { if (pendingDelete !== w.week_start) openWeek(w.week_start); }}
                  onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && pendingDelete !== w.week_start) openWeek(w.week_start); }}>
                  <div className="ck-card-top">
                    <span className="ck-card-week">Week of {weekLabelForStart(w.week_start)}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`ck-card-badge ${w.status === 'final' ? 'final' : 'draft'}`}>{w.status === 'final' ? 'Final' : 'Draft'}</span>
                      {canManage && (
                        <button type="button" className="ck-card-del" title="Delete checkpoint"
                          onClick={(e) => { e.stopPropagation(); setPendingDelete(w.week_start); }}>
                          <i className="bi bi-trash3" />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="ck-card-brand">{selectedBrand && <BrandAvatar brand={selectedBrand} size={22} radius={6} />}<span>{brandName}</span></div>
                  <div className="ck-card-updated">Updated {new Date(w.updated_at).toLocaleDateString()}</div>
                  {pendingDelete === w.week_start && (
                    <div className="ck-card-confirm" onClick={(e) => e.stopPropagation()}>
                      <span>Delete this checkpoint?</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="ck-btn-danger" disabled={deleting} onClick={() => removeCheckpoint(w.id, w.week_start, () => setPendingDelete(null))}>{deleting ? '…' : 'Delete'}</button>
                        <button type="button" className="wx-btn wx-btn-ghost" style={{ padding: '5px 10px' }} disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ─────────────── VIEW ─────────────── */}
      {mode === 'view' && (
        <>
          <div className="ck-topbar">
            <button className="wx-btn wx-btn-ghost" onClick={() => setMode('list')}><i className="bi bi-arrow-left me-1" /> Back</button>
            <div className="ck-topbar-title"><strong>{brandName}</strong> · Week of {weekLabel}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {canManage && (viewDelete ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Delete?</span>
                  <button className="ck-btn-danger" disabled={deleting} onClick={() => removeCheckpoint(weeks.find((w) => w.week_start === weekStart)?.id || existing.data?.id, weekStart, () => { setViewDelete(false); setMode('list'); })}>{deleting ? '…' : 'Yes'}</button>
                  <button className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }} disabled={deleting} onClick={() => setViewDelete(false)}>No</button>
                </span>
              ) : (
                <button className="wx-btn wx-btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setViewDelete(true)}><i className="bi bi-trash3 me-1" /> Delete</button>
              ))}
              <button className="wx-btn wx-btn-ghost" disabled={!data} onClick={() => setMode('edit')}><i className="bi bi-pencil-square me-1" /> Edit</button>
              <button className="wx-btn wx-btn-primary" disabled={!data || busy} onClick={onGenerate}>
                {busy ? <><span className="wx-spinner" /> {progress ? `Rendering ${progress.i}/${progress.total}…` : 'Generating…'}</> : <><i className="bi bi-filetype-pdf me-1" /> Generate PDF</>}
              </button>
            </div>
          </div>
          <div className="ck-view-stage" ref={viewColRef}>
            {!data ? (
              <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
            ) : (
              <div className="ckpt-preview" style={{ height: unscaledH * scale, margin: '0 auto', maxWidth: 1280 }}>
                <div style={{ width: 1280, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                  <MemoDeck data={data} ref={deckRef} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ─────────────── EDIT ─────────────── */}
      {mode === 'edit' && (
        <>
          <div className="ck-topbar">
            <button className="wx-btn wx-btn-ghost" onClick={() => guardAction(() => setMode('view'))}><i className="bi bi-arrow-left me-1" /> Back</button>
            <div className="ck-topbar-title">
              Editing · Week of {weekLabel}
              {saveText && <span style={{ marginLeft: 12, fontSize: 12, fontWeight: 600, color: saveState === 'local' ? 'var(--warning)' : 'var(--text-muted)' }}><i className={`bi ${saveState === 'saving' ? 'bi-arrow-repeat' : saveState === 'local' ? 'bi-cloud-slash' : 'bi-cloud-check'} me-1`} />{saveText}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="wx-input" value={data?.currency || '$'} disabled={!data} style={{ width: 74 }} onChange={(e) => setData((d) => ({ ...d, currency: e.target.value }))}>
                <option value="$">$</option><option value="£">£</option><option value="€">€</option>
              </select>
              <button className="wx-btn wx-btn-ghost" onClick={onAutofill} disabled={autofilling || !data}>
                {autofilling ? <><span className="wx-spinner" /> Auto-filling…</> : <><i className="bi bi-magic me-1" /> Auto-fill{selectedBrand?.euka_store_id ? ' + Euka' : ''}</>}
              </button>
              <button className="wx-btn wx-btn-primary" onClick={onDone}><i className="bi bi-check2 me-1" /> Done</button>
            </div>
          </div>
          {autofillMsg && <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-4px 0 12px' }}>{autofillMsg}</div>}
          {data ? <CheckpointForm data={data} setData={setData} /> : (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
          )}
        </>
      )}
    </>
  );
}
