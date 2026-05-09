import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  createTask, createGroupTasks, updateTask, listAssignableUsers, listBrandsForTaskCreate,
  getUserResetSchedule, formatResetHint,
} from '../../lib/tasksApi';
import { supabase } from '../../lib/supabase';
import { XIcon, AlertIcon, UserIcon } from '../common/Icon';
import TaskCommentsPanel from './TaskCommentsPanel';
import TaskAttachmentsPanel from './TaskAttachmentsPanel';

const CATEGORY_OPTIONS = [
  { v: 'general', label: 'General', hint: 'One-off task' },
  { v: 'daily',   label: 'Daily',   hint: 'Resets each day' },
  { v: 'weekly',  label: 'Weekly',  hint: 'Resets each week' },
  { v: 'monthly', label: 'Monthly', hint: 'Resets each month' },
];
const PRIORITY_OPTIONS = [
  { v: 'low',    label: 'Low' },
  { v: 'medium', label: 'Medium' },
  { v: 'high',   label: 'High' },
];

/**
 * Create or edit a task.
 * Props:
 *   task       — existing task (edit mode) or null (create)
 *   onClose    — () => void
 *   onSaved    — (task) => void
 */
export default function CreateTaskModal({ task, onClose, onSaved, defaultBrandId = null }) {
  const { user, profile } = useAuth();
  const isEdit = !!task;
  // Everyone can create brand-tagged tasks. The assignee scope below
  // restricts who they can hand it off to: APC always self-assigns;
  // IPC self-assigns unless they have canManageTasks (then they can
  // group-assign to multiple APCs at once).
  const canCreateBrandTask = true;
  const ipcCanAssign = profile?.role === 'ipc' && !!profile?.permissions?.canManageTasks;
  const selfAssignOnly = profile?.role === 'apc' || (profile?.role === 'ipc' && !ipcCanAssign);
  const isIpcGroupMode = ipcCanAssign && !isEdit; // IPC group fan-out is create-only

  const [isPersonal, setIsPersonal] = useState(
    isEdit ? (task.brand_id == null && task.assignee_id === task.created_by) : false,
  );
  const [title, setTitle]             = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [category, setCategory]       = useState(task?.category || 'general');
  const [priority, setPriority]       = useState(task?.priority || 'medium');
  const [dueDate, setDueDate]         = useState(task?.due_date || '');
  const [link, setLink]               = useState(task?.link || '');
  // Notifications are opt-in — the assignee only gets pinged when
  // this is ticked. Always starts unchecked for both create + edit.
  const [notify, setNotify]           = useState(false);
  const [brandId, setBrandId]         = useState(task?.brand_id || defaultBrandId || '');
  // APC/IPC always self-assign their tasks (whether personal or
  // brand-tagged) so we lock assigneeId to the current user upfront.
  const [assigneeId, setAssigneeId]   = useState(
    task?.assignee_id || ((isPersonal || selfAssignOnly) ? user?.id : ''),
  );
  // IPC group-mode: array of APC user-ids the task should fan out to.
  const [ipcSelectedIds, setIpcSelectedIds] = useState([]);
  const [ipcSearch, setIpcSearch]           = useState('');

  const [brands, setBrands]           = useState([]);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [assignees, setAssignees]     = useState([]);
  const [assigneesLoading, setAssigneesLoading] = useState(false);
  const [assigneeSchedule, setSchedule] = useState(null);

  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  // Load brand list (non-personal, and creator role allows it)
  useEffect(() => {
    if (isPersonal || !canCreateBrandTask) { setBrands([]); setBrandsLoading(false); return; }
    let cancelled = false;
    setBrandsLoading(true);
    listBrandsForTaskCreate({ creatorRole: profile.role, creatorId: user.id })
      .then((list) => { if (!cancelled) setBrands(list); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setBrandsLoading(false); });
    return () => { cancelled = true; };
  }, [isPersonal, canCreateBrandTask, profile?.role, user?.id]);

  // Load assignee list whenever brand or personal toggle changes
  useEffect(() => {
    if (isPersonal) {
      setAssignees([]);
      setAssigneesLoading(false);
      setAssigneeId(user?.id);
      return;
    }
    let cancelled = false;
    setAssigneesLoading(true);
    listAssignableUsers({
      creatorRole: profile.role,
      creatorId: user.id,
      brandId: brandId || null,
    })
      .then((list) => { if (!cancelled) setAssignees(list); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setAssigneesLoading(false); });
    return () => { cancelled = true; };
  }, [isPersonal, brandId, profile?.role, user?.id]);

  // Load assignee reset schedule (for hint text)
  useEffect(() => {
    const id = isPersonal ? user?.id : assigneeId;
    if (!id) { setSchedule(null); return; }
    let cancelled = false;
    getUserResetSchedule(id)
      .then((s) => { if (!cancelled) setSchedule(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [assigneeId, isPersonal, user?.id]);

  const resetHint = useMemo(
    () => (category === 'general' ? '' : formatResetHint(category, assigneeSchedule)),
    [category, assigneeSchedule],
  );

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!title.trim()) return setError('Title is required.');

    // ---- IPC group fan-out -------------------------------------
    // When an IPC has canManageTasks and picks multiple APCs, we
    // create one task per APC. The selected `brandId` (if any)
    // becomes the brand for ALL fan-out rows; if blank, brand
    // auto-resolves per APC from their first brand_assignment.
    if (isIpcGroupMode && ipcSelectedIds.length > 0 && !isPersonal) {
      try {
        setSaving(true);
        let pairs;
        if (brandId) {
          // Specific brand override — every fan-out row uses this brand.
          pairs = ipcSelectedIds.map((id) => ({ brandId, assigneeId: id }));
        } else {
          // Auto-resolve: query brand_assignments for each picked APC and
          // use their first one. APCs without an assignment get a null
          // brand (general task).
          const { data: assigns, error: aErr } = await supabase
            .from('brand_assignments')
            .select('user_id, brand_id')
            .in('user_id', ipcSelectedIds);
          if (aErr) throw new Error(aErr.message);
          const firstByUser = new Map();
          (assigns || []).forEach((r) => {
            if (!firstByUser.has(r.user_id)) firstByUser.set(r.user_id, r.brand_id);
          });
          pairs = ipcSelectedIds.map((id) => ({
            brandId: firstByUser.get(id) || null,
            assigneeId: id,
          }));
        }
        const saved = await createGroupTasks({
          pairs, title, description, category, priority, dueDate, link, notify,
        });
        onSaved(Array.isArray(saved) ? saved[0] : saved);
        return;
      } catch (err) {
        setError(err.message || 'Failed to fan-out tasks.');
        return;
      } finally {
        setSaving(false);
      }
    }

    // ---- Single-assignee path (unchanged) ----------------------
    const effectiveAssignee = isPersonal ? user.id : assigneeId;
    const effectiveBrand    = isPersonal ? null : (brandId || null);

    if (!effectiveAssignee) return setError('Please pick an assignee.');

    try {
      setSaving(true);
      let saved;
      if (isEdit) {
        saved = await updateTask(task.id, {
          title, description, category, priority, dueDate, link,
          assigneeId: effectiveAssignee,
          notify,
        });
      } else {
        saved = await createTask({
          brandId: effectiveBrand,
          assigneeId: effectiveAssignee,
          title, description, category, priority, dueDate, link,
          notify,
        });
      }
      onSaved(saved);
    } catch (err) {
      setError(err.message || 'Failed to save task.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">{isEdit ? 'Edit task' : 'Add task'}</div>
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

            {/* Personal toggle */}
            {!isEdit && (
              <button
                type="button"
                onClick={() => setIsPersonal((v) => !v)}
                disabled={saving}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 16px',
                  width: '100%',
                  background: isPersonal ? 'var(--accent-soft)' : 'var(--surface-2)',
                  border: `1.5px solid ${isPersonal ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-md)',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  marginBottom: 14,
                  textAlign: 'left',
                  color: 'inherit',
                  transition: 'all var(--dur-fast)',
                }}
              >
                <span
                  style={{
                    width: 38,
                    height: 38,
                    flex: '0 0 38px',
                    borderRadius: 'var(--radius-md)',
                    background: isPersonal ? 'var(--accent)' : 'var(--surface-1)',
                    color: isPersonal ? 'var(--on-accent)' : 'var(--text-muted)',
                    display: 'grid',
                    placeItems: 'center',
                    border: `1px solid ${isPersonal ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    transition: 'all var(--dur-fast)',
                  }}
                >
                  <UserIcon width="18" height="18" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: 'block',
                    fontWeight: 700,
                    color: isPersonal ? 'var(--accent)' : 'var(--text-primary)',
                    fontSize: 13.5,
                  }}>
                    Personal task
                  </span>
                  <span style={{
                    display: 'block',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginTop: 2,
                  }}>
                    Only you will see it — no brand, self-assigned.
                  </span>
                </span>
                <MiniToggle checked={isPersonal} />
              </button>
            )}

            {/* Brand picker (not personal) */}
            {!isPersonal && canCreateBrandTask && (
              <div style={{ marginBottom: 12 }}>
                <label className="wx-label">
                  Brand <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span>
                </label>
                {brandsLoading ? (
                  <div style={loadingHintStyle}>
                    <span className="wx-spinner" /> Loading brands…
                  </div>
                ) : brands.length === 0 ? (
                  <div style={emptyHintStyle}>
                    No brands available yet. The task will be created without a brand.
                  </div>
                ) : (
                  <select
                    className="wx-input"
                    value={brandId}
                    onChange={(e) => setBrandId(e.target.value)}
                    disabled={saving || isEdit}
                  >
                    <option value="">— No brand (general task) —</option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>{b.brand_name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Assignee — hidden when the current role can only
                self-assign (APC, or IPC without canManageTasks). The
                actual assigneeId is already pinned to user.id in state.

                IPC group mode (canManageTasks): a multi-pick list of
                APCs replaces the single-select dropdown so one form
                fans out into one task per picked APC. */}
            {!isPersonal && !selfAssignOnly && !isIpcGroupMode && (
              <div style={{ marginBottom: 12 }}>
                <label className="wx-label">Assign to <span style={{ color: 'var(--danger)' }}>*</span></label>
                {assigneesLoading ? (
                  <div style={loadingHintStyle}>
                    <span className="wx-spinner" /> Loading assignees…
                  </div>
                ) : assignees.length === 0 ? (
                  <div style={emptyHintStyle}>
                    {brandId
                      ? 'No one is managing this brand yet. Pick a different brand, or assign APCs first from Brands.'
                      : 'No users available to assign in your scope. Create users in Manage Users first.'}
                  </div>
                ) : (
                  <select
                    className="wx-input"
                    value={assigneeId}
                    onChange={(e) => setAssigneeId(e.target.value)}
                    disabled={saving}
                  >
                    <option value="">— Select —</option>
                    {assignees.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name} · {u.role?.toUpperCase()}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* IPC group-pick — multi-select APCs. When brandId is blank
                each task auto-resolves brand from the picked APC's first
                brand_assignment. When brandId is set, it overrides for
                every fan-out row. */}
            {!isPersonal && isIpcGroupMode && (
              <div style={{ marginBottom: 12 }}>
                <label className="wx-label">
                  Assign to APCs <span style={{ color: 'var(--danger)' }}>*</span>{' '}
                  {ipcSelectedIds.length > 0 && (
                    <span style={{ fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>
                      ({ipcSelectedIds.length} selected — one task per APC)
                    </span>
                  )}
                </label>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {brandId
                    ? 'Brand selected above will apply to every task.'
                    : 'Brand auto-resolves to each APC\'s first assigned brand. Pick a brand above to override.'}
                </div>
                <input className="wx-input"
                  placeholder="Search APCs by name…"
                  value={ipcSearch}
                  onChange={(e) => setIpcSearch(e.target.value)}
                  style={{ marginBottom: 6 }} />
                {assigneesLoading ? (
                  <div style={loadingHintStyle}>
                    <span className="wx-spinner" /> Loading APCs…
                  </div>
                ) : assignees.length === 0 ? (
                  <div style={emptyHintStyle}>No APCs available.</div>
                ) : (
                  <div style={{
                    maxHeight: 200, overflowY: 'auto',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-1)',
                  }}>
                    {assignees
                      .filter((u) => !ipcSearch.trim() || (u.display_name || '').toLowerCase().includes(ipcSearch.toLowerCase()))
                      .map((u) => {
                        const checked = ipcSelectedIds.includes(u.id);
                        return (
                          <label key={u.id}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 10px', cursor: 'pointer',
                              borderBottom: '1px solid var(--border-subtle)',
                              background: checked ? 'var(--accent-soft)' : 'transparent',
                            }}>
                            <input type="checkbox" checked={checked}
                              onChange={() => setIpcSelectedIds((prev) =>
                                checked ? prev.filter((x) => x !== u.id) : [...prev, u.id]
                              )} />
                            <span style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 600 }}>
                              {u.display_name}
                            </span>
                            <span style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                              {u.email}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            {/* Self-assign hint for APC and (no-permission) IPC — they
                can't hand work off, only create tasks for themselves. */}
            {!isPersonal && selfAssignOnly && !isIpcGroupMode && (
              <div style={{
                ...loadingHintStyle,
                marginBottom: 12,
                background: 'var(--accent-soft)',
                borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
                color: 'var(--text-primary)',
              }}>
                <UserIcon width="14" height="14" style={{ color: 'var(--accent)' }} />
                <span>
                  This task will be assigned to <strong>you</strong>.
                </span>
              </div>
            )}

            {/* Title */}
            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Title <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                className="wx-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
                placeholder="e.g. Review weekly analytics"
              />
            </div>

            {/* Description */}
            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Description</label>
              <textarea
                className="wx-input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
                placeholder="Add context…"
                style={{ resize: 'vertical', minHeight: 70 }}
              />
            </div>

            {/* Category + priority */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12 }}>
              <div>
                <label className="wx-label">Category</label>
                <select
                  className="wx-input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={saving}
                >
                  {CATEGORY_OPTIONS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                </select>
                {resetHint && (
                  <div style={{
                    fontSize: 11.5,
                    color: 'var(--accent)',
                    marginTop: 6,
                    fontWeight: 600,
                  }}>
                    ⟳ {resetHint}
                  </div>
                )}
              </div>
              <div>
                <label className="wx-label">Priority</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {PRIORITY_OPTIONS.map((p) => (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => setPriority(p.v)}
                      disabled={saving}
                      className={`wx-role-chip ${priority === p.v ? 'wx-role-chip-active' : ''}`}
                      style={{ flex: 1, textAlign: 'center', padding: '8px 4px' }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Due + link */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <label className="wx-label">Due date <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
                <input
                  type="date"
                  className="wx-input"
                  value={dueDate || ''}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={saving}
                />
              </div>
              <div>
                <label className="wx-label">Link <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
                <input
                  type="url"
                  className="wx-input"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  disabled={saving}
                  placeholder="https://…"
                />
              </div>
            </div>

            {isEdit && task?.id && <TaskAttachmentsPanel taskId={task.id} />}
            {isEdit && task?.id && <TaskCommentsPanel taskId={task.id} />}

            {/* Opt-in notification — default off so silent edits don't
                ping the assignee. Hidden in personal-task mode since
                there's no one else to notify. */}
            {!isPersonal && (() => {
              // Dynamic notify label — name the "other" person so it's
              // obvious who gets pinged. Resolved against:
              //   * Create flow → notify the chosen assignee
              //   * Edit flow → notify the relevant counterpart
              //     (creator if I'm assignee, assignee if I'm creator)
              const me = user?.id;
              const isAssignee = isEdit && task?.assignee_id === me;
              const isCreator  = isEdit && task?.created_by  === me;
              const creatorName  = task?.creator?.display_name  || 'creator';
              const assigneeName = (() => {
                if (isEdit) return task?.assignee?.display_name || 'assignee';
                const picked = assignees.find((u) => u.id === assigneeId);
                return picked?.display_name || 'the assignee';
              })();
              let label;
              let hint;
              if (!isEdit) {
                label = `Notify ${assigneeName}`;
                hint  = 'Send an in-app + push notification announcing the new task.';
              } else if (isAssignee && !isCreator) {
                label = `Notify ${creatorName}`;
                hint  = 'Send an in-app + push notification about this change. Leave off for a silent update.';
              } else if (isCreator && !isAssignee) {
                label = `Notify ${assigneeName}`;
                hint  = 'Send an in-app + push notification about this change. Leave off for a silent update.';
              } else {
                label = `Notify ${creatorName} & ${assigneeName}`;
                hint  = 'Send an in-app + push notification about this change. Leave off for a silent update.';
              }
              return (
                <label style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 12px', marginTop: 6,
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  background: notify ? 'var(--accent-soft)' : 'var(--surface-1)',
                  cursor: 'pointer',
                  transition: 'background var(--dur-fast)',
                }}>
                  <input type="checkbox" checked={notify}
                    onChange={(e) => setNotify(e.target.checked)}
                    disabled={saving}
                    style={{ marginTop: 2 }} />
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                    <strong>{label}</strong>
                    <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                      {hint}
                    </div>
                  </span>
                </label>
              );
            })()}
          </div>

          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : (isEdit ? 'Save changes' : 'Create task')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const emptyHintStyle = {
  border: '1px dashed var(--border-default)',
  background: 'var(--surface-2)',
  padding: '10px 14px',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-muted)',
  fontSize: 12.5,
  lineHeight: 1.4,
};

// Distinct from emptyHintStyle so loading reads as "we're working
// on it" rather than "there's nothing here".
const loadingHintStyle = {
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-2)',
  padding: '10px 14px',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-secondary)',
  fontSize: 12.5,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

function MiniToggle({ checked }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 36,
        height: 22,
        flex: '0 0 36px',
        borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--surface-3)',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-default)'}`,
        position: 'relative',
        transition: 'all var(--dur-fast)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          // Center vertically regardless of border / box-sizing quirks.
          top: '50%',
          transform: 'translateY(-50%)',
          left: checked ? 16 : 2,
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
