import { Link } from 'react-router-dom';
import { Avatar, Button, StatusBadge } from '../ui';
import { useDialogs } from '../common/useDialogs';
import { useApprovalAction, KIND_LABEL } from '../../lib/approvalsApi';
import { relativeAge } from './relativeAge';

const ROLE_LABEL = { apc: 'APC', ipc: 'IPC', tl: 'TL', pctl: 'PCTL', ol: 'OL', ads_manager: 'Ads Manager', boss: 'Boss' };

// Approve / reject labels per source, matching the wording on each source page.
function labels(item, role) {
  if (item.kind === 'reports') return { approve: role === 'tl' ? 'Verify' : 'Approve', reject: 'Return' };
  return { approve: 'Approve', reject: 'Reject' };
}

// One approval: who · what · age, inline actions, and Open (deep link to the
// source). Reject/Return asks for a required reason in a modal (no browser prompt).
export default function ApprovalRow({ item, role, selectable = false, selected = false, onToggle }) {
  const act = useApprovalAction();
  const { askText, notify } = useDialogs();
  const l = labels(item, role);
  const busy = act.isPending && act.variables?.item?.id === item.id;

  const reject = async () => {
    const note = await askText(
      item.kind === 'reports'
        ? `Why are you returning this report? The ${role === 'tl' ? 'APC' : 'Team Lead'} sees this reason.`
        : 'Reason (the requester sees this):',
      '',
      { title: `${l.reject} — ${item.who || item.title}`, confirmLabel: l.reject },
    );
    if (note == null) return;
    if (!note.trim()) { notify.warning('A reason is required.'); return; }
    act.mutate({ item, action: 'reject', note: note.trim() });
  };

  return (
    <li className="appr-row">
      {selectable && (
        <input type="checkbox" className="form-check-input appr-row__check" checked={selected}
          onChange={onToggle} aria-label={`Select ${item.title}`} />
      )}
      <Avatar name={item.who || '?'} toneKey={item.who} size={34} />
      <div className="appr-row__main">
        <div className="appr-row__who">
          <span className="appr-row__name">{item.who || 'Someone'}</span>
          {item.whoRole && <span className="appr-row__role">{ROLE_LABEL[item.whoRole] || item.whoRole}</span>}
          <span className="appr-row__kind">{KIND_LABEL[item.kind]}</span>
          {item.at && <span className="appr-row__age">{relativeAge(item.at)}</span>}
        </div>
        <div className="appr-row__title">{item.title}</div>
        {item.detail && <div className="appr-row__detail">{item.detail}</div>}
      </div>
      <div className="appr-row__actions">
        {item.waitingOn && <StatusBadge tone="neutral">Waiting on {item.waitingOn}</StatusBadge>}
        {item.canAct && (
          <>
            <Button size="sm" loading={busy && act.variables?.action === 'approve'} disabled={busy}
              onClick={() => act.mutate({ item, action: 'approve' })}>
              {l.approve}
            </Button>
            {item.canForward && (
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => act.mutate({ item, action: 'forward' })}>
                Forward to Boss
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={busy} onClick={reject}>{l.reject}</Button>
          </>
        )}
        <Button as={Link} to={item.link} size="sm" variant="ghost">Open</Button>
      </div>
    </li>
  );
}
