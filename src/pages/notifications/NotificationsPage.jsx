import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../../contexts/NotificationsContext';
import { formatRelTime } from '../../lib/notificationsApi';
import {
  CheckIcon, BellIcon, RefreshIcon, ReportIcon, MegaphoneIcon, StarIcon,
} from '../../components/common/Icon';
import '../../styles/notifications.css';
// Needed for the .task-tabs / .task-tab / .task-tab-count pill styles
// the All / Unread switcher reuses. Without this import the page
// renders the tabs as unstyled buttons in dark mode.
import '../../styles/tasks.css';

const TABS = [
  { id: 'all',    label: 'All' },
  { id: 'unread', label: 'Unread' },
];

const CATEGORY_LABEL = {
  task:           'Tasks',
  brand:          'Brands',
  report:         'Reports',
  paid_collab:    'Paid Collab',
  leave:          'Leave',
  resource:       'Resources',
  performance:    'Performance',
  knowledge_base: 'Knowledge Base',
  attendance:     'Attendance',
  tier:           'Tier',
  agenda:         'Agenda Meetings',
  salary:         'Salary',
  hr:             'HR',
  system:         'System',
};

const CATEGORY_META = {
  task:           { Icon: CheckIcon,     tone: 'task',   bi: 'bi-check2-square' },
  report:         { Icon: ReportIcon,    tone: 'report', bi: 'bi-file-earmark-text' },
  brand:          { Icon: StarIcon,      tone: 'brand',  bi: 'bi-shop' },
  paid_collab:    { Icon: MegaphoneIcon, tone: 'paid',   bi: 'bi-megaphone-fill' },
  leave:          { Icon: BellIcon,      tone: 'system', bi: 'bi-house-door-fill' },
  resource:       { Icon: BellIcon,      tone: 'system', bi: 'bi-bookmark-fill' },
  performance:    { Icon: StarIcon,      tone: 'brand',  bi: 'bi-bar-chart-fill' },
  knowledge_base: { Icon: BellIcon,      tone: 'system', bi: 'bi-book-fill' },
  attendance:     { Icon: BellIcon,      tone: 'system', bi: 'bi-clock-fill' },
  tier:           { Icon: StarIcon,      tone: 'brand',  bi: 'bi-award-fill' },
  agenda:         { Icon: CheckIcon,     tone: 'task',   bi: 'bi-calendar-week' },
  salary:         { Icon: StarIcon,      tone: 'brand',  bi: 'bi-cash-coin' },
  hr:             { Icon: CheckIcon,     tone: 'task',   bi: 'bi-award-fill' },
  system:         { Icon: BellIcon,      tone: 'system', bi: 'bi-bell-fill' },
};

function initialsOf(name) {
  if (!name) return '';
  return String(name).split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}

export default function NotificationsPage() {
  const { items, counts, reload, markRead, markAllRead } = useNotifications();
  const navigate = useNavigate();
  const [tab, setTab] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const categories = useMemo(() => {
    const set = new Set();
    items.forEach((n) => set.add(n.category));
    return Array.from(set);
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((n) => {
      if (tab === 'unread' && n.read_at) return false;
      if (categoryFilter !== 'all' && n.category !== categoryFilter) return false;
      return true;
    });
  }, [items, tab, categoryFilter]);

  function handleClick(n) {
    markRead(n.id);
    if (n.link) navigate(n.link);
  }

  return (
    <>
      <div
        className="page-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}
      >
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-subtitle">
            {counts.total > 0 ? `${counts.total} unread` : 'All caught up'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={reload}>
            <RefreshIcon width="15" height="15" />
          </button>
          {counts.total > 0 && (
            <button className="wx-btn wx-btn-primary" onClick={markAllRead}>
              <CheckIcon width="15" height="15" /> Mark all read
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <div className="task-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`task-tab ${tab === t.id ? 'task-tab-active' : ''}`}
            >
              {t.label}
              <span className="task-tab-count">
                {t.id === 'unread' ? counts.total : items.length}
              </span>
            </button>
          ))}
        </div>
        {categories.length > 1 && (
          <div className="task-tabs">
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={`task-tab ${categoryFilter === 'all' ? 'task-tab-active' : ''}`}
            >
              <i className="bi bi-grid-3x3-gap-fill" style={{ fontSize: '0.78rem' }} />
              All types
            </button>
            {categories.map((c) => {
              const meta = CATEGORY_META[c];
              const count = items.filter((n) => n.category === c).length;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategoryFilter(c)}
                  className={`task-tab ${categoryFilter === c ? 'task-tab-active' : ''}`}
                >
                  {meta?.bi && <i className={`bi ${meta.bi}`} style={{ fontSize: '0.78rem' }} />}
                  {CATEGORY_LABEL[c] || c.replace(/_/g, ' ')}
                  <span className="task-tab-count">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="wx-card" style={{ padding: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 64, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{
              width: 52, height: 52,
              borderRadius: '50%',
              background: 'var(--surface-2)',
              color: 'var(--text-muted)',
              display: 'grid', placeItems: 'center',
              margin: '0 auto 14px',
            }}>
              <BellIcon width="22" height="22" />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              Nothing here
            </div>
            <div style={{ fontSize: 13.5 }}>
              {tab === 'unread' ? 'All notifications have been read.' : 'No notifications yet.'}
            </div>
          </div>
        ) : (
          filtered.map((n) => {
            const meta = CATEGORY_META[n.category] || CATEGORY_META.system;
            const Icon = meta.Icon;
            return (
              <button
                key={n.id}
                type="button"
                className={`notif-row ${n.read_at ? '' : 'notif-row-unread'}`}
                onClick={() => handleClick(n)}
              >
                {n.actor ? (
                  <div className="notif-row-avatar">
                    <div className="notif-row-avatar-photo">
                      {n.actor.avatar_url
                        ? <img src={n.actor.avatar_url} alt={n.actor.display_name || ''} />
                        : <span>{initialsOf(n.actor.display_name) || '·'}</span>}
                    </div>
                    <span
                      className={`notif-row-avatar-cat notif-row-avatar-cat-${meta.tone}`}
                      title={CATEGORY_LABEL[n.category] || n.category}
                    >
                      <Icon width="10" height="10" />
                    </span>
                  </div>
                ) : (
                  <div className={`notif-row-icon notif-row-icon-${meta.tone}`}>
                    <Icon width="18" height="18" />
                  </div>
                )}
                <div className="notif-row-content">
                  <div className="notif-row-title">{n.title}</div>
                  {n.body && <div className="notif-row-body">{n.body}</div>}
                  <div className="notif-row-meta">
                    <span className={`notif-row-chip notif-row-chip-${meta.tone}`}>
                      {CATEGORY_LABEL[n.category] || n.category}
                    </span>
                    {!n.read_at && <span className="notif-row-newdot" aria-label="Unread" />}
                  </div>
                </div>
                <div className="notif-row-time">{formatRelTime(n.created_at)}</div>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
