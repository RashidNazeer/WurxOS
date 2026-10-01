// Who works on a brand. brands.owner_id is the Team Lead (owner); the APCs and
// IPCs are rows of public.brand_assignments (expires_at = temporary cover,
// mig 210; IPCs since mig 359). `db` is the caller's client, so for a non-Boss
// the brand_assignments RLS (can_view_brand, mig 004) decides, as in the app.
// deno-lint-ignore-file no-explicit-any

import type { Db } from './types.ts';

export type Assignee = { brand_id: string; user_id: string; name: string; role: string; until: string | null };

const GROUP: Record<string, string> = { apc: 'APCs', ipc: 'IPCs', tl: 'TLs', pctl: 'PCTLs', ol: 'OLs', ads_manager: 'Ads Managers', developer: 'Developers', boss: 'Boss' };
const ORDER = ['apc', 'ipc', 'tl', 'pctl', 'ads_manager', 'ol', 'developer', 'boss'];

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' });

// Active, non-deleted people assigned to these brands; expired cover is left out.
export async function loadAssignments(db: Db, brandIds: string[], now = new Date()): Promise<Map<string, Assignee[]>> {
  const out = new Map<string, Assignee[]>();
  if (!brandIds.length) return out;
  const { data: rows, error } = await db.from('brand_assignments').select('brand_id, user_id, expires_at').in('brand_id', brandIds);
  if (error) throw error;
  const live = (rows || []).filter((r: any) => !r.expires_at || new Date(r.expires_at) > now);
  const ids = [...new Set(live.map((r: any) => r.user_id))];
  if (!ids.length) return out;
  const { data: profs, error: pe } = await db.from('profiles').select('id, display_name, role, is_active, deleted_at').in('id', ids);
  if (pe) throw pe;
  const who = new Map((profs || []).filter((p: any) => p.is_active !== false && !p.deleted_at).map((p: any) => [p.id, p]));
  for (const r of live) {
    const p: any = who.get(r.user_id);
    if (!p) continue;
    const a = { brand_id: r.brand_id, user_id: r.user_id, name: p.display_name, role: String(p.role || ''), until: r.expires_at ?? null };
    (out.get(r.brand_id) ?? out.set(r.brand_id, []).get(r.brand_id)!).push(a);
  }
  return out;
}

export const coverText = (a: Assignee) => (a.until ? ` (temporary cover until ${day(a.until)})` : '');
const label = (a: Assignee) => `${a.name}${coverText(a)}`;

// "APCs: A, B (temporary cover until 12 Oct); IPCs: C", or '' when none.
export function assignmentText(list: Assignee[] = []): string {
  const by = new Map<string, Assignee[]>();
  for (const a of list) (by.get(a.role) ?? by.set(a.role, []).get(a.role)!).push(a);
  const rank = (r: string) => (ORDER.includes(r) ? ORDER.indexOf(r) : 99);
  return [...by.keys()].sort((x, y) => rank(x) - rank(y))
    .map((r) => `${GROUP[r] ?? r}: ${by.get(r)!.sort((a, b) => a.name.localeCompare(b.name)).map(label).join(', ')}`)
    .join('; ');
}
