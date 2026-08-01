// ============================================================
// Paid Collab — Weekly Checkpoint (pctl / ipc).
//
// A stripped-down checkpoint view for the paid collab team: a week picker + a
// §09-only editor for each brand on the SHARED team list (paid_collab_brands).
// They fill just the Paid Collab section per (brand, week); nothing else from the
// APC checkpoint is shown. Data → paid_collab_entries (mig 279), which the APC's
// checkpoint reads read-only.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { defaultReviewWeekStart, addWeeks, weekLabelForStart } from '../../lib/checkpointModel';
import {
  listManagedBrands, getPaidCollabEntriesForWeek, savePaidCollabEntry,
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

export default function PaidCollabCheckpointDashboard() {
  const [weekStart, setWeekStart] = useState(defaultReviewWeekStart);
  const [brands, setBrands] = useState([]);
  const [entries, setEntries] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const weekLabel = useMemo(() => weekLabelForStart(weekStart), [weekStart]);

  const loadBrands = useCallback(async () => {
    setLoading(true); setError('');
    try { setBrands(await listManagedBrands()); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadBrands(); }, [loadBrands]);

  useEffect(() => {
    let alive = true;
    const ids = brands.map((b) => b.id);
    if (!ids.length) { setEntries({}); return undefined; }
    getPaidCollabEntriesForWeek(ids, weekStart).then((m) => { if (alive) setEntries(m); }).catch(() => {});
    return () => { alive = false; };
  }, [brands, weekStart]);

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
              {weekStart === defaultReviewWeekStart() ? 'Last week' : (
                <button className="wx-btn-link" onClick={() => setWeekStart(defaultReviewWeekStart())} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 10.5 }}>Jump to last week</button>
              )}
            </div>
          </div>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '8px 11px' }} title="Next week" onClick={() => setWeekStart((w) => addWeeks(w, 1))}><i className="bi bi-chevron-right" /></button>
        </div>
        <Link to="/settings?section=pcCheckpointBrands" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 'auto' }}><i className="bi bi-gear me-1" /> Manage brands</Link>
      </div>

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
            <BrandPaidCollabCard key={b.id} brand={b} weekStart={weekStart} entry={entries[b.id]}
              onSaved={(row) => setEntries((m) => ({ ...m, [b.id]: row }))} />
          ))}
        </div>
      )}
    </>
  );
}

function BrandPaidCollabCard({ brand, weekStart, entry, onSaved }) {
  const [form, setForm] = useState(() => ({ ...emptyPaidCollab(), ...(entry?.data || {}) }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setForm({ ...emptyPaidCollab(), ...(entry?.data || {}) }); setSaved(false); }, [entry, weekStart]);

  const filled = isPaidCollabFilled(entry?.data);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  async function save() {
    setSaving(true); setErr('');
    try {
      const row = await savePaidCollabEntry({ brandId: brand.id, weekStart, data: form });
      onSaved?.(row); setSaved(true);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{brand.brand_name}</strong>
        {brand.client_name && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {brand.client_name}</span>}
        <span style={{
          marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
          background: filled ? 'var(--success-soft)' : 'var(--surface-2)', color: filled ? 'var(--success)' : 'var(--text-muted)',
        }}>
          {filled ? '✓ Filled' : 'Not filled'}{entry?.updated_at ? ` · ${new Date(entry.updated_at).toLocaleDateString()}` : ''}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {NUM_FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="wx-label" style={{ fontSize: 12 }}>{f.label}{f.money ? ' ($)' : ''}</span>
            <input type="text" inputMode="decimal" className="wx-input"
              value={form[f.key] ?? ''} placeholder={f.money ? '$ —' : '—'}
              onChange={(e) => set(f.key, e.target.value.replace(/[^0-9.\-]/g, ''))} />
          </label>
        ))}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
        <span className="wx-label" style={{ fontSize: 12 }}>Notes</span>
        <textarea className="wx-input" rows={2} value={form.notes ?? ''}
          onChange={(e) => set('notes', e.target.value)} style={{ resize: 'vertical' }} />
      </label>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 10 }}><span>{err}</span></div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, alignItems: 'center' }}>
        {saved && <span style={{ fontSize: 12, color: 'var(--success)' }}><i className="bi bi-cloud-check me-1" />Saved</span>}
        <button className="wx-btn wx-btn-primary wx-btn-sm" disabled={saving} onClick={save}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : <><i className="bi bi-check2 me-1" /> Save</>}
        </button>
      </div>
    </div>
  );
}
