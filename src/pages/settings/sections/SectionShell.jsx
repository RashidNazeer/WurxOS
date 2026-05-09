// Shared wrapper for a Settings section. Renders a card with a
// structured header (icon + title + subtitle + optional action
// slot) and a separated body so every section shares the same
// visual rhythm. Action slot is used for top-right controls that
// don't belong in the footer (e.g. "Learn more" or a toggle).
export default function SectionShell({ icon: Icon, title, subtitle, action, children }) {
  return (
    <div className="settings-card">
      <div className="settings-section-header">
        {Icon && (
          <div className="settings-section-icon"><Icon width="18" height="18" /></div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="settings-section-title">{title}</div>
          {subtitle && <div className="settings-section-subtitle">{subtitle}</div>}
        </div>
        {action && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{action}</div>
        )}
      </div>
      <div className="settings-section-body">{children}</div>
    </div>
  );
}
