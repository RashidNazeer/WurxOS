// v1-compat shim for components/teamManagement/ReassignApcLeadTab.js.
//
// v1 expected:
//   loadTeamMembers() → { tls: [{id, name, role}], apcs: [{id, name, role, ownerId, ownerName, assignedBrands[]}] }
//   reassignApcLead({ apcId, apcName, oldTLId, newTL, actor }) → { changed: <number of brands moved> }
//
// v2 already has the right backend (lib/teamApi.js: fetchTeamRoster +
// moveApcToTl RPC). This file adapts those to v1's shape so the
// verbatim port keeps working.

import { fetchTeamRoster, moveApcToTl } from '../lib/teamApi';

export async function loadTeamMembers() {
  const roster = await fetchTeamRoster();
  // fetchTeamRoster returns { tls, pctls, profiles, brands, ... }.
  // We need a flat APC list with each APC's TL + brand-assignments.
  const tls = (roster?.tls || []).map((t) => ({
    id: t.id,
    name: t.display_name || t.email || 'TL',
    role: t.role || 'tl',
  }));
  const tlById = new Map(tls.map((t) => [t.id, t]));

  // The roster may already include APCs nested under TLs. Some v2
  // shapes use `tls[].apcs[].brands[]`; others put APCs in a top-level
  // array with `reports_to`. Handle both.
  const apcs = [];
  const flatApcs = roster?.apcs || roster?.profiles?.filter((p) => p.role === 'apc' || p.role === 'ipc') || [];
  for (const a of flatApcs) {
    const tlId = a.reports_to || a.ownerId || null;
    apcs.push({
      id: a.id,
      name: a.display_name || a.name || a.email || 'APC',
      role: a.role || 'apc',
      email: a.email || '',
      ownerId: tlId,
      ownerName: tlId ? (tlById.get(tlId)?.name || '') : '',
      assignedBrands: a.brands || a.assignedBrands || a.brand_assignments || [],
    });
  }

  // Fallback: if roster put APCs nested under each TL, flatten.
  if (apcs.length === 0 && Array.isArray(roster?.tls)) {
    for (const t of roster.tls) {
      for (const a of (t.apcs || [])) {
        apcs.push({
          id: a.id,
          name: a.display_name || a.name || a.email || 'APC',
          role: a.role || 'apc',
          email: a.email || '',
          ownerId: t.id,
          ownerName: t.display_name || '',
          assignedBrands: a.brands || a.assignedBrands || [],
        });
      }
    }
  }

  return { tls, apcs };
}

export async function reassignApcLead({ apcId, newTL }) {
  if (!apcId || !newTL?.id) throw new Error('Missing arguments');
  const result = await moveApcToTl(apcId, newTL.id);
  // RPC returns either an integer (count) or a row object with a
  // count field — normalize. Server emits notifications on its own.
  let changed = 0;
  if (typeof result === 'number') changed = result;
  else if (result && typeof result.brand_count === 'number') changed = result.brand_count;
  else if (Array.isArray(result) && result.length) changed = result[0].brand_count || result[0].count || 0;
  return { changed };
}
