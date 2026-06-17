import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import { useNotifications } from '../../contexts/NotificationsContext';
import { formatRelTime } from '../../lib/notificationsApi';
import {
  BellIcon, CheckIcon, ChecklistIcon, ReportIcon, StoreIcon,
  MegaphoneIcon, HomeIcon, BookmarkIcon, StarIcon, MessageIcon,
} from '../common/Icon';
import '../../styles/notifications.css';

// Category metadata (icon + class suffix used in the avatar badge color).
const CATEGORY_META = {
  task:         { label: 'Tasks',        icon: ChecklistIcon },
  report:       { label: 'Reports',      icon: ReportIcon },
  brand:        { label: 'Brands',       icon: StoreIcon },
  paid_collab:  { label: 'Paid Collab',  icon: MegaphoneIcon },
  leave:        { label: 'Leave',        icon: HomeIcon },
  resource:     { label: 'Resources',    icon: BookmarkIcon },
  performance:  { label: 'Performance',  icon: StarIcon },
  agenda:       { label: 'Agenda',       icon: ChecklistIcon },
  salary:       { label: 'Salary',       icon: StarIcon },
  hr:           { label: 'HR',           icon: ChecklistIcon },
  system:       { label: 'System',       icon: MessageIcon },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

export default function NotificationBell() {
  const { items, counts, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [tab, setTab] = useState('all'); // 'all' | 'unread' | <category>
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const navigate = useNavigate();

  // Position the panel under the button (fixed → escapes any overflow)
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const panelWidth = 420;
    const left = Math.min(window.innerWidth - panelWidth - 12, r.right - panelWidth);
    setPos({ top: r.bottom + 8, left: Math.max(12, left) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    // Close on outer scroll only — scrolling INSIDE the panel must not
    // dismiss it, so we filter on the event target (capture phase).
    function onScroll(e) {
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onResize() { setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function handleItemClick(n) {
    markRead(n.id);
    setOpen(false);
    if (n.link) { const go = () => navigate(n.link); if (!maybeGuardLeave(go)) go(); }
  }

  const unread = counts.total || 0;

  // Visible tabs: All + Unread, then any category that actually has items.
  const visibleTabs = useMemo(() => {
    const present = new Set(items.map((n) => n.category));
    return [
      { key: 'all',    label: 'All',    count: items.length },
      { key: 'unread', label: 'Unread', count: items.filter((n) => !n.read_at).length },
      ...CATEGORY_ORDER
        .filter((c) => present.has(c))
        .map((c) => ({ key: c, label: CATEGORY_META[c].label, count: items.filter((n) => n.category === c).length })),
    ];
  }, [items]);

  // Apply the active tab filter, then group into Today / Yesterday / Earlier.
  const grouped = useMemo(() => {
    let list = items;
    if (tab === 'unread') list = list.filter((n) => !n.read_at);
    else if (tab !== 'all') list = list.filter((n) => n.category === tab);
    list = list.slice(0, 30);
    return groupByDate(list);
  }, [items, tab]);

  const totalShown = grouped.reduce((s, g) => s + g.items.length, 0);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="notif-bell"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
      >
        <BellIcon width="18" height="18" />
        {unread > 0 && (
          <span className="notif-bell-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="notif-panel"
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
        >
          <div className="notif-panel-header">
            <div className="notif-panel-title">
              Notifications
              {unread > 0 && <span className="notif-panel-title-count">{unread > 99 ? '99+' : unread}</span>}
            </div>
            {unread > 0 && (
              <button type="button" className="notif-panel-action" onClick={markAllRead}>
                <CheckIcon width="13" height="13" /> Mark all read
              </button>
            )}
          </div>

          <div className="notif-panel-tabs">
            {visibleTabs.map((t) => (
              <button key={t.key} type="button"
                className={`notif-tab ${tab === t.key ? 'is-active' : ''}`}
                onClick={() => setTab(t.key)}>
                {t.label}
                {t.count > 0 && <span className="notif-tab-count">{t.count}</span>}
              </button>
            ))}
          </div>

          <div className="notif-panel-list">
            {totalShown === 0 ? (
              <div className="notif-empty">
                <div className="notif-empty-illu"><BellIcon width="22" height="22" /></div>
                <div className="notif-empty-title">
                  {tab === 'unread' ? 'No unread notifications' : 'You\'re all caught up'}
                </div>
                <div className="notif-empty-text">
                  {tab === 'all' ? 'New activity will show up here.' : 'Switch tabs to see other notifications.'}
                </div>
              </div>
            ) : (
              grouped.map((g) => (
                <div key={g.label}>
                  <div className="notif-section">{g.label}</div>
                  {g.items.map((n) => (
                    <NotifItem key={n.id} n={n} onClick={() => handleItemClick(n)} />
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="notif-panel-footer">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="auth-link"
              style={{ fontSize: 13 }}
            >
              View all notifications
            </Link>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ============================================================
function NotifItem({ n, onClick }) {
  const meta = CATEGORY_META[n.category] || CATEGORY_META.system;
  const Icon = meta.icon;
  const unread = !n.read_at;
  return (
    <button type="button" onClick={onClick}
      className={`notif-item ${unread ? 'notif-item-unread' : ''}`}>
      <div className="notif-avatar">
        {n.actor?.avatar_url
          ? <img src={n.actor.avatar_url} alt="" />
          : <span>{initialsOf(n.actor?.display_name) || '·'}</span>}
        <span className={`notif-avatar-cat notif-avatar-cat-${CATEGORY_META[n.category] ? n.category : 'system'}`}>
          <Icon width="9" height="9" />
        </span>
      </div>
      <div className="notif-item-body">
        <div className="notif-item-title">{n.title}</div>
        {n.body && <div className="notif-item-text">{n.body}</div>}
      </div>
      <div className="notif-item-side">
        <span>{formatRelTime(n.created_at)}</span>
        {unread && <span className="notif-item-dot" />}
      </div>
    </button>
  );
}

// ============================================================
// Helpers
// ============================================================
function initialsOf(name) {
  if (!name) return '';
  return String(name).split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}

function groupByDate(list) {
  const today = startOfDay(new Date());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);

  const buckets = {
    today:     { label: 'Today',     items: [] },
    yesterday: { label: 'Yesterday', items: [] },
    week:      { label: 'This week', items: [] },
    earlier:   { label: 'Earlier',   items: [] },
  };
  for (const n of list) {
    const d = startOfDay(new Date(n.created_at));
    if (d.getTime() === today.getTime())          buckets.today.items.push(n);
    else if (d.getTime() === yesterday.getTime()) buckets.yesterday.items.push(n);
    else if (d.getTime() >= weekAgo.getTime())    buckets.week.items.push(n);
    else                                          buckets.earlier.items.push(n);
  }
  return Object.values(buckets).filter((b) => b.items.length > 0);
}
function startOfDay(d) { const c = new Date(d); c.setHours(0,0,0,0); return c; }
