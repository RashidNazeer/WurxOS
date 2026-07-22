// ============================================================
// Weekly Performance Checkpoint builder (APC).
//
// Tracked server-side (weekly_checkpoints, mig 264): one row per brand per week.
// Navigate weeks; a week with no checkpoint offers "Create — pre-fill from last
// week" (carry-forward moves last week's numbers into this week's "previous"
// columns + non-stat config + open actions; NEVER N-2 or current stats) or
// "Start blank". Edits autosave to the DB (with a localStorage safety mirror
// for flaky connections). Generate → polished 12-slide landscape PDF.
// ============================================================
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { listBrands } from '../../lib/brandsApi';
import {
  EMPTY_CHECKPOINT, defaultReviewWeekStart, weekLabelForStart, addWeeks,
} from '../../lib/checkpointModel';
import { carryForward } from '../../lib/checkpointCarry';
import {
  listCheckpoints, getCheckpoint, findPreviousCheckpoint, saveCheckpoint,
} from '../../lib/checkpointsApi';
import { loadDraft, saveDraft, hydrate } from '../../lib/checkpointDraft';
import { exportCheckpointToPdf, SLIDE_H } from '../../utils/exportCheckpointPdf';
import CheckpointForm from '../../components/checkpoint/CheckpointForm';
import CheckpointDeck from '../../components/checkpoint/CheckpointDeck';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { AlertIcon } from '../../components/common/Icon';
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
  const [data, setData] = useState(null);            // null = no checkpoint loaded/created
  const [previewData, setPreviewData] = useState(EMPTY_CHECKPOINT);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle|saving|saved|local|error
  const [savedAt, setSavedAt] = useState(null);

  const deckRef = useRef(null);
  const previewColRef = useRef(null);
  const loadedRef = useRef(false);
  const baselineRef = useRef('');

  const weekLabel = useMemo(() => weekLabelForStart(weekStart), [weekStart]);

  const { data: brands = [], isLoading: brandsLoading, error: brandsErr } = useQuery({
    queryKey: ['checkpoint', 'brands'],
    queryFn: () => listBrands({ status: 'active' }),
  });
  const selectedBrand = brands.find((b) => b.id === brandId) || null;
  const brandName = selectedBrand?.brand_name || '';

  useEffect(() => { if (!brandId && brands.length) setBrandId(brands[0].id); }, [brands, brandId]);

  const existing = useQuery({
    queryKey: ['checkpoint', 'one', brandId, weekStart],
    queryFn: () => getCheckpoint(brandId, weekStart),
    enabled: !!brandId,
  });
  const { data: weeks = [] } = useQuery({
    queryKey: ['checkpoint', 'weeks', brandId],
    queryFn: () => listCheckpoints(brandId),
    enabled: !!brandId,
  });
  const weeksSet = useMemo(() => new Set(weeks.map((w) => w.week_start)), [weeks]);
  const hasPrev = useMemo(() => weeks.some((w) => w.week_start < weekStart), [weeks, weekStart]);

  // reset when the brand+week key changes
  useEffect(() => { setData(null); loadedRef.current = false; baselineRef.current = ''; setSaveState('idle'); }, [brandId, weekStart]);

  // load the checkpoint once the query settles (DB row → local recovery → empty)
  useEffect(() => {
    if (!brandId || !existing.isSuccess || loadedRef.current) return;
    loadedRef.current = true;
    if (existing.data) {
      const d = hydrate(existing.data.data);
      d.cover = { ...d.cover, brandName, weekLabel };
      setData(d);
      baselineRef.current = JSON.stringify(d);
      setSaveState('saved');
    } else {
      const local = loadDraft(brandId, weekStart);   // recover unsynced offline work
      if (local) {
        local.cover = { ...local.cover, brandName, weekLabel };
        setData(local);
        baselineRef.current = '';                      // force a re-save
        setSaveState('local');
      } else {
        setData(null);                                 // → empty state
      }
    }
  }, [existing.isSuccess, existing.data, brandId, weekStart, brandName, weekLabel]);

  // keep cover in sync if brand name resolves after load
  useEffect(() => {
    if (!data || !selectedBrand) return;
    if (data.cover.brandName !== selectedBrand.brand_name || data.cover.weekLabel !== weekLabel) {
      setData((d) => ({ ...d, cover: { ...d.cover, brandName: selectedBrand.brand_name, weekLabel } }));
    }
  }, [selectedBrand, weekLabel, data]);

  // debounce preview
  useEffect(() => { if (data) { const id = setTimeout(() => setPreviewData(data), 180); return () => clearTimeout(id); } }, [data]);

  // autosave (DB) + instant local mirror
  useEffect(() => {
    if (!data || !brandId) return;
    const snapshot = JSON.stringify(data);
    if (snapshot === baselineRef.current) return;
    saveDraft(brandId, weekStart, data);              // instant offline backup
    setSaveState('saving');
    const id = setTimeout(async () => {
      try {
        await saveCheckpoint({ brandId, weekStart, weekLabel, data });
        baselineRef.current = snapshot;
        setSaveState('saved'); setSavedAt(Date.now());
        qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
      } catch {
        setSaveState('local');                         // kept in localStorage
      }
    }, 1200);
    return () => clearTimeout(id);
  }, [data, brandId, weekStart, weekLabel, qc]);

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
      d.cover = { brandName, apcName: profile?.display_name || '', team: d.cover.team || '', weekLabel };
      loadedRef.current = true;
      setData(d);
      saveDraft(brandId, weekStart, d);
      try {
        await saveCheckpoint({ brandId, weekStart, weekLabel, data: d });
        baselineRef.current = JSON.stringify(d);
        setSaveState('saved'); setSavedAt(Date.now());
        qc.invalidateQueries({ queryKey: ['checkpoint', 'weeks', brandId] });
        qc.invalidateQueries({ queryKey: ['checkpoint', 'one', brandId, weekStart] });
      } catch { setSaveState('local'); }
    } finally { setCreating(false); }
  }

  // responsive preview scale
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = previewColRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { const w = entries[0].contentRect.width; if (w > 0) setScale(Math.min(1, w / 1280)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);
  const unscaledH = SLIDE_COUNT * SLIDE_H + (SLIDE_COUNT - 1) * PREVIEW_GAP;

  async function onGenerate() {
    if (!data) return;
    setBusy(true); setProgress({ i: 0, total: SLIDE_COUNT });
    setPreviewData(data);
    await raf(); await raf();
    try {
      await exportCheckpointToPdf(deckRef.current, {
        title: `${brandName || 'Brand'} — Weekly Checkpoint ${weekLabel}`,
        onProgress: (i, total) => setProgress({ i, total }),
      });
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Couldn't generate the PDF: ${e?.message || e}`);
    } finally { setBusy(false); setProgress(null); }
  }

  const saveText = saveState === 'saving' ? 'Saving…'
    : saveState === 'saved' ? `Saved${savedAt ? ` ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : saveState === 'local' ? 'Saved locally (offline) — will sync'
    : '';
  const isThisWeekReview = weekStart === defaultReviewWeekStart();

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Weekly Checkpoint</h1>
          <p className="page-subtitle">Fill in last week's numbers and story, then generate a polished PDF for Tuesday's meeting.</p>
        </div>
        <button className="wx-btn wx-btn-primary" disabled={!data || busy} onClick={onGenerate}>
          {busy
            ? <><span className="wx-spinner" /> {progress ? `Rendering ${progress.i}/${progress.total}…` : 'Generating…'}</>
            : <><i className="bi bi-filetype-pdf me-1" /> Generate PDF</>}
        </button>
      </div>

      {brandsErr && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{brandsErr.message}</span>
        </div>
      )}

      {/* control bar: brand + week navigator */}
      <div className="wx-card" style={{ padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220, flex: '1 1 220px' }}>
          {selectedBrand && <BrandAvatar brand={selectedBrand} size={38} radius={9} />}
          <select className="wx-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}
            disabled={brandsLoading} style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
            {brandsLoading && <option>Loading…</option>}
            {!brandsLoading && brands.length === 0 && <option value="">No brands available</option>}
            {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Previous week"
            onClick={() => setWeekStart((w) => addWeeks(w, -1))}><i className="bi bi-chevron-left" /></button>
          <div style={{ minWidth: 172, textAlign: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--text-primary)' }}>Week of {weekLabel}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
              {isThisWeekReview ? 'Last week' : (
                <button className="wx-btn-link" onClick={() => setWeekStart(defaultReviewWeekStart())}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5 }}>Jump to last week</button>
              )}
              {weeksSet.has(weekStart) ? null : <span style={{ opacity: .6 }}>· no checkpoint</span>}
            </div>
          </div>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Next week"
            onClick={() => setWeekStart((w) => addWeeks(w, 1))}><i className="bi bi-chevron-right" /></button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Currency</span>
          <select className="wx-input" value={data?.currency || '$'} disabled={!data} style={{ width: 78 }}
            onChange={(e) => setData((d) => ({ ...d, currency: e.target.value }))}>
            <option value="$">$</option><option value="£">£</option><option value="€">€</option>
          </select>
        </label>
        <div style={{ marginLeft: 'auto', fontSize: 11.5, color: saveState === 'local' ? 'var(--warning)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, minHeight: 18 }}>
          {saveText && <><i className={`bi ${saveState === 'saving' ? 'bi-arrow-repeat' : saveState === 'local' ? 'bi-cloud-slash' : 'bi-cloud-check'}`} /> {saveText}</>}
        </div>
      </div>

      {/* body */}
      {!brandId ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Pick a brand to begin.</div>
      ) : (existing.isLoading && !data) ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
      ) : existing.isError ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          <AlertIcon width="18" height="18" /> <span style={{ marginLeft: 6 }}>Couldn't load this week (maybe a connection blip). Use the week arrows to retry.</span>
        </div>
      ) : !data ? (
        <div className="wx-card" style={{ padding: '30px 24px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text-primary)' }}>No checkpoint yet for the week of {weekLabel}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
              {hasPrev
                ? 'Start from last week to carry over your previous numbers (they become this week’s “vs last week”), sticky settings, and any open action items — then just fill in the new week.'
                : 'This is the first checkpoint for this brand — start blank and fill it in.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {hasPrev && (
              <button className="wx-btn wx-btn-primary" disabled={creating} onClick={() => createNew(true)}>
                {creating ? <><span className="wx-spinner" /> Creating…</> : <><i className="bi bi-arrow-down-up me-1" /> Create from last week</>}
              </button>
            )}
            <button className="wx-btn wx-btn-ghost" disabled={creating} onClick={() => createNew(false)}>
              <i className="bi bi-file-earmark-plus me-1" /> Start blank
            </button>
          </div>
        </div>
      ) : (
        <div className="ck-builder">
          <div className="ck-builder-form">
            <CheckpointForm data={data} setData={setData} />
          </div>
          <div className="ck-builder-preview" ref={previewColRef}>
            <div className="ck-preview-sticky">
              <div className="ck-preview-hint">Live preview · this is exactly what the PDF will look like</div>
              <div className="ckpt-preview" style={{ height: unscaledH * scale }}>
                <div style={{ width: 1280, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                  <MemoDeck data={previewData} ref={deckRef} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
