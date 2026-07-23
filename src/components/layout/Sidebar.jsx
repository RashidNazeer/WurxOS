import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { getMenuForRole, applyMenuLayout } from './menu';
import { ChevronRightIcon, MenuIcon, SearchIcon, XIcon } from '../common/Icon';
import UnreadDot from './UnreadDot';

export default function Sidebar({ role, menuLayout, collapsed, onToggle, mobileOpen, onMobileClose }) {
  // Role menu + the user's saved order/pins (Settings → Menu Layout). Pinned
  // entries are tagged `_pinned` and floated to the top by applyMenuLayout.
  const menu = useMemo(() => applyMenuLayout(getMenuForRole(role), menuLayout), [role, menuLayout]);
  const [query, setQuery] = useState('');

  // v1-style menu filter — substring match against item labels +
  // the children of collapsible groups. A group is shown if either:
  //   * its own label matches, OR
  //   * any of its children match (only those children are rendered).
  const q = query.trim().toLowerCase();
  const match = (label) => !q || (label || '').toLowerCase().includes(q);

  const filtered = useMemo(() => {
    if (!q) return menu;
    return menu
      .map((item) => {
        if (item.children) {
          if (match(item.label)) return item; // group label matches → keep all children
          const hits = item.children.filter((c) => match(c.label));
          return hits.length ? { ...item, children: hits } : null;
        }
        return match(item.label) ? item : null;
      })
      .filter(Boolean);
  }, [menu, q]);

  const pinnedItems = useMemo(() => menu.filter((m) => m._pinned), [menu]);
  const restItems = useMemo(() => menu.filter((m) => !m._pinned), [menu]);
  const renderEntry = (item, key) => (item.children
    ? <NavGroup key={key} item={item} collapsed={collapsed} forceOpen={!!q} />
    : <NavItem key={key} item={item} collapsed={collapsed} />);

  return (
    <aside className="shell-sidebar">
      <div className="shell-sidebar-header">
        <div className="brand-mark">
          <img src="/Logo.png" alt="WurxOS" />
        </div>
        <div className="brand-text">
          <div className="brand-name">WurxOS</div>
          <div className="brand-sub">by Wurx Media</div>
        </div>
        {/* On mobile (drawer open), this button is a CLOSE button — the
            drawer slides shut. On desktop, it toggles the collapsed rail.
            Mixing the two in one button confused users who tapped here
            expecting the drawer to close and instead collapsed it into
            an icons-only rail. */}
        {mobileOpen ? (
          <button
            type="button"
            className="shell-sidebar-toggle"
            onClick={onMobileClose}
            aria-label="Close menu"
            title="Close menu"
          >
            <XIcon width="14" height="14" />
          </button>
        ) : (
          <button
            type="button"
            className="shell-sidebar-toggle"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <MenuIcon width="16" height="16" />
          </button>
        )}
      </div>

      {/* v1-parity menu search — only rendered when expanded so the
          collapsed rail stays icon-only. */}
      {!collapsed && (
        <div className="shell-sidebar-search">
          <span className="shell-sidebar-search-icon">
            <SearchIcon width="13" height="13" />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search menu…"
            aria-label="Search menu"
            className="shell-sidebar-search-input"
          />
          {query && (
            <button
              type="button"
              className="shell-sidebar-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear"
            >
              <XIcon width="11" height="11" />
            </button>
          )}
        </div>
      )}

      <nav className="shell-nav">
        {filtered.length === 0 ? (
          <div className="shell-nav-empty">No menu items match.</div>
        ) : q ? (
          filtered.map((item, i) => renderEntry(item, i))
        ) : (
          <>
            {pinnedItems.length > 0 && (
              <>
                {!collapsed && (
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '4px 16px 4px' }}>Pinned</div>
                )}
                {pinnedItems.map((item, i) => renderEntry(item, `p${i}`))}
                <div style={{ height: 1, background: 'var(--border-subtle)', margin: '8px 14px' }} />
              </>
            )}
            {restItems.map((item, i) => renderEntry(item, `r${i}`))}
          </>
        )}
      </nav>

      <div className="shell-sidebar-footer">
        <div className="shell-sidebar-footer-card">
          <div className="shell-sidebar-footer-logo">
            <img src="/Logo.png" alt="Wurx Media" />
          </div>
          <div className="shell-sidebar-footer-text">
            <div className="shell-sidebar-footer-title">Wurx Media</div>
            <div className="shell-sidebar-footer-sub">
              <span className="shell-sidebar-footer-dot" />
              WurxOS · v2 · Operational
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function NavItem({ item, collapsed }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/dashboard'}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
    >
      <span className="icon" style={{ position: 'relative' }}>
        {Icon ? <Icon width="17" height="17" /> : null}
        {item.category && <UnreadDot category={item.category} />}
      </span>
      <span className="label">{item.label}</span>
    </NavLink>
  );
}

function NavGroup({ item, collapsed, forceOpen = false }) {
  const location = useLocation();
  const anyActive = item.children.some((c) => c.to && location.pathname.startsWith(c.to));
  const [open, setOpen] = useState(anyActive || forceOpen);
  // Auto-close the expand state whenever the sidebar collapses so it
  // doesn't flash the sub-menu briefly on re-expand. Auto-open when
  // the search filter trims this group to its hits — matches v1 behavior.
  useEffect(() => {
    if (collapsed) setOpen(false);
    else if (forceOpen || anyActive) setOpen(true);
  }, [collapsed, anyActive, forceOpen]);

  const Icon = item.icon;

  return (
    <>
      <button
        type="button"
        className="shell-nav-toggle"
        data-open={open}
        onClick={() => setOpen((o) => !o)}
        title={collapsed ? item.label : undefined}
      >
        <span className="icon">{Icon ? <Icon width="17" height="17" /> : null}</span>
        <span className="label">{item.label}</span>
        <span className="chev"><ChevronRightIcon width="14" height="14" /></span>
      </button>
      {open && (
        <div className="shell-nav-sub">
          {item.children.map((c, i) => (
            <NavLink
              key={i}
              to={c.to}
              end
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="label">{c.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </>
  );
}
