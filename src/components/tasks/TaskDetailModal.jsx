import { XIcon, PencilIcon, StoreIcon, UserIcon, CalendarIcon, ClockIcon, CheckIcon, AlertIcon, LinkIcon } from '../common/Icon';
import BrandAvatar from '../brands/BrandAvatar';
import TaskCommentsPanel from './TaskCommentsPanel';
import TaskAttachmentsPanel from './TaskAttachmentsPanel';

/**
 * Read-mostly task detail popup. Anyone who can see the task can see
 * this modal — it shows the full picture (assigned by / assigned to /
 * brand / due date / category / priority / link / description /
 * comments / attachments). Edit is exposed via the top-right Edit
 * button only when the caller passes `canEdit=true`.
 */

const STATUS_META = {
  todo:        { label: 'To do',       fg: 'var(--text-secondary)', dot: 'var(--border-strong)' },
  in_progress: { label: 'In progress', fg: 'var(--warning)',         dot: 'var(--warning)' },
  done:        { label: 'Done',        fg: 'var(--success)',         dot: 'var(--success)' },
};
const PRIORITY_META = {
  low:    { label: 'Low',    fg: '#475569' },
  medium: { label: 'Medium', fg: '#b45309' },
  high:   { label: 'High',   fg: '#b91c1c' },
};
const CATEGORY_META = {
  general: { label: 'General' },
  daily:   { label: 'Daily'   },
  weekly:  { label: 'Weekly'  },
  monthly: { label: 'Monthly' },
};

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const chipBase = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '4px 10px', borderRadius: 999,
  fontSize: 11.5, fontWeight: 600,
  background: 'var(--surface-2)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
};

function dueLabel(d, status) {
  if (status === 'done') return { label: 'Completed', tone: 'var(--success)' };
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(d); due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0)   return { label: `${Math.abs(days)}d overdue`, tone: 'var(--danger)' };
  if (days === 0) return { label: 'Due today', tone: 'var(--warning)' };
  if (days === 1) return { label: 'Due tomorrow', tone: 'var(--warning)' };
  return { label: `Due in ${days}d`, tone: 'var(--text-secondary)' };
}

function Row({ icon: Icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ flex: '0 0 30px', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 2, color: 'var(--text-muted)' }}>
        {Icon && <Icon width="15" height="15" />}
      </div>
      <div style={{ flex: '0 0 110px', fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, paddingTop: 2 }}>
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text-primary)' }}>
        {children}
      </div>
    </div>
  );
}

export default function TaskDetailModal({ task, canEdit, onClose, onEdit }) {
  if (!task) return null;
  const status   = STATUS_META[task.status]     || STATUS_META.todo;
  const priority = PRIORITY_META[task.priority] || PRIORITY_META.medium;
  const category = CATEGORY_META[task.category] || CATEGORY_META.general;
  // Recurring tasks never have a meaningful due — skip the chip.
  const due = task.category && task.category !== 'general'
    ? null
    : dueLabel(task.due_date, task.status);

  const assigneeName = task.assignee?.display_name || task.assignee?.email?.split('@')[0] || '—';
  const assigneeRole = task.assignee?.role || '';
  const creatorName  = task.creator?.display_name  || '—';
  const creatorRole  = task.creator?.role || '';

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span
              aria-hidden
              style={{
                width: 10, height: 10, borderRadius: '50%', flex: '0 0 auto',
                background: status.dot,
                boxShadow: task.status === 'in_progress' ? '0 0 0 3px color-mix(in srgb, var(--warning) 25%, transparent)' : 'none',
              }}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {canEdit && (
              <button
                type="button"
                className="wx-btn wx-btn-ghost"
                onClick={onEdit}
                style={{ padding: '6px 10px', fontSize: 12 }}
                title="Edit"
              >
                <PencilIcon width="13" height="13" /> Edit
              </button>
            )}
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
        </div>

        <div className="wx-modal-body" style={{ paddingBottom: 8 }}>
          {/* Status / priority / category / due — chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <span style={{ ...chipBase, color: status.fg }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.dot, display: 'inline-block' }} />
              {status.label}
            </span>
            <span style={{ ...chipBase, color: priority.fg }}>
              {priority.label} priority
            </span>
            <span style={chipBase}>{category.label}</span>
            {due && (
              <span style={{ ...chipBase, color: due.tone }}>
                <CalendarIcon width="11" height="11" /> {due.label}
              </span>
            )}
          </div>

          {/* Description */}
          {task.description && (
            <div
              style={{
                background: 'var(--surface-2)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                marginBottom: 14,
                fontSize: 13,
                color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {task.description}
            </div>
          )}

          {/* Meta rows */}
          <div style={{ marginBottom: 14 }}>
            <Row icon={UserIcon} label="Assigned to">
              <span style={{ fontWeight: 600 }}>{assigneeName}</span>
              {assigneeRole && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 12 }}>· {assigneeRole.toUpperCase()}</span>
              )}
            </Row>
            <Row icon={UserIcon} label="Assigned by">
              <span style={{ fontWeight: 600 }}>{creatorName}</span>
              {creatorRole && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 12 }}>· {creatorRole.toUpperCase()}</span>
              )}
            </Row>
            {task.brand_id ? (
              <Row icon={StoreIcon} label="Brand">
                {task.brand ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <BrandAvatar brand={task.brand} size={20} />
                    <span style={{ fontWeight: 600 }}>{task.brand.brand_name}</span>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>—</span>
                )}
              </Row>
            ) : (
              <Row icon={UserIcon} label="Scope">
                <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Personal / general (no brand)</span>
              </Row>
            )}
            {/* Recurring tasks never carry a due date — they reset on
                their own schedule. Hide the row entirely instead of
                showing "—". */}
            {(!task.category || task.category === 'general') && (
              <Row icon={CalendarIcon} label="Due date">
                {formatDate(task.due_date)}
              </Row>
            )}
            {task.link && (
              <Row icon={LinkIcon} label="Link">
                <a
                  href={task.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)', wordBreak: 'break-all' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {task.link}
                </a>
              </Row>
            )}
            <Row icon={ClockIcon} label="Created">
              <span style={{ color: 'var(--text-secondary)' }}>{formatDateTime(task.created_at)}</span>
            </Row>
            {task.updated_at && task.updated_at !== task.created_at && (
              <Row icon={ClockIcon} label="Updated">
                <span style={{ color: 'var(--text-secondary)' }}>{formatDateTime(task.updated_at)}</span>
              </Row>
            )}
          </div>

          {/* Attachments */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 8 }}>
              Attachments
            </div>
            <TaskAttachmentsPanel taskId={task.id} />
          </div>

          {/* Comments */}
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 8 }}>
              Comments
            </div>
            <TaskCommentsPanel taskId={task.id} />
          </div>
        </div>

        <div className="wx-modal-footer">
          <button type="button" className="wx-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
