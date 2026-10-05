import React, { useEffect, useRef, useState, useMemo, useLayoutEffect } from 'react';
import { ROLE_COLORS, roleShortLabel, initialsOf, teamKindOf, alpha } from './hierarchyTheme';

/**
 * Org chart view — Boss → OLs → TLs (with APC/IPC roster + brand chips).
 *
 * Connectors are real SVG cubic-bezier paths drawn between measured DOM
 * positions of the cards, so they curve smoothly and re-flow on resize.
 *
 * Note on TL → OL grouping: the data model doesn't pin a specific OL to a
 * TL today. We render all OLs and the boss with a "fan" of curves down to
 * every TL; visually it implies collective oversight rather than a 1:1
 * reporting line, which matches the truth.
 */
export default function HierarchyOrgChart({ boss, ols, tls, teamFilter, onSelect }) {
  const wrapRef = useRef(null);
  const bossRef = useRef(null);
  const olRefs = useRef({});
  const tlRefs = useRef({});
  const [paths, setPaths] = useState([]);
  const [size, setSize]   = useState({ w: 0, h: 0 });

  // Optionally narrow to a single TL via the team filter dropdown.
  const visibleTls = useMemo(() => {
    if (!teamFilter) return tls;
    return tls.filter(t => t.id === teamFilter);
  }, [tls, teamFilter]);

  // Recompute SVG paths on layout / resize.
  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const wrap = wrapRef.current;
    const recompute = () => {
      const wrapBox = wrap.getBoundingClientRect();
      const w = wrap.scrollWidth;
      const h = wrap.scrollHeight;
      const list = [];

      const center = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left - wrapBox.left + b.width / 2, top: b.top - wrapBox.top, bottom: b.bottom - wrapBox.top };
      };

      const bossC = center(bossRef.current);
      const olCs  = ols.map(o => ({ id: o.id, ...(center(olRefs.current[o.id]) || {}) }));
      const tlCs  = visibleTls.map(t => ({ id: t.id, ...(center(tlRefs.current[t.id]) || {}) }));

      // Boss → each OL
      if (bossC) {
        olCs.forEach((ol, i) => {
          if (ol.x == null) return;
          list.push({
            key: `b-${ol.id}`,
            d:   curve(bossC.x, bossC.bottom, ol.x, ol.top),
            stroke: 'url(#grad-purple)',
          });
        });
      }

      // OLs → each TL (fan from "OL row centroid" so we don't lie about
      // who reports to whom). For simplicity use each OL → each TL with
      // low opacity, layered.
      tlCs.forEach(tl => {
        if (tl.x == null) return;
        olCs.forEach(ol => {
          if (ol.x == null) return;
          list.push({
            key: `${ol.id}-${tl.id}`,
            d:   curve(ol.x, ol.bottom, tl.x, tl.top),
            stroke: 'url(#grad-soft)',
            opacity: olCs.length > 1 ? 0.55 : 1,
          });
        });
      });

      setPaths(list);
      setSize({ w, h });
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrap);
    window.addEventListener('resize', recompute);
    return () => { ro.disconnect(); window.removeEventListener('resize', recompute); };
  }, [boss, ols, visibleTls]);

  return (
    <div ref={wrapRef} className="position-relative rounded-4 p-4"
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        backgroundImage: 'radial-gradient(color-mix(in srgb, var(--text-primary) 6%, transparent) 1px, transparent 1px), radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--purple) 10%, transparent), transparent 50%), radial-gradient(circle at 80% 30%, color-mix(in srgb, var(--info) 8%, transparent), transparent 50%)',
        backgroundSize: '14px 14px, auto, auto',
        overflow: 'hidden',
      }}>
      {/* SVG connectors layer */}
      <svg width={size.w} height={size.h}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          <linearGradient id="grad-purple" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="var(--purple)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--purple)" stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="grad-soft" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="var(--purple)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--success)" stopOpacity="0.4"  />
          </linearGradient>
        </defs>
        {paths.map(p => (
          <path key={p.key} d={p.d} fill="none"
            stroke={p.stroke} strokeWidth="2" strokeLinecap="round"
            strokeDasharray="0"
            opacity={p.opacity ?? 1}
            style={{ filter: 'drop-shadow(0 0 4px color-mix(in srgb, var(--purple) 25%, transparent))' }} />
        ))}
      </svg>

      {/* Boss */}
      {boss && (
        <div className="d-flex justify-content-center mb-4 position-relative" style={{ zIndex: 1 }}>
          <BossCard nodeRef={bossRef} user={boss} />
        </div>
      )}

      {/* OLs */}
      {ols.length > 0 && (
        <div className="d-flex justify-content-center flex-wrap gap-3 mb-4 position-relative" style={{ zIndex: 1 }}>
          {ols.map(ol => (
            <OLCard key={ol.id}
              nodeRef={(el) => { olRefs.current[ol.id] = el; }}
              user={ol}
              reportCount={tls.length} />
          ))}
        </div>
      )}

      {/* TLs */}
      {visibleTls.length === 0 ? (
        <div className="text-center text-muted py-4 position-relative" style={{ zIndex: 1 }}>
          No team leads match the current filter.
        </div>
      ) : (
        <div className="row g-3 position-relative" style={{ zIndex: 1 }}>
          {visibleTls.map(tl => (
            <div key={tl.id} className="col-12 col-md-6 col-xl-4">
              <TeamCard
                nodeRef={(el) => { tlRefs.current[tl.id] = el; }}
                tl={tl}
                onClickTl={() => onSelect({ type: 'tl', tl })}
                onClickMember={(m) => onSelect({ type: 'member', member: m, tl })}
                onClickBrand={(b) => onSelect({ type: 'brand', brand: b, tl })}
              />
            </div>
          ))}
        </div>
      )}

      <style>{`
        .node-pop { animation: wx-rise var(--dur-enter) var(--ease-out); }
      `}</style>
    </div>
  );
}

// Cubic bezier from (x1,y1) to (x2,y2) with vertical-ish control points.
function curve(x1, y1, x2, y2) {
  const dy = y2 - y1;
  const c1x = x1, c1y = y1 + dy * 0.55;
  const c2x = x2, c2y = y2 - dy * 0.55;
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

// ── Card components ────────────────────────────────────────────────────

// Renders the user's real profile photo when available, otherwise the
// role-coloured initials box.
function AvatarBox({ src, name, size, fontSize, background, color = 'var(--text-inverse)' }) {
  if (src) {
    return (
      <img src={src} alt={name || ''} className="rounded-3 flex-shrink-0"
        style={{ width: size, height: size, objectFit: 'cover', display: 'block' }} />
    );
  }
  return (
    <div className="rounded-3 d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
      style={{ width: size, height: size, background, color, fontSize }}>
      {initialsOf(name)}
    </div>
  );
}

function BossCard({ nodeRef, user }) {
  const c = ROLE_COLORS.boss;
  return (
    <div ref={nodeRef} className="node-pop d-inline-flex align-items-center gap-2 rounded-3 px-3 py-2"
      style={{
        background: c.solid,
        color: c.on,
        boxShadow: 'var(--shadow-lg)',
        minWidth: 220,
      }}>
      <AvatarBox src={user.avatar_url} name={user.displayName || user.email}
        size={38} fontSize="0.8rem" background="var(--surface-1)" color={c.solid} />
      <div className="min-w-0">
        <div className="fw-bold text-truncate" style={{ fontSize: '0.92rem' }}>{user.displayName || user.email}</div>
        <div className="d-inline-block rounded-pill px-2"
          style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', background: 'var(--surface-1)', color: 'var(--text-primary)' }}>
          BOSS
        </div>
      </div>
    </div>
  );
}

function OLCard({ nodeRef, user, reportCount }) {
  const c = ROLE_COLORS.ol;
  return (
    <div ref={nodeRef} className="node-pop d-inline-flex align-items-center gap-2 rounded-3 px-3 py-2"
      style={{ background: c.light, border: `1px solid ${alpha(c.solid, 19)}`, boxShadow: `0 4px 14px ${alpha(c.solid, 18)}`, minWidth: 220 }}>
      <AvatarBox src={user.avatar_url} name={user.displayName || user.email}
        size={38} fontSize="0.78rem" background={c.solid} color={c.on} />
      <div className="min-w-0">
        <div className="fw-bold text-truncate" style={{ fontSize: '0.86rem', color: 'var(--text-primary)' }}>{user.displayName || user.email}</div>
        <div className="d-flex align-items-center gap-1" style={{ fontSize: '0.6rem' }}>
          <span className="rounded-pill px-2 py-0" style={{ background: c.solid, color: c.on, fontWeight: 800, letterSpacing: '0.06em' }}>OL</span>
          <span className="text-muted" style={{ fontWeight: 700, letterSpacing: '0.06em' }}>· {reportCount} TLS</span>
        </div>
      </div>
    </div>
  );
}

function TeamCard({ nodeRef, tl, onClickTl, onClickMember, onClickBrand }) {
  const kind = teamKindOf(tl.role);
  const c = ROLE_COLORS[tl.role] || ROLE_COLORS.tl;

  return (
    <div ref={nodeRef} className="node-pop card border-0 shadow-sm h-100"
      style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      {/* Header */}
      <button type="button" onClick={onClickTl}
        className="d-flex align-items-center gap-2 p-3 text-start border-0 w-100"
        style={{ background: c.light, borderBottom: `1px solid ${alpha(c.solid, 15)}`, cursor: 'pointer' }}>
        <AvatarBox src={tl.avatar_url} name={tl.displayName || tl.email}
          size={36} fontSize="0.72rem" background={c.solid} color={c.on} />
        <div className="flex-grow-1 min-w-0">
          <div className="fw-semibold text-truncate" style={{ fontSize: '0.86rem', color: 'var(--text-primary)' }}>{tl.displayName || tl.email}</div>
          <span className="rounded-pill px-2" style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', background: c.solid, color: c.on }}>
            {kind.headerLabel}
          </span>
        </div>
        <i className="bi bi-chevron-right text-muted" style={{ fontSize: '0.7rem' }} />
      </button>

      <div className="card-body p-3">
        {/* Brands owned — TL/PCTL only */}
        {kind.hasBrands && (
          <>
            <SectionHeader icon="bi-shop" label="Brands" count={tl.brands.length} />
            {tl.brands.length === 0 ? (
              <EmptyHint text="No brands assigned" />
            ) : (
              <div className="d-flex flex-wrap gap-1 mb-3">
                {tl.brands.map(b => (
                  <BrandChip key={b.id} name={b.brandName}
                    onClick={(e) => { e.stopPropagation(); onClickBrand(b); }} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Members + their brands */}
        <SectionHeader icon="bi-people"
          label={kind.memberLabel}
          count={tl.members.length}
          className={kind.hasBrands ? 'mt-2' : ''} />
        {tl.members.length === 0 ? (
          <EmptyHint text="No team members" />
        ) : (
          <div className="d-flex flex-column gap-2">
            {tl.members.map(m => (
              <MemberRow key={m.id} m={m}
                onClickMember={() => onClickMember(m)}
                onClickBrand={onClickBrand} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberRow({ m, onClickMember, onClickBrand }) {
  const role = (m.userType || 'apc');
  const c = ROLE_COLORS[role] || ROLE_COLORS.apc;
  return (
    <div className="rounded-3 p-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
      <button type="button" onClick={onClickMember}
        className="d-flex align-items-center gap-2 border-0 w-100 text-start"
        style={{ background: 'transparent', cursor: 'pointer' }}>
        <AvatarBox src={m.avatar_url} name={m.userName || m.email}
          size={28} fontSize="0.62rem" background={c.solid} color={c.on} />
        <div className="flex-grow-1 min-w-0">
          <div className="fw-semibold text-truncate" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{m.userName || m.email}</div>
          <span className="rounded-pill px-2" style={{ fontSize: '0.55rem', fontWeight: 800, letterSpacing: '0.06em', background: c.solid, color: c.on }}>
            {roleShortLabel(role)}
          </span>
        </div>
        <i className="bi bi-chevron-right text-muted" style={{ fontSize: '0.6rem' }} />
      </button>
      {m.brands && m.brands.length > 0 && (
        <div className="d-flex flex-wrap gap-1 mt-2">
          {m.brands.map(b => (
            <BrandChip key={b.id || b.brandName} name={b.brandName} small
              onClick={(e) => { e.stopPropagation(); onClickBrand(b); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon, label, count, className }) {
  return (
    <div className={`d-flex align-items-center justify-content-between mb-2 ${className || ''}`}>
      <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <i className={`bi ${icon} me-1`} />{label}
      </div>
      <span className="rounded-pill px-2" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.62rem', fontWeight: 700 }}>{count}</span>
    </div>
  );
}

function EmptyHint({ text }) {
  return (
    <div className="text-muted small mb-3" style={{ fontSize: '0.74rem', fontStyle: 'italic' }}>{text}</div>
  );
}

function BrandChip({ name, onClick, small }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-pill border-0"
      style={{
        background: 'var(--warning-soft)',
        color: 'var(--warning-text)',
        border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
        fontSize: small ? '0.6rem' : '0.66rem',
        fontWeight: 600,
        padding: small ? '2px 8px' : '4px 10px',
        cursor: 'pointer',
        transition: 'transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
      title={`Reassign ${name}`}>
      {name}
    </button>
  );
}
