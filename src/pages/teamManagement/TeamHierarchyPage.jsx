import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fetchHierarchy } from '../../lib/teamApi';
import HierarchyReassignPanel from '../../components/teamManagement/HierarchyReassignPanel';
import HierarchyOrgChart from '../../components/teamManagement/HierarchyOrgChart';
import HierarchyTree from '../../components/teamManagement/HierarchyTree';
import { ROLE_COLORS } from '../../components/teamManagement/hierarchyTheme';

/**
 * Team Hierarchy — beautiful org chart for Boss + OL.
 *
 * 1:1 port of v1's TeamHierarchyPage. Data fetch uses v2's
 * fetchHierarchy() which emits the same {users, teamUsers, brands}
 * shape v1's Firestore loaders produced, so the rest of this file
 * is identical to v1 down to the JSX and stat-card sub-components.
 */
export default function TeamHierarchyPage() {
  const { profile } = useAuth();
  const userRole = profile?.role;
  const isBoss = userRole === 'boss';
  const isOL = userRole === 'ol';

  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [teamUsers, setTeamUsers] = useState([]);
  const [brands, setBrands] = useState([]);

  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('chart'); // 'chart' | 'tree' | 'matrix'
  const [roleFilter, setRoleFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await fetchHierarchy();
        if (cancelled) return;
        setUsers(r.users);
        setTeamUsers(r.teamUsers);
        setBrands(r.brands);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // Build derived org structure (Boss → OLs → TLs → APCs/IPCs)
  const org = useMemo(() => {
    const boss = users.find((u) => u.role === 'boss') || null;
    const ols = users.filter((u) => u.role === 'ol');
    const tls = users.filter((u) => u.role === 'tl' || u.role === 'pctl');

    const enrichedTls = tls.map((t) => {
      const members = teamUsers.filter((tu) => tu.ownerId === t.id);
      const tlBrands = brands.filter((b) => b.ownerId === t.id);
      return {
        ...t,
        members: members.map((m) => ({
          ...m,
          brands: (m.assignedBrands || [])
            .map((ab) => brands.find((b) => b.id === ab.id) || ab)
            .filter(Boolean),
        })),
        brands: tlBrands,
      };
    });

    return { boss, ols, tls: enrichedTls };
  }, [users, teamUsers, brands]);

  // Apply search + filters
  const visibleTls = useMemo(() => {
    let list = org.tls;
    if (roleFilter) {
      if (roleFilter === 'tl') list = list.filter((t) => t.role === 'tl');
      else if (roleFilter === 'pctl') list = list.filter((t) => t.role === 'pctl');
      else if (roleFilter === 'apc' || roleFilter === 'ipc') {
        list = list.filter((t) => t.members.some((m) => (m.userType || 'apc') === roleFilter));
      }
    }
    if (search) {
      const s = search.toLowerCase();
      list = list.filter((t) =>
        (t.displayName || t.email || '').toLowerCase().includes(s)
        || t.members.some((m) => (m.userName || m.email || '').toLowerCase().includes(s))
        || t.brands.some((b) => (b.brandName || '').toLowerCase().includes(s))
        || t.members.some((m) => m.brands.some((b) => (b.brandName || '').toLowerCase().includes(s))),
      );
    }
    return list;
  }, [org.tls, search, roleFilter]);

  // Stats
  const stats = useMemo(() => {
    const tlCount = org.tls.filter((t) => t.role === 'tl').length;
    const pctlCount = org.tls.filter((t) => t.role === 'pctl').length;
    const apcCount = teamUsers.filter((t) => (t.userType || 'apc') === 'apc').length;
    const ipcCount = teamUsers.filter((t) => t.userType === 'ipc').length;
    const headcount = 1 + org.ols.length + org.tls.length + apcCount + ipcCount;
    const activeBrands = brands.filter((b) => b.status !== 'inactive').length;
    const unassignedBrands = brands.filter((b) => !b.ownerId).length;
    const apcsWithBrands = teamUsers.filter((t) => (t.userType || 'apc') === 'apc');
    const totalApcBrands = apcsWithBrands.reduce((s, a) => s + ((a.assignedBrands || []).length), 0);
    const avgBrands = apcCount > 0 ? (totalApcBrands / apcCount).toFixed(1) : '0';
    return {
      headcount,
      ols: org.ols,
      tlCount, pctlCount,
      apcCount, ipcCount,
      avgBrands,
      brandsTotal: brands.length,
      activeBrands,
      unassignedBrands,
    };
  }, [org, teamUsers, brands]);

  function handleReload() {
    setSelection(null);
    setReloadKey((k) => k + 1);
  }

  if (loading) {
    return (
      <div style={{ padding: '24px 28px' }}>
        <div className="d-flex align-items-center gap-2 text-muted">
          <span className="spinner-border spinner-border-sm" /> Loading team hierarchy…
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px 48px', position: 'relative', background: '#f8fafc', minHeight: '100%' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <div className="d-flex align-items-center gap-2 mb-2">
            <div className="d-inline-flex align-items-center justify-content-center rounded-3"
              style={{ width: 38, height: 38, background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', boxShadow: '0 6px 20px rgba(124,58,237,0.35)' }}>
              <i className="bi bi-diagram-3-fill text-white" style={{ fontSize: '1.1rem' }} />
            </div>
            <h4 className="fw-bold mb-0" style={{ color: '#0f172a', fontSize: '1.5rem', letterSpacing: '-0.02em' }}>
              Team Hierarchy
            </h4>
          </div>
          <div className="d-flex align-items-center gap-2 flex-wrap" style={{ fontSize: '0.78rem' }}>
            <span className="text-muted">Visual org chart · click any node to reassign or open a profile</span>
            <Pill>{stats.ols.length} OLs</Pill>
            <Pill>{stats.tlCount + stats.pctlCount} TL/PCTLs</Pill>
            <Pill>{stats.apcCount} APCs</Pill>
            <Pill>{stats.ipcCount} IPCs</Pill>
            <Pill>{stats.brandsTotal} Brands</Pill>
          </div>
        </div>
      </div>

      {/* ── Stat cards ────────────────────────────────────────────────── */}
      <div className="row g-3 mb-3">
        <StatCard
          dark
          label="Headcount"
          value={stats.headcount}
          dot="#fb923c"
          sub={`Across ${1 + stats.ols.length + stats.tlCount + stats.pctlCount} leadership · ${stats.apcCount + stats.ipcCount} on team`}
        />
        <StatCard
          label="Operations Leads"
          value={stats.ols.length}
          dot={ROLE_COLORS.ol.solid}
          sub={stats.ols.length > 0 ? stats.ols.map((o) => firstName(o.displayName || o.email)).join(' · ') : 'None'}
        />
        <StatCard
          label="Team Leads"
          value={stats.tlCount + stats.pctlCount}
          dot={ROLE_COLORS.tl.solid}
          sub={`${stats.tlCount} TL · ${stats.pctlCount} Paid Collab TL`}
        />
        <StatCard
          label="APCs / IPCs"
          value={`${stats.apcCount} / ${stats.ipcCount}`}
          dot={ROLE_COLORS.apc.solid}
          sub={`avg ${stats.avgBrands} brands per APC`}
        />
        <StatCard
          label="Brands Managed"
          value={stats.brandsTotal}
          dot="#fb923c"
          sub={`${stats.unassignedBrands} unassigned · ${stats.activeBrands} active`}
        />
      </div>

      {/* ── Control bar ───────────────────────────────────────────────── */}
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 14 }}>
        <div className="card-body p-3 d-flex flex-wrap align-items-center gap-2">
          <div className="input-group input-group-sm" style={{ maxWidth: 260 }}>
            <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}>
              <i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} />
            </span>
            <input type="text" className="form-control border-0" placeholder="Search team or brand…"
              value={search} onChange={(e) => setSearch(e.target.value)} style={{ background: '#f1f5f9' }} />
          </div>

          <ViewToggle value={viewMode} onChange={setViewMode} />

          <select className="form-select form-select-sm" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{ maxWidth: 140 }}>
            <option value="">All teams</option>
            {org.tls.map((t) => <option key={t.id} value={t.id}>{t.displayName || t.email}</option>)}
          </select>
          <select className="form-select form-select-sm" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ maxWidth: 130 }}>
            <option value="">All roles</option>
            <option value="tl">TL</option>
            <option value="pctl">PCTL</option>
            <option value="apc">APC</option>
            <option value="ipc">IPC</option>
          </select>

          <div className="d-flex align-items-center gap-2 ms-auto flex-wrap" style={{ fontSize: '0.7rem' }}>
            <Legend color={ROLE_COLORS.boss.solid} label="Boss" />
            <Legend color={ROLE_COLORS.ol.solid}   label="OL"   />
            <Legend color={ROLE_COLORS.tl.solid}   label="TL"   />
            <Legend color={ROLE_COLORS.pctl.solid} label="PCTL" />
            <Legend color={ROLE_COLORS.apc.solid}  label="APC"  />
            <Legend color={ROLE_COLORS.ipc.solid}  label="IPC"  />
          </div>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div className="hierarchy-fade">
        {viewMode === 'chart' && (
          <HierarchyOrgChart
            boss={org.boss}
            ols={org.ols}
            tls={visibleTls}
            teamFilter={teamFilter}
            onSelect={setSelection}
          />
        )}
        {viewMode === 'tree' && (
          <HierarchyTree
            boss={org.boss}
            ols={org.ols}
            tls={visibleTls}
            allBrandsCount={stats.brandsTotal}
            allReportsCount={stats.headcount - 1}
            onSelect={setSelection}
          />
        )}
        {viewMode === 'matrix' && (
          <MatrixPlaceholder />
        )}
      </div>

      {/* Reassignment side panel */}
      {selection && (
        <HierarchyReassignPanel
          selection={selection}
          tls={org.tls}
          brands={brands}
          teamUsers={teamUsers}
          isBoss={isBoss}
          isOL={isOL}
          onClose={() => setSelection(null)}
          onSaved={handleReload}
        />
      )}

      <style>{`
        @keyframes hierarchy-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .hierarchy-fade { animation: hierarchy-fade-in 280ms ease-out; }
      `}</style>
    </div>
  );
}

// ── Small components ───────────────────────────────────────────────────

function Pill({ children }) {
  return (
    <span className="rounded-pill px-2 py-1" style={{ background: '#fff', border: '1px solid #e2e8f0', fontSize: '0.7rem', fontWeight: 600, color: '#475569' }}>
      {children}
    </span>
  );
}

function StatCard({ label, value, sub, dot, dark }) {
  return (
    <div className="col-12 col-md-6 col-xl">
      <div className="card border-0 shadow-sm h-100" style={{
        borderRadius: 14, overflow: 'hidden',
        background: dark ? 'linear-gradient(135deg, #0f172a, #1e293b)' : '#fff',
        color: dark ? '#fff' : '#0f172a',
      }}>
        <div className="card-body p-3">
          <div className="d-flex align-items-center gap-2 mb-1" style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: dark ? 'rgba(255,255,255,0.7)' : '#64748b' }}>
            <span className="rounded-circle d-inline-block" style={{ width: 7, height: 7, background: dot }} />
            {label}
          </div>
          <div className="fw-bold" style={{ fontSize: '1.6rem', letterSpacing: '-0.02em', lineHeight: 1.05, marginTop: 4 }}>
            {value}
          </div>
          {sub && (
            <div style={{ fontSize: '0.7rem', marginTop: 4, color: dark ? 'rgba(255,255,255,0.65)' : '#64748b' }}>
              {sub}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ViewToggle({ value, onChange }) {
  const items = [
    { key: 'chart',  label: 'Org Chart', icon: 'bi-diagram-3' },
    { key: 'tree',   label: 'Tree',      icon: 'bi-list-nested' },
    { key: 'matrix', label: 'Matrix',    icon: 'bi-grid-3x3-gap' },
  ];
  return (
    <div className="d-flex p-1 rounded-3" style={{ background: '#f1f5f9' }}>
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button key={it.key} type="button"
            onClick={() => onChange(it.key)}
            className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{
              background: active ? '#0f172a' : 'transparent',
              color: active ? '#fff' : '#64748b',
              border: 'none', borderRadius: 8,
              padding: '5px 12px', fontSize: '0.74rem', fontWeight: 700,
              boxShadow: active ? '0 2px 6px rgba(15,23,42,0.18)' : 'none',
              transition: 'all 150ms ease',
            }}>
            <i className={`bi ${it.icon}`} style={{ fontSize: '0.8rem' }} />{it.label}
          </button>
        );
      })}
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span className="d-inline-flex align-items-center gap-1" style={{ color: '#64748b' }}>
      <span className="rounded-circle d-inline-block" style={{ width: 8, height: 8, background: color }} />
      {label}
    </span>
  );
}

function MatrixPlaceholder() {
  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
      <div className="card-body p-5 text-center text-muted">
        <i className="bi bi-grid-3x3-gap" style={{ fontSize: '2rem', color: '#cbd5e1' }} />
        <div className="mt-2" style={{ fontSize: '0.92rem', fontWeight: 600 }}>Matrix view — coming soon</div>
        <div style={{ fontSize: '0.78rem' }}>For now use Org Chart or Tree to navigate the hierarchy.</div>
      </div>
    </div>
  );
}

function firstName(s) {
  if (!s) return '';
  return s.split(/\s+/)[0];
}
