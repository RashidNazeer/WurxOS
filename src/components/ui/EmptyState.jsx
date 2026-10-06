/**
 * <EmptyState icon title description action compact />
 */
export default function EmptyState({ icon, title, description, action, compact = false, className = '' }) {
  return (
    <div className={`ui-empty${compact ? ' ui-empty--compact' : ''} ${className}`.trim()}>
      {icon && <div className="ui-empty__icon" aria-hidden="true">{icon}</div>}
      {title && <div className="ui-empty__title">{title}</div>}
      {description && <p className="ui-empty__text">{description}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
