import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useNotifications } from '../../../contexts/NotificationsContext';
import { Button } from '../../../components/ui';
import { todayKeys, fetchTikTokConnections } from '../../../lib/todayApi';

// Role shortcuts built only from data that already exists (unread counts per
// notification category). Each link is one click to the work surface.
export default function QuickLinksCard({ title = 'Shortcuts', links }) {
  const { counts } = useNotifications();
  return (
    <section className="today-card">
      <header className="today-card__head"><h2 className="today-card__title"><i className="bi bi-lightning-charge" aria-hidden="true" /> {title}</h2></header>
      <ul className="today-links">
        {links.map((l) => {
          const n = l.category ? counts?.byCategory?.[l.category] || 0 : 0;
          return (
            <li key={l.to}>
              <Link to={l.to} className="today-links__item">
                <i className={`bi ${l.icon}`} aria-hidden="true" />
                <span className="today-links__label">{l.label}</span>
                {n > 0 && <span className="today-card__count is-alert">{n}</span>}
                <i className="bi bi-chevron-right today-links__chev" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Ads Manager: prompt to connect TikTok Ads when no connection exists yet.
export function TikTokConnectCard({ uid }) {
  const q = useQuery({ queryKey: todayKeys.tiktok(uid), queryFn: fetchTikTokConnections, enabled: !!uid, staleTime: 30 * 60_000, retry: 0 });
  const list = Array.isArray(q.data) ? q.data : q.data?.connections || [];
  if (q.isPending || q.error || list.length > 0) return null;
  return (
    <section className="today-card today-card--accent">
      <header className="today-card__head"><h2 className="today-card__title"><i className="bi bi-link-45deg" aria-hidden="true" /> Connect TikTok Ads</h2></header>
      <p className="today-card__text">GMV Max data needs a TikTok Ads connection for your brands.</p>
      <Button as={Link} to="/settings?section=tiktokAds" size="sm">Connect TikTok Ads</Button>
    </section>
  );
}
