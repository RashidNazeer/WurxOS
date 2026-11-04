// Who may use the connector and how fast. Pure, so it is tested without a database.

// Owner request 2026-11-03: the Boss and the OLs (developers for support). Team Leads and below are not
// let in: widening this is a one-line change once the Boss agrees.
export const MCP_ROLES = ['boss', 'ol', 'developer'];
export const MCP_CALLS_PER_MINUTE = 30;

// `calls` = this person's calls in the last minute; null (count unavailable) fails open so a busy
// database does not lock the Boss out.
export const rateLimited = (calls: number | null | undefined) => typeof calls === 'number' && calls >= MCP_CALLS_PER_MINUTE;

// "Source: reports · 2026-10" — where a result came from, so Claude can cite it.
export function sourceLine(s: { table: string; period?: string | null; brand?: string | null; status?: string | null }): string {
  if (!s || s.table === 'none') return '';
  const bits = [s.table, s.brand, s.period, s.status].filter(Boolean);
  return `\n\nSource: ${bits.join(' · ')}`;
}
