// v1-compat shim for components/teamManagement/ReassignApcLeadTab.jsx.
//
// v1 expected:
//   loadTeamMembers() → { tls: [{id, name, role}], apcs: [{id, name, role, ownerId, ownerName, assignedBrands[]}] }
//   reassignApcLead({ apcId, newTL, brandCount }) → { changed }
//
// BUG HISTORY (fixed 2026-07-13): this shim was written against a WRONG
// assumption about fetchTeamRoster()'s return shape. It assumed
// `{ tls, pctls, profiles, brands }` and read `roster.tls` + `apc.brands`.
// fetchTeamRoster() actually returns ONLY `{ profiles, brands }`:
//   • roster.tls was always undefined → tls = []  → the "Pick new Team Lead"
//     list rendered EMPTY (you literally could not reassign anyone) and every
//     APC showed "No TL", even though profiles.reports_to was set for all 24.
//   • profile rows carry no brand fields → assignedBrands = [] → every APC
//     showed "0 brands", even though brand_assignments links 20 of them to
//     1-2 brands each.
// So derive BOTH from the real shape: supervisors come from profiles (tl/pctl),
// and each user's brands come from brands[].assigneeIds (i.e. brand_assignments).

import { fetchTeamRoster, moveApcToTl } from '../lib/teamApi';

export async function loadTeamMembers() {
  const roster = await fetchTeamRoster();
  const profiles = roster?.profiles || [];
  const brands = roster?.brands || [];

  const nameOf = (p) => p?.display_name || p?.email || '';
  // Resolve any supervisor's name, whatever their role (an APC could report to
  // someone who isn't in the tl/pctl picker list).
  const nameById = new Map(profiles.map((p) => [p.id, nameOf(p)]));

  // Supervisors the picker can assign to. team_move_apc_to_tl accepts a target
  // whose role is 'tl' OR 'pctl' (APCs sit under TLs, IPCs under PCTLs).
  const tls = profiles
    .filter((p) => p.role === 'tl' || p.role === 'pctl')
    .map((p) => ({ id: p.id, name: nameOf(p) || 'TL', role: p.role }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // brand_assignments(user_id, brand_id) is exposed by fetchTeamRoster as
  // brands[].assigneeIds. Invert it into a per-user brand list.
  const brandsByUser = new Map();
  for (const b of brands) {
    for (const uid of b.assigneeIds || []) {
      if (!brandsByUser.has(uid)) brandsByUser.set(uid, []);
      brandsByUser.get(uid).push({ id: b.id, brandName: b.brand_name, status: b.status });
    }
  }

  const apcs = profiles
    .filter((p) => p.role === 'apc' || p.role === 'ipc')
    .map((p) => ({
      id: p.id,
      name: nameOf(p) || 'APC',
      role: p.role,
      email: p.email || '',
      ownerId: p.reports_to || null,
      ownerName: p.reports_to ? (nameById.get(p.reports_to) || '') : '',
      assignedBrands: brandsByUser.get(p.id) || [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { tls, apcs };
}

export async function reassignApcLead({ apcId, newTL, brandCount = 0 }) {
  if (!apcId || !newTL?.id) throw new Error('Missing arguments');
  await moveApcToTl(apcId, newTL.id);
  // team_move_apc_to_tl returns the APC's uuid (NOT a count), and deliberately
  // leaves brand_assignments alone — an APC's brands are assigned to the PERSON,
  // so they follow them to the new TL. Report the APC's own brand count.
  return { changed: brandCount };
}
