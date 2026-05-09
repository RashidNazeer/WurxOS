import { useEffect, useState } from 'react';
import { getRoleExtras, roleLabel } from '../../lib/roles';
import { listActiveParentsOfRole } from '../../lib/adminApi';
import { AlertIcon, XIcon, PlusIcon } from '../common/Icon';

/**
 * Renders the role-specific extras (permissions toggles + reports-to
 * dropdown) shared by CreateUserModal and EditUserModal.
 *
 * Props:
 *   role          — the role being created/edited (e.g. 'apc')
 *   reportsTo     — current reports_to uuid (or '')
 *   onReportsTo   — (uuid) => void
 *   permissions   — current permissions object { key: bool }
 *   onPermissions — (obj) => void
 *   disabled      — boolean
 */
export default function RoleExtraFields({
  role,
  reportsTo,
  onReportsTo,
  permissions,
  onPermissions,
  responsibilities = [],
  onResponsibilities,
  disabled,
  // When set, the reports-to relationship is fixed server-side — we
  // hide the picker, skip the parents fetch, and don't offer the
  // permissions panel (those are Boss-granted, not self-granted).
  lockedReportsTo = null,
}) {
  const extras = getRoleExtras(role);
  const [parents, setParents] = useState([]);
  const [loadingParents, setLoadingParents] = useState(false);
  const [parentsErr, setParentsErr] = useState('');

  // Load eligible parents when the role requires one (skip if the
  // reports-to is locked — the picker won't render).
  useEffect(() => {
    let cancelled = false;
    if (!extras.reportsToRole || lockedReportsTo) {
      setParents([]);
      return;
    }
    setLoadingParents(true);
    setParentsErr('');
    listActiveParentsOfRole(extras.reportsToRole)
      .then((list) => { if (!cancelled) setParents(list); })
      .catch((err) => { if (!cancelled) setParentsErr(err.message); })
      .finally(() => { if (!cancelled) setLoadingParents(false); });
    return () => { cancelled = true; };
  }, [extras.reportsToRole, lockedReportsTo]);

  const togglePerm = (key) => {
    onPermissions({ ...(permissions || {}), [key]: !(permissions || {})[key] });
  };

  return (
    <>
      {/* Reports-to dropdown (APC → TL, IPC → PCTL). Hidden when locked. */}
      {extras.reportsToRole && !lockedReportsTo && (
        <div style={{ marginBottom: 14 }}>
          <label className="wx-label">
            Reports to ({roleLabel(extras.reportsToRole)}) <span style={{ color: 'var(--danger)' }}>*</span>
          </label>
          {parentsErr && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 8 }}>
              <AlertIcon width="14" height="14" /> <span>{parentsErr}</span>
            </div>
          )}
          {loadingParents ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              <span className="wx-spinner" style={{ color: 'var(--accent)' }} />{' '}
              Loading {roleLabel(extras.reportsToRole)}s…
            </div>
          ) : parents.length === 0 ? (
            <div
              style={{
                border: '1px dashed var(--border-default)',
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-muted)',
                fontSize: 13,
              }}
            >
              No active {roleLabel(extras.reportsToRole)}s exist yet. Please create one first,
              then come back to add this {roleLabel(role)}.
            </div>
          ) : (
            <select
              className="wx-input"
              value={reportsTo || ''}
              onChange={(e) => onReportsTo(e.target.value || null)}
              disabled={disabled}
            >
              <option value="">— Select a {roleLabel(extras.reportsToRole)} —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} · {p.email}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Permission toggles (TL, PCTL). Hidden when locked — only Boss
          grants those, not the creating user. */}
      {extras.permissions.length > 0 && !lockedReportsTo && (
        <div style={{ marginBottom: 4 }}>
          <label className="wx-label" style={{ marginBottom: 8 }}>Permissions</label>
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}
          >
            {extras.permissions.map((perm, i) => {
              const on = !!(permissions || {})[perm.key];
              return (
                <div
                  key={perm.key}
                  onClick={() => !disabled && togglePerm(perm.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '11px 14px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                    transition: 'background var(--dur-fast) var(--ease-out)',
                  }}
                >
                  <div style={{ minWidth: 0, marginRight: 12 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {perm.label}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {perm.hint}
                    </div>
                  </div>
                  <MiniSwitch checked={on} disabled={disabled} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export function ResponsibilityTags({ value, onChange, disabled }) {
  const [draft, setDraft] = useState('');
  const tags = Array.isArray(value) ? value : [];

  function add() {
    const t = draft.trim();
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) { setDraft(''); return; }
    onChange([...tags, t]);
    setDraft('');
  }
  function remove(t) { onChange(tags.filter((x) => x !== t)); }

  return (
    <div style={{ marginBottom: 14 }}>
      <label className="wx-label">Responsibilities <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {tags.map((t) => (
          <span key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 4px 3px 10px', borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
            fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          }}>
            {t}
            <button type="button" onClick={() => remove(t)} disabled={disabled}
              style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, borderRadius: 'var(--radius-sm)' }}>
              <XIcon width="11" height="11" />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="wx-input"
          placeholder="Add a responsibility (e.g. Outreach, QA)…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          disabled={disabled}
          style={{ flex: 1 }}
        />
        <button type="button" className="wx-btn wx-btn-ghost" onClick={add} disabled={disabled || !draft.trim()}>
          <PlusIcon width="13" height="13" /> Add
        </button>
      </div>
    </div>
  );
}

function MiniSwitch({ checked, disabled }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--surface-3)',
        border: '1px solid',
        borderColor: checked ? 'var(--accent)' : 'var(--border-default)',
        position: 'relative',
        flex: '0 0 auto',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--dur-fast)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          // Center vertically regardless of border / box-sizing quirks.
          top: '50%',
          transform: 'translateY(-50%)',
          left: checked ? 17 : 1,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          transition: 'left var(--dur-fast) var(--ease-out)',
        }}
      />
    </span>
  );
}
