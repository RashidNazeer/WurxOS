import { useEffect, useState } from 'react';
import { listMyTeamLeadIds } from './agendaApi';

// Every Team Lead an APC works under (their reports_to + the owners of the brands they hold, mig 428),
// so the agenda treats them as a member of each of those teams. Seeded with reports_to so the first
// render is right for the common single-team APC; non-APCs get an empty list.
export function useMyTeamLeadIds(uid, isApc, reportsTo) {
  const [ids, setIds] = useState(() => (isApc && reportsTo ? [reportsTo] : []));
  useEffect(() => {
    if (!isApc || !uid) { setIds([]); return undefined; }
    let off = false;
    listMyTeamLeadIds(uid, reportsTo).then((r) => { if (!off) setIds(r); }).catch(() => {});
    return () => { off = true; };
  }, [uid, isApc, reportsTo]);
  return ids;
}
