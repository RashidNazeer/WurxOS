import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import { useNotifications } from '../../contexts/NotificationsContext';
import { formatRelTime } from '../../lib/notificationsApi';
import {
  XIcon, CheckIcon, ChecklistIcon, ReportIcon, StoreIcon,
  MegaphoneIcon, HomeIcon, BookmarkIcon, StarIcon, MessageIcon, UsersIcon,
} from '../common/Icon';
import '../../styles/notifications.css';

// Category → icon + color-class suffix. Suffixes that don't have a
// dedicated color fall back to a sensible neighbour (see notifications.css).
const CATEGORY_META = {
  task:        { label: 'Task',        icon: ChecklistIcon, cat: 'task' },
  report:      { label: 'Report',      icon: ReportIcon,    cat: 'report' },
  brand:       { label: 'Brand',       icon: StoreIcon,     cat: 'brand' },
  paid_collab: { label: 'Paid Collab', icon: MegaphoneIcon, cat: 'paid_collab' },
  leave:       { label: 'Leave',       icon: HomeIcon,      cat: 'leave' },
  resource:    { label: 'Resource',    icon: BookmarkIcon,  cat: 'resource' },
  performance: { label: 'Performance', icon: StarIcon,      cat: 'performance' },
  agenda:      { label: 'Agenda',      icon: ChecklistIcon, cat: 'agenda' },
  creator_library: { label: 'Creator Library', icon: UsersIcon, cat: 'brand' },
  salary:      { label: 'Salary',      icon: StarIcon,      cat: 'performance' },
  hr:          { label: 'HR',          icon: ChecklistIcon, cat: 'agenda' },
  system:      { label: 'System',      icon: MessageIcon,   cat: 'system' },
};

const LEAVE_MS = 240;   // keep in sync with the .is-leaving animation duration

export default function NotificationToaster() {
  const { toasts, dismissToast, clearToasts, markRead, markAllRead } = useNotifications();
  const navigate = useNavigate();

  // Only ever show the head of the queue; closing it reveals the next.
  const current = toasts[0];
  if (!current) return null;

  function open(n) {
    markRead(n.id);
    if (n.link) { const go = () => navigate(n.link); if (!maybeGuardLeave(go)) go(); }
    dismissToast(n.id);
  }

  return createPortal(
    <div className="notif-toast-region" role="region" aria-label="Notifications">
      <ToastCard
        key={current.id}
        n={current}
        remaining={toasts.length}
        onClose={() => dismissToast(current.id)}
        onOpen={() => open(current)}
        onMarkAll={() => { markAllRead(); clearToasts(); }}
      />
    </div>,
    document.body,
  );
}

// ============================================================
// A single popup card. Owns its enter/leave animation: the parent
// swaps `key` per notification so each new head re-mounts and slides
// in; closing plays the leave animation, THEN tells the parent to
// drop it from the queue.
function ToastCard({ n, remaining, onClose, onOpen, onMarkAll }) {
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  function close(after) {
    if (leaving) return;
    setLeaving(true);
    timerRef.current = setTimeout(after, LEAVE_MS);
  }

  const meta = CATEGORY_META[n.category] || CATEGORY_META.system;
  const Icon = meta.icon;
  const more = remaining - 1;

  return (
    <div className={`notif-toast-wrap${more > 0 ? ' has-stack' : ''}`}>
      {more > 0 && <span className="notif-toast-ghost notif-toast-ghost-1" aria-hidden="true" />}
      {more > 1 && <span className="notif-toast-ghost notif-toast-ghost-2" aria-hidden="true" />}

      <div className={`notif-toast${leaving ? ' is-leaving' : ''}`} role="alert">
        <span className={`notif-toast-rail notif-toast-rail-${meta.cat}`} aria-hidden="true" />

        <div className="notif-toast-head">
          <span className={`notif-toast-icon notif-toast-icon-${meta.cat}`}>
            {n.actor?.avatar_url
              ? <img src={n.actor.avatar_url} alt="" />
              : <Icon width="15" height="15" />}
          </span>
          <span className="notif-toast-cat">{meta.label}</span>
          {more > 0 && <span className="notif-toast-badge">+{more} more</span>}
          <span className="notif-toast-time">{formatRelTime(n.created_at)}</span>
          <button
            type="button"
            className="notif-toast-x"
            aria-label="Dismiss"
            onClick={() => close(onClose)}
          >
            <XIcon width="14" height="14" />
          </button>
        </div>

        <button type="button" className="notif-toast-body" onClick={() => close(onOpen)}>
          <div className="notif-toast-title">{n.title}</div>
          {n.body && <div className="notif-toast-text">{n.body}</div>}
        </button>

        <div className="notif-toast-foot">
          {n.link
            ? <button type="button" className="notif-toast-open" onClick={() => close(onOpen)}>View details</button>
            : <span />}
          <button type="button" className="notif-toast-markall" onClick={() => close(onMarkAll)}>
            <CheckIcon width="13" height="13" /> Mark all as read
          </button>
        </div>
      </div>
    </div>
  );
}
