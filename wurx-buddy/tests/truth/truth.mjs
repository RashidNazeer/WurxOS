// Ground truth computed straight from the raw snapshot rows, by code that shares NOTHING with the Buddy tools
// (no tools/*.ts import), plus SQL twins of the key numbers that `run.mjs --sql` re-checks live on production.
export function truthOf(tables, rpcData) {
  const P = tables.profiles;
  const isCur = (p) => p.is_active === true && !p.deleted_at;
  const byId = new Map(P.map((p) => [p.id, p]));
  const S = {
    people: P,
    cur: (role) => P.filter((p) => isCur(p) && (!role || p.role === role)),
    former: (role) => P.filter((p) => !isCur(p) && (!role || p.role === role)),
    nm: (list) => list.map((p) => p.display_name),
    byId, tables,
  };
  // a display name shared with a current person (two people can have one name) is not a clean 'former' signal
  S.fnames = (role) => S.former(role).map((p) => p.display_name).filter((n) => !P.some((c) => isCur(c) && c.display_name === n));
  S.rated = ['ol', 'pctl', 'tl', 'apc', 'ipc'];
  S.comp = (uid, month) => rpcData.composite[`${uid}|${month}`] || null;
  S.compScore = (p, month) => { const c = S.comp(p.id, month); return c && c.composite_score != null && c.level !== 'pending_verification' ? Number(c.composite_score) : null; };
  // best current person of a role by composite for a month
  S.best = (role, month) => S.cur(role).map((p) => ({ p, s: S.compScore(p, month) })).filter((x) => x.s != null).sort((a, b) => b.s - a.s);
  S.bestFormer = (role, month) => S.former(role).filter((p) => tables.performance_ratings.some((r) => r.user_id === p.id && r.month === month) || (tables.performance_month_snapshots || []).some((r) => r.user_id === p.id && r.month === month)).map((p) => ({ p, s: S.compScore(p, month) })).filter((x) => x.s != null).sort((a, b) => b.s - a.s);
  S.salaryRows = tables.employee_compensation;
  S.salaryCurrent = S.salaryRows.filter((c) => { const p = byId.get(c.user_id); return p && isCur(p) && p.role !== 'boss'; });
  S.salaryCurrentTotal = S.salaryCurrent.reduce((t, c) => t + Number(c.basic_salary || 0), 0);
  S.salaryFormer = S.salaryRows.filter((c) => { const p = byId.get(c.user_id); return p && !isCur(p); });
  S.noSalary = S.cur().filter((p) => p.role !== 'boss' && !S.salaryRows.some((c) => c.user_id === p.id));
  S.attPct = (uid, month) => { const b = (rpcData.breakdown[month] || []).find((x) => x.user_id === uid); return b ? b.pct_display : null; };
  const addMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  S.leaveOverlap = (month) => tables.leave_requests.filter((l) => l.start_date < `${addMonth(month, 1)}-01` && l.end_date >= `${month}-01`);
  S.leaveByStatus = (month, status) => S.leaveOverlap(month).filter((l) => l.status === status);
  S.brandsActive = tables.brands.filter((b) => String(b.status).toLowerCase() === 'active');
  S.brandsInactive = tables.brands.filter((b) => String(b.status).toLowerCase() !== 'active');
  S.brand = (name) => tables.brands.find((b) => b.brand_name === name);
  S.ownerRole = (b) => byId.get(b.owner_id)?.role ?? null;
  const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
  S.monthlyGmv = (month) => tables.reports.filter((r) => r.type === 'monthly' && r.status === 'approved' && r.period_start.slice(0, 7) === month)
    .map((r) => ({ brand: tables.brands.find((b) => b.id === r.brand_id), gmv: num(r.data?.keyMetrics?.gmv) ?? num(r.data?.totalSales?.monthGmv), r }))
    .filter((x) => x.gmv != null && x.brand).sort((a, b) => b.gmv - a.gmv);
  S.reportsPending = (b, month) => tables.reports.some((r) => r.brand_id === b.id && r.type === 'monthly' && r.status !== 'approved' && r.period_start.slice(0, 7) === month);
  S.incentivesFor = (month) => tables.incentives.filter((r) => r.month === month);
  S.incentiveEarned = (row) => [...(row.incentives || []), ...(row.bonuses || [])].reduce((t, g) => t + (g.completed ? Number(g.amount) || 0 : 0), 0);
  return S;
}

// SQL twins: [id, sql, (S) => expected]. Run live (read-only) by `run.mjs --sql`.
export const SQL_CHECKS = [
  ['cur-total-people', "select count(*)::int v from profiles where is_active and deleted_at is null and role<>'boss'", (S) => S.cur().filter((p) => p.role !== 'boss').length],
  ['cur-tl', "select count(*)::int v from profiles where is_active and deleted_at is null and role='tl'", (S) => S.cur('tl').length],
  ['cur-apc', "select count(*)::int v from profiles where is_active and deleted_at is null and role='apc'", (S) => S.cur('apc').length],
  ['former-total', "select count(*)::int v from profiles where not is_active or deleted_at is not null", (S) => S.former().length],
  ['salary-current-total', "select coalesce(sum(c.basic_salary),0)::bigint v from employee_compensation c join profiles p on p.id=c.user_id where p.is_active and p.deleted_at is null and p.role<>'boss'", (S) => S.salaryCurrentTotal],
  ['salary-current-count', "select count(*)::int v from employee_compensation c join profiles p on p.id=c.user_id where p.is_active and p.deleted_at is null and p.role<>'boss'", (S) => S.salaryCurrent.length],
  ['brands-active', "select count(*)::int v from brands where lower(status)='active'", (S) => S.brandsActive.length],
  ['leave-overlap-2026-10', "select count(*)::int v from leave_requests where start_date < '2026-11-01' and end_date >= '2026-10-01'", (S) => S.leaveOverlap('2026-10').length],
  ['oct-incentive-rows', "select count(*)::int v from incentives where month='2026-10'", (S) => S.incentivesFor('2026-10').length],
];
