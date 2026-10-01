import { useQuery } from '@tanstack/react-query';
import { Avatar, StatusBadge } from '../../../components/ui';
import TodayCard, { ShowAll } from './TodayCard';
import { todayKeys, fetchTeamToday, POLL } from '../../../lib/todayApi';
import { fmtTime } from '../../../lib/attendanceApi';

const STATE = {
  'clocked-in':       { tone: 'success', label: 'In', rank: 2 },
  'on-break':         { tone: 'warning', label: 'On break', rank: 1 },
  'pending-approval': { tone: 'info',    label: 'Clock-out pending', rank: 1 },
  'clocked-out':      { tone: 'neutral', label: 'Clocked out', rank: 3 },
};

// TL / PCTL: who on my team is in right now. One-shot query, refreshed every
// 60 s while the tab is visible — no extra realtime channels.
export default function TeamTodayCard({ uid }) {
  const q = useQuery({ queryKey: todayKeys.teamToday(uid), queryFn: () => fetchTeamToday(uid), enabled: !!uid, staleTime: 30_000, ...POLL });
  const rows = (q.data || [])
    .map((m) => ({ m, s: m.record ? STATE[m.record.status] || STATE['clocked-in'] : { tone: 'danger', label: 'Not in', rank: 0 } }))
    .sort((a, b) => a.s.rank - b.s.rank);
  const inCount = rows.filter((r) => r.m.record && r.m.record.status !== 'clocked-out').length;
  const shown = rows.slice(0, 6);
  return (
    <TodayCard title={`Team today · ${inCount}/${rows.length} in`} icon="bi-people" linkTo="/attendance" linkLabel="Attendance"
      query={q} empty={rows.length === 0} emptyText="No team members yet">
      <ul className="today-list">
        {shown.map(({ m, s }) => (
          <li key={m.id} className="today-row">
            <Avatar name={m.name} toneKey={m.id} size={28} />
            <div className="today-row__main">
              <div className="today-row__title">{m.name}</div>
              {m.record?.clockIn && <div className="today-row__sub">In {fmtTime(m.record.clockIn)}</div>}
            </div>
            <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
          </li>
        ))}
      </ul>
      <ShowAll total={rows.length} shown={shown.length} to="/attendance" />
    </TodayCard>
  );
}
