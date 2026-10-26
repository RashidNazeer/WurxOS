// VERBATIM PORT of v1 components/teamManagement/TeamManagementPage.js (70 LOC).
// Tabbed wrapper combining Brand Switcher + Reassign APC Lead.
//
// Surgical patches:
//   1. useAuth() v2 shape → derive userRole
//   2. v2 has a single BrandSwitcherPage (no OL-specific variant — RLS
//      handles the role split server-side). Both boss and OL hit the
//      same component.
import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import BrandSwitcherPage from '../../pages/brands/BrandSwitcherPage';
import ReassignApcLeadTab from './ReassignApcLeadTab';

const TABS = [
  { key: 'switcher', label: 'Brand Switcher',     icon: 'bi-arrow-left-right' },
  { key: 'apc',      label: 'Reassign APC Lead',  icon: 'bi-person-gear' },
];

export default function TeamManagementPage() {
  const { profile } = useAuth();
  const userRole = profile?.role || '';
  const [tab, setTab] = useState('switcher');

  return (
    <div style={{ padding: '24px 28px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-3 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-people-fill me-2" style={{ color: 'var(--info-text)' }} />
            Team Management
          </h4>
          <p className="text-muted small mb-0">Move brands between team members, and reassign APCs to different team leads.</p>
        </div>
      </div>

      {/* Tab pills */}
      <div className="d-flex p-1 rounded-3 mb-3" style={{ background: 'var(--surface-2)', boxShadow: 'inset 0 1px 2px color-mix(in srgb, var(--text-primary) 6%, transparent)', width: 'fit-content' }}>
        {TABS.map(t => {
          const isActive = tab === t.key;
          return (
            <button key={t.key} type="button"
              className="btn btn-sm d-inline-flex align-items-center gap-2"
              style={{
                background: isActive ? 'var(--surface-1)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: 'none', borderRadius: 'var(--radius-md)',
                padding: '8px 18px', fontSize: '0.82rem', fontWeight: 700,
                letterSpacing: '-0.01em',
                boxShadow: isActive ? 'var(--shadow-sm)' : 'none',
                transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out)',
              }}
              onClick={() => setTab(t.key)}>
              <i className={`bi ${t.icon}`} />{t.label}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      <div className="card border-0 shadow-sm" style={{ borderRadius: 'var(--radius-lg)' }}>
        <div className="card-body p-3 p-md-4">
          {tab === 'switcher' && <BrandSwitcherPage />}
          {tab === 'apc' && <ReassignApcLeadTab />}
        </div>
      </div>
    </div>
  );
}
