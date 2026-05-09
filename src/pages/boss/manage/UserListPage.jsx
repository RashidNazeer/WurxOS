import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listProfilesByRole, deleteUser } from '../../../lib/adminApi';
import { getRoleExtras } from '../../../lib/roles';
import { useAuth } from '../../../contexts/AuthContext';
import CreateUserModal from '../../../components/boss/CreateUserModal';
import EditUserModal from '../../../components/boss/EditUserModal';
import {
  PlusIcon, SearchIcon, AlertIcon, PencilIcon, UsersIcon, RefreshIcon, TrashIcon, XIcon,
} from '../../../components/common/Icon';
import '../../../styles/table.css';

export default function UserListPage({ role, title, emptyHint }) {
  const { user: me } = useAuth();
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['profiles-by-role', role],
    queryFn: () => listProfilesByRole(role),
  });
  const error = queryError?.message || '';
  const load  = () => qc.invalidateQueries({ queryKey: ['profiles-by-role', role] });

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return rows;
    return rows.filter(
      (r) =>
        (r.display_name || '').toLowerCase().includes(qq) ||
        (r.email || '').toLowerCase().includes(qq),
    );
  }, [rows, q]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">
            {rows.length} {rows.length === 1 ? 'user' : 'users'}
            {q && filtered.length !== rows.length && ` · ${filtered.length} matching "${q}"`}
          </p>
        </div>
        <button className="wx-btn wx-btn-primary" onClick={() => setShowCreate(true)}>
          <PlusIcon width="16" height="16" /> Add {title.replace(/s$/, '')}
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
            <div className="wx-empty-title">No {title.toLowerCase()} yet</div>
            <div>{emptyHint || 'Click the button above to add one.'}</div>
          </div>
        )}

        {!loading && filtered.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={me?.id === u.id}
            onEdit={() => setEditUser(u)}
            onDelete={() => setDeleteTarget(u)}
          />
        ))}
      </div>

      {showCreate && (
        <CreateUserModal
          role={role}
          title={title}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {editUser && (
        <EditUserModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onUpdated={() => { setEditUser(null); load(); }}
        />
      )}

      {deleteTarget && (
        <DeleteUserModal
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); load(); }}
        />
      )}
    </>
  );
}

function UserRow({ user, isSelf, onEdit, onDelete }) {
  const initials = (user.display_name || user.email || '?')
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  const extras = getRoleExtras(user.role);
  const activePerms = extras.permissions.filter((p) => user.permissions?.[p.key]);
  return (
    <div className="wx-list-row">
      <div className="wx-user-cell">
        <div className="wx-user-avatar">
          {user.avatar_url
            ? <img src={user.avatar_url} alt=""
                style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
            : initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="wx-user-name">{user.display_name || '—'}</div>
          {user.parent && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              Reports to <strong style={{ color: 'var(--text-secondary)' }}>{user.parent.display_name}</strong>
            </div>
          )}
          {activePerms.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {activePerms.map((p) => (
                <span
                  key={p.key}
                  title={p.hint}
                  style={{
                    fontSize: 10.5,
                    padding: '2px 7px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    fontWeight: 600,
                  }}
                >
                  {p.label}
                </span>
              ))}
            </div>
          )}
          {Array.isArray(user.responsibilities) && user.responsibilities.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {user.responsibilities.slice(0, 4).map((r) => (
                <span key={r}
                  title={r}
                  style={{
                    fontSize: 10.5,
                    padding: '2px 7px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--surface-2)',
                    color: 'var(--text-secondary)',
                    fontWeight: 600,
                  }}
                >
                  {r}
                </span>
              ))}
              {user.responsibilities.length > 4 && (
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  +{user.responsibilities.length - 4}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="wx-user-email">{user.email}</div>
      <div>
        {user.is_active ? (
          <span className="wx-badge wx-badge-success">
            <span className="wx-badge-dot" /> Active
          </span>
        ) : (
          <span className="wx-badge wx-badge-muted">
            <span className="wx-badge-dot" /> Inactive
          </span>
        )}
      </div>
      <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button
          className="wx-btn wx-btn-ghost"
          style={{ padding: '6px 12px', fontSize: 12.5 }}
          onClick={onEdit}
        >
          <PencilIcon width="14" height="14" /> Edit
        </button>
        {!isSelf && user.role !== 'boss' && (
          <button
            className="wx-btn wx-btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--danger)' }}
            onClick={onDelete}
            title="Delete user"
            aria-label="Delete user"
          >
            <TrashIcon width="14" height="14" />
          </button>
        )}
      </div>
    </div>
  );
}

function DeleteUserModal({ user, onClose, onDeleted }) {
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const target = (user.display_name || user.email || '').trim();
  const canSubmit = confirm.trim() === target && !deleting;

  async function handleDelete() {
    setError('');
    if (!canSubmit) {
      setError(`Type "${target}" exactly to confirm.`);
      return;
    }
    setDeleting(true);
    try {
      await deleteUser(user.id);
      onDeleted();
    } catch (err) {
      setError(err.message || 'Failed to delete user.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 32, height: 32, borderRadius: 'var(--radius-md)',
              background: 'var(--danger-soft)', color: 'var(--danger)',
              display: 'grid', placeItems: 'center', flex: '0 0 auto',
            }}>
              <TrashIcon width="16" height="16" />
            </span>
            Delete user
          </div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          {error && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="16" height="16" /> <span>{error}</span>
            </div>
          )}
          <div style={{ fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 6, lineHeight: 1.5 }}>
            Are you sure you want to delete <strong>{user.display_name || user.email}</strong>?
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
            This is permanent. The user will no longer be able to sign in. Their historical assignments
            and audit trail will reference a deleted account.
          </div>
          <label className="wx-label" style={{ marginBottom: 6 }}>
            Type <strong style={{ color: 'var(--text-primary)' }}>{target}</strong> to confirm
          </label>
          <input
            className="wx-input"
            placeholder={target}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={deleting}
            autoFocus
          />
        </div>
        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            className="wx-btn"
            style={{
              background: canSubmit ? 'var(--danger)' : 'var(--surface-3)',
              color: canSubmit ? '#fff' : 'var(--text-muted)',
              border: 0,
              fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
            onClick={handleDelete}
            disabled={!canSubmit}
          >
            {deleting ? <><span className="wx-spinner" /> Deleting…</> : 'Delete user'}
          </button>
        </div>
      </div>
    </div>
  );
}
