import { useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listMyIPCs, updateIPCProfile, getLeaveQuotaDefault,
  listMySelectedBrands, listIPCAssignedBrands,
  assignIPCToBrand, unassignIPCFromBrand,
} from '../../lib/paidCollabApi';
import { createUser, generatePassword } from '../../lib/adminApi';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  PlusIcon, SearchIcon, AlertIcon, PencilIcon, UsersIcon, RefreshIcon,
  XIcon, MailIcon, LockIcon, UserIcon, EyeIcon, EyeOffIcon, CheckIcon, CopyIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

export default function IPCsPage() {
  const { user } = useAuth();
  const pctlId = user?.id;

  const [q, setQ]                 = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editIPC, setEditIPC]     = useState(null);

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['ipcs', 'mine', pctlId],           queryFn: () => listMyIPCs(pctlId),          enabled: !!pctlId },
      { queryKey: ['pc-brands', 'selected', pctlId],  queryFn: () => listMySelectedBrands(pctlId), enabled: !!pctlId },
      { queryKey: ['leave-defaults'],                 queryFn: () => getLeaveQuotaDefault() },
    ],
  });
  const [ipcsQ, brandsQ, defaultsQ] = results;
  const rows     = ipcsQ.data || [];
  const brands   = brandsQ.data || [];
  const defaults = defaultsQ.data || { wfh: 2, medical: 1, emergency: 1 };
  const loading  = ipcsQ.isPending;
  const error    = results.find((r) => r.error)?.error?.message || '';
  const load     = () => { qc.invalidateQueries({ queryKey: ['ipcs'] }); qc.invalidateQueries({ queryKey: ['pc-brands'] }); };

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return rows;
    return rows.filter((r) =>
      (r.display_name || '').toLowerCase().includes(qq) ||
      (r.email || '').toLowerCase().includes(qq),
    );
  }, [rows, q]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">IPCs</h1>
          <p className="page-subtitle">
            {rows.length} {rows.length === 1 ? 'IPC' : 'IPCs'} reporting to you
            {q && filtered.length !== rows.length && ` · ${filtered.length} matching "${q}"`}
          </p>
        </div>
        <button className="wx-btn wx-btn-primary" onClick={() => setShowCreate(true)}>
          <PlusIcon width="16" height="16" /> Add IPC
        </button>
      </div>

      <div className="wx-toolbar">
        <div className="wx-search">
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search by name or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={load} disabled={loading} title="Refresh">
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}

      <div className="wx-list">
        <div className="wx-list-row wx-list-header">
          <div>Name</div>
          <div>Email</div>
          <div>Status</div>
          <div />
        </div>

        {loading && (
          <div className="wx-empty">
            <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="wx-empty">
            <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
              <UsersIcon width="22" height="22" />
            </div>
            <div className="wx-empty-title">No IPCs yet</div>
            <div>Click Add IPC to onboard your first Influencer Partnership Coordinator.</div>
          </div>
        )}

        {!loading && filtered.map((u) => (
          <IPCRow key={u.id} ipc={u} onEdit={() => setEditIPC(u)} />
        ))}
      </div>

      {showCreate && (
        <CreateIPCModal
          pctlId={pctlId}
          defaults={defaults}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {editIPC && (
        <EditIPCModal
          ipc={editIPC}
          brands={brands}
          onClose={() => setEditIPC(null)}
          onSaved={() => { setEditIPC(null); load(); }}
        />
      )}
    </>
  );
}

function IPCRow({ ipc, onEdit }) {
  const initials = (ipc.display_name || ipc.email || '?')
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  const lq = ipc.leave_quota || { wfh: 0, medical: 0, emergency: 0 };
  return (
    <div className="wx-list-row">
      <div className="wx-user-cell">
        <div className="wx-user-avatar">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div className="wx-user-name">{ipc.display_name || '—'}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            <QuotaChip label="WFH"       n={lq.wfh} />
            <QuotaChip label="Medical"   n={lq.medical} />
            <QuotaChip label="Emergency" n={lq.emergency} />
          </div>
        </div>
      </div>
      <div className="wx-user-email">{ipc.email}</div>
      <div>
        {ipc.is_active
          ? <span className="wx-badge wx-badge-success"><span className="wx-badge-dot" /> Active</span>
          : <span className="wx-badge wx-badge-muted"><span className="wx-badge-dot" /> Inactive</span>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <button className="wx-btn wx-btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={onEdit}>
          <PencilIcon width="14" height="14" /> Edit
        </button>
      </div>
    </div>
  );
}

function QuotaChip({ label, n }) {
  return (
    <span style={{
      fontSize: 10.5,
      padding: '2px 7px',
      borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-2)',
      color: 'var(--text-secondary)',
      fontWeight: 600,
    }}>
      {label} · {n}
    </span>
  );
}

/* ------------------------------------------------------------
   Create IPC modal (PCTL flow — no reports_to picker, leave
   quota pre-filled from defaults).
   ------------------------------------------------------------ */
function CreateIPCModal({ pctlId, defaults, onClose, onCreated }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState(() => generatePassword(12));
  const [showPw, setShowPw]     = useState(true);
  const [quota, setQuota]       = useState(defaults);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [created, setCreated]   = useState(null);
  const [copied, setCopied]     = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!displayName.trim()) return setError('Enter the IPC\'s name.');
    if (!email.trim())       return setError('Email is required.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');

    setSaving(true);
    try {
      const out = await createUser({
        email: email.trim().toLowerCase(),
        password,
        displayName: displayName.trim(),
        role: 'ipc',
        reportsTo: pctlId,  // Edge Function forces this regardless — sent for clarity.
        permissions: {},
      });
      // Apply initial leave quota (profile already created by trigger)
      if (out?.profile?.id) {
        await updateIPCProfile(out.profile.id, { leave_quota: quota });
      }
      setCreated(out);
    } catch (err) { setError(err.message || 'Failed to create IPC.'); }
    finally { setSaving(false); }
  }

  async function copyCreds() {
    try {
      await navigator.clipboard.writeText(`Email: ${email}\nPassword: ${password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  if (created) {
    return (
      <div className="wx-modal-backdrop" onClick={onClose}>
        <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">IPC created</div>
            <button className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px', background: 'var(--success-soft)', color: 'var(--success)',
              borderRadius: 'var(--radius-md)', marginBottom: 16, fontSize: 13.5, fontWeight: 600,
            }}>
              <CheckIcon width="18" height="18" /> Share the credentials below with {displayName}.
            </div>
            <div style={{
              background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)', padding: '14px 16px',
              fontFamily: 'ui-monospace, monospace', fontSize: 13, marginBottom: 14,
            }}>
              <Kv label="Email" value={email} />
              <Kv label="Password" value={password} mask={!showPw} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="wx-btn wx-btn-ghost" onClick={() => setShowPw((v) => !v)} style={{ flex: 1 }}>
                {showPw ? <EyeOffIcon /> : <EyeIcon />} {showPw ? 'Hide' : 'Show'} password
              </button>
              <button className="wx-btn wx-btn-ghost" onClick={copyCreds} style={{ flex: 1 }}>
                {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy credentials'}
              </button>
            </div>
          </div>
          <div className="wx-modal-footer">
            <button className="wx-btn wx-btn-primary" onClick={onCreated}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">Add IPC</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            {error && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
                <AlertIcon width="16" height="16" /> <span>{error}</span>
              </div>
            )}

            <Field label="Full name" icon={<UserIcon />}>
              <input className="wx-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={saving} placeholder="Jane Doe" />
            </Field>
            <Field label="Work email" icon={<MailIcon />}>
              <input type="email" className="wx-input" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} placeholder="jane@company.com" />
            </Field>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label className="wx-label" style={{ margin: 0 }}>Password</label>
                <button type="button" className="auth-link" onClick={() => setPassword(generatePassword(12))} disabled={saving}>
                  <RefreshIcon width="12" height="12" /> Regenerate
                </button>
              </div>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><LockIcon /></span>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="wx-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saving}
                  style={{ fontFamily: 'ui-monospace, monospace' }}
                />
                <button type="button" className="wx-input-group-action" onClick={() => setShowPw((v) => !v)} tabIndex={-1}>
                  {showPw ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
              <label className="wx-label">Leave quota (per year)</label>
              <QuotaEditor value={quota} onChange={setQuota} disabled={saving} />
            </div>
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Creating…</> : 'Create IPC'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   Edit IPC modal — rename, (de)activate, leave quota, brand
   assignments.
   ------------------------------------------------------------ */
function EditIPCModal({ ipc, brands, onClose, onSaved }) {
  const [displayName, setDisplayName] = useState(ipc.display_name || '');
  const [isActive, setIsActive]       = useState(!!ipc.is_active);
  const [quota, setQuota]             = useState(ipc.leave_quota || { wfh: 0, medical: 0, emergency: 0 });
  const [assigned, setAssigned]       = useState([]);
  const [loadingA, setLoadingA]       = useState(true);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');

  useEffect(() => {
    let cancelled = false;
    listIPCAssignedBrands(ipc.id)
      .then((list) => { if (!cancelled) setAssigned(list); })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoadingA(false); });
    return () => { cancelled = true; };
  }, [ipc.id]);

  const assignedIds = useMemo(() => new Set(assigned.map((b) => b.id)), [assigned]);

  async function toggleBrand(brand) {
    setErr('');
    try {
      if (assignedIds.has(brand.id)) {
        await unassignIPCFromBrand(ipc.id, brand.id);
        setAssigned((a) => a.filter((b) => b.id !== brand.id));
      } else {
        await assignIPCToBrand(ipc.id, brand.id);
        setAssigned((a) => [...a, brand]);
      }
    } catch (e) { setErr(e.message); }
  }

  async function saveCore() {
    setErr(''); setSaving(true);
    try {
      await updateIPCProfile(ipc.id, {
        display_name: displayName.trim(),
        is_active: isActive,
        leave_quota: quota,
      });
      onSaved();
    } catch (e) { setErr(e.message || 'Failed to save.'); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Edit IPC — {ipc.display_name}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="16" height="16" /> <span>{err}</span>
            </div>
          )}

          <Field label="Full name"><input className="wx-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={saving} /></Field>
          <Field label="Email"><input className="wx-input" value={ipc.email} disabled /></Field>

          <div style={{ marginBottom: 14 }}>
            <label className="wx-label">Status</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className={`wx-role-chip ${isActive ? 'wx-role-chip-active' : ''}`}
                onClick={() => setIsActive(true)} disabled={saving} style={{ flex: 1 }}>Active</button>
              <button type="button" className={`wx-role-chip ${!isActive ? 'wx-role-chip-active' : ''}`}
                onClick={() => setIsActive(false)} disabled={saving} style={{ flex: 1 }}>Inactive</button>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label className="wx-label">Leave quota</label>
            <QuotaEditor value={quota} onChange={setQuota} disabled={saving} />
          </div>

          <div style={{ marginTop: 8, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <label className="wx-label">Brand assignments</label>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              Toggle from your selected paid-collab brands.
            </div>
            {loadingA ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                <span className="wx-spinner" /> Loading assignments…
              </div>
            ) : brands.length === 0 ? (
              <div style={{
                border: '1px dashed var(--border-default)',
                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                color: 'var(--text-muted)', fontSize: 13,
              }}>
                You haven't selected any paid-collab brands yet. Go to <strong>Paid Collab → Brands</strong> to pick one first.
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {brands.map((b) => {
                  const on = assignedIds.has(b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleBrand(b)}
                      disabled={saving}
                      className={`wx-role-chip ${on ? 'wx-role-chip-active' : ''}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}
                    >
                      <BrandAvatar brand={b} size={16} radius={4} />
                      {b.brand_name}
                      {on && <CheckIcon width="12" height="12" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={saveCore} disabled={saving}>
            {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------ */
function Field({ label, icon, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label className="wx-label">{label}</label>
      {icon ? (
        <div className="wx-input-group">
          <span className="wx-input-group-icon">{icon}</span>
          {children}
        </div>
      ) : children}
    </div>
  );
}

function QuotaEditor({ value, onChange, disabled }) {
  const set = (k, v) => onChange({ ...value, [k]: Math.max(0, Number(v) || 0) });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
      {[
        { k: 'wfh',       label: 'WFH' },
        { k: 'medical',   label: 'Medical' },
        { k: 'emergency', label: 'Emergency' },
      ].map((f) => (
        <div key={f.k}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>{f.label}</div>
          <input
            type="number"
            min={0}
            className="wx-input"
            value={value[f.k] ?? 0}
            onChange={(e) => set(f.k, e.target.value)}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

function Kv({ label, value, mask }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0' }}>
      <div style={{ width: 80, color: 'var(--text-muted)', fontSize: 12 }}>{label}</div>
      <div style={{ color: 'var(--text-primary)', wordBreak: 'break-all', flex: 1 }}>
        {mask ? '•'.repeat(Math.min(value.length, 14)) : value}
      </div>
    </div>
  );
}
