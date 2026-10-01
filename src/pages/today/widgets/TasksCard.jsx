import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../components/ui';
import TodayCard, { ShowAll } from './TodayCard';
import { todayKeys, fetchMyTasks } from '../../../lib/todayApi';
import { pktToday } from '../../../lib/reportDue';
import { updateTask } from '../../../lib/tasksApi';

// Recurring tasks (daily/weekly/monthly) reset on their own schedule and never
// show a due label — same rule as the old dashboard card.
const isDeadline = (t) => !t.category || t.category === 'general';

function dueInfo(t, today) {
  if (!isDeadline(t) || !t.due_date) return { label: isDeadline(t) ? '' : t.category, rank: 3, tone: 'muted' };
  if (t.due_date < today) {
    const days = Math.round((new Date(today) - new Date(t.due_date)) / 86400000);
    return { label: `${days}d overdue`, rank: 0, tone: 'danger' };
  }
  if (t.due_date === today) return { label: 'Today', rank: 1, tone: 'warning' };
  return { label: new Date(`${t.due_date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), rank: 2, tone: 'muted' };
}

export default function TasksCard({ uid }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = todayKeys.tasks(uid);
  const q = useQuery({ queryKey: key, queryFn: () => fetchMyTasks(uid), enabled: !!uid, staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false });

  // Optimistic tick (S6): drop the row now, restore it if the server says no.
  const done = useMutation({
    mutationFn: (task) => updateTask(task.id, { status: 'done' }),
    onMutate: async (task) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (old) => (old || []).filter((t) => t.id !== task.id));
      return { prev };
    },
    onError: (err, _t, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(`Couldn't complete the task: ${err.message}`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  const today = pktToday();
  const tasks = (q.data || [])
    .map((t) => ({ t, d: dueInfo(t, today) }))
    .sort((a, b) => a.d.rank - b.d.rank);
  const shown = tasks.slice(0, 5);
  return (
    <TodayCard title="My tasks" icon="bi-check2-square" linkTo="/tasks" linkLabel="All tasks"
      query={q} empty={tasks.length === 0} emptyText="No open tasks" count={tasks.filter((x) => x.d.rank <= 1).length}>
      <ul className="today-list">
        {shown.map(({ t, d }) => (
          <li key={t.id} className="today-row">
            <input type="checkbox" className="form-check-input today-row__check"
              aria-label={`Mark "${t.title}" done`} onChange={() => done.mutate(t)} />
            <div className="today-row__main">
              <Link to="/tasks" className="today-row__title">{t.title}</Link>
              <div className="today-row__sub">{t.brand?.brand_name || 'Personal'}{t.priority && t.priority !== 'normal' ? ` · ${t.priority}` : ''}</div>
            </div>
            {d.label && <span className={`today-row__due is-${d.tone}`}>{d.label}</span>}
          </li>
        ))}
      </ul>
      <ShowAll total={tasks.length} shown={shown.length} to="/tasks" />
    </TodayCard>
  );
}
