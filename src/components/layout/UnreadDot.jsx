import { useNotifications } from '../../contexts/NotificationsContext';

/**
 * Small pulsing dot placed on a sidebar nav item whose `category` has
 * unread notifications. Positioned absolute over the icon wrapper.
 */
export default function UnreadDot({ category }) {
  const { counts } = useNotifications();
  const n = (category && counts.byCategory?.[category]) || 0;
  if (!n) return null;
  return <span className="sidebar-unread-dot" title={`${n} unread`} />;
}
