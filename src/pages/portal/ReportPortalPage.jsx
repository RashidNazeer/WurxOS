import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedReport } from '../../lib/reportShareApi';
import { AlertIcon, CheckIcon, ReportIcon } from '../../components/common/Icon';
import { useForceLightTheme } from './useForceLightTheme';
import '../../styles/reports.css';
import '../../styles/portal.css';

export default function ReportPortalPage() {
  // External clients always see the report in light mode.
  useForceLightTheme();

  const { token } = useParams();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchSharedReport(token)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-0, var(--surface-2))' }}>
        <div style={{ color: 'var(--text-muted)' }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading report…
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-0, var(--surface-2))', padding: 20 }}>
        <div className="wx-card" style={{ maxWidth: 440, padding: 28, textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
            color: 'var(--danger)', display: 'grid', placeItems: 'center', margin: '0 auto 12px',
          }}>
            <AlertIcon width="22" height="22" />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
            Unable to open report
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>{err}</div>
        </div>
      </div>
    );
  }

  const report = data?.report;
  const brand  = data?.brand;
  const author = data?.author;
  const sections = report?.sections || {};

  return (
    <div className="portal-page" style={{ minHeight: '100vh', background: 'var(--surface-0, var(--surface-2))', padding: '32px 16px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {/* Toolbar (hidden in print) */}
        <div className="portal-toolbar" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button className="wx-btn wx-btn-ghost" onClick={() => window.print()}>
            <ReportIcon width="14" height="14" /> Save / Print as PDF
          </button>
        </div>

        {/* Header */}
        <div className="wx-card portal-header" style={{ padding: 24, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                {report?.type === 'biweekly' ? 'Bi-weekly report' : 'Weekly report'}
              </div>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                {brand?.brand_name || 'Report'}
              </h1>
              <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 6 }}>
                {fmtDate(report?.period_start)} – {fmtDate(report?.period_end)}
                {author?.display_name && <> · by {author.display_name}</>}
              </div>
            </div>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 'var(--radius-pill)',
              background: 'color-mix(in srgb, var(--success) 18%, transparent)',
              color: 'var(--success)', fontWeight: 700, fontSize: 11.5,
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              <CheckIcon width="12" height="12" /> Approved
            </span>
          </div>
        </div>

        {/* Sections */}
        {Object.keys(sections).length === 0 ? (
          <div className="wx-card" style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>
            This report has no content.
          </div>
        ) : (
          Object.entries(sections).map(([key, value]) => (
            <Section key={key} title={humanize(key)} value={value} />
          ))
        )}

        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11.5, marginTop: 24 }}>
          Shared via WurxOS · Read-only
        </div>
      </div>
    </div>
  );
}

function Section({ title, value }) {
  return (
    <div className="wx-card" style={{ padding: 22, marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ color: 'var(--text-primary)', fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {renderValue(value)}
      </div>
    </div>
  );
}

function renderValue(v) {
  if (v === null || v === undefined || v === '') return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
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
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
