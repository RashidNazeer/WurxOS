import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BrandAvatar from '../brands/BrandAvatar';
import { CheckIcon, PencilIcon, ChevronDownIcon } from '../common/Icon';
import { updateTask } from '../../lib/tasksApi';
import '../../styles/tasks.css';

const STATUS_OPTIONS = [
  { v: 'todo',        label: 'To do',       dot: 'var(--border-strong)' },
  { v: 'in_progress', label: 'In progress', dot: 'var(--warning)' },
  { v: 'done',        label: 'Done',        dot: 'var(--success)' },
];
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.v, o.label]));

// Cycle order for quick single-click on the check circle
const NEXT_STATUS = { todo: 'in_progress', in_progress: 'done', done: 'todo' };

export default function TaskRow({ task, canEdit, onEdit, onView, onChanged, currentUserId, selected, onToggleSelect }) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null); // { top, left }
  // Notification opt-in for status changes — default off so silent
  // ticks don't ping the creator/assignee. The checkbox lives inside
  // the status dropdown; the single-click cycle button is always
  // silent by design.
  const [notifyOnStatus, setNotifyOnStatus] = useState(false);
  const pillRef = useRef(null);
  const menuRef = useRef(null);

  const isPersonal = !task.brand_id
    && task.created_by === task.assignee_id
    && task.assignee_id === currentUserId;

  const canChangeStatus = canEdit || task.assignee_id === currentUserId;
  const done = task.status === 'done';
  // Recurring tasks (daily/weekly/monthly) reset on their own
  // schedule, so they intentionally don't carry a due date and can
  // never be "overdue". The data migration cleared old values; this
  // is the UI safety net for any that slipped through.
  const dueInfo = task.category && task.category !== 'general'
    ? null
    : formatDue(task.due_date, task.status);

  // Close on outside click / scroll / resize
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)
          && pillRef.current && !pillRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    function onScrollOrResize() { setMenuOpen(false); }
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [menuOpen]);

  // Position the fixed-position menu under the pill
  useLayoutEffect(() => {
    if (!menuOpen || !pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    const menuWidth = 180;
    const left = Math.min(window.innerWidth - menuWidth - 8, r.right - menuWidth);
    setMenuPos({ top: r.bottom + 6, left: Math.max(8, left), width: menuWidth });
  }, [menuOpen]);

  async function setStatus(newStatus, { notify = false } = {}) {
    if (busy || newStatus === task.status) { setMenuOpen(false); return; }
    setBusy(true);
    try {
      const updated = await updateTask(task.id, { status: newStatus, notify });
      // Preserve joined relations (brand/assignee/creator) — the update
      // response only returns raw columns.
      onChanged?.({ ...task, ...(updated || { status: newStatus }) });
    } finally {
      setBusy(false);
      setMenuOpen(false);
      setNotifyOnStatus(false);
    }
  }

  // The quick cycle button (single click on the check circle) is
  // always silent — users hit it dozens of times per day.
  const cycleStatus = () => setStatus(NEXT_STATUS[task.status] || 'in_progress');

  return (
    <div
      className="task-row"
      data-status={task.status}
      style={selected ? { background: 'var(--accent-soft)' } : undefined}
    >
      {/* Status stripe */}
      <div className="task-stripe" data-status={task.status} />

      {onToggleSelect && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          title="Select"
          style={{
            position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)',
            width: 14, height: 14, cursor: 'pointer',
          }}
        />
      )}

      {/* Large check circle — click to cycle */}
      <button
        type="button"
        className="task-status-btn"
        data-status={task.status}
        onClick={cycleStatus}
        disabled={!canChangeStatus || busy}
        title={canChangeStatus ? `${STATUS_LABEL[task.status]} — click to advance` : STATUS_LABEL[task.status]}
      >
        {done && <CheckIcon width="14" height="14" />}
      </button>

      {/* Title + meta — click anywhere here to open the detail popup */}
      <div
        style={{ minWidth: 0, cursor: onView ? 'pointer' : undefined }}
        onClick={onView ? () => onView(task) : undefined}
        role={onView ? 'button' : undefined}
        tabIndex={onView ? 0 : undefined}
        onKeyDown={onView ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onView(task); } } : undefined}
      >
        <div className={done ? 'task-title task-title-done' : 'task-title'}>
          {task.title}
        </div>
        <div className="task-meta">
          {task.category !== 'general' && (
            <span className="task-chip task-chip-category">⟳ {task.category}</span>
          )}
          <span className={`task-chip task-chip-priority-${task.priority}`}>
            {task.priority}
          </span>
          {isPersonal && <span className="task-chip task-chip-personal">Personal</span>}
          {task.covered_from_user_id && (
            <span className="task-chip" style={{
              background: 'color-mix(in srgb, var(--warning) 20%, transparent)',
              color: 'var(--warning)',
            }} title="Temporarily reassigned because the original owner is on leave">
              Coverage
            </span>
          )}
          {task.brand && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <BrandAvatar brand={task.brand} size={16} radius={4} />
              <strong style={{ color: 'var(--text-secondary)' }}>{task.brand.brand_name}</strong>
            </span>
          )}
          {task.assignee && !isPersonal && (
            <span>
              → <strong style={{ color: 'var(--text-secondary)' }}>{task.assignee.display_name}</strong>
            </span>
          )}
        </div>
      </div>

      {/* Due */}
      <div>
        {dueInfo && <div className={`task-due ${dueInfo.cls}`}>{dueInfo.label}</div>}
      </div>

      {/* Status pill — click to pick directly */}
      <div>
        <button
          ref={pillRef}
          type="button"
          className="task-status-pill"
          data-status={task.status}
          onClick={() => canChangeStatus && setMenuOpen((v) => !v)}
          disabled={!canChangeStatus || busy}
          title="Change status"
        >
          <span className="task-status-pill-dot" />
          {STATUS_LABEL[task.status]}
          {canChangeStatus && <ChevronDownIcon width="13" height="13" />}
        </button>
        {menuOpen && menuPos && createPortal(
          <div
            ref={menuRef}
            className="task-status-menu"
            style={{
              position: 'fixed',
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <button
                key={o.v}
                type="button"
                className="task-status-option"
                onClick={() => setStatus(o.v, { notify: notifyOnStatus })}
                disabled={busy}
              >
                <span className="task-status-option-dot" style={{ background: o.dot }} />
                {o.label}
                {task.status === o.v && (
                  <CheckIcon
                    width="14"
                    height="14"
                    style={{ marginLeft: 'auto', color: 'var(--accent)' }}
                  />
                )}
              </button>
            ))}
            <label
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', marginTop: 4,
                borderTop: '1px solid var(--border-subtle)',
                fontSize: 11.5, color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={notifyOnStatus}
                onChange={(e) => setNotifyOnStatus(e.target.checked)}
                style={{ margin: 0 }}
              />
              {/* Dynamic label — show only the "other" side, since
                  the actor doesn't need to be told what they did:
                  - assignee changing status      → notify creator
                  - creator changing status       → notify assignee
                  - admin on a self-assigned task → notify the one person
                  - admin on a normal task        → notify both */}
              {(() => {
                const isAssignee = task.assignee_id === currentUserId;
                const isCreator  = task.created_by  === currentUserId;
                // Prefer the assignee's CURRENT TL over the task's
                // historical creator. When an APC is reassigned to a
                // different TL, the task's `created_by` keeps pointing
                // at the original TL (set in mig 141), but the person
                // who actually needs the ping is the APC's current TL.
                // Fall back to the creator's name for tasks where the
                // assignee has no TL (e.g., boss/OL-assigned cross-team
                // work).
                const currentTlName = task.assignee?.current_tl?.display_name;
                const creatorName   = currentTlName || task.creator?.display_name || 'creator';
                const assigneeName  = task.assignee?.display_name || 'assignee';
                const selfAssigned  = task.created_by === task.assignee_id;
                if (isAssignee && !isCreator) return `Notify ${creatorName}`;
                if (isCreator  && !isAssignee) return `Notify ${assigneeName}`;
                if (isAssignee && isCreator)   return 'Notify yourself';
                // Admin acting on someone else's task. Avoid "Notify Hassan & Hassan"
                // when the task is self-assigned — there's only one person to notify.
                if (selfAssigned) return `Notify ${assigneeName}`;
                return `Notify ${creatorName} & ${assigneeName}`;
              })()}
            </label>
          </div>,
          document.body,
        )}
      </div>

      {/* Edit button (creator / admin / brand owner) */}
      {canEdit ? (
        <button
          className="wx-btn wx-btn-ghost"
          onClick={onEdit}
          style={{ padding: '6px 10px', fontSize: 12 }}
        >
          <PencilIcon width="13" height="13" /> Edit
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function formatDue(d, status) {
  // Done tasks never show overdue/due — they're done. Show "Completed"
  // (with no date) regardless of the original deadline.
  if (status === 'done') return { label: 'Completed', cls: 'task-due-done' };
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(d); due.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / (1000 * 60 * 60 * 24));
  if (diff < 0)  return { label: `${Math.abs(diff)}d overdue`, cls: 'task-due-overdue' };
  if (diff === 0) return { label: 'Due today',                  cls: 'task-due-today' };
  if (diff === 1) return { label: 'Due tomorrow',               cls: '' };
  if (diff <= 7)  return { label: `Due in ${diff}d`,            cls: '' };
  return { label: due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), cls: '' };
}
