import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { getOlIncentiveBrands, setOlIncentiveBrands } from '../../../lib/incentivesApi';

// OL-only. Each OL curates which brands count toward THEIR incentive & bonus
// (the "≥70% of my brands hit GMV target" rule). Pre-seeded (Kelsey → Arslan,
// the rest → Fahad) but fully editable here. What's ticked here is what shows
// on the OL's incentive page and drives their auto-filled %.
export default function OlIncentiveBrandsSection() {
  const { user } = useAuth();
  const olId = user?.id;

  const [brands, setBrands] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    if (!olId) return;
    (async () => {
      setLoading(true); setErr('');
      try {
        const [{ data: bs, error: be }, mine] = await Promise.all([
          supabase.from('brands')
            .select('id, brand_name, client_name, owner:owner_id(display_name)')
            .eq('status', 'active').order('client_name', { ascending: true }),
          getOlIncentiveBrands(olId),
        ]);
        if (be) throw new Error(be.message);
        setBrands(bs || []);
        setSelected(new Set(mine));
      } catch (e) { setErr(e.message || String(e)); }
      finally { setLoading(false); }
    })();
  }, [olId]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Group by client, filtered by search.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = brands.filter((b) =>
      !needle || (b.brand_name || '').toLowerCase().includes(needle) || (b.client_name || '').toLowerCase().includes(needle));
    const m = new Map();
    for (const b of filtered) {
      const c = (b.client_name || '').trim() || '(no client)';
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(b);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [brands, q]);

  const toggleGroup = (list) => setSelected((s) => {
    const next = new Set(s);
    const ids = list.map((b) => b.id);
    if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    return next;
  });

  async function save() {
    setSaving(true); setErr(''); setOk('');
    try {
      await setOlIncentiveBrands(olId, [...selected]);
      setOk(`Saved — ${selected.size} brand${selected.size === 1 ? '' : 's'} now count toward your incentive.`);
      setTimeout(() => setOk(''), 3000);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <p className="text-muted" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 12 }}>
        Tick the brands that count toward <strong>your</strong> incentive &amp; bonus. Your incentive is met when
        <strong> ≥70%</strong> of these hit their GMV target (a brand counts once its Team Lead marks that brand's
        GMV-target incentive complete). This is pre-set (Kelsey → Arslan, the rest → Fahad) — adjust anytime.
      </p>

      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><span>{err}</span></div>}
      {ok && <div style={{ marginBottom: 10, color: 'var(--success)', fontSize: 13 }}><i className="bi bi-check2-circle me-1" />{ok}</div>}

      <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <div className="position-relative" style={{ minWidth: 220, flex: '1 1 260px', maxWidth: 380 }}>
          <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', pointerEvents: 'none' }} />
          <input className="wx-input" placeholder="Search brands or clients…" style={{ paddingLeft: 30 }} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: '0.72rem', fontWeight: 700, padding: '6px 10px' }}>
          {selected.size} selected
        </span>
      </div>

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2"><span className="wx-spinner" /> Loading brands…</div>
      ) : groups.length === 0 ? (
        <div className="text-muted small">No active brands match “{q}”.</div>
      ) : (
        <div className="d-flex flex-column gap-3" style={{ maxHeight: 460, overflowY: 'auto', paddingRight: 4 }}>
          {groups.map(([client, list]) => {
            const allIn = list.every((b) => selected.has(b.id));
            return (
              <div key={client}>
                <div className="d-flex align-items-center gap-2 mb-1">
                  <button type="button" className="btn btn-sm p-0 d-inline-flex align-items-center gap-1"
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase' }}
                    onClick={() => toggleGroup(list)} title={allIn ? 'Deselect all in client' : 'Select all in client'}>
                    <i className={`bi ${allIn ? 'bi-check-square-fill' : 'bi-square'}`} style={{ color: allIn ? 'var(--accent)' : 'var(--text-muted)' }} />
                    {client} <span className="text-muted" style={{ fontWeight: 500 }}>· {list.length}</span>
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                  {list.map((b) => {
                    const on = selected.has(b.id);
                    return (
                      <label key={b.id} className="d-flex align-items-center gap-2"
                        style={{ padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                          background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}` }}>
                        <input type="checkbox" className="form-check-input mt-0" checked={on} onChange={() => toggle(b.id)} />
                        <span style={{ minWidth: 0 }}>
                          <span className="fw-semibold text-truncate d-block" style={{ fontSize: '0.82rem' }}>{b.brand_name}</span>
                          <span className="text-muted" style={{ fontSize: '0.68rem' }}>TL · {b.owner?.display_name || '—'}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="settings-footer-actions" style={{ marginTop: 14 }}>
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={loading || saving}>
          {saving ? <><span className="wx-spinner" /> Saving…</> : <><i className="bi bi-save me-1" /> Save my incentive brands</>}
        </button>
      </div>
    </div>
  );
}
