import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { getMenuForRole } from './menu';
import { ChevronRightIcon, MenuIcon, HelpIcon, SearchIcon, XIcon } from '../common/Icon';
import UnreadDot from './UnreadDot';

export default function Sidebar({ role, collapsed, onToggle }) {
  const menu = getMenuForRole(role);
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

  // Open the keyboard-shortcuts overlay by synthesizing the '?' key
  // press that KeyboardShortcuts.jsx listens for — no need to lift
  // its state or share context.
  const openShortcuts = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
  };

  return (
    <aside className="shell-sidebar">
      <div className="shell-sidebar-header">
        <div className="brand-mark">W</div>
        <div className="brand-text">
          <div className="brand-name">WurxOS</div>
          <div className="brand-sub">v2</div>
        </div>
        <button
          type="button"
          className="shell-sidebar-toggle"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <MenuIcon width="16" height="16" />
        </button>
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
        ) : (
          filtered.map((item, i) =>
            item.children ? (
              <NavGroup key={i} item={item} collapsed={collapsed} forceOpen={!!q} />
            ) : (
              <NavItem key={i} item={item} collapsed={collapsed} />
            ),
          )
        )}
      </nav>

      <div className="shell-sidebar-footer">
        <div className="shell-sidebar-footer-brand">
          <span className="shell-sidebar-footer-dot" />
          <span>WurxOS · v2</span>
        </div>
        <button
          type="button"
          className="shell-sidebar-footer-btn"
          onClick={openShortcuts}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <HelpIcon width="14" height="14" />
        </button>
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
