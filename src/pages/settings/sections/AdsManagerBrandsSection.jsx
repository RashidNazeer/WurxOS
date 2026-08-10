import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { getAdsManagerBrands, setAdsManagerBrands } from '../../../lib/incentivesApi';

// OL / Boss. Picks which brands each Ads Manager runs paid ads for
// (ads_manager_brands, mig 316). That one list does double duty:
//   * it is ALL the ads manager can see (can_view_brand), and
//   * it is the set of brand groups the OL builds their incentive plan from.
// So an empty list means that person sees no brands at all — the UI says so
// out loud rather than letting it look like a bug.
export default function AdsManagerBrandsSection() {
  const [managers, setManagers] = useState([]);
  const [selectedManager, setSelectedManager] = useState('');
  const [brands, setBrands] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [initial, setInitial] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingSet, setLoadingSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  // Ads managers + the brand catalogue, once.
  useEffect(() => {
    (async () => {
      setLoading(true); setErr('');
      try {
        const [{ data: people, error: pe }, { data: bs, error: be }] = await Promise.all([
          supabase.from('profiles')
            .select('id, display_name, email')
            .eq('role', 'ads_manager').eq('is_active', true).is('deleted_at', null)
            .order('display_name'),
          supabase.from('brands')
            .select('id, brand_name, client_name, owner:owner_id(display_name)')
            .eq('status', 'active').order('client_name', { ascending: true }),
        ]);
        if (pe) throw new Error(pe.message);
        if (be) throw new Error(be.message);
        setManagers(people || []);
        setBrands(bs || []);
        if ((people || []).length === 1) setSelectedManager(people[0].id);
      } catch (e) { setErr(e.message || String(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  // That manager's current set.
  useEffect(() => {
    if (!selectedManager) { setSelected(new Set()); setInitial(new Set()); return; }
    (async () => {
      setLoadingSet(true); setErr(''); setOk('');
      try {
        const ids = await getAdsManagerBrands(selectedManager);
        setSelected(new Set(ids));
        setInitial(new Set(ids));
      } catch (e) { setErr(e.message || String(e)); }
      finally { setLoadingSet(false); }
    })();
  }, [selectedManager]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = brands.filter((b) =>
      !needle
      || (b.brand_name || '').toLowerCase().includes(needle)
      || (b.client_name || '').toLowerCase().includes(needle));
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

  const dirty = selected.size !== initial.size || [...selected].some((id) => !initial.has(id));
  const manager = managers.find((m) => m.id === selectedManager);

  async function save() {
    setSaving(true); setErr(''); setOk('');
    try {
      await setAdsManagerBrands(selectedManager, [...selected]);
      setInitial(new Set(selected));
      setOk(`Saved — ${manager?.display_name || 'this ads manager'} now manages ${selected.size} brand${selected.size === 1 ? '' : 's'}.`);
      setTimeout(() => setOk(''), 3500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <p className="text-muted" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 12 }}>
        Pick the brands each <strong>Ads Manager</strong> runs paid ads for. This is the only thing that
        decides what they can see — brands, brand analytics and GMV Max are all limited to this list —
        and it's the same list you'll build their per-brand incentive plan from on the Incentives page.
      </p>

      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><span>{err}</span></div>}
      {ok && <div style={{ marginBottom: 10, color: 'var(--success)', fontSize: 13 }}><i className="bi bi-check2-circle me-1" />{ok}</div>}

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2"><span className="wx-spinner" /> Loading…</div>
      ) : managers.length === 0 ? (
        <div className="text-muted small">
          No active Ads Managers yet. The Boss adds one under <strong>Employees → Ads Managers</strong>.
        </div>
      ) : (
        <>
          <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
            <select className="wx-input" style={{ maxWidth: 260 }}
              value={selectedManager} onChange={(e) => setSelectedManager(e.target.value)}>
              <option value="">— Choose an ads manager —</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.display_name || m.email}</option>
              ))}
            </select>
            {selectedManager && (
              <>
                <div className="position-relative" style={{ minWidth: 200, flex: '1 1 240px', maxWidth: 360 }}>
                  <i className="bi bi-search position-absolute text-muted"
                    style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', pointerEvents: 'none' }} />
                  <input className="wx-input" placeholder="Search brands or clients…" style={{ paddingLeft: 30 }}
                    value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: '0.72rem', fontWeight: 700, padding: '6px 10px' }}>
                  {selected.size} selected
                </span>
              </>
            )}
          </div>

          {!selectedManager ? (
            <div className="text-muted small">Choose an ads manager to set their brands.</div>
          ) : loadingSet ? (
            <div className="text-muted small d-flex align-items-center gap-2"><span className="wx-spinner" /> Loading their brands…</div>
          ) : (
            <>
              {selected.size === 0 && (
                <div className="wx-alert wx-alert-info" style={{ marginBottom: 10 }}>
                  <span>
                    {manager?.display_name || 'This ads manager'} currently has <strong>no brands</strong>, so they
                    can't see any brand in the app. Tick the brands they run ads for and save.
                  </span>
                </div>
              )}
              {groups.length === 0 ? (
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
                <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving || !dirty}>
                  {saving ? <><span className="wx-spinner" /> Saving…</> : <><i className="bi bi-save me-1" /> Save brands</>}
                </button>
                {dirty && !saving && (
                  <span className="text-muted ms-2" style={{ fontSize: 12 }}>Unsaved changes</span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
