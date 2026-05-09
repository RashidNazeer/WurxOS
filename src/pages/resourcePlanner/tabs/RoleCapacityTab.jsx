import { useEffect, useState } from 'react';
import { ROLE_KEYS, ROLE_LABELS, ROLE_DEPARTMENTS } from '../../../lib/resourcePlannerApi';

// Per-role Max Brands / Max Hours / Notes table. Saves on blur via
// role_capacity patch. Editing one role only sends that role's
// sub-object to the RPC (deep-merge handled server-side).
export default function RoleCapacityTab({ config, onConfigChange }) {
  const [local, setLocal] = useState(config.roleCapacity || {});
  useEffect(() => { setLocal(config.roleCapacity || {}); }, [config]);

  const setField = (role, field, value) => {
    setLocal((prev) => ({
      ...prev,
      [role]: { ...(prev[role] || {}), [field]: value },
    }));
  };

  const commit = (role, field) => {
    const prev = config.roleCapacity?.[role]?.[field];
    const next = local[role]?.[field];
    // Normalize numeric fields
    let outVal = next;
    if (field === 'maxBrands' || field === 'maxHours') {
      outVal = next === '' || next === null || next === undefined ? 0 : Number(next);
    }
    if (outVal === prev) return;
    onConfigChange({ roleCapacity: { [role]: { [field]: outVal } } });
  };

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: 14, borderBottom: '1px solid #e5e7eb' }}>
        <strong>Role Capacity</strong>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
          If APC Max Brands = 5 and an APC has 6 assigned brands, utilization reads 120%.
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="wx-table" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th>Role</th>
              <th>Department</th>
              <th style={{ width: 130 }}>Max Brands</th>
              <th style={{ width: 140 }}>Max Hours/Week</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {ROLE_KEYS.map((role) => {
              const dept = ROLE_DEPARTMENTS[role];
              const row = local[role] || {};
              return (
                <tr key={role}>
                  <td style={{ fontWeight: 600 }}>{ROLE_LABELS[role]}</td>
                  <td>
                    <span style={{ padding: '2px 8px', borderRadius: 6, background: '#f1f5f9', color: '#475569', fontSize: 12, fontWeight: 500 }}>
                      {dept}
                    </span>
                  </td>
                  <td>
                    <input
                      type="number" min="0" max="200" className="wx-input"
                      value={row.maxBrands ?? ''}
                      onChange={(e) => setField(role, 'maxBrands', e.target.value)}
                      onBlur={() => commit(role, 'maxBrands')}
                    />
                  </td>
                  <td>
                    <input
                      type="number" min="0" max="80" className="wx-input"
                      value={row.maxHours ?? ''}
                      onChange={(e) => setField(role, 'maxHours', e.target.value)}
                      onBlur={() => commit(role, 'maxHours')}
                    />
                  </td>
                  <td>
                    <input
                      type="text" className="wx-input"
                      value={row.notes ?? ''}
                      onChange={(e) => setField(role, 'notes', e.target.value)}
                      onBlur={() => commit(role, 'notes')}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
