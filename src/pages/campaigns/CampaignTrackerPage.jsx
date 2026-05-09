import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listCampaigns, listBrandsForPicker, createCampaign, createCampaignsBulk,
  updateCampaign, deleteCampaign, effectiveStatus, STATUS_META, parseBulkPaste,
} from '../../lib/campaignTrackerApi';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, SearchIcon,
  MegaphoneIcon, ClockIcon, TrashIcon, PencilIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/modal.css';

const STATUS_TABS = ['all', 'Ongoing', 'Upcoming', 'Ended', 'Deactivated'];

export default function CampaignTrackerPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const canWrite = ['boss','ol','developer','tl','pctl','apc','ipc'].includes(role);

  const [q, setQ]                   = useState('');
  const [statusTab, setStatus]      = useState('all');
  const [brandFilter, setBrand]     = useState('all');
  const [typeFilter, setType]       = useState('all');
  const [showCompose, setCompose]   = useState(false);
  const [editRow, setEdit]          = useState(null);

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['campaigns', 'list'],   queryFn: listCampaigns },
      { queryKey: ['campaigns', 'brands'], queryFn: listBrandsForPicker },
    ],
  });
  const [listQ, brandsQ] = results;
  const rows    = listQ.data || [];
  const brands  = brandsQ.data || [];
  const loading = listQ.isPending;
  const err     = results.find((r) => r.error)?.error?.message || '';
  const load    = () => qc.invalidateQueries({ queryKey: ['campaigns'] });

  const types = useMemo(() => {
    const s = new Set(rows.map((r) => r.type).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (brandFilter !== 'all' && r.brand_id !== brandFilter) return false;
      if (typeFilter  !== 'all' && r.type !== typeFilter)      return false;
      if (statusTab   !== 'all' && r._status !== statusTab)     return false;
      if (qq && !(
        (r.promotion_name || '').toLowerCase().includes(qq) ||
        (r.brand?.brand_name || '').toLowerCase().includes(qq) ||
        (r.type || '').toLowerCase().includes(qq)
      )) return false;
      return true;
    });
  }, [rows, q, brandFilter, typeFilter, statusTab]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-subtitle">Shop-wide promotions tracker — coupons, bundles, flash sales.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={load} title="Refresh"><RefreshIcon width="15" height="15" /></button>
          {canWrite && (
            <button className="wx-btn wx-btn-primary" onClick={() => setCompose(true)}>
              <PlusIcon width="15" height="15" /> New campaign
            </button>
          )}
        </div>
      </div>

      <div className="wx-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 240 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input className="wx-input" placeholder="Search promotion, brand, type…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 200 }} value={brandFilter} onChange={(e) => setBrand(e.target.value)}>
          <option value="all">All brands</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 180 }} value={typeFilter} onChange={(e) => setType(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {STATUS_TABS.map((s) => (
            <button key={s} type="button"
              className={`wx-role-chip ${statusTab === s ? 'wx-role-chip-active' : ''}`}
              onClick={() => setStatus(s)}>
              {s === 'all' ? 'All' : STATUS_META[s]?.label || s}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div style={{ display: 'grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
            <MegaphoneIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No campaigns in this view</div>
          <div>{canWrite ? 'Add one manually or paste from TikTok Seller Center.' : 'Brand campaigns will appear here.'}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {filtered.map((r) => (
            <CampaignCard key={r.id} row={r} onClick={() => setEdit(r)} />
          ))}
        </div>
      )}

      {showCompose && (
        <ComposeModal
          brands={brands}
          onClose={() => setCompose(false)}
          onSaved={() => { setCompose(false); load(); }}
        />
      )}
      {editRow && (
        <EditModal
          row={editRow}
          brands={brands}
          meUid={user?.id}
          canEdit={canEditRow(editRow, user?.id, role)}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); load(); }}
        />
      )}
    </>
  );
}

function canEditRow(row, uid, role) {
  if (!row || !uid) return false;
  if (role === 'boss' || role === 'ol' || role === 'developer') return true;
  return row.added_by === uid || row.owner_id === uid;
}

function CampaignCard({ row, onClick }) {
  const meta = STATUS_META[row._status] || STATUS_META.Ongoing;
  const days = row.end_time
    ? Math.ceil((new Date(row.end_time) - new Date()) / 86400000)
    : null;
  return (
    <div className="wx-card" style={{ padding: 14, cursor: 'pointer' }} onClick={onClick}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <BrandAvatar brand={row.brand} size={38} radius={10} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {row.brand?.brand_name || '—'}{row.type ? ` · ${row.type}` : ''}
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{row.promotion_name}</div>
        </div>
        <StatusBadge tone={meta.tone} label={meta.label} />
      </div>
      <div style={{
        marginTop: 10, fontSize: 12, color: 'var(--text-muted)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
      }}>
        <span>
          <ClockIcon width="12" height="12" style={{ verticalAlign: '-2px', marginRight: 4 }} />
          {row.start_time ? fmt(row.start_time) : 'No start'}
          {row.end_time   ? ` → ${fmt(row.end_time)}` : ' → Indefinite'}
        </span>
        {row._status === 'Ongoing' && days != null && days <= 7 && days >= 0 && (
          <span style={{ color: days <= 2 ? 'var(--warning)' : 'var(--text-muted)', fontWeight: 700 }}>
            {days === 0 ? 'ends today' : `${days}d left`}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ tone, label }) {
  const t =
    tone === 'success' ? { bg: 'color-mix(in srgb, var(--success) 16%, transparent)', fg: 'var(--success)' }
  : tone === 'warning' ? { bg: 'color-mix(in srgb, var(--warning) 16%, transparent)', fg: 'var(--warning)' }
  : tone === 'danger'  ? { bg: 'color-mix(in srgb, var(--danger)  16%, transparent)', fg: 'var(--danger)'  }
  : tone === 'info'    ? { bg: 'color-mix(in srgb, var(--accent)  14%, transparent)', fg: 'var(--accent)'  }
                       : { bg: 'var(--surface-2)', fg: 'var(--text-muted)' };
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
      background: t.bg, color: t.fg,
    }}>{label}</span>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ============================================================
// Compose modal — Manual tab + Paste tab
// ============================================================
function ComposeModal({ brands, onClose, onSaved }) {
  const [mode, setMode] = useState('manual'); // manual | paste
  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><MegaphoneIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">New campaign</div>
            <div className="wx-m-head-sub">Track a TikTok Shop promotion — add manually, or paste from Seller Center.</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '10px 22px 0' }}>
          <TabBtn active={mode === 'manual'} onClick={() => setMode('manual')}>Manual</TabBtn>
          <TabBtn active={mode === 'paste'}  onClick={() => setMode('paste')}>Paste import</TabBtn>
        </div>

        {mode === 'manual'
          ? <ManualForm brands={brands} onCancel={onClose} onSaved={onSaved} />
          : <PasteForm brands={brands} onCancel={onClose} onSaved={onSaved} />}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        border: 0, background: 'transparent', padding: '8px 14px', borderRadius: 8,
        fontSize: 13, fontWeight: 700, cursor: 'pointer',
        color: active ? 'var(--accent)' : 'var(--text-muted)', position: 'relative',
      }}>
      {children}
      {active && <div style={{ position: 'absolute', left: 10, right: 10, bottom: -9, height: 2, background: 'var(--accent)', borderRadius: 2 }} />}
    </button>
  );
}

function ManualForm({ brands, onCancel, onSaved }) {
  const [brandId, setBrandId]   = useState('');
  const [name, setName]         = useState('');
  const [status, setStatus]     = useState('Ongoing');
  const [startTime, setStart]   = useState('');
  const [endTime, setEnd]       = useState('');
  const [type, setType]         = useState('');
  const [notes, setNotes]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  async function save() {
    setErr('');
    if (!brandId) return setErr('Pick a brand.');
    if (!name.trim()) return setErr('Promotion name is required.');
    setSaving(true);
    try {
      await createCampaign({
        brandId,
        promotionName: name,
        status,
        startTime: startTime ? new Date(startTime).toISOString() : null,
        endTime:   endTime   ? new Date(endTime).toISOString()   : null,
        type, notes,
      });
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className="wx-m-body">
        {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
        <div className="wx-m-field">
          <div className="wx-m-field-head">
            <div className="wx-m-field-label">Brand</div>
            <div className="wx-m-field-meta is-required">Required</div>
          </div>
          <select className="wx-m-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">— pick a brand —</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
          </select>
        </div>

        <div className="wx-m-field">
          <div className="wx-m-field-head">
            <div className="wx-m-field-label">Promotion name</div>
            <div className="wx-m-field-meta is-required">Required</div>
          </div>
          <input className="wx-m-input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Mother's Day Flash Sale" autoFocus />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="wx-m-field">
            <div className="wx-m-field-head"><div className="wx-m-field-label">Start time</div></div>
            <input type="datetime-local" className="wx-m-input" value={startTime} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">End time</div>
              <div className="wx-m-field-meta">Blank = indefinite</div>
            </div>
            <input type="datetime-local" className="wx-m-input" value={endTime} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="wx-m-field">
            <div className="wx-m-field-head"><div className="wx-m-field-label">Type</div></div>
            <input className="wx-m-input" value={type} onChange={(e) => setType(e.target.value)}
              placeholder="e.g. Coupon, Bundle, Flash Sale" />
          </div>
          <div className="wx-m-field">
            <div className="wx-m-field-head"><div className="wx-m-field-label">Status</div></div>
            <select className="wx-m-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="Ongoing">Ongoing</option>
              <option value="Deactivated">Deactivated</option>
            </select>
          </div>
        </div>

        <div className="wx-m-field">
          <div className="wx-m-field-head">
            <div className="wx-m-field-label">Notes</div>
            <div className="wx-m-field-meta">Optional</div>
          </div>
          <div className="wx-m-textarea-shell">
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the team should know about this promo." />
          </div>
        </div>
      </div>

      <div className="wx-m-foot">
        <div className="wx-m-kbd-hints"><kbd>Esc</kbd> cancel</div>
        <div className="wx-m-foot-actions">
          <button className="wx-btn wx-btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
            {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Add campaign</>}
          </button>
        </div>
      </div>
    </>
  );
}

function PasteForm({ brands, onCancel, onSaved }) {
  const [brandId, setBrandId] = useState('');
  const [paste, setPaste]     = useState('');
  const [parsed, setParsed]   = useState([]);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  useEffect(() => {
    if (!paste.trim()) { setParsed([]); return; }
    try { setParsed(parseBulkPaste(paste)); }
    catch { setParsed([]); }
  }, [paste]);

  async function save() {
    setErr('');
    if (!brandId) return setErr('Pick a brand — every parsed row will be tagged to this brand.');
    if (parsed.length === 0) return setErr('No campaigns parsed from paste.');
    setSaving(true);
    try {
      await createCampaignsBulk(parsed.map((p) => ({ ...p, brandId })));
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className="wx-m-body">
        {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

        <div className="wx-m-field">
          <div className="wx-m-field-head">
            <div className="wx-m-field-label">Brand for this batch</div>
            <div className="wx-m-field-meta is-required">Required</div>
          </div>
          <select className="wx-m-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">— pick a brand —</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
          </select>
        </div>

        <div className="wx-m-field">
          <div className="wx-m-field-head">
            <div className="wx-m-field-label">Paste from Seller Center</div>
            <div className="wx-m-field-meta">Tab-separated rows</div>
          </div>
          <div className="wx-m-textarea-shell">
            <textarea rows={9} value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'Promotion name\tStatus\tStart time\tEnd time\tType\nSummer Bundle\tOngoing\tMar 17, 2026 12:22 PM\tMar 25, 2026 11:59 PM\tCoupon'}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
            <div className="wx-m-char-count">{paste.length} chars</div>
          </div>
        </div>

        {parsed.length > 0 && (
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Parsed {parsed.length} row{parsed.length === 1 ? '' : 's'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {parsed.map((p, i) => (
                <div key={i} style={{
                  padding: 8, border: '1px solid var(--border-subtle)',
                  borderRadius: 8, background: 'var(--surface-1)',
                  display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 6, fontSize: 12,
                }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{p.promotionName}</div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      {p.type || '—'}
                      {p.startTime && ` · ${new Date(p.startTime).toLocaleDateString()}`}
                      {p.endTime   && ` → ${new Date(p.endTime).toLocaleDateString()}`}
                      {!p.endTime && ' → Indefinite'}
                    </div>
                  </div>
                  <StatusBadge tone={STATUS_META[p.status]?.tone || 'muted'} label={p.status} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="wx-m-foot">
        <div className="wx-m-kbd-hints"><kbd>Esc</kbd> cancel</div>
        <div className="wx-m-foot-actions">
          <button className="wx-btn wx-btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving || parsed.length === 0}>
            {saving ? <><span className="wx-spinner" /> Importing…</> : <><CheckIcon width="14" height="14" /> Import {parsed.length || ''}</>}
          </button>
        </div>
      </div>
    </>
  );
}

// ============================================================
// Edit modal
// ============================================================
function EditModal({ row, brands, canEdit, onClose, onSaved }) {
  const [brandId, setBrandId]   = useState(row.brand_id);
  const [name, setName]         = useState(row.promotion_name || '');
  const [status, setStatus]     = useState(row.status || 'Ongoing');
  const [startTime, setStart]   = useState(row.start_time ? isoForInput(row.start_time) : '');
  const [endTime, setEnd]       = useState(row.end_time   ? isoForInput(row.end_time)   : '');
  const [type, setType]         = useState(row.type  || '');
  const [notes, setNotes]       = useState(row.notes || '');
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  async function save() {
    setErr('');
    if (!name.trim()) return setErr('Promotion name is required.');
    setSaving(true);
    try {
      await updateCampaign(row.id, {
        brand_id:  brandId,
        promotionName: name,
        status,
        startTime: startTime ? new Date(startTime).toISOString() : null,
        endTime:   endTime   ? new Date(endTime).toISOString()   : null,
        type, notes,
      });
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${row.promotion_name}"?`)) return;
    setSaving(true); setErr('');
    try { await deleteCampaign(row.id); onSaved(); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><MegaphoneIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">{canEdit ? 'Edit campaign' : 'Campaign'}</div>
            <div className="wx-m-head-sub">
              {row.added_by_profile?.display_name || '—'}
              {row.added_by_profile?.role && ` · ${row.added_by_profile.role.toUpperCase()}`}
              {' · '}added {new Date(row.created_at).toLocaleDateString()}
            </div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          <div className="wx-m-field">
            <div className="wx-m-field-head"><div className="wx-m-field-label">Brand</div></div>
            <select className="wx-m-input" value={brandId} disabled={!canEdit}
              onChange={(e) => setBrandId(e.target.value)}>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
            </select>
          </div>

          <div className="wx-m-field">
            <div className="wx-m-field-head"><div className="wx-m-field-label">Promotion name</div></div>
            <input className="wx-m-input" value={name} disabled={!canEdit}
              onChange={(e) => setName(e.target.value)} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="wx-m-field">
              <div className="wx-m-field-head"><div className="wx-m-field-label">Start time</div></div>
              <input type="datetime-local" className="wx-m-input" value={startTime} disabled={!canEdit}
                onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="wx-m-field">
              <div className="wx-m-field-head"><div className="wx-m-field-label">End time</div></div>
              <input type="datetime-local" className="wx-m-input" value={endTime} disabled={!canEdit}
                onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="wx-m-field">
              <div className="wx-m-field-head"><div className="wx-m-field-label">Type</div></div>
              <input className="wx-m-input" value={type} disabled={!canEdit}
                onChange={(e) => setType(e.target.value)} />
            </div>
            <div className="wx-m-field">
              <div className="wx-m-field-head"><div className="wx-m-field-label">Status</div></div>
              <select className="wx-m-input" value={status} disabled={!canEdit}
                onChange={(e) => setStatus(e.target.value)}>
                <option value="Ongoing">Ongoing</option>
                <option value="Deactivated">Deactivated</option>
              </select>
            </div>
          </div>

          <div className="wx-m-field">
            <div className="wx-m-field-head"><div className="wx-m-field-label">Notes</div></div>
            <div className="wx-m-textarea-shell">
              <textarea rows={3} value={notes} disabled={!canEdit}
                onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints"><kbd>Esc</kbd> close</div>
          <div className="wx-m-foot-actions">
            {canEdit && (
              <>
                <button className="wx-btn wx-btn-ghost" onClick={handleDelete} disabled={saving}>
                  <TrashIcon width="13" height="13" /> Delete
                </button>
                <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
                  {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save</>}
                </button>
              </>
            )}
            {!canEdit && (
              <button className="wx-btn wx-btn-primary" onClick={onClose}>Close</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function isoForInput(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
