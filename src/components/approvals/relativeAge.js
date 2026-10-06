// "just now", "12m ago", "3h ago", "2d ago".
export function relativeAge(date) {
  const ms = Date.now() - (date instanceof Date ? date.getTime() : new Date(date).getTime());
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
