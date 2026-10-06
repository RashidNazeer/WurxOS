import { useMemo, useState } from 'react';
import { ROLE_KEYS, ROLE_LABELS, DEPARTMENTS } from '../../../lib/resourcePlannerApi';
import { SearchIcon } from '../../../components/common/Icon';

// Search + role + department filters with util / brands / name sort.
// Color-coded utilization pill matches v1's bucket scheme.
export default function CurrentTeamTab({ employees }) {
  const [q, setQ]               = useState('');
  const [roleFilter, setRole]   = useState('all');
  const [deptFilter, setDept]   = useState('all');
  const [sort, setSort]         = useState('util_desc');

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let out = employees.filter((e) => e.status === 'Active');
    if (roleFilter !== 'all') out = out.filter((e) => e.role === roleFilter);
    if (deptFilter !== 'all') out = out.filter((e) => e.department === deptFilter);
    if (qq) {
      out = out.filter((e) =>
        (e.name || '').toLowerCase().includes(qq) ||
        (e.email || '').toLowerCase().includes(qq),
      );
    }
    out = [...out].sort((a, b) => {
      if (sort === 'util_desc') {
        const av = a.utilization ?? -1, bv = b.utilization ?? -1;
        return bv - av;
      }
      if (sort === 'brands_desc') return (b.brandCount || 0) - (a.brandCount || 0);
      if (sort === 'name_asc') return (a.name || '').localeCompare(b.name || '');
      return 0;
    });
    return out;
  }, [employees, q, roleFilter, deptFilter, sort]);

  const totalBrands = rows.reduce((sum, r) => sum + (r.brandCount || 0), 0);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 320 }}>
          <SearchIcon width="14" height="14" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text" className="wx-input"
            style={{ paddingLeft: 32 }}
            placeholder="Search name or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="wx-input" style={{ maxWidth: 180 }} value={roleFilter} onChange={(e) => setRole(e.target.value)}>
          <option value="all">All roles</option>
          {ROLE_KEYS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 200 }} value={deptFilter} onChange={(e) => setDept(e.target.value)}>
          <option value="all">All departments</option>
          {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 180, marginLeft: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="util_desc">Utilization ↓</option>
          <option value="brands_desc">Brands ↓</option>
          <option value="name_asc">Name A→Z</option>
        </select>
      </div>

      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-1)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="wx-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>Brands</th>
                <th style={{ textAlign: 'right' }}>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.email}</div>
                  </td>
                  <td>
                    <span style={{ padding: '2px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--info-soft)', color: 'var(--purple-text)', fontSize: 12, fontWeight: 500 }}>
                      {ROLE_LABELS[r.role] || r.role}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{r.department}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.brandCount}</td>
                  <td style={{ textAlign: 'right' }}>
                    <UtilPill value={r.utilization} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No employees match these filters.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ background: 'var(--surface-2)' }}>
                  <td colSpan={3} style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>TOTAL</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{totalBrands}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  );
}

function UtilPill({ value }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  }
  let bg = 'var(--success-soft)', fg = 'var(--success-text)';       // green ≤ 50
  if (value > 100)       { bg = 'var(--danger-soft)'; fg = 'var(--danger-text)'; }
  else if (value > 85)   { bg = 'var(--warning-soft)'; fg = 'var(--warning-text)'; }
  else if (value > 50)   { bg = 'var(--info-soft)'; fg = 'var(--info-text)'; }
  return (
    <span style={{ padding: '2px 10px', borderRadius: 'var(--radius-pill)', background: bg, color: fg, fontWeight: 600, fontSize: 12 }}>
      {value}%
    </span>
  );
}
