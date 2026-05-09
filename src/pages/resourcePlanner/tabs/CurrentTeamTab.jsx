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
          <SearchIcon width="14" height="14" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
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

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
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
                    <div style={{ fontSize: 12, color: '#64748b' }}>{r.email}</div>
                  </td>
                  <td>
                    <span style={{ padding: '2px 8px', borderRadius: 6, background: '#e0e7ff', color: '#3730a3', fontSize: 12, fontWeight: 500 }}>
                      {ROLE_LABELS[r.role] || r.role}
                    </span>
                  </td>
                  <td style={{ color: '#475569' }}>{r.department}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.brandCount}</td>
                  <td style={{ textAlign: 'right' }}>
                    <UtilPill value={r.utilization} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: '#94a3b8', padding: 24 }}>No employees match these filters.</td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ background: '#f8fafc' }}>
                  <td colSpan={3} style={{ fontWeight: 600, color: '#475569' }}>TOTAL</td>
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
    return <span style={{ color: '#94a3b8' }}>—</span>;
  }
  let bg = '#f0fdf4', fg = '#166534';       // green ≤ 50
  if (value > 100)       { bg = '#fef2f2'; fg = '#991b1b'; }
  else if (value > 85)   { bg = '#fffbeb'; fg = '#92400e'; }
  else if (value > 50)   { bg = '#eff6ff'; fg = '#1e40af'; }
  return (
    <span style={{ padding: '2px 10px', borderRadius: 999, background: bg, color: fg, fontWeight: 600, fontSize: 12 }}>
      {value}%
    </span>
  );
}
