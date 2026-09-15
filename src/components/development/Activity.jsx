// History entries (dev_activity) turned into plain sentences.
import { Avatar } from './ui';
import { PRIORITY_BY_KEY, STATUS_BY_KEY, TYPE_BY_KEY, exactTime, shortDate, taskCode, timeAgo } from './devModel';

const statusLabel = (key) => STATUS_BY_KEY[key]?.label || key;

// Returns { text, detail } where text is a list of strings and task links.
export function describeActivity(entry, maps, { inTask = false } = {}) {
  const p = entry.payload || {};
  const task = entry.task_id ? maps.taskById.get(entry.task_id) : null;
  const ref = inTask ? null : (task ? { task } : null);
  const person = (id) => maps.personById.get(id)?.display_name || 'someone';
  const release = (id) => (id ? maps.releaseById.get(id)?.name || 'a release' : 'Unscheduled');
  const onTask = (verb, preposition = '') => (ref ? [verb, preposition, ref] : [verb]);

  switch (entry.kind) {
    case 'task_created':
      return { text: p.type === 'bug' ? onTask('reported the bug') : onTask('created'), detail: inTask ? null : null };
    case 'status':
      return {
        text: ref ? ['moved', ref, `to ${statusLabel(p.to)}`] : [`moved this to ${statusLabel(p.to)}`],
        detail: p.to === 'blocked' ? p.reason : null,
      };
    case 'assignee':
      if (!p.to) return { text: ref ? ['unassigned', ref] : ['unassigned this task'] };
      return { text: ref ? ['assigned', ref, `to ${person(p.to)}`] : [`assigned this to ${person(p.to)}`] };
    case 'priority':
      return { text: ref ? ['set', ref, `to ${PRIORITY_BY_KEY[p.to]?.label || p.to} priority`] : [`set priority to ${PRIORITY_BY_KEY[p.to]?.label || p.to}`] };
    case 'due_date':
      if (!p.to) return { text: ref ? ['cleared the due date of', ref] : ['cleared the due date'] };
      return { text: ref ? ['set', ref, `due ${shortDate(p.to)}`] : [`set the due date to ${shortDate(p.to)}`] };
    case 'moved':
      if (p.from_project !== p.to_project) {
        const name = maps.projectById.get(p.to_project)?.name || 'another project';
        return { text: ref ? ['moved', ref, `to ${name}`] : [`moved this to ${name}`] };
      }
      return { text: ref ? ['moved', ref, `to ${release(p.to_release)}`] : [`moved this to ${release(p.to_release)}`] };
    case 'title':
      return { text: onTask('renamed'), detail: `${p.from} → ${p.to}` };
    case 'type':
      return { text: ref ? ['marked', ref, `as a ${TYPE_BY_KEY[p.to]?.label.toLowerCase() || p.to}`] : [`marked this as a ${TYPE_BY_KEY[p.to]?.label.toLowerCase() || p.to}`] };
    case 'description':
      return { text: ref ? ['updated the description of', ref] : ['updated the description'] };
    case 'blocked_reason':
      return { text: ref ? ['updated what is blocking', ref] : ['updated what is blocking this'], detail: p.reason };
    case 'comment':
      return { text: ref ? [p.reply ? 'replied on' : 'commented on', ref] : [p.reply ? 'replied' : 'commented'], detail: p.excerpt };
    case 'comment_deleted':
      return { text: ref ? ['deleted a comment on', ref] : ['deleted a comment'] };
    case 'checklist_added':
      return { text: ref ? ['added a step to', ref] : ['added a step'], detail: p.body };
    case 'checklist_done':
      return { text: ref ? ['ticked a step on', ref] : ['ticked a step'], detail: p.body };
    case 'checklist_reopened':
      return { text: ref ? ['reopened a step on', ref] : ['reopened a step'], detail: p.body };
    case 'checklist_removed':
      return { text: ref ? ['removed a step from', ref] : ['removed a step'], detail: p.body };
    case 'checklist_edited':
      return { text: ref ? ['edited a step on', ref] : ['edited a step'], detail: p.to };
    case 'file_added':
      return { text: ref ? [`attached ${p.name} to`, ref] : [`attached ${p.name}`] };
    case 'file_removed':
      return { text: ref ? [`removed ${p.name} from`, ref] : [`removed ${p.name}`] };
    case 'task_deleted':
      return { text: [`deleted WRX-${p.number} · ${p.title}`] };
    case 'project_created':
      return { text: [`added the project ${p.name}`] };
    case 'project_updated':
      return { text: [`updated ${p.name}`] };
    case 'project_archived':
      return { text: [`archived ${p.name}`] };
    case 'project_restored':
      return { text: [`restored ${p.name}`] };
    case 'release_created':
      return { text: [`planned the release ${p.name}`] };
    case 'release_status':
      if (p.to === 'shipped') return { text: [`shipped ${p.name}`] };
      if (p.to === 'current') return { text: [`made ${p.name} the current release`] };
      return { text: [`moved ${p.name} back to planned`] };
    case 'release_updated':
      return { text: [`updated the release ${p.name}`] };
    default:
      return { text: [entry.kind.replace(/_/g, ' ')] };
  }
}

export function ActivityFeed({ entries, maps, onOpenTask, inTask = false, empty = 'Nothing has happened yet.' }) {
  if (!entries?.length) return <p className="dv-muted dv-feed-empty">{empty}</p>;
  return (
    <ol className={`dv-feed${inTask ? ' is-in-task' : ''}`}>
      {entries.map((entry) => {
        const actor = maps.personById.get(entry.actor_id);
        const { text, detail } = describeActivity(entry, maps, { inTask });
        return (
          <li key={entry.id} className="dv-feed-item">
            <Avatar person={actor} size={inTask ? 22 : 28} />
            <div className="dv-feed-body">
              <p>
                <strong>{actor?.display_name || 'Someone'}</strong>{' '}
                {text.map((part, i) => (typeof part === 'string'
                  ? <span key={i}>{part}{' '}</span>
                  : (
                    <span key={i}>
                      <button type="button" className="dv-link" onClick={() => onOpenTask?.(part.task.number)}>
                        {taskCode(part.task)} {part.task.title}
                      </button>{' '}
                    </span>
                  )))}
              </p>
              {detail && <div className="dv-feed-quote">{detail}</div>}
              <time dateTime={entry.created_at} title={exactTime(entry.created_at)}>{timeAgo(entry.created_at)}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
