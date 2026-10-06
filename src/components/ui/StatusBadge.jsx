/**
 * <StatusBadge tone="success|warning|danger|info|purple|neutral|accent">Label</StatusBadge>
 * <StatusBadge status={row.status} map={STATUS_TONES.leave} />
 * One tone map for the whole app: each tone is its -soft fill + -text
 * colour, which passes 4.5:1 in both themes.
 */
export const TONES = ['success', 'warning', 'danger', 'info', 'purple', 'neutral', 'accent'];

export const STATUS_TONES = {
  report: {
    draft:     { tone: 'neutral', label: 'Draft' },
    returned:  { tone: 'danger',  label: 'Returned' },
    submitted: { tone: 'info',    label: 'Submitted' },
    verified:  { tone: 'purple',  label: 'Verified' },
    approved:  { tone: 'success', label: 'Approved' },
    late:      { tone: 'warning', label: 'Late' },
    missing:   { tone: 'danger',  label: 'Missing' },
  },
  leave: {
    pending:      { tone: 'warning', label: 'Pending' },
    pending_tl:   { tone: 'warning', label: 'Pending TL' },
    pending_ol:   { tone: 'warning', label: 'Pending OL' },
    pending_boss: { tone: 'warning', label: 'Pending Boss' },
    approved:     { tone: 'success', label: 'Approved' },
    rejected:     { tone: 'danger',  label: 'Rejected' },
    cancelled:    { tone: 'neutral', label: 'Cancelled' },
    withdrawn:    { tone: 'neutral', label: 'Withdrawn' },
  },
  task: {
    todo:        { tone: 'neutral', label: 'To do' },
    in_progress: { tone: 'warning', label: 'In progress' },
    done:        { tone: 'success', label: 'Done' },
    overdue:     { tone: 'danger',  label: 'Overdue' },
  },
};

export default function StatusBadge({ tone, status, map, dot = true, children, className = '', ...rest }) {
  const entry = map && status != null ? map[status] : null;
  const t = TONES.includes(tone) ? tone : (entry?.tone || 'neutral');
  const label = children ?? entry?.label ?? (status != null ? String(status).replace(/_/g, ' ') : null);
  return (
    <span className={`ui-badge ui-badge--${t} ${className}`.trim()} {...rest}>
      {dot && <span className="ui-badge__dot" aria-hidden="true" />}
      {label}
    </span>
  );
}
