// Small visual reminder that every time/date control on a settings
// section refers to Pakistan time. WurxOS is locked to Asia/Karachi
// for all scheduled notifications regardless of OS clock — see
// migration 095 for the DB-level constraint.

export default function PktChip({ style }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', marginBottom: 12,
      background: 'var(--accent-soft)', color: 'var(--accent)',
      border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
      borderRadius: 999, fontSize: 11.5, fontWeight: 600,
      ...(style || {}),
    }}>
      <span aria-hidden>🇵🇰</span>
      <span>All times in Pakistan time (Asia/Karachi)</span>
    </div>
  );
}
