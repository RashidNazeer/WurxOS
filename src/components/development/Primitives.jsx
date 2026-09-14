// Small shared pieces of the Development workspace: avatar, status and
// priority labels, and the empty state.
import { STATUS_META, PRIORITY_META } from '../../lib/devTasksApi';
import { initials } from './devFormat';

export function Avatar({ person, alert = false }) {
  return (
    <span className={`dev-avatar${alert ? ' is-alert' : ''}`} title={person?.display_name || 'Unassigned'}>
      {person?.avatar_url ? <img src={person.avatar_url} alt="" /> : initials(person)}
    </span>
  );
}

export function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.backlog;
  return (
    <span className={`dev-pill is-${meta.tone}`}>
      <i className={`bi ${meta.icon}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function PriorityPill({ priority }) {
  const meta = PRIORITY_META[priority] || PRIORITY_META.normal;
  return <span className={`dev-priority is-${meta.tone}`}>{meta.label}</span>;
}

export function Empty({ icon = 'bi-inbox', title, body }) {
  return (
    <div className="dev-empty">
      <i className={`bi ${icon}`} aria-hidden="true" />
      <strong>{title}</strong>
      {body && <span>{body}</span>}
    </div>
  );
}
