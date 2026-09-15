// ============================================================
// Paid Collab — Weekly Checkpoint (pctl / ipc).
//
// A stripped-down checkpoint view for the paid collab team: a week picker + a
// §09-only editor for each brand on the SHARED team list (paid_collab_brands).
// They fill just the Paid Collab section per (brand, week); nothing else from the
// APC checkpoint is shown. Data → paid_collab_entries (mig 279), which the APC's
// checkpoint reads read-only.
//
// ── FILLING THE RIGHT WEEK (15 Sept 2026) ─────────────────────────────────
// An IPC entered 7–13 Sept's numbers under 14–20 Sept, and 7–13 already held a
// teammate's entries that nothing on screen attributed to anyone. So:
// - the numbers shown always belong to the week on screen. They used to stay
//   from the previous week until the new week loaded (for good, if loading
//   failed) and Save wrote them into the new week; Save now waits for the load;
// - a week that has not finished yet is flagged, and saving to it asks first;
// - every Save button names its week;
// - each entry says who saved it and when.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { defaultReviewWeekStart, addWeeks, weekLabelForStart } from '../../lib/checkpointModel';
import {
  listManagedBrands, getPaidCollabEntriesForWeek, savePaidCollabEntry, getSaverNames,
  emptyPaidCollab, isPaidCollabFilled,
} from '../../lib/paidCollabCheckpointApi';

const NUM_FIELDS = [
  { key: 'creatorsOnboarded', label: 'Creators onboarded' },
  { key: 'creatorsInPipeline', label: 'Creators in pipeline' },
  { key: 'videosCompleted', label: 'Videos completed' },
  { key: 'totalVideos', label: 'Videos planned (total)' },
  { key: 'totalBudget', label: 'Total budget', money: true },
  { key: 'budgetAllocated', label: 'Budget allocated', money: true },
];

const savedAtLabel = (value) => new Date(value).toLocaleString('en-GB', {
  timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

const linkButton = {
  background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', fontWeight: 700,
};

export default function PaidCollabCheckpointDashboard() {
  const [weekStart, setWeekStart] = useState(defaultReviewWeekStart);
  const [brands, setBrands] = useState([]);
  // Entries and the week they were loaded for: a card shows, and may save, only
  // numbers loaded for the week on screen.
  const [loadedWeek, setLoadedWeek] = useState(null);
  const [entries, setEntries] = useState({});
  const [names, setNames] = useState({});
  const [weekError, setWeekError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const weekLabel = useMemo(() => weekLabelForStart(weekStart), [weekStart]);
  const lastWeek = defaultReviewWeekStart();
  // This week or a later one: it has not ended, so it is rarely the week to fill.
  const unfinished = weekStart > lastWeek;
  const ready = loadedWeek === weekStart;

  const loadBrands = useCallback(async () => {
    setLoading(true); setError('');
    try { setBrands(await listManagedBrands()); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadBrands(); }, [loadBrands]);

  useEffect(() => {
    let alive = true;
    setLoadedWeek(null); setEntries({}); setWeekError('');
    const ids = brands.map((b) => b.id);
    if (!ids.length) { setLoadedWeek(weekStart); return undefined; }
    getPaidCollabEntriesForWeek(ids, weekStart)
      .then((m) => {
        if (!alive) return;
        setEntries(m); setLoadedWeek(weekStart);
        getSaverNames(Object.values(m).map((e) => e.updated_by))
          .then((who) => { if (alive) setNames((n) => ({ ...n, ...who })); });
      })
      .catch((e) => { if (alive) setWeekError(e.message || String(e)); });
    return () => { alive = false; };
  }, [brands, weekStart, reloadKey]);

  function onSaved(brandId, row) {
    if (row.week_start !== weekStart) return;   // the page moved to another week meanwhile
    setEntries((m) => ({ ...m, [brandId]: row }));
    getSaverNames([row.updated_by]).then((who) => setNames((n) => ({ ...n, ...who })));
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Paid Collab — Weekly Checkpoint</h1>
        <p className="page-subtitle">Fill the Paid Collab section for each brand your team handles, one week at a time.</p>
      </div>

      <div className="wx-card" style={{ padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Previous week" onClick={() => setWeekStart((w) => addWeeks(w, -1))}><i className="bi bi-chevron-left" /></button>
          <div style={{ minWidth: 200, textAlign: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--text-primary)' }}>Week of {weekLabel}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              {weekStart === lastWeek ? 'Last week' : (
                <button className="wx-btn-link" onClick={() => setWeekStart(lastWeek)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5 }}>Jump to last week</button>
              )}
            </div>
          </div>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Next week" onClick={() => setWeekStart((w) => addWeeks(w, 1))}><i className="bi bi-chevron-right" /></button>
        </div>
        <Link to="/settings?section=pcCheckpointBrands" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 'auto' }}><i className="bi bi-gear me-1" /> Manage brands</Link>
      </div>

      {unfinished && (
        <div className="wx-alert" role="status" style={{ marginBottom: 14, background: 'var(--warning-soft)', border: '1px solid var(--warning)', color: 'var(--text-primary)' }}>
          <span>
            <strong>The week of {weekLabel} hasn&apos;t finished yet.</strong>{' '}
            Tuesday&apos;s checkpoint uses last week, {weekLabelForStart(lastWeek)}.{' '}
            <button type="button" style={linkButton} onClick={() => setWeekStart(lastWeek)}>Go to last week</button>
          </span>
        </div>
      )}

      {weekError && (
        <div className="wx-alert wx-alert-danger" role="alert" style={{ marginBottom: 14 }}>
          <span>
            Couldn&apos;t load the week of {weekLabel} ({weekError}). Nothing can be saved for this week until it loads.{' '}
            <button type="button" style={linkButton} onClick={() => setReloadKey((n) => n + 1)}>Try again</button>
          </span>
        </div>
      )}

      {error && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}><span>{error}</span></div>}

      {loading ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading brands…</div>
      ) : brands.length === 0 ? (
        <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
          No brands on your Paid Collab list yet. Add them in{' '}
          <Link to="/settings?section=pcCheckpointBrands" style={{ color: 'var(--accent)' }}>Settings → Paid Collab Brands</Link>.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {brands.map((b) => (
            <BrandPaidCollabCard
              key={b.id}
              brand={b}
              weekStart={weekStart}
              weekLabel={weekLabel}
              ready={ready}
              unfinished={unfinished}
              entry={ready ? entries[b.id] : undefined}
              savedBy={ready ? names[entries[b.id]?.updated_by] : undefined}
              onSaved={(row) => onSaved(b.id, row)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function BrandPaidCollabCard({ brand, weekStart, weekLabel, ready, unfinished, entry, savedBy, onSaved }) {
  const [form, setForm] = useState(() => ({ ...emptyPaidCollab(), ...(entry?.data || {}) }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(false);

  // The form always shows the entry loaded for the week on screen (empty while it loads).
  useEffect(() => { setForm({ ...emptyPaidCollab(), ...(entry?.data || {}) }); }, [entry, weekStart, ready]);
  useEffect(() => { setSaved(false); setErr(''); setConfirming(false); }, [weekStart]);

  const filled = isPaidCollabFilled(entry?.data);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  async function save() {
    setConfirming(false);
    setSaving(true); setErr('');
    try {
      const row = await savePaidCollabEntry({ brandId: brand.id, weekStart, data: form });
      onSaved?.(row); setSaved(true);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  let status = 'Not filled';
  if (!ready) status = 'Loading…';
  else if (filled) status = `✓ Filled${savedBy ? ` by ${savedBy}` : ''}${entry?.updated_at ? ` · ${savedAtLabel(entry.updated_at)}` : ''}`;

  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{brand.brand_name}</strong>
        {brand.client_name && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {brand.client_name}</span>}
        <span style={{
          marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
          background: ready && filled ? 'var(--success-soft)' : 'var(--surface-2)', color: ready && filled ? 'var(--success)' : 'var(--text-muted)',
        }}>
          {status}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {NUM_FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="wx-label" style={{ fontSize: 12 }}>{f.label}{f.money ? ' ($)' : ''}</span>
            <input type="text" inputMode="decimal" className="wx-input" disabled={!ready}
              value={form[f.key] ?? ''} placeholder={f.money ? '$ —' : '—'}
              onChange={(e) => set(f.key, e.target.value.replace(/[^0-9.\-]/g, ''))} />
          </label>
        ))}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
        <span className="wx-label" style={{ fontSize: 12 }}>Notes</span>
        <textarea className="wx-input" rows={2} value={form.notes ?? ''} disabled={!ready}
          onChange={(e) => set('notes', e.target.value)} style={{ resize: 'vertical' }} />
      </label>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 10 }}><span>{err}</span></div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, alignItems: 'center' }}>
        {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}><i className="bi bi-cloud-check me-1" />Saved</span>}
        <button className="wx-btn wx-btn-primary wx-btn-sm" disabled={saving || !ready}
          onClick={() => (unfinished ? setConfirming(true) : save())}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : <><i className="bi bi-check2 me-1" /> Save · {weekLabel}</>}
        </button>
      </div>

      {confirming && (
        <div className="ck-overlay" onClick={() => setConfirming(false)}>
          <div className="ck-modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ck-modal-title">
              <i className="bi bi-exclamation-triangle" style={{ color: 'var(--warning)' }} />
              Save {brand.brand_name} for {weekLabel}?
            </div>
            <p className="ck-modal-sub">
              That week hasn&apos;t finished yet. Tuesday&apos;s checkpoint normally uses last week&apos;s numbers.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="wx-btn wx-btn-primary" onClick={save}>Save for {weekLabel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
