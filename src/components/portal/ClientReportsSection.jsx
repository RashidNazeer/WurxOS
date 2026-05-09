import { useMemo, useState } from 'react';

/**
 * Public reports viewer for the client portal.
 *
 * Receives the bundled `reports` array from get_client_access (already
 * filtered to approved + permitted brands and types). Lets the viewer
 * pick a brand, then a report; renders the report's `data` jsonb as
 * plain read-only sections.
 */
export default function ClientReportsSection({ reports = [], brands = [] }) {
  const grouped = useMemo(() => {
    const m = new Map();
    for (const r of reports) {
      const key = r.brand_id;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (b.period_start || '').localeCompare(a.period_start || ''));
    }
    return m;
  }, [reports]);

  const [selectedBrandId, setSelectedBrandId] = useState(brands[0]?.id || null);
  const brandReports = grouped.get(selectedBrandId) || [];
  const [selectedReportId, setSelectedReportId] = useState(brandReports[0]?.id || null);
  const selected = brandReports.find(r => r.id === selectedReportId) || brandReports[0] || null;

  if (reports.length === 0) {
    return (
      <div className="wx-card" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 28, opacity: 0.4 }}>📋</div>
        <div style={{ fontWeight: 700, marginTop: 8, color: 'var(--text-secondary)' }}>No approved reports yet</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '4px 0 0' }}>
          Reports will appear here once they're approved by your account team.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 16 }}>
      <div className="wx-card" style={{ padding: 14, alignSelf: 'flex-start', position: 'sticky', top: 64 }}>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 8 }}>
          Brand
        </div>
        <select className="wx-input" style={{ width: '100%', marginBottom: 14, fontSize: 13 }}
          value={selectedBrandId || ''}
          onChange={e => { setSelectedBrandId(e.target.value); setSelectedReportId(null); }}>
          {brands.map(b => (
            <option key={b.id} value={b.id}>{b.brand_name}</option>
          ))}
        </select>

        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 8 }}>
          Reports ({brandReports.length})
        </div>
        {brandReports.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>No approved reports for this brand.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '60vh', overflowY: 'auto' }}>
            {brandReports.map(r => {
              const isSel = (selected?.id === r.id);
              const tint = r.type === 'biweekly' ? '#0ea5e9' : '#3b82f6';
              return (
                <button key={r.id} type="button" onClick={() => setSelectedReportId(r.id)}
                  style={{
                    textAlign: 'left', padding: '8px 10px', borderRadius: 8,
                    background: isSel ? `${tint}1a` : 'transparent',
                    border: `1px solid ${isSel ? tint : 'transparent'}`,
                    cursor: 'pointer',
                  }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{r.period_label || '—'}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'capitalize', marginTop: 2 }}>{r.type}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div>
        {selected ? <ReportPanel report={selected} brands={brands} /> : (
          <div className="wx-card" style={{ padding: 32, textAlign: 'center' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Pick a report to view.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReportPanel({ report, brands }) {
  const brand = brands.find(b => b.id === report.brand_id);
  const data = report.data || {};

  return (
    <div className="wx-card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            {report.type === 'biweekly' ? 'Bi-weekly report' : 'Weekly report'}
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
            {brand?.brand_name || report.brand_name || 'Report'}
          </h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            {fmtDate(report.period_start)} – {fmtDate(report.period_end)}
            {report.author_name && <> · by {report.author_name}</>}
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 10px', borderRadius: 999,
          background: 'color-mix(in srgb, var(--success) 18%, transparent)',
          color: 'var(--success)', fontWeight: 700, fontSize: 11,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>✓ Approved</span>
      </div>

      {Object.keys(data).length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>This report has no content.</div>
      ) : (
        Object.entries(data).map(([key, value]) => (
          <Section key={key} title={humanize(key)} value={value} />
        ))
      )}
    </div>
  );
}

function Section({ title, value }) {
  if (value == null || value === '') return null;
  return (
    <div style={{ marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 700 }}>
        {title}
      </div>
      <div style={{ color: 'var(--text-primary)', fontSize: 13.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {renderValue(value)}
      </div>
    </div>
  );
}

function renderValue(v) {
  if (v == null || v === '') return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (typeof v === 'string') {
    // Strip HTML tags from rich-text content for safe rendering
    return <span dangerouslySetInnerHTML={{ __html: v }} />;
  }
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
    return (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {v.map((item, i) => <li key={i} style={{ marginBottom: 4 }}>{renderValue(item)}</li>)}
      </ul>
    );
  }
  if (typeof v === 'object') {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        {Object.entries(v).map(([k, val]) => (
          <div key={k}>
            <strong style={{ color: 'var(--text-secondary)' }}>{humanize(k)}:</strong>{' '}
            {renderValue(val)}
          </div>
        ))}
      </div>
    );
  }
  return String(v);
}

function humanize(key) {
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
