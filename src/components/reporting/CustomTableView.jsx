// Read-only real table for a brand "table" custom section (rows-based model).
// entry: { name, columns:[{id,label,type,options}], rows:[{ [colId]: value }] }.
// Shared by the Weekly/Bi-Weekly and Monthly report views (and thus the client
// portal + image PDF, which reuse those views). Returns null when there's nothing
// to show so the caller's section wrapper can be skipped.
export default function CustomTableView({ entry }) {
  const columns = entry?.columns || [];
  const rows = (entry?.rows || []).filter((r) => columns.some((c) => r?.[c.id] != null && r[c.id] !== ''));
  if (!columns.length || !rows.length) return null;

  const th = {
    padding: '8px 12px', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700,
    color: 'var(--text-secondary, #475569)', whiteSpace: 'nowrap',
    background: 'var(--surface-2, #f8fafc)', borderBottom: '2px solid var(--border-subtle, #e2e8f0)',
  };
  const td = {
    padding: '8px 12px', fontSize: '0.84rem', color: 'var(--text-primary, #1e293b)',
    borderBottom: '1px solid var(--border-subtle, #eef2f7)', verticalAlign: 'top',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: Math.min(240 + columns.length * 120, 1100) }}>
        <thead>
          <tr>
            {columns.map((c) => <th key={c.id} style={th}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => <td key={c.id} style={td}>{fmtCell(r?.[c.id], c.type)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtCell(v, type) {
  if (v == null || v === '') return <span style={{ color: 'var(--text-muted, #94a3b8)' }}>—</span>;
  if (type === 'url') {
    const href = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    return <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent, #6366f1)' }}>{v}</a>;
  }
  if (type === 'currency' || type === 'number') {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toLocaleString(undefined, type === 'currency' ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  }
  return String(v);
}
