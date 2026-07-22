// ============================================================
// Weekly Performance Checkpoint builder (APC).
//
// Manual entry (v1): the APC fills the form, sees a live deck preview, and
// clicks "Generate PDF" to download a polished 12-slide landscape deck. Drafts
// autosave to localStorage per brand + week. No auto-fetch yet.
// ============================================================
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { listBrands } from '../../lib/brandsApi';
import { EMPTY_CHECKPOINT, currentWeekLabel } from '../../lib/checkpointModel';
import { loadDraft, saveDraft } from '../../lib/checkpointDraft';
import { exportCheckpointToPdf, SLIDE_H } from '../../utils/exportCheckpointPdf';
import CheckpointForm from '../../components/checkpoint/CheckpointForm';
import CheckpointDeck from '../../components/checkpoint/CheckpointDeck';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { AlertIcon } from '../../components/common/Icon';
import '../../styles/checkpoint.css';

const SLIDE_COUNT = 12;
const PREVIEW_GAP = 28;

// Memoized so the heavy 12-slide deck only re-renders when the (debounced)
// preview data actually changes — keeps typing in the form smooth.
const MemoDeck = memo(CheckpointDeck);
const raf = () => new Promise((r) => requestAnimationFrame(r));

export default function AgendaCheckpointPage() {
  const { profile } = useAuth();
  const [brandId, setBrandId] = useState('');
  const [week, setWeek] = useState(currentWeekLabel);
  const [data, setData] = useState(EMPTY_CHECKPOINT);
  const [previewData, setPreviewData] = useState(data);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Debounce the deck preview: form stays instant, the heavy deck re-renders a
  // beat after you stop typing.
  useEffect(() => {
    const id = setTimeout(() => setPreviewData(data), 180);
    return () => clearTimeout(id);
  }, [data]);

  const deckRef = useRef(null);
  const previewColRef = useRef(null);
  const loadedKey = useRef('');

  const { data: brands = [], isLoading: brandsLoading, error: brandsErr } = useQuery({
    queryKey: ['checkpoint', 'brands'],
    queryFn: () => listBrands({ status: 'active' }),
  });
  const selectedBrand = brands.find((b) => b.id === brandId) || null;

  // auto-select first brand once loaded
  useEffect(() => { if (!brandId && brands.length) setBrandId(brands[0].id); }, [brands, brandId]);

  // (Re)load draft / init template whenever the brand+week key changes.
  useEffect(() => {
    if (!brandId) return;
    const key = `${brandId}::${week}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    const brandName = brands.find((b) => b.id === brandId)?.brand_name || '';
    const draft = loadDraft(brandId, week);
    if (draft) {
      draft.cover = { ...draft.cover, brandName, weekLabel: week };
      setData(draft);
    } else {
      const fresh = EMPTY_CHECKPOINT();
      fresh.cover = { brandName, apcName: profile?.display_name || '', team: '', weekLabel: week };
      setData(fresh);
    }
  }, [brandId, week, brands, profile]);

  // keep cover brand/week in sync if brands finish loading after init
  useEffect(() => {
    if (!selectedBrand) return;
    setData((d) => (d.cover.brandName === selectedBrand.brand_name && d.cover.weekLabel === week)
      ? d : { ...d, cover: { ...d.cover, brandName: selectedBrand.brand_name, weekLabel: week } });
  }, [selectedBrand, week]);

  // autosave draft
  useEffect(() => {
    if (!brandId) return;
    const id = setTimeout(() => { if (saveDraft(brandId, week, data)) setSavedAt(Date.now()); }, 400);
    return () => clearTimeout(id);
  }, [data, brandId, week]);

  // responsive preview scale
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = previewColRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) setScale(Math.min(1, w / 1280));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const unscaledH = SLIDE_COUNT * SLIDE_H + (SLIDE_COUNT - 1) * PREVIEW_GAP;

  async function onGenerate() {
    setBusy(true);
    setProgress({ i: 0, total: SLIDE_COUNT });
    setPreviewData(data);            // flush any pending debounce so we capture latest
    await raf(); await raf();        // let React commit + browser lay out
    try {
      await exportCheckpointToPdf(deckRef.current, {
        title: `${data.cover.brandName || 'Brand'} — Weekly Checkpoint ${week}`,
        onProgress: (i, total) => setProgress({ i, total }),
      });
    } catch (e) {
      // surface as alert rather than silent failure
      // eslint-disable-next-line no-alert
      alert(`Couldn't generate the PDF: ${e?.message || e}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const savedLabel = useMemo(() => savedAt ? `Draft saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Draft autosaves locally', [savedAt]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Weekly Checkpoint</h1>
          <p className="page-subtitle">Fill in last week's numbers and story, then generate a polished PDF for Tuesday's meeting.</p>
        </div>
        <button className="wx-btn wx-btn-primary" disabled={!brandId || busy} onClick={onGenerate}>
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

      {/* control bar */}
      <div className="wx-card" style={{ padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 240, flex: '1 1 240px' }}>
          {selectedBrand && <BrandAvatar brand={selectedBrand} size={38} radius={9} />}
          <select className="wx-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}
            disabled={brandsLoading} style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
            {brandsLoading && <option>Loading…</option>}
            {!brandsLoading && brands.length === 0 && <option value="">No brands available</option>}
            {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Week</span>
          <input className="wx-input" value={week} onChange={(e) => setWeek(e.target.value)} style={{ minWidth: 200 }} placeholder="Jul 5–11, 2026" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Currency</span>
          <select className="wx-input" value={data.currency} onChange={(e) => setData((d) => ({ ...d, currency: e.target.value }))} style={{ width: 80 }}>
            <option value="$">$</option><option value="£">£</option><option value="€">€</option>
          </select>
        </label>
        <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="bi bi-cloud-check" /> {savedLabel}
        </div>
      </div>

      {/* builder: form + live preview */}
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
    </>
  );
}
