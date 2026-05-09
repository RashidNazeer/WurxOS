import { useMemo, useState } from 'react';
import { ROLE_LABELS } from '../../../lib/resourcePlannerApi';
import { CheckIcon } from '../../../components/common/Icon';

// Employee × Brand matrix heatmap. Left-sticky employee column,
// scrollable brand columns (rotated headers), right-sticky total.
export default function BrandAllocationTab({ employees, brands }) {
  const [statusFilter, setStatus] = useState('Active');

  const visibleBrands = useMemo(() => {
    if (statusFilter === 'all') return brands;
    return brands.filter((b) => b.status === statusFilter);
  }, [brands, statusFilter]);

  // Only show employees actually assignable to brands (exclude boss/ol
  // oversight rows — they'd be all-green across every brand, which is
  // noise not signal). Matches v1 behavior.
  const visibleEmployees = useMemo(() => {
    return employees
      .filter((e) => e.status === 'Active')
      .filter((e) => ['tl', 'pctl', 'apc', 'ipc'].includes(e.role));
  }, [employees]);

  const assigned = (emp, brand) => emp.brandIds.includes(brand.id);

  const brandTotals = visibleBrands.map((b) => ({
    brand: b,
    count: visibleEmployees.filter((e) => assigned(e, b)).length,
  }));
  const grandTotal = brandTotals.reduce((s, r) => s + r.count, 0);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#64748b', marginRight: 4 }}>Show:</span>
        {['Active', 'Paused', 'all'].map((s) => (
          <button
            key={s}
            className="wx-btn"
            onClick={() => setStatus(s)}
            style={{
              background: statusFilter === s ? '#2563eb' : 'transparent',
              color: statusFilter === s ? '#fff' : '#475569',
              border: statusFilter === s ? 'none' : '1px solid #e5e7eb',
            }}
          >
            {s === 'all' ? 'All' : s}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 12, background: '#10b981', borderRadius: 2 }} /> Assigned
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 12, background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 2 }} /> Not assigned
          </span>
        </div>
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        <div style={{ overflow: 'auto', maxHeight: '70vh' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
            <thead>
              <tr>
                <th style={stickyLeftHead}>Employee</th>
                {visibleBrands.map((b) => (
                  <th key={b.id} style={rotatedHead} title={b.name}>
                    <div style={{ transform: 'rotate(-60deg)', transformOrigin: 'left bottom', whiteSpace: 'nowrap' }}>
                      {b.name}
                    </div>
                  </th>
                ))}
                <th style={stickyRightHead}>Total</th>
              </tr>
            </thead>
            <tbody>
              {visibleEmployees.map((e) => (
                <tr key={e.id}>
                  <td style={stickyLeftCell}>
                    <div style={{ fontWeight: 600 }}>{e.name}</div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>{ROLE_LABELS[e.role] || e.role}</div>
                  </td>
                  {visibleBrands.map((b) => {
                    const on = assigned(e, b);
                    return (
                      <td key={b.id} style={{ ...cellBase, background: on ? '#10b981' : '#fff', textAlign: 'center' }}>
                        {on && <CheckIcon width="14" height="14" color="#fff" />}
                      </td>
                    );
                  })}
                  <td style={stickyRightCell}>{e.brandCount}</td>
                </tr>
              ))}
              {visibleEmployees.length === 0 && (
                <tr>
                  <td colSpan={visibleBrands.length + 2} style={{ textAlign: 'center', color: '#94a3b8', padding: 24 }}>
                    No assignable employees (TL/PCTL/APC/IPC) are active.
                  </td>
                </tr>
              )}
            </tbody>
            {visibleEmployees.length > 0 && visibleBrands.length > 0 && (
              <tfoot>
                <tr style={{ background: '#f8fafc' }}>
                  <td style={stickyLeftCell}><strong>Totals</strong></td>
                  {brandTotals.map(({ brand, count }) => (
                    <td key={brand.id} style={{ ...cellBase, textAlign: 'center', fontWeight: 700 }}>{count}</td>
                  ))}
                  <td style={stickyRightCell}><strong>{grandTotal}</strong></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  );
}

const cellBase = {
  padding: '8px 6px',
  borderBottom: '1px solid #f1f5f9',
  borderRight: '1px solid #f1f5f9',
  minWidth: 34,
};
const stickyLeftHead = {
  position: 'sticky', left: 0, top: 0, zIndex: 3,
  background: '#f8fafc', padding: '12px 12px', textAlign: 'left',
  borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', minWidth: 200,
};
const stickyRightHead = {
  position: 'sticky', right: 0, top: 0, zIndex: 3,
  background: '#f8fafc', padding: '12px 12px', textAlign: 'right',
  borderBottom: '1px solid #e5e7eb', borderLeft: '1px solid #e5e7eb', minWidth: 70,
};
const rotatedHead = {
  position: 'sticky', top: 0, zIndex: 2, background: '#f8fafc',
  padding: '60px 4px 8px', borderBottom: '1px solid #e5e7eb',
  height: 120, verticalAlign: 'bottom', minWidth: 34, maxWidth: 34,
};
const stickyLeftCell = {
  position: 'sticky', left: 0, zIndex: 1, background: '#fff',
  padding: '8px 12px', borderBottom: '1px solid #f1f5f9',
  borderRight: '1px solid #e5e7eb', minWidth: 200,
};
const stickyRightCell = {
  position: 'sticky', right: 0, zIndex: 1, background: '#fff',
  padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid #f1f5f9',
  borderLeft: '1px solid #e5e7eb', minWidth: 70, fontWeight: 700,
};
