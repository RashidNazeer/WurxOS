import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../../contexts/NotificationsContext';
import { formatRelTime } from '../../lib/notificationsApi';
import {
  CheckIcon, BellIcon, RefreshIcon, ReportIcon, MegaphoneIcon, StarIcon,
} from '../../components/common/Icon';
import '../../styles/notifications.css';

const TABS = [
  { id: 'all',    label: 'All' },
  { id: 'unread', label: 'Unread' },
];

const CATEGORY_LABEL = {
  task:        'Tasks',
  brand:       'Brands',
  report:      'Reports',
  paid_collab: 'Paid Collab',
  system:      'System',
};

const CATEGORY_META = {
  task:        { Icon: CheckIcon,     tone: 'task' },
  report:      { Icon: ReportIcon,    tone: 'report' },
  brand:       { Icon: StarIcon,      tone: 'brand' },
  paid_collab: { Icon: MegaphoneIcon, tone: 'paid' },
  system:      { Icon: BellIcon,      tone: 'system' },
};

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
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
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
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={`wx-role-chip ${categoryFilter === 'all' ? 'wx-role-chip-active' : ''}`}
              style={{ padding: '7px 14px' }}
            >
              All types
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategoryFilter(c)}
                className={`wx-role-chip ${categoryFilter === c ? 'wx-role-chip-active' : ''}`}
                style={{ padding: '7px 14px' }}
              >
                {CATEGORY_LABEL[c] || c}
              </button>
            ))}
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
                <div className={`notif-row-icon notif-row-icon-${meta.tone}`}>
                  <Icon width="18" height="18" />
                </div>
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
