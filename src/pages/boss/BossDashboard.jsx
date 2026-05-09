import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { countProfilesByRole } from '../../lib/adminApi';
import { repairWeekLabels } from '../../lib/reportsApi';
import { useAuth } from '../../contexts/AuthContext';
import {
  UsersIcon, ShieldIcon, AlertIcon, PlusIcon, ArrowRightIcon, RefreshIcon,
} from '../../components/common/Icon';

const CARDS = [
  { role: 'ol',        label: 'Operation Leads',        to: '/boss/manage/ols',        accent: '#6366f1' },
  { role: 'tl',        label: 'Team Leads',             to: '/boss/manage/tls',        accent: '#10b981' },
  { role: 'pctl',      label: 'Paid Collab TLs',        to: '/boss/manage/pctls',      accent: '#f59e0b' },
  { role: 'apc',       label: 'APCs',                   to: '/boss/manage/apcs',       accent: '#06b6d4' },
  { role: 'ipc',       label: 'IPCs',                   to: '/boss/manage/ipcs',       accent: '#ec4899' },
  { role: 'developer', label: 'Developers',             to: '/boss/manage/developers', accent: '#8b5cf6' },
];

export default function BossDashboard() {
  const { profile } = useAuth();
  const { data: counts, isLoading: loading, error: queryError } = useQuery({
    queryKey: ['profiles-counts-by-role'],
    queryFn: () => countProfilesByRole(),
  });
  const error = queryError?.message || '';

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Welcome{profile?.display_name ? `, ${profile.display_name}` : ''} 👋</h1>
        <p className="page-subtitle">Here's a snapshot of your team. More stats will appear as you add features.</p>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 18 }}>
          <AlertIcon width="16" height="16" />
          <span>{error}</span>
        </div>
      )}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 14,
          marginBottom: 28,
        }}
      >
        {CARDS.map((c) => (
          <StatCard
            key={c.role}
            label={c.label}
            value={loading ? null : (counts?.[c.role] ?? 0)}
            accent={c.accent}
            to={c.to}
          />
        ))}
      </section>

      <div
        className="wx-card"
        style={{
          padding: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <UsersIcon width="20" height="20" />
          </div>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
              Build your team
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Create Operation Leads, Team Leads, and Coordinators from the Manage Users section.
            </div>
          </div>
        </div>
        <Link to="/boss/manage/ols" className="wx-btn wx-btn-primary" style={{ textDecoration: 'none' }}>
          <PlusIcon width="16" height="16" /> Add a team member
        </Link>
      </div>

      <MaintenanceSection />
    </>
  );
}

// --------------------------------------------------------------
// Maintenance — Boss-only utilities. Currently:
//   * Repair Week Labels — recomputes period_number + period_label
//     for every weekly report, anchored at the brand's earliest
//     report. Use after editing dates on legacy reports leaves
//     numbering inconsistent.
// --------------------------------------------------------------
function MaintenanceSection() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function runRepair() {
    if (!confirm('Recompute Week labels for every weekly report on every brand? Safe — only updates labels.')) return;
    setRunning(true); setErr(''); setResult(null);
    try {
      const r = await repairWeekLabels();
      setResult(r);
    } catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  }

  return (
    <div className="wx-card" style={{ padding: 22, marginTop: 18 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Maintenance</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
        One-off Boss/Developer utilities for fixing legacy data.
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, flexWrap: 'wrap',
        padding: 14, borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
      }}>
        <div>
          <div style={{ fontWeight: 600 }}>Repair Week Labels</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Recompute every weekly report's number and label using each brand's
            earliest report as the anchor. Fixes duplicate or shifted labels caused
            by anchor drift over time. Safe to run any time.
          </div>
          {result && (
            <div className="wx-alert" style={{
              marginTop: 8,
              background: 'color-mix(in srgb, var(--success) 14%, transparent)',
              color: 'var(--success)',
              border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
            }}>
              Relabelled <strong>{result.reports_relabelled}</strong> report(s) across{' '}
              <strong>{result.brands_processed}</strong> brand(s).
            </div>
          )}
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginTop: 8 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}
        </div>
        <button type="button" className="wx-btn wx-btn-ghost" onClick={runRepair} disabled={running}>
          {running ? <><span className="wx-spinner" /> Running…</> : <><RefreshIcon width="14" height="14" /> Run repair</>}
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent, to }) {
  return (
    <Link
      to={to}
      className="wx-card"
      style={{
        padding: 18,
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'transform var(--dur-fast) var(--ease-out), border-color var(--dur-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.borderColor = 'var(--border-strong)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = '';
        e.currentTarget.style.borderColor = '';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 'var(--radius-md)',
            background: `${accent}1e`,
            color: accent,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <ShieldIcon width="17" height="17" />
        </div>
        <ArrowRightIcon width="14" height="14" style={{ color: 'var(--text-muted)' }} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>
        {value === null ? <span style={{ opacity: 0.3 }}>—</span> : value}
      </div>
    </Link>
  );
}
