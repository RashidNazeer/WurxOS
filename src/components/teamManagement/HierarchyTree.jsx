import React, { useState } from 'react';
import { ROLE_COLORS, roleShortLabel, initialsOf } from './hierarchyTheme';

/**
 * Tree view — indented, expandable hierarchy list.
 *
 * Each row is a clickable node that opens the same reassignment side
 * panel as the org chart. Rows expand/collapse via a chevron; deep nodes
 * (APC/IPC) expand to reveal their assigned brands as chips.
 */
export default function HierarchyTree({ boss, ols, tls, allReportsCount, allBrandsCount, onSelect }) {
  const [expanded, setExpanded] = useState(() => {
    // Start with everything collapsed except the boss + first OL
    const init = new Set();
    if (boss) init.add(`boss-${boss.id}`);
    if (ols[0]) init.add(`ol-${ols[0].id}`);
    return init;
  });

  function toggle(key) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function isOpen(key) { return expanded.has(key); }

  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
      <div className="card-body p-3">
        {boss && (
          <BossNode
            user={boss}
            open={isOpen(`boss-${boss.id}`)}
            onToggle={() => toggle(`boss-${boss.id}`)}
            reportsCount={allReportsCount}
            brandsCount={allBrandsCount}
          >
            {ols.map(ol => (
              <OLNode key={ol.id}
                user={ol}
                open={isOpen(`ol-${ol.id}`)}
                onToggle={() => toggle(`ol-${ol.id}`)}
                reportCount={tls.length}>
                {tls.map(tl => (
                  <TLNode key={tl.id}
                    tl={tl}
                    open={isOpen(`tl-${tl.id}`)}
                    onToggle={() => toggle(`tl-${tl.id}`)}
                    onSelect={onSelect}
                    isOpen={isOpen}
                    onMemberToggle={(mid) => toggle(`m-${mid}`)} />
                ))}
              </OLNode>
            ))}
          </BossNode>
        )}
      </div>

      <style>{`
        @keyframes slide-down {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
        .tree-children { animation: slide-down 200ms ease-out; }
      `}</style>
    </div>
  );
}

function Chevron({ open, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="border-0 rounded-circle d-flex align-items-center justify-content-center"
      style={{
        width: 24, height: 24, background: '#f1f5f9', cursor: 'pointer',
        transition: 'transform 200ms ease',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        flexShrink: 0,
      }}>
      <i className="bi bi-chevron-right" style={{ fontSize: '0.65rem', color: '#475569' }} />
    </button>
  );
}

function RoleBadge({ role }) {
  const c = ROLE_COLORS[role] || ROLE_COLORS.apc;
  return (
    <span className="rounded-pill px-2 ms-2"
      style={{ background: c.solid, color: '#fff', fontSize: '0.55rem', fontWeight: 800, letterSpacing: '0.06em' }}>
      {roleShortLabel(role)}
    </span>
  );
}

function Avatar({ name, size = 26, role }) {
  const c = ROLE_COLORS[role] || { solid: '#3b82f6', text: '#1e3a8a' };
  return (
    <div className="rounded-3 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${c.solid}, ${c.text || c.solid})`, fontSize: size > 32 ? '0.72rem' : '0.6rem' }}>
      {initialsOf(name)}
    </div>
  );
}

function MetaRight({ children }) {
  return (
    <div className="ms-auto text-muted text-end" style={{ fontSize: '0.7rem' }}>
      {children}
    </div>
  );
}

// ── Boss / OL / TL / member nodes ─────────────────────────────────────

function BossNode({ user, open, onToggle, reportsCount, brandsCount, children }) {
  return (
    <div>
      <div className="d-flex align-items-center gap-2 py-2">
        <Chevron open={open} onClick={onToggle} />
        <Avatar name={user.displayName || user.email} size={32} role="boss" />
        <span className="fw-bold" style={{ fontSize: '0.92rem', color: '#0f172a' }}>{user.displayName || user.email}</span>
        <RoleBadge role="boss" />
        <MetaRight>
          <strong style={{ color: '#0f172a' }}>{reportsCount}</strong> reports
          {' · '}
          <strong style={{ color: '#0f172a' }}>{brandsCount}</strong> brands
        </MetaRight>
      </div>
      {open && (
        <div className="tree-children" style={{ marginLeft: 16, borderLeft: '1px solid #e2e8f0', paddingLeft: 16 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function OLNode({ user, open, onToggle, reportCount, children }) {
  return (
    <div>
      <div className="d-flex align-items-center gap-2 py-2">
        <Chevron open={open} onClick={onToggle} />
        <Avatar name={user.displayName || user.email} size={28} role="ol" />
        <span className="fw-semibold" style={{ fontSize: '0.86rem', color: '#0f172a' }}>{user.displayName || user.email}</span>
        <RoleBadge role="ol" />
        <MetaRight>
          <strong style={{ color: '#0f172a' }}>{reportCount}</strong> reports
        </MetaRight>
      </div>
      {open && (
        <div className="tree-children" style={{ marginLeft: 16, borderLeft: '1px solid #e2e8f0', paddingLeft: 16 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function TLNode({ tl, open, onToggle, onSelect, isOpen, onMemberToggle }) {
  return (
    <div>
      <div className="d-flex align-items-center gap-2 py-2">
        <Chevron open={open} onClick={onToggle} />
        <Avatar name={tl.displayName || tl.email} size={28} role={tl.role === 'pctl' ? 'pctl' : 'tl'} />
        <button type="button"
          onClick={() => onSelect({ type: 'tl', tl })}
          className="border-0 bg-transparent p-0 fw-semibold text-start"
          style={{ fontSize: '0.84rem', color: '#0f172a', cursor: 'pointer' }}>
          {tl.displayName || tl.email}
        </button>
        <RoleBadge role={tl.role === 'pctl' ? 'pctl' : 'tl'} />
        <MetaRight>
          <strong style={{ color: '#0f172a' }}>{tl.brands.length}</strong> brand{tl.brands.length === 1 ? '' : 's'}
          {' · '}
          <strong style={{ color: '#0f172a' }}>{tl.members.length}</strong> {tl.role === 'pctl' ? 'IPC' : 'APC'}{tl.members.length === 1 ? '' : 's'}
        </MetaRight>
      </div>
      {open && (
        <div className="tree-children" style={{ marginLeft: 16, borderLeft: '1px solid #e2e8f0', paddingLeft: 16 }}>
          {tl.brands.length > 0 && (
            <div className="d-flex flex-wrap gap-1 my-1">
              {tl.brands.map(b => (
                <button key={b.id} type="button"
                  onClick={() => onSelect({ type: 'brand', brand: b, tl })}
                  className="rounded-pill border-0"
                  style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa', fontSize: '0.62rem', fontWeight: 600, padding: '3px 9px', cursor: 'pointer' }}
                  title={`Reassign ${b.brandName}`}>
                  {b.brandName}
                </button>
              ))}
            </div>
          )}
          {tl.members.map(m => (
            <MemberNode key={m.id}
              m={m}
              tl={tl}
              open={isOpen(`m-${m.id}`)}
              onToggle={() => onMemberToggle(m.id)}
              onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberNode({ m, tl, open, onToggle, onSelect }) {
  const role = (m.userType || 'apc');
  const brandsCount = (m.brands || []).length;
  return (
    <div>
      <div className="d-flex align-items-center gap-2 py-2">
        <Chevron open={open} onClick={onToggle} />
        <Avatar name={m.userName || m.email} size={26} role={role} />
        <button type="button"
          onClick={() => onSelect({ type: 'member', member: m, tl })}
          className="border-0 bg-transparent p-0 fw-semibold text-start"
          style={{ fontSize: '0.78rem', color: '#0f172a', cursor: 'pointer' }}>
          {m.userName || m.email}
        </button>
        <RoleBadge role={role} />
        <MetaRight>
          <strong style={{ color: '#0f172a' }}>{brandsCount}</strong> brand{brandsCount === 1 ? '' : 's'}
        </MetaRight>
      </div>
      {open && brandsCount > 0 && (
        <div className="tree-children d-flex flex-wrap gap-1 my-1"
          style={{ marginLeft: 38 }}>
          {m.brands.map(b => (
            <button key={b.id || b.brandName} type="button"
              onClick={() => onSelect({ type: 'brand', brand: b, tl })}
              className="rounded-pill border-0"
              style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa', fontSize: '0.6rem', fontWeight: 600, padding: '2px 8px', cursor: 'pointer' }}>
              {b.brandName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
