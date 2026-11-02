// One way to name a person in tool output, so the model never has to guess a role or whether the
// person still works here, and the grounding check (agent/grounding.ts) can parse it back:
//   "Haseeb (APC)"   "Ali Ahmad (APC, former employee – left 2026-10-12)"
// A person is FORMER when profiles.is_active is false or deleted_at is set (WurxOS deactivates by
// soft-deleting, so the two go together). The date is the Pakistan-time day it happened.
// deno-lint-ignore-file no-explicit-any

import type { Db } from './types.ts';

export type PersonRow = { id?: string; display_name?: string | null; role?: string | null; is_active?: boolean | null; deleted_at?: string | null };

export const roleCode = (role: unknown) => String(role || '?').toUpperCase().replace(/_/g, ' ');
export const isFormer = (p: PersonRow | null | undefined) => !!p && (p.is_active === false || !!p.deleted_at);

const pktDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' });
export const leftOn = (p: PersonRow): string | null => {
  if (!p.deleted_at) return null;
  const d = new Date(String(p.deleted_at));
  return Number.isNaN(d.getTime()) ? String(p.deleted_at).slice(0, 10) : pktDay.format(d);
};

export const FORMER_PHRASE = 'former employee';

// "Name (ROLE)" / "Name (ROLE, former employee – left 2026-10-12)".
export function who(p: PersonRow | null | undefined, fallback = 'Unknown person'): string {
  if (!p) return fallback;
  const name = String(p.display_name || fallback);
  if (!isFormer(p)) return `${name} (${roleCode(p.role)})`;
  const d = leftOn(p);
  return `${name} (${roleCode(p.role)}, ${FORMER_PHRASE} – ${d ? `left ${d}` : 'deactivated'})`;
}

export async function loadPeople(db: Db, ids: string[]): Promise<Map<string, PersonRow>> {
  const out = new Map<string, PersonRow>();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  const { data } = await db.from('profiles').select('id, display_name, role, is_active, deleted_at').in('id', want);
  for (const p of data || []) out.set(p.id, p);
  return out;
}

// Former employees whose name matches: so "no active employee" never reads as "no such person".
export async function formerMatches(db: Db, name: string): Promise<PersonRow[]> {
  const q = String(name || '').trim();
  if (!q) return [];
  const { data } = await db.from('profiles').select('id, display_name, role, is_active, deleted_at')
    .ilike('display_name', `%${q}%`).limit(20);
  return (data || []).filter(isFormer).slice(0, 5);
}

export async function noActiveMatch(db: Db, name: string): Promise<string> {
  const former = await formerMatches(db, name);
  return `No active employee matches "${name}".` + (former.length
    ? ` A ${FORMER_PHRASE} does: ${former.map((p) => who(p)).join('; ')}. They no longer work here, so there is no current data for them.`
    : '');
}

// People visible to the caller are narrower than "everyone" unless Boss/OL (RLS decides the rest).
export const sawAll = (boss: boolean, role: unknown) => boss || String(role || '').toLowerCase() === 'ol';
export const PARTIAL_VIEW = 'You can only see the people your role allows, so this is NOT the whole company: never call anyone the highest, lowest or best overall from it.';
