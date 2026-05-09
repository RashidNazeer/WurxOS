import { AlertIcon } from '../common/Icon';

/**
 * Inline notice shown on every Brand Detail tab when the brand is
 * inactive. Mirrors the DB-level write block (migration 115): no
 * new tasks, campaigns, products, or reports — but existing data
 * stays editable so people can finish closing items out.
 */
export default function InactiveBrandBanner({ feature }) {
  return (
    <div
      className="wx-alert"
      style={{
        background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
        color: 'var(--warning)',
        border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
        marginBottom: 12,
        display: 'flex', alignItems: 'center', gap: 8,
      }}
    >
      <AlertIcon width="14" height="14" />
      <span>
        This brand is inactive — new {feature} can&apos;t be created. Existing items remain editable.
        Reactivate the brand from <strong>Team Management</strong> to resume.
      </span>
    </div>
  );
}
