import React, { useEffect, useRef, useState, useMemo, useLayoutEffect } from 'react';
import { ROLE_COLORS, roleShortLabel, initialsOf } from './hierarchyTheme';

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
        background: 'radial-gradient(circle at 20% 0%, rgba(124,58,237,0.10), transparent 50%), radial-gradient(circle at 80% 30%, rgba(59,130,246,0.08), transparent 50%), #fff',
        border: '1px solid #e2e8f0',
        backgroundImage: `radial-gradient(rgba(15,23,42,0.06) 1px, transparent 1px), radial-gradient(circle at 20% 0%, rgba(124,58,237,0.10), transparent 50%), radial-gradient(circle at 80% 30%, rgba(59,130,246,0.08), transparent 50%)`,
        backgroundSize: '14px 14px, auto, auto',
        overflow: 'hidden',
      }}>
      {/* SVG connectors layer */}
      <svg width={size.w} height={size.h}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          <linearGradient id="grad-purple" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#7c3aed" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="grad-soft" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#7c3aed" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#16a34a" stopOpacity="0.4"  />
          </linearGradient>
        </defs>
        {paths.map(p => (
          <path key={p.key} d={p.d} fill="none"
            stroke={p.stroke} strokeWidth="2" strokeLinecap="round"
            strokeDasharray="0"
            opacity={p.opacity ?? 1}
            style={{ filter: 'drop-shadow(0 0 4px rgba(124,58,237,0.25))' }} />
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
        @keyframes node-pop {
          from { opacity: 0; transform: translateY(6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)   scale(1);    }
        }
        .node-pop { animation: node-pop 320ms cubic-bezier(.22,.61,.36,1); }
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

function BossCard({ nodeRef, user }) {
  const c = ROLE_COLORS.boss;
  return (
    <div ref={nodeRef} className="node-pop d-inline-flex align-items-center gap-2 rounded-3 px-3 py-2"
      style={{
        background: 'linear-gradient(135deg, #0f172a, #1e293b)',
        color: '#fff',
        boxShadow: '0 10px 30px rgba(15,23,42,0.35)',
        minWidth: 220,
      }}>
      <div className="rounded-3 d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
        style={{ width: 38, height: 38, background: '#fff', color: c.solid, fontSize: '0.8rem' }}>
        {initialsOf(user.displayName || user.email)}
      </div>
      <div className="min-w-0">
        <div className="fw-bold text-truncate" style={{ fontSize: '0.92rem' }}>{user.displayName || user.email}</div>
        <div className="d-inline-block rounded-pill px-2"
          style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', background: '#fff', color: '#0f172a' }}>
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
      style={{ background: c.light, border: `1px solid ${c.solid}30`, boxShadow: '0 4px 14px rgba(124,58,237,0.18)', minWidth: 220 }}>
      <div className="rounded-3 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
        style={{ width: 38, height: 38, background: `linear-gradient(135deg, ${c.solid}, #5b21b6)`, fontSize: '0.78rem' }}>
        {initialsOf(user.displayName || user.email)}
      </div>
      <div className="min-w-0">
        <div className="fw-bold text-truncate" style={{ fontSize: '0.86rem', color: '#0f172a' }}>{user.displayName || user.email}</div>
        <div className="d-flex align-items-center gap-1" style={{ fontSize: '0.6rem' }}>
          <span className="rounded-pill px-2 py-0" style={{ background: c.solid, color: '#fff', fontWeight: 800, letterSpacing: '0.06em' }}>OL</span>
          <span className="text-muted" style={{ fontWeight: 700, letterSpacing: '0.06em' }}>· {reportCount} TLS</span>
        </div>
      </div>
    </div>
  );
}

function TeamCard({ nodeRef, tl, onClickTl, onClickMember, onClickBrand }) {
  const isPCTL = tl.role === 'pctl';
  const c = isPCTL ? ROLE_COLORS.pctl : ROLE_COLORS.tl;

  return (
    <div ref={nodeRef} className="node-pop card border-0 shadow-sm h-100"
      style={{ borderRadius: 14, overflow: 'hidden' }}>
      {/* Header */}
      <button type="button" onClick={onClickTl}
        className="d-flex align-items-center gap-2 p-3 text-start border-0 w-100"
        style={{ background: c.light, borderBottom: `1px solid ${c.solid}25`, cursor: 'pointer' }}>
        <div className="rounded-3 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
          style={{ width: 36, height: 36, background: `linear-gradient(135deg, ${c.solid}, ${c.text})`, fontSize: '0.72rem' }}>
          {initialsOf(tl.displayName || tl.email)}
        </div>
        <div className="flex-grow-1 min-w-0">
          <div className="fw-semibold text-truncate" style={{ fontSize: '0.86rem', color: '#0f172a' }}>{tl.displayName || tl.email}</div>
          <span className="rounded-pill px-2" style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', background: c.solid, color: '#fff' }}>
            {isPCTL ? 'PAID COLLAB TL' : 'TEAM LEAD'}
          </span>
        </div>
        <i className="bi bi-chevron-right text-muted" style={{ fontSize: '0.7rem' }} />
      </button>

      <div className="card-body p-3">
        {/* Brands owned */}
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

        {/* Members + their brands */}
        <SectionHeader icon="bi-people"
          label={isPCTL ? 'IPCs' : 'APCs'}
          count={tl.members.length}
          className="mt-2" />
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
    <div className="rounded-3 p-2" style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
      <button type="button" onClick={onClickMember}
        className="d-flex align-items-center gap-2 border-0 w-100 text-start"
        style={{ background: 'transparent', cursor: 'pointer' }}>
        <div className="rounded-3 d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
          style={{ width: 28, height: 28, background: `linear-gradient(135deg, ${c.solid}, ${c.text})`, fontSize: '0.62rem' }}>
          {initialsOf(m.userName || m.email)}
        </div>
        <div className="flex-grow-1 min-w-0">
          <div className="fw-semibold text-truncate" style={{ fontSize: '0.78rem', color: '#0f172a' }}>{m.userName || m.email}</div>
          <span className="rounded-pill px-2" style={{ fontSize: '0.55rem', fontWeight: 800, letterSpacing: '0.06em', background: c.solid, color: '#fff' }}>
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
      <span className="rounded-pill px-2" style={{ background: '#f1f5f9', color: '#475569', fontSize: '0.62rem', fontWeight: 700 }}>{count}</span>
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
        background: 'linear-gradient(135deg, #fff7ed, #ffedd5)',
        color: '#9a3412',
        border: '1px solid #fed7aa',
        fontSize: small ? '0.6rem' : '0.66rem',
        fontWeight: 600,
        padding: small ? '2px 8px' : '4px 10px',
        cursor: 'pointer',
        transition: 'transform 120ms ease, box-shadow 120ms ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(154,52,18,0.18)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
      title={`Reassign ${name}`}>
      {name}
    </button>
  );
}
