// Report-editor save indicator, modelled on the checkpoint's
// "Saved 3:45 / Saved locally". Reads state the editors already keep:
//   saving  — a server save is in flight
//   dirty   — edits since the last server save (useReportAutosave has
//             already copied them to this browser's local storage)
//   savedAt — time of the last successful server save in this session
export default function SaveStatus({ saving, dirty, savedAt, className = '' }) {
  let icon; let text; let tone;
  if (saving) {
    icon = 'bi-arrow-repeat'; text = 'Saving…'; tone = 'var(--text-muted)';
  } else if (dirty) {
    icon = 'bi-hdd'; text = 'Saved locally — not yet saved to WurxOS'; tone = 'var(--warning-text)';
  } else if (savedAt) {
    icon = 'bi-cloud-check';
    text = `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    tone = 'var(--success-text)';
  } else {
    return null;
  }
  return (
    <span className={`d-inline-flex align-items-center gap-1 ${className}`.trim()} role="status" aria-live="polite"
      style={{ fontSize: 12, fontWeight: 600, color: tone, whiteSpace: 'nowrap' }}>
      <i className={`bi ${icon}`} aria-hidden="true" /> {text}
    </span>
  );
}
