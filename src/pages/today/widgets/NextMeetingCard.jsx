import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, StatusBadge } from '../../../components/ui';
import TodayCard from './TodayCard';
import { todayKeys, fetchNextMeeting } from '../../../lib/todayApi';
import { agendaMeetingStartAt } from '../../../lib/agendaApi';

// Next agenda meeting (RLS-scoped). Starting a meeting stays on the agenda
// page, which owns the permission rules; this card links there.
export default function NextMeetingCard({ checkpointBanner = false }) {
  const q = useQuery({ queryKey: todayKeys.meetings(), queryFn: fetchNextMeeting, staleTime: 5 * 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false });
  const m = q.data;
  const at = m ? agendaMeetingStartAt(m) : null;
  const live = m && (m.status === 'ongoing' || m.status === 'paused');
  const when = at
    ? at.toLocaleString('en-US', { timeZone: 'Asia/Karachi', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const isToday = at && at.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }) === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
  return (
    <TodayCard title="Next meeting" icon="bi-calendar-event" linkTo="/agenda/upcoming" linkLabel="Agenda"
      query={q} empty={!m} emptyText="No meetings scheduled">
      {m && (
        <div className="today-meeting">
          <div className="today-row__main">
            <div className="today-row__title">{m.tl?.display_name ? `${m.tl.display_name}'s team` : 'Weekly agenda'}</div>
            <div className="today-row__sub">{when} PKT</div>
          </div>
          {live
            ? <StatusBadge tone="success">{m.status === 'paused' ? 'Paused' : 'In progress'}</StatusBadge>
            : isToday && <StatusBadge tone="warning">Today</StatusBadge>}
          <Button as={Link} to={live ? '/agenda/ongoing' : '/agenda/upcoming'} size="sm" variant={live ? 'primary' : 'secondary'}>
            {live ? 'Join' : 'Details'}
          </Button>
        </div>
      )}
      {checkpointBanner && m && isToday && (
        <Link to="/agenda/checkpoint" className="today-banner">
          <i className="bi bi-clipboard-check" aria-hidden="true" /> Weekly Checkpoint due today — open it
        </Link>
      )}
    </TodayCard>
  );
}
