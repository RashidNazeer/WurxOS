import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listBrands } from '../../lib/brandsApi';
import {
  SHARE_TYPE_OPTIONS, SHARE_TYPE_COLORS,
  listClientAccessLinks, createClientAccessLink, updateClientAccessLink,
  deleteClientAccessLink, buildClientAccessUrl,
} from '../../lib/clientAccessApi';
import {
  PlusIcon, PencilIcon, TrashIcon, CopyIcon, SearchIcon, XIcon, CheckIcon, AlertIcon, LinkIcon,
} from '../../components/common/Icon';

export default function ClientAccessPage() {
  const qc = useQueryClient();
  const { data: brands = [] } = useQuery({
    queryKey: ['brands', { status: 'active' }],
    queryFn: () => listBrands({ status: 'active' }),
  });
  const { data: links = [], isLoading } = useQuery({
    queryKey: ['client-access'],
    queryFn: listClientAccessLinks,
  });

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterClient, setFilterClient] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editLink, setEditLink] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  // Distinct UMBRELLA client values across all current links. The
  // `client` column is auto-filled by mig 160's trigger from the
  // linked brand's client_name — so multiple Kelsey links all share
  // client='Kelsey' even when their display labels are
  // 'Kelsey - Bentgo', 'Kelsey - FlyWell', etc.
  // Trim + case-fold the dedupe to merge any casing/whitespace drift.
  const clientNames = useMemo(() => {
    const counts = new Map();
    for (const l of links) {
      const raw = (l.client || '').trim();
      if (!raw) continue;
      const norm = raw.toLowerCase();
      const cur = counts.get(norm);
      if (cur) {
        cur.n += 1;
      } else {
        counts.set(norm, { display: raw, n: 1 });
      }
    }
    return [...counts.values()]
      .map((v) => v.display)
      .sort((a, b) => a.localeCompare(b));
  }, [links]);

  const filtered = useMemo(() => {
    return links.filter(c => {
      if (search) {
        const q = search.toLowerCase();
        const nameMatch = (c.client_name || c.label || '').toLowerCase().includes(q);
        const brandMatch = (c.brand_ids || []).some(bid => {
          const br = brands.find(b => b.id === bid);
          return br && br.brand_name.toLowerCase().includes(q);
        });
        if (!nameMatch && !brandMatch) return false;
      }
      if (filterStatus === 'active'   && !c.active) return false;
      if (filterStatus === 'disabled' &&  c.active) return false;
      if (filterClient) {
        if ((c.client || '').trim().toLowerCase() !== filterClient.toLowerCase()) return false;
      }
      return true;
    });
  }, [links, search, filterStatus, filterClient, brands]);

  function openCreate() { setEditLink(null);  setShowModal(true); }
  function openEdit(c)  { setEditLink(c);     setShowModal(true); }

  async function handleCopy(c) {
    const url = buildClientAccessUrl(c.token, { legacyV1: !!c.legacy_v1 });
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch { /* ignore */ }
  }

  async function handleToggleActive(c) {
    await updateClientAccessLink(c.id, { active: !c.active });
    qc.invalidateQueries({ queryKey: ['client-access'] });
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await deleteClientAccessLink(deleteTarget.id);
    setDeleteTarget(null);
    qc.invalidateQueries({ queryKey: ['client-access'] });
  }

  return (
    <div style={{ padding: '20px 24px 40px' }}>
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h4 style={{ fontWeight: 800, margin: '0 0 4px', color: 'var(--text-primary)', letterSpacing: '-0.02em', fontSize: 20 }}>Client Access</h4>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
            Share dashboards with clients — pick brands, then choose what they can see.
          </p>
        </div>
        <button className="wx-btn wx-btn-primary" onClick={openCreate}>
          <PlusIcon width="14" height="14" /> New Client Link
        </button>
      </div>

      {links.length > 0 && (
        <div className="wx-card" style={{ padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--surface-2)', borderRadius: 8, flex: '1 1 220px' }}>
              <SearchIcon width="13" height="13" />
              <input style={{ flex: 1, border: 0, background: 'transparent', outline: 'none', fontSize: 13, padding: '4px 0' }}
                placeholder="Search by client or brand…"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="wx-input" style={{ width: 'auto', minWidth: 130, fontSize: 12.5, padding: '6px 8px' }}
              value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
            {clientNames.length > 0 && (
              <select className="wx-input" style={{ width: 'auto', minWidth: 150, fontSize: 12.5, padding: '6px 8px' }}
                value={filterClient}
                onChange={(e) => setFilterClient(e.target.value)}
                title="Filter links by client">
                <option value="">All Clients</option>
                {clientNames.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}
            {(search || filterStatus || filterClient) && (
              <button className="wx-btn wx-btn-ghost" style={{ fontSize: 12 }}
                onClick={() => { setSearch(''); setFilterStatus(''); setFilterClient(''); }}>
                <XIcon width="12" height="12" /> Clear
              </button>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : links.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 36, border: '2px dashed var(--border)', borderRadius: 14, background: 'var(--surface-1)' }}>
          <div style={{ fontSize: 30, opacity: 0.5 }}>🔗</div>
          <div style={{ fontWeight: 800, marginTop: 10 }}>No client links yet</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '4px 0 14px' }}>
            Create a link to share your dashboard with clients.
          </p>
          <button className="wx-btn wx-btn-primary" onClick={openCreate}>Create first link</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {filtered.map(c => (
            <LinkCard key={c.id} link={c} brands={brands}
              copied={copiedId === c.id}
              onCopy={() => handleCopy(c)}
              onEdit={() => openEdit(c)}
              onToggle={() => handleToggleActive(c)}
              onDelete={() => setDeleteTarget(c)} />
          ))}
        </div>
      )}

      {showModal && (
        <ClientAccessModal
          link={editLink} brands={brands}
          existingClientNames={clientNames}
          onClose={() => { setShowModal(false); setEditLink(null); }}
          onSaved={() => {
            setShowModal(false); setEditLink(null);
            qc.invalidateQueries({ queryKey: ['client-access'] });
          }} />
      )}

      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)' }} onClick={() => setDeleteTarget(null)} />
          <div className="wx-card" style={{ position: 'relative', maxWidth: 420, padding: 22, textAlign: 'center' }}>
            <div style={{ fontSize: 30, color: '#dc2626' }}>⚠️</div>
            <h6 style={{ fontWeight: 800, marginTop: 8, marginBottom: 6 }}>Delete this client link?</h6>
            <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '0 0 14px' }}>
              <strong>{deleteTarget.client_name || deleteTarget.label || 'Untitled'}</strong> will be permanently removed and the link will stop working immediately.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="wx-btn wx-btn-ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="wx-btn wx-btn-primary" style={{ background: '#dc2626' }} onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────
function LinkCard({ link, brands, copied, onCopy, onEdit, onToggle, onDelete }) {
  const url = buildClientAccessUrl(link.token, { legacyV1: !!link.legacy_v1 });
  const brandNames = (link.brand_ids || []).map(bid => {
    const br = brands.find(b => b.id === bid);
    return br ? br.brand_name : null;
  }).filter(Boolean);
  const shareTypes = link.share_types || [];
  const isActive = link.active !== false && !link.revoked_at;

  return (
    <div className="wx-card" style={{
      borderRadius: 14, padding: 0, overflow: 'hidden',
      opacity: isActive ? 1 : 0.65,
    }}>
      <div style={{ height: 4, background: isActive ? 'linear-gradient(135deg,#22c55e,#16a34a)' : '#94a3b8' }} />
      <div style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>{link.client_name || link.label || 'Unnamed Client'}</div>
            <span style={{
              display: 'inline-block', marginTop: 4, padding: '2px 8px', borderRadius: 999,
              fontSize: 10, fontWeight: 700,
              background: isActive ? 'color-mix(in srgb, var(--success) 18%, transparent)' : 'var(--surface-3, #e2e8f0)',
              color: isActive ? 'var(--success)' : 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>{isActive ? 'Active' : 'Disabled'}</span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={onEdit} title="Edit">
              <PencilIcon width="12" height="12" />
            </button>
            <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={onToggle} title={isActive ? 'Disable' : 'Enable'}>
              {isActive ? '⏸' : '▶'}
            </button>
            <button className="wx-btn wx-btn-ghost" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--danger)' }} onClick={onDelete} title="Delete">
              <TrashIcon width="12" height="12" />
            </button>
          </div>
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: 4 }}>Shares</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
          {shareTypes.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>None</span>
          ) : shareTypes.map(t => {
            const meta = SHARE_TYPE_OPTIONS.find(o => o.id === t);
            const col = SHARE_TYPE_COLORS[t] || { bg: '#f1f5f9', fg: '#475569' };
            return (
              <span key={t} style={{
                background: col.bg, color: col.fg, fontSize: 10.5, fontWeight: 700,
                padding: '3px 9px', borderRadius: 999,
              }}>{meta?.label || t}</span>
            );
          })}
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: 4 }}>
          Brands ({brandNames.length})
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
          {brandNames.length === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No brands assigned</span>
          ) : (
            <>
              {brandNames.slice(0, 6).map((n, i) => (
                <span key={i} style={{
                  background: 'var(--surface-2)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 999,
                  padding: '2px 8px', fontSize: 11, fontWeight: 600,
                }}>{n}</span>
              ))}
              {brandNames.length > 6 && (
                <span style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>
                  +{brandNames.length - 6} more
                </span>
              )}
            </>
          )}
        </div>

        {link.legacy_v1 && (
          <div style={{
            fontSize: 10.5, fontWeight: 700, color: '#92400e',
            background: '#fef3c7', border: '1px solid #fde68a',
            borderRadius: 999, padding: '2px 8px',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            marginBottom: 6, alignSelf: 'flex-start',
          }} title="This link was originally shared with the client from v1. The v1 URL still works — it redirects to the v2 portal automatically.">
            <i className="bi bi-clock-history" style={{ fontSize: 9 }} /> Legacy v1 link
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: 8, borderRadius: 8,
          background: '#f0f4ff', border: '1px solid #c5d5ff',
        }}>
          <LinkIcon width="13" height="13" style={{ color: '#3b82f6', flexShrink: 0 }} />
          <input readOnly value={url} onClick={e => e.target.select()}
            style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', fontSize: 11.5, color: '#1e40af', outline: 'none' }} />
          <button className="wx-btn wx-btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onCopy}>
            {copied ? <><CheckIcon width="11" height="11" /> Copied</> : <><CopyIcon width="11" height="11" /> Copy</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create / edit modal ─────────────────────────────────────────────
function ClientAccessModal({ link, brands, existingClientNames = [], onClose, onSaved }) {
  const [clientName, setClientName] = useState(link?.client_name || '');
  const [label, setLabel] = useState(link?.label || '');
  const [shareTypes, setShareTypes] = useState(link?.share_types || ['weekly']);
  const [brandIds, setBrandIds] = useState(link?.brand_ids || []);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const filteredBrands = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...brands]
      .sort((a, b) => (a.brand_name || '').localeCompare(b.brand_name || ''))
      .filter(b => !q || (b.brand_name || '').toLowerCase().includes(q));
  }, [brands, search]);

  function toggleShareType(id) {
    setShareTypes(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function toggleBrand(id) {
    setBrandIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleSave() {
    if (!clientName.trim() && !label.trim()) {
      setError('Add a client name or label so this link is identifiable.');
      return;
    }
    if (brandIds.length === 0)   { setError('Select at least one brand.');      return; }
    if (shareTypes.length === 0) { setError('Select at least one share type.'); return; }
    setSaving(true); setError('');
    try {
      if (link) {
        await updateClientAccessLink(link.id, { clientName, label, shareTypes, brandIds });
      } else {
        await createClientAccessLink({ clientName, label, shareTypes, brandIds });
      }
      onSaved();
    } catch (e) {
      setError(e?.message || 'Failed to save.');
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)' }} onClick={onClose} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 720, maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, borderRadius: 18 }}>
        <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--border)' }}>
          <h6 style={{ fontWeight: 800, margin: '0 0 4px', fontSize: 15 }}>
            {link ? 'Edit Client Link' : 'New Client Link'}
          </h6>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: 0 }}>
            Pick the brands the client can see, then check what data surfaces to expose.
          </p>
        </div>
        <div style={{ padding: 22, flexGrow: 1, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>
                Link name <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  (display label, e.g. "Kelsey - Bentgo")
                </span>
              </label>
              {/* Free-text display label for THIS specific link. The
                  umbrella client (used for filtering) is auto-derived
                  from the linked brand(s)' client_name field — see
                  mig 160's trigger. No separate client picker needed. */}
              <input className="wx-input" placeholder="e.g. Kelsey - Bentgo"
                value={clientName} onChange={e => setClientName(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'block' }}>
                Internal label <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <input className="wx-input" placeholder="e.g. Q3-2026 dashboard"
                value={label} onChange={e => setLabel(e.target.value)} />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' }}>
              Share types <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(check all that apply)</span>
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {SHARE_TYPE_OPTIONS.map(o => {
                const checked = shareTypes.includes(o.id);
                const col = SHARE_TYPE_COLORS[o.id] || { bg: '#f1f5f9', fg: '#475569' };
                return (
                  <label key={o.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    padding: '8px 10px', borderRadius: 10,
                    background: checked ? col.bg : 'var(--surface-2)',
                    border: `1.5px solid ${checked ? col.fg : 'var(--border)'}`,
                    color: checked ? col.fg : 'var(--text-primary)',
                    fontSize: 13, fontWeight: 600,
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleShareType(o.id)}
                      style={{ accentColor: col.fg }} />
                    <span>{o.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, margin: 0 }}>
                Brands <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({brandIds.length} selected)</span>
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="wx-btn wx-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => setBrandIds(brands.map(b => b.id))}>Select all</button>
                <button type="button" className="wx-btn wx-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => setBrandIds([])}>Clear</button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--surface-2)', borderRadius: 8, marginBottom: 8 }}>
              <SearchIcon width="13" height="13" />
              <input style={{ flex: 1, border: 0, background: 'transparent', outline: 'none', fontSize: 13, padding: '4px 0' }}
                placeholder="Search brand…"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-1)' }}>
              {filteredBrands.length === 0 ? (
                <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No brands match.</div>
              ) : filteredBrands.map(b => {
                const sel = brandIds.includes(b.id);
                return (
                  <label key={b.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    padding: '7px 12px', borderBottom: '1px solid var(--border)',
                    background: sel ? 'var(--accent-soft, #f0f9ff)' : 'transparent',
                  }}>
                    <input type="checkbox" checked={sel} onChange={() => toggleBrand(b.id)} />
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{b.brand_name}</span>
                    {b.tier && <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Tier {b.tier}</span>}
                  </label>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="wx-alert wx-alert-danger" style={{ marginTop: 14 }}>
              <AlertIcon width="14" height="14" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> {link ? 'Save changes' : 'Create link'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
