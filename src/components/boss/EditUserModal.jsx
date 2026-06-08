import { useState } from 'react';
import { updateUserProfile, deleteUser } from '../../lib/adminApi';
import { setUserHireDate } from '../../lib/salariesApi';
import { ROLES, roleLabel, getRoleExtras } from '../../lib/roles';
import { useAuth } from '../../contexts/AuthContext';
import RoleExtraFields, { ResponsibilityTags } from './RoleExtraFields';
import { XIcon, UserIcon, AlertIcon, TrashIcon, CalendarIcon } from '../common/Icon';

// Boss cannot edit other Boss accounts or their own role.
// All non-boss roles selectable.
const ASSIGNABLE = ROLES.filter((r) => r.value !== 'boss');

export default function EditUserModal({ user, onClose, onUpdated }) {
  const { user: me } = useAuth();
  const isSelf = me?.id === user.id;

  const [displayName, setDisplayName] = useState(user.display_name || '');
  const [role, setRole]               = useState(user.role);
  const [isActive, setIsActive]       = useState(user.is_active);
  const [reportsTo, setReportsTo]     = useState(user.reports_to || '');
  const [permissions, setPermissions] = useState(user.permissions || {});
  const [responsibilities, setResponsibilities] = useState(user.responsibilities || []);
  // Hire date — Boss-only field, written via set_user_hire_date RPC
  // (which logs an audit_log row). Hidden for the Boss editing his
  // own profile since Boss has no payroll record.
  const [hireDate, setHireDate]       = useState(user.start_date || '');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  const [deleting, setDeleting]       = useState(false);

  const isTargetBoss = user.role === 'boss';
  const extras = getRoleExtras(role);
  const canDelete = !isSelf && !isTargetBoss;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!displayName.trim()) return setError('Name is required.');
    if (!isTargetBoss && !isSelf && extras.reportsToRole && !reportsTo) {
      return setError(`Please select a ${roleLabel(extras.reportsToRole)}.`);
    }

    const patch = {
      display_name: displayName.trim(),
      responsibilities: responsibilities || [],
    };
    if (!isTargetBoss && !isSelf) {
      patch.role = role;
      patch.reports_to = extras.reportsToRole ? reportsTo : null;
      patch.permissions = extras.permissions.length ? permissions : {};
    }
    if (!isSelf) patch.is_active = isActive;

    setSaving(true);
    try {
      await updateUserProfile(user.id, patch);
      // Hire date is gated to Boss via the RPC. The profiles UPDATE
      // policy lets Boss write start_date too, but routing through
      // set_user_hire_date keeps the audit_log entry uniform.
      const cleanHire = hireDate || null;
      const prevHire = user.start_date || null;
      if (!isTargetBoss && cleanHire !== prevHire) {
        await setUserHireDate(user.id, cleanHire);
      }
      onUpdated();
    } catch (err) {
      setError(err.message || 'Failed to update user.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setError('');
    const target = (user.display_name || user.email || '').trim();
    if (confirmDelete.trim() !== target) {
      setError(`Type "${target}" exactly to confirm deletion.`);
      return;
    }
    setDeleting(true);
    try {
      await deleteUser(user.id);
      onUpdated();
    } catch (err) {
      setError(err.message || 'Failed to delete user.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">Edit user</div>
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

            {(isSelf || isTargetBoss) && (
              <div className="wx-alert wx-alert-info" style={{ marginBottom: 14 }}>
                <AlertIcon width="16" height="16" />
                <span>
                  {isSelf
                    ? 'You can\'t change your own role or deactivate yourself.'
                    : 'Boss accounts can\'t have their role or status changed here.'}
                </span>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Email</label>
              <div className="wx-input-group">
                <input className="wx-input" value={user.email} disabled />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                Email can't be changed from here (Supabase auth field).
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Full name</label>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><UserIcon /></span>
                <input
                  className="wx-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            {!isTargetBoss && !isSelf && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label className="wx-label">Role</label>
                  <div className="wx-role-grid">
                    {ASSIGNABLE.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className={`wx-role-chip ${role === r.value ? 'wx-role-chip-active' : ''}`}
                        onClick={() => {
                          setRole(r.value);
                          // Clear reports_to if new role doesn't need one
                          const nextExtras = getRoleExtras(r.value);
                          if (!nextExtras.reportsToRole) setReportsTo('');
                          if (!nextExtras.permissions.length) setPermissions({});
                        }}
                        disabled={saving}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                  <RoleExtraFields
                    role={role}
                    reportsTo={reportsTo}
                    onReportsTo={setReportsTo}
                    permissions={permissions}
                    onPermissions={setPermissions}
                    disabled={saving}
                  />
                </div>
              </>
            )}

            {/* Hire date — Boss-managed, drives anniversary detection and
                years-completed counts in Salary Management. */}
            {!isTargetBoss && (
              <div style={{ marginBottom: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                <label className="wx-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CalendarIcon width="13" height="13" /> Hire date
                </label>
                <input
                  type="date"
                  className="wx-input"
                  value={hireDate}
                  onChange={(e) => setHireDate(e.target.value)}
                  disabled={saving}
                />
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                  Drives years-completed counts and the work-anniversary celebrations.
                </div>
              </div>
            )}

            {/* Responsibilities: editable for everyone except foreign Boss accounts */}
            {!isTargetBoss && (
              <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                <ResponsibilityTags
                  value={responsibilities}
                  onChange={setResponsibilities}
                  disabled={saving}
                />
              </div>
            )}

            {!isSelf && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-2)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13.5 }}>
                    Active account
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Inactive users can't sign in. Historical data is preserved.
                  </div>
                </div>
                <Switch checked={isActive} onChange={setIsActive} disabled={saving} />
              </div>
            )}

            {isTargetBoss && (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
                Current role: <strong style={{ color: 'var(--text-primary)' }}>{roleLabel(user.role)}</strong>
              </div>
            )}

            {canDelete && (
              <div
                style={{
                  marginTop: 18,
                  padding: 14,
                  border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--danger-soft)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <TrashIcon width="16" height="16" style={{ color: 'var(--danger)' }} />
                  <div style={{ fontWeight: 700, color: 'var(--danger)', fontSize: 13.5 }}>
                    Delete account
                  </div>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
                  Permanently removes this user. They will no longer be able to sign in.
                  This cannot be undone. Type <strong style={{ color: 'var(--text-primary)' }}>{user.display_name || user.email}</strong> below to confirm.
                </div>
                <input
                  className="wx-input"
                  placeholder="Type the user's name to confirm"
                  value={confirmDelete}
                  onChange={(e) => setConfirmDelete(e.target.value)}
                  disabled={deleting || saving}
                  style={{ marginBottom: 10 }}
                />
                <button
                  type="button"
                  className="wx-btn"
                  style={{
                    background: 'var(--danger)',
                    color: '#fff',
                    border: 0,
                    fontWeight: 600,
                    width: '100%',
                  }}
                  onClick={handleDelete}
                  disabled={deleting || saving || !confirmDelete.trim()}
                >
                  {deleting ? <><span className="wx-spinner" /> Deleting…</> : <>Delete user permanently</>}
                </button>
              </div>
            )}
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving || deleting}>
              Cancel
            </button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving || deleting}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Switch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--surface-3)',
        border: '1px solid',
        borderColor: checked ? 'var(--accent)' : 'var(--border-default)',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all var(--dur-fast) var(--ease-out)',
        padding: 0,
        flex: '0 0 auto',
      }}
    >
      <span
        style={{
          position: 'absolute',
          // Center vertically regardless of border / box-sizing quirks.
          top: '50%',
          transform: 'translateY(-50%)',
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          transition: 'left var(--dur-fast) var(--ease-out)',
        }}
      />
    </button>
  );
}
