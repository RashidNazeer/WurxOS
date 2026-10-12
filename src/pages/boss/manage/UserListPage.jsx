import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listProfilesByRole, listFormerProfilesByRole, deleteUser } from '../../../lib/adminApi';
import { getRoleExtras } from '../../../lib/roles';
import { useAuth } from '../../../contexts/AuthContext';
import CreateUserModal from '../../../components/boss/CreateUserModal';
import EditUserModal from '../../../components/boss/EditUserModal';
import {
  PlusIcon, SearchIcon, AlertIcon, PencilIcon, UsersIcon, RefreshIcon, TrashIcon, XIcon,
} from '../../../components/common/Icon';
import '../../../styles/table.css';

// Who an Operation Lead may retire (Owner, 2026-10-12: "if an APC or Teamlead
// is laid off the boss or OL must be able to mark them as ex-employee").
// Enforced for real in the delete-user function; this only decides whether the
// button is worth showing.
const OL_MAY_RETIRE = ['apc', 'tl'];

export default function UserListPage({ role, title, emptyHint }) {
  const { user: me, profile } = useAuth();
  const myRole = String(profile?.role || '').toLowerCase();
  const isBoss = myRole === 'boss';
  // Creating accounts and editing a profile stay with the Boss: create-user is
  // Boss-only, and the profiles UPDATE policy is self-or-boss, so an OL
  // pressing either would just collect a 403.
  const canCreate = isBoss;
  const canEdit = isBoss;
  const canRetire = isBoss || (myRole === 'ol' && OL_MAY_RETIRE.includes(role));
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Current staff by default. Former staff are a deliberate second view rather
  // than mixed into the list: almost every reason to open this page is about
  // someone who still works here.
  const [tab, setTab] = useState('current');

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['profiles-by-role', role],
    queryFn: () => listProfilesByRole(role),
  });
  // Fetched alongside, not on demand, so the tab can show its count and
  // switching is instant.
  const { data: formerRows = [], isLoading: loadingFormer, error: formerError } = useQuery({
    queryKey: ['profiles-by-role-former', role],
    queryFn: () => listFormerProfilesByRole(role),
  });
  const error = queryError?.message || formerError?.message || '';
  const load  = () => {
    qc.invalidateQueries({ queryKey: ['profiles-by-role', role] });
    qc.invalidateQueries({ queryKey: ['profiles-by-role-former', role] });
  };

  const isFormer = tab === 'former';
  const source = isFormer ? formerRows : rows;
  const busy = isFormer ? loadingFormer : loading;

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return source;
    return source.filter(
      (r) =>
        (r.display_name || '').toLowerCase().includes(qq) ||
        (r.email || '').toLowerCase().includes(qq),
    );
  }, [source, q]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">
            {isFormer
              ? `${formerRows.length} former ${formerRows.length === 1 ? 'member' : 'members'}`
              : `${rows.length} ${rows.length === 1 ? 'user' : 'users'}`}
            {q && filtered.length !== source.length && ` · ${filtered.length} matching "${q}"`}
          </p>
        </div>
        {canCreate && (
          <button className="wx-btn wx-btn-primary" onClick={() => setShowCreate(true)}>
            <PlusIcon width="16" height="16" /> Add {title.replace(/s$/, '')}
          </button>
        )}
      </div>

      {/* Only worth showing once somebody has actually left this role. */}
      {formerRows.length > 0 && (
        <div className="wx-segmented" role="tablist" aria-label="Current or former staff" style={{ marginBottom: 12 }}>
          <button
            type="button" role="tab" className="wx-segmented-btn"
            aria-selected={!isFormer} data-active={!isFormer}
            onClick={() => setTab('current')}
          >
            Current <span className="wx-segmented-n">{rows.length}</span>
          </button>
          <button
            type="button" role="tab" className="wx-segmented-btn"
            aria-selected={isFormer} data-active={isFormer}
            onClick={() => setTab('former')}
          >
            Ex-employees <span className="wx-segmented-n">{formerRows.length}</span>
          </button>
        </div>
      )}

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
          <div>{isFormer ? 'Left' : 'Status'}</div>
          <div />
        </div>

        {busy && (
          <div className="wx-empty">
            <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
          </div>
        )}

        {!busy && filtered.length === 0 && (
          <div className="wx-empty">
            <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
              <UsersIcon width="22" height="22" />
            </div>
            <div className="wx-empty-title">
              {isFormer ? `No former ${title.toLowerCase()}` : `No ${title.toLowerCase()} yet`}
            </div>
            <div>
              {isFormer
                ? 'Nobody in this role has left.'
                : (emptyHint || 'Click the button above to add one.')}
            </div>
          </div>
        )}

        {!busy && filtered.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            former={isFormer}
            isSelf={me?.id === u.id}
            canEdit={canEdit}
            canRetire={canRetire}
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

function UserRow({ user, former = false, isSelf, canEdit = true, canRetire = true, onEdit, onDelete }) {
  const initials = (user.display_name || user.email || '?')
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  const extras = getRoleExtras(user.role);
  const activePerms = extras.permissions.filter((p) => user.permissions?.[p.key]);
  return (
    <div className="wx-list-row" data-former={former || undefined}>
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
        {former ? (
          <span className="wx-badge wx-badge-muted" title={user.deleted_at || ''}>
            <span className="wx-badge-dot" /> {leftOn(user.deleted_at)}
          </span>
        ) : user.is_active ? (
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
        {/* A former member has no account to edit and cannot be retired twice,
            so the row is read-only. Their history stays reachable through the
            reports and audit trail that still reference them. */}
        {!former && canEdit && (
          <button
            className="wx-btn wx-btn-ghost"
            style={{ padding: '6px 12px', fontSize: 12.5 }}
            onClick={onEdit}
          >
            <PencilIcon width="14" height="14" /> Edit
          </button>
        )}
        {!former && canRetire && !isSelf && user.role !== 'boss' && (
          <button
            className="wx-btn wx-btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--danger)' }}
            onClick={onDelete}
            title="Mark as ex-employee"
            aria-label="Mark as ex-employee"
          >
            <TrashIcon width="14" height="14" />
          </button>
        )}
      </div>
    </div>
  );
}

// "Left 12 Oct 2026" — the date is what the Boss is scanning for.
function leftOn(ts) {
  if (!ts) return 'Ex-employee';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'Ex-employee';
  return `Left ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
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
              background: 'var(--danger-soft)', color: 'var(--danger-text)',
              display: 'grid', placeItems: 'center', flex: '0 0 auto',
            }}>
              <TrashIcon width="16" height="16" />
            </span>
            Mark as ex-employee
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
            Mark <strong>{user.display_name || user.email}</strong> as an ex-employee?
          </div>
          {/* The old copy said "This is permanent … a deleted account", which
              was never what happens: delete-user soft-deletes, so the person
              and their history are kept. Saying otherwise made the Boss think
              retiring someone destroyed their records. */}
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
            They lose access immediately and are signed out of any open session. Nothing is deleted:
            their reports, approvals and assignments stay as they are, and you will find them under
            <strong style={{ color: 'var(--text-secondary)' }}> Ex-employees</strong> on this page.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
            Reassign their brands and anyone reporting to them first — those do not move by themselves.
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
              color: canSubmit ? 'var(--on-danger)' : 'var(--text-muted)',
              border: 0,
              fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
            onClick={handleDelete}
            disabled={!canSubmit}
          >
            {deleting ? <><span className="wx-spinner" /> Saving…</> : 'Mark as ex-employee'}
          </button>
        </div>
      </div>
    </div>
  );
}
