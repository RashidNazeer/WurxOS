// Who may use the connector and how fast. Pure, so it is tested without a database.

// Owner 2026-11-04: the Boss and the OLs ONLY. Everyone else (TL, APC, IPC, developer, …) is refused,
// here on every request and on the consent screen. Widening this is a deliberate, reviewed change.
export const MCP_ROLES = ['boss', 'ol'];
export const MCP_ROLES_LABEL = 'the Boss and Operations Leads';
export const MCP_CALLS_PER_MINUTE = 30;

// The ONE gate. Exact match on the role stored in profiles (never from the token, a header or an argument):
// no trimming, no case folding, so 'OL', ' ol' or 'ol ' are NOT roles and are refused. A deactivated or
// deleted account is refused whatever its role. Anything unexpected (null, a non-string) is refused.
export function mcpAllowed(p: { role?: unknown; is_active?: unknown; deleted_at?: unknown } | null | undefined): boolean {
  if (!p || typeof p.role !== 'string') return false;
  if (p.is_active !== true || p.deleted_at) return false;
  return Object.prototype.hasOwnProperty.call(ROLE_SET, p.role);
}
const ROLE_SET: Record<string, true> = Object.fromEntries(MCP_ROLES.map((r) => [r, true as const]));

// `calls` = this person's PRIOR calls in the last minute (the current call's own row excluded). An unknown
// count counts as limited: when the log cannot be read the connector stops, it never opens.
export const rateLimited = (calls: number | null | undefined) => typeof calls !== 'number' || !Number.isFinite(calls) || calls >= MCP_CALLS_PER_MINUTE;

// "Source: reports · 2026-10" — where a result came from, so Claude can cite it.
export function sourceLine(s: { table: string; period?: string | null; brand?: string | null; status?: string | null }): string {
  if (!s || s.table === 'none') return '';
  const bits = [s.table, s.brand, s.period, s.status].filter(Boolean);
  return `\n\nSource: ${bits.join(' · ')}`;
}
