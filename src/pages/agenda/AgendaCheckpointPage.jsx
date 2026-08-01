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
import { useSearchParams } from 'react-router-dom';
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
  submitCheckpoint, verifyCheckpoint, approveCheckpoint, returnCheckpoint, reopenCheckpoint,
} from '../../lib/checkpointsApi';
import { loadDraft, saveDraft, clearDraft, hydrate } from '../../lib/checkpointDraft';
import { runCheckpointAutofill, applyAutofillPatch, mirrorTargetInvites } from '../../lib/checkpointAutofill';
import { deductPromptApcCheckpoint } from '../../lib/apcReportingApi';
import { listManagedBrandIds, getPaidCollabEntry, getLatestPaidCollabEntry, remindPaidCollab, emptyPaidCollab } from '../../lib/paidCollabCheckpointApi';
import PaidCollabCheckpointDashboard from './PaidCollabCheckpointDashboard';
import { exportCheckpointToPdf, SLIDE_H } from '../../utils/exportCheckpointPdf';
import CheckpointForm from '../../components/checkpoint/CheckpointForm';
import CheckpointDeck from '../../components/checkpoint/CheckpointDeck';
import CheckpointReturnNotice from '../../components/checkpoint/CheckpointReturnNotice';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { AlertIcon } from '../../components/common/Icon';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { useReportLeaveGuard } from '../../components/reporting/useReportLeaveGuard';
import '../../styles/checkpoint.css';

const SLIDE_COUNT = 12;
const PREVIEW_GAP = 28;
const MemoDeck = memo(CheckpointDeck);
const raf = () => new Promise((r) => requestAnimationFrame(r));

// status → { label, cls } for the card / topbar pills.
const STATUS_PILL = {
  draft:     { label: 'Draft',      cls: 'draft' },
  submitted: { label: 'Pending TL', cls: 'submitted' },
  verified:  { label: 'Pending OL', cls: 'verified' },
  approved:  { label: 'Approved',   cls: 'approved' },
};
const pillFor = (s) => STATUS_PILL[s] || STATUS_PILL.draft;

// Friendly one-liner after an auto-fill / create, pointing the APC at what's
// filled vs. what they still need to complete by hand.
function autofillSummary(meta, created) {
  if (!meta) return created ? 'Blank checkpoint created — fill in each section below, then Done → Submit for verification.' : '';
  const bits = [meta.reportFound ? 'weekly report ✓' : 'no weekly report for this week'];
  if (meta.reportN2Found) bits.push('N-2 report ✓');
  if (meta.eukaTried) bits.push(meta.eukaOk ? 'Euka ✓' : 'Euka unavailable');
  const n = meta.filled || 0;
  const lead = created ? 'Created & auto-filled' : 'Auto-filled';
  return `${lead} ${n} field${n === 1 ? '' : 's'} from your data (${bits.join(' · ')}). Review those numbers, then complete the rest below.`;
}

// The paid collab team (pctl/ipc) gets a stripped-down §09-only dashboard; everyone
// else gets the full APC checkpoint flow below.
export default function AgendaCheckpointPage() {
  const { profile } = useAuth();
  if (!profile) return null;
  if (profile.role === 'pctl' || profile.role === 'ipc') return <PaidCollabCheckpointDashboard />;
  return <ApcCheckpointPage />;
}

function ApcCheckpointPage() {
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
  const [createStage, setCreateStage] = useState(null);     // {label, pct} — non-dismissable autofill overlay
  const [autofilling, setAutofilling] = useState(false);
  const [autofillMsg, setAutofillMsg] = useState('');       // banner after auto-fill / create
  const [saveState, setSaveState] = useState('idle');  // idle|saving|saved|local
  const [savedAt, setSavedAt] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // week_start pending confirm (cards)
  const [deleting, setDeleting] = useState(false);
  const [viewDelete, setViewDelete] = useState(false);      // view-mode confirm
  const [wfBusy, setWfBusy] = useState('');                 // '' | 'submit' | 'verify' | 'approve' | 'return' | 'reopen'
  const [wfErr, setWfErr] = useState('');
  const [returnOpen, setReturnOpen] = useState(false);      // return-note modal
  const [returnNote, setReturnNote] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

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

  // Paid Collab §09: whether THIS brand is on the shared team list (→ read-only §09
  // + reminder in the APC form; hidden if not), and the team's entry for the week.
  const { data: pcManagedIds = [] } = useQuery({
    queryKey: ['checkpoint', 'pc-managed'], queryFn: listManagedBrandIds,
  });
  const isPaidCollabManaged = pcManagedIds.includes(brandId);
  const pcEntryQuery = useQuery({
    queryKey: ['checkpoint', 'pc-entry', brandId, weekStart],
    queryFn: () => getPaidCollabEntry(brandId, weekStart),
    enabled: !!brandId && isPaidCollabManaged,
  });
  const pcEntry = pcEntryQuery.data || null;
  const paidCollabMode = isPaidCollabManaged ? 'readonly' : 'hidden';
  // The Paid Collab team fills §09 as a rolling snapshot (not week-specific), and
  // its week_start can differ from the checkpoint's (e.g. Mon-start vs Sun-start).
  // So when THIS exact week has nothing, auto-fall-back to the brand's latest
  // filled entry — that way OL / TL / APC all see the team's data instead of a
  // blank section. The APC can still explicitly re-pull.
  const pcLatestQuery = useQuery({
    queryKey: ['checkpoint', 'pc-latest', brandId],
    queryFn: () => getLatestPaidCollabEntry(brandId),
    enabled: !!brandId && isPaidCollabManaged,
  });
  const [pulledPcEntry, setPulledPcEntry] = useState(null);
  const [pullingPc, setPullingPc] = useState(false);
  useEffect(() => { setPulledPcEntry(null); }, [brandId, weekStart]);
  const effectivePcEntry = pcEntry || pulledPcEntry || pcLatestQuery.data || null;
  const paidCollabPulled = !pcEntry && !!effectivePcEntry;
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

  // Deep-link from a notification: /agenda/checkpoint?brand=<id>&week=<YYYY-MM-DD>
  // opens that brand+week in view mode. Applied once; we pin defaultAppliedRef so
  // the "jump to last week" default can't clobber the linked week, then clear the
  // query so it doesn't fight later manual navigation.
  const [pendingDeepView, setPendingDeepView] = useState(false);
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (deepLinkAppliedRef.current || !brands.length) return;
    const b = searchParams.get('brand');
    const w = searchParams.get('week');
    if (!b || !w || !brands.some((x) => x.id === b)) return;
    deepLinkAppliedRef.current = true;
    defaultAppliedRef.current = b;      // don't let the default-week effect override
    setBrandId(b);
    setWeekStart(w);
    setPendingDeepView(true);
    setSearchParams({}, { replace: true });
  }, [brands, searchParams, setSearchParams]);
  // Once the linked checkpoint has loaded, flip to view mode (the brand-change
  // effect resets to 'list', so we wait for the row then switch).
  useEffect(() => {
    if (!pendingDeepView || !existing.isSuccess) return;
    setPendingDeepView(false);
    if (existing.data) setMode('view');
  }, [pendingDeepView, existing.isSuccess, existing.data]);

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
    setCreating(true); setWfErr(''); setAutofillMsg('');
    // Non-dismissable progress overlay so the APC sees work happening (Euka
    // brands can take several seconds) instead of just a greyed-out button.
    setCreateStage({ label: fromLast ? 'Loading last week…' : 'Setting up this checkpoint…', pct: 12 });
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
      let meta = null;
      try {
        const patch = await runCheckpointAutofill({ brandId, weekStart, brand: selectedBrand, onStage: setCreateStage });
        d = mirrorTargetInvites(applyAutofillPatch(d, patch));
        meta = patch.meta;
      } catch { /* best effort — a failed auto-fill still yields a usable blank/carried form */ }
      setCreateStage({ label: 'Saving…', pct: 96 });
      loadedRef.current = true;
      setData(d);
      try {
        await saveCheckpoint({ brandId, weekStart, weekLabel, data: d });
        baselineRef.current = JSON.stringify(d); setDirty(false); setSaveState('saved'); setSavedAt(Date.now());
        qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
        qc.invalidateQueries({ queryKey: ['checkpoint', 'one', brandId, weekStart] });
      } catch { setSaveState('local'); }
      setAutofillMsg(autofillSummary(meta, true));
      setMode('edit');
    } finally { setCreating(false); setCreateStage(null); }
  }

  async function onAutofill() {
    if (!data || autofilling) return;
    setAutofilling(true); setAutofillMsg('');
    try {
      const patch = await runCheckpointAutofill({ brandId, weekStart, brand: selectedBrand });
      setData((d) => mirrorTargetInvites(applyAutofillPatch(d, patch)));
      setAutofillMsg(autofillSummary(patch.meta, false));
    } catch (e) { setAutofillMsg(`Auto-fill failed: ${e?.message || e}`); }
    finally { setAutofilling(false); }
  }

  // Nudge the paid collab team to fill §09 for this brand+week.
  const [remindingPc, setRemindingPc] = useState(false);
  const [pcRemindMsg, setPcRemindMsg] = useState('');
  async function onRemindPaidCollab() {
    if (!brandId || remindingPc) return;
    setRemindingPc(true); setPcRemindMsg('');
    try {
      const n = await remindPaidCollab(brandId, weekStart);
      setPcRemindMsg(n > 0 ? `Reminder sent to ${n} paid collab team member${n === 1 ? '' : 's'}.` : 'No active paid collab members to notify.');
    } catch (e) { setPcRemindMsg(`Couldn't send reminder: ${e?.message || e}`); }
    finally { setRemindingPc(false); }
  }

  // Pull whatever the paid collab team last entered for this brand (any week).
  async function onPullPaidCollab() {
    if (!brandId || pullingPc) return;
    setPullingPc(true); setPcRemindMsg('');
    try {
      const latest = await getLatestPaidCollabEntry(brandId);
      setPulledPcEntry(latest || null);
      if (!latest) setPcRemindMsg("The Paid Collab team hasn't entered any data for this brand yet.");
    } catch (e) { setPcRemindMsg(`Couldn't pull the team's data: ${e?.message || e}`); }
    finally { setPullingPc(false); }
  }

  // ── approval workflow actions (submit → verify → approve, + return/reopen) ──
  const cp = existing.data || null;
  const status = cp?.status || 'draft';
  const isAuthor = !!cp?.author_id && cp.author_id === profile?.id;
  const isOwnerTL = !!selectedBrand?.owner_id && selectedBrand.owner_id === profile?.id;
  const isAdmin = ['ol', 'boss', 'developer'].includes(profile?.role);
  // The owner TL can edit the checkpoint directly (draft or submitted) instead of
  // bouncing it back to the APC for every small fix. RLS (checkpoint_can_write)
  // already grants the owner TL write access.
  const canEditContent = isAdmin
    || (isAuthor && status === 'draft')
    || (isOwnerTL && (status === 'draft' || status === 'submitted'));
  const canSubmit = status === 'draft' && (isAuthor || isAdmin);
  const canVerify = status === 'submitted' && (isOwnerTL || isAdmin);
  const canApprove = status === 'verified' && isAdmin;
  const canReturn = (status === 'submitted' && (isOwnerTL || isAdmin)) || (status === 'verified' && isAdmin);
  const canReopen = status === 'approved' && isAdmin;
  const cpId = () => cp?.id || weeks.find((w) => w.week_start === weekStart)?.id || null;

  async function runWf(kind, fn) {
    setWfBusy(kind); setWfErr('');
    try {
      await fn();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] }),
        existing.refetch(),
      ]);
      return true;
    } catch (e) { setWfErr(e?.message || String(e)); return false; }
    finally { setWfBusy(''); }
  }
  async function doSubmit() {
    if (dirty) { const ok = await saveNow(); if (!ok) { setWfErr('Could not save your latest edits — check your connection and try again.'); return; } }
    const id = cpId(); if (id) await runWf('submit', () => submitCheckpoint(id));
  }
  async function doVerify()  { const id = cpId(); if (id) await runWf('verify',  () => verifyCheckpoint(id)); }
  async function doApprove() { const id = cpId(); if (id) await runWf('approve', () => approveCheckpoint(id)); }
  async function doReopen()  { const id = cpId(); if (id) await runWf('reopen',  () => reopenCheckpoint(id)); }
  async function doReturn() {
    const id = cpId(); if (!id) return;
    const note = returnNote.trim();
    if (!note) { setWfErr('Please add a note explaining what needs to change.'); return; }
    const ok = await runWf('return', () => returnCheckpoint(id, { note }));
    if (ok) {
      setReturnOpen(false); setReturnNote('');
      // Returning a SUBMITTED checkpoint goes to the APC (draft) — the TL may dock
      // the APC's reporting. A verified→submitted return (OL→TL) does not.
      if (status === 'submitted') { try { await deductPromptApcCheckpoint(id); } catch { /* best-effort */ } }
    }
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

  // For the deck/PDF, source §09 from the paid collab team's entry on managed brands
  // (the checkpoint blob's own paidCollab is a stale mirror the APC no longer edits).
  const deckData = useMemo(() => {
    if (!data || !isPaidCollabManaged) return data;
    return { ...data, paidCollab: { ...emptyPaidCollab(), ...(effectivePcEntry?.data || {}) } };
  }, [data, isPaidCollabManaged, effectivePcEntry]);

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
                      <span className={`ck-card-badge ${pillFor(w.status).cls}`}>{pillFor(w.status).label}</span>
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
            <div className="ck-topbar-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span><strong>{brandName}</strong> · Week of {weekLabel}</span>
              <span className={`ck-status-pill ${pillFor(status).cls}`}>{pillFor(status).label}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {canSubmit && (
                <button className="wx-btn wx-btn-primary" disabled={!!wfBusy || !data} onClick={doSubmit}>
                  {wfBusy === 'submit' ? <><span className="wx-spinner" /> Submitting…</> : <><i className="bi bi-send me-1" /> Submit for verification</>}
                </button>
              )}
              {canVerify && (
                <button className="wx-btn wx-btn-primary" disabled={!!wfBusy} onClick={doVerify}>
                  {wfBusy === 'verify' ? <><span className="wx-spinner" /> Verifying…</> : <><i className="bi bi-check2-circle me-1" /> Verify</>}
                </button>
              )}
              {canApprove && (
                <button className="wx-btn wx-btn-primary" disabled={!!wfBusy} onClick={doApprove}>
                  {wfBusy === 'approve' ? <><span className="wx-spinner" /> Approving…</> : <><i className="bi bi-patch-check me-1" /> Approve</>}
                </button>
              )}
              {canReturn && (
                <button className="wx-btn wx-btn-ghost" style={{ color: 'var(--danger)' }} disabled={!!wfBusy}
                  onClick={() => { setWfErr(''); setReturnNote(''); setReturnOpen(true); }}>
                  <i className="bi bi-arrow-counterclockwise me-1" /> Return {status === 'verified' ? 'to TL' : 'to APC'}
                </button>
              )}
              {canReopen && (
                <button className="wx-btn wx-btn-ghost" disabled={!!wfBusy} onClick={doReopen}>
                  {wfBusy === 'reopen' ? <><span className="wx-spinner" /> Reopening…</> : <><i className="bi bi-unlock me-1" /> Reopen to edit</>}
                </button>
              )}
              {canManage && (viewDelete ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Delete?</span>
                  <button className="ck-btn-danger" disabled={deleting} onClick={() => removeCheckpoint(weeks.find((w) => w.week_start === weekStart)?.id || existing.data?.id, weekStart, () => { setViewDelete(false); setMode('list'); })}>{deleting ? '…' : 'Yes'}</button>
                  <button className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }} disabled={deleting} onClick={() => setViewDelete(false)}>No</button>
                </span>
              ) : (
                <button className="wx-btn wx-btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setViewDelete(true)}><i className="bi bi-trash3 me-1" /> Delete</button>
              ))}
              {canEditContent && (
                <button className="wx-btn wx-btn-ghost" disabled={!data} onClick={() => setMode('edit')}><i className="bi bi-pencil-square me-1" /> Edit</button>
              )}
              <button className={`wx-btn ${(canSubmit || canVerify || canApprove) ? 'wx-btn-ghost' : 'wx-btn-primary'}`} disabled={!data || busy} onClick={onGenerate}>
                {busy ? <><span className="wx-spinner" /> {progress ? `Rendering ${progress.i}/${progress.total}…` : 'Generating…'}</> : <><i className="bi bi-filetype-pdf me-1" /> Generate PDF</>}
              </button>
            </div>
          </div>
          {wfErr && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}><AlertIcon width="16" height="16" /> <span>{wfErr}</span></div>}
          <CheckpointReturnNotice checkpointId={cp?.id} status={status} />
          <div className="ck-view-stage" ref={viewColRef}>
            {!data ? (
              <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
            ) : (
              <div className="ckpt-preview" style={{ height: unscaledH * scale, margin: '0 auto', maxWidth: 1280 }}>
                <div style={{ width: 1280, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                  <MemoDeck data={deckData} ref={deckRef} />
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
          <CheckpointReturnNotice checkpointId={cp?.id} status={status} />
          {autofillMsg && (
            <div className="ck-autofill-banner">
              <i className="bi bi-magic" />
              <span style={{ flex: 1, minWidth: 0 }}>{autofillMsg}</span>
              <button type="button" className="ck-autofill-x" onClick={() => setAutofillMsg('')} aria-label="Dismiss"><i className="bi bi-x-lg" /></button>
            </div>
          )}
          {data ? (
            <CheckpointForm data={data} setData={setData}
              paidCollabMode={paidCollabMode} paidCollabEntry={effectivePcEntry}
              onRemindPaidCollab={onRemindPaidCollab} remindingPaidCollab={remindingPc}
              paidCollabRemindMsg={pcRemindMsg}
              onPullPaidCollab={onPullPaidCollab} pullingPaidCollab={pullingPc}
              paidCollabPulled={paidCollabPulled} paidCollabHasWeekEntry={!!pcEntry} />
          ) : (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
          )}
        </>
      )}

      {/* ─────────── non-dismissable auto-fill / create overlay ─────────── */}
      {creating && createStage && (
        <div className="ck-overlay">
          <div className="ck-overlay-card">
            <div className="ck-overlay-spinner"><span className="wx-spinner" /></div>
            <div className="ck-overlay-title">Preparing {brandName || 'the'} checkpoint</div>
            <div className="ck-overlay-stage">{createStage.label || 'Working…'}</div>
            <div className="ck-overlay-bar"><div className="ck-overlay-bar-fill" style={{ width: `${Math.max(6, Math.min(100, createStage.pct || 0))}%` }} /></div>
            <div className="ck-overlay-note">Pulling in your weekly report{selectedBrand?.euka_store_id ? ' and Euka data' : ''} and auto-filling. Please don't close this window.</div>
          </div>
        </div>
      )}

      {/* ─────────── return-with-note modal ─────────── */}
      {returnOpen && (
        <div className="ck-overlay" onClick={() => !wfBusy && setReturnOpen(false)}>
          <div className="ck-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ck-modal-title">
              <i className="bi bi-arrow-counterclockwise" style={{ color: 'var(--danger)' }} />
              Return {status === 'verified' ? 'to Team Lead' : 'to APC'}
            </div>
            <p className="ck-modal-sub">
              Explain what needs to change. This note is shown to {status === 'verified' ? 'the Team Lead' : 'the APC'} on their checkpoint and sent as a notification.
            </p>
            <textarea className="wx-input" rows={4} autoFocus value={returnNote}
              onChange={(e) => setReturnNote(e.target.value)} placeholder="e.g. GMV Max spend looks off vs. the report — please double-check the paid section." />
            {wfErr && <div className="wx-alert wx-alert-danger" style={{ marginTop: 10 }}><AlertIcon width="15" height="15" /> <span>{wfErr}</span></div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="wx-btn wx-btn-ghost" disabled={!!wfBusy} onClick={() => setReturnOpen(false)}>Cancel</button>
              <button className="wx-btn wx-btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={!!wfBusy || !returnNote.trim()} onClick={doReturn}>
                {wfBusy === 'return' ? <><span className="wx-spinner" /> Returning…</> : <>Return checkpoint</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
