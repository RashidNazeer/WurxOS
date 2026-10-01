import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import { getMenuForRole, applyMenuLayout } from './menu';
import { withApprovals, sectionMenu } from './navStructure';
import { useApprovalsCount } from '../../lib/approvalsBadge';
import { preloadPath } from '../../routes/pages';
import { ChevronRightIcon, MenuIcon, SearchIcon, XIcon } from '../common/Icon';
import UnreadDot from './UnreadDot';
import { useNotifications } from '../../contexts/NotificationsContext';
import { useBuddy } from '../../contexts/BuddyContext';

export default function Sidebar({ role, menuLayout, collapsed, onToggle, mobileOpen, onMobileClose }) {
  // Role menu + the user's saved order/pins (Settings → Menu Layout). Pinned
  // entries are tagged `_pinned` and floated to the top by applyMenuLayout.
  const buddy = !!useBuddy()?.allowed;
  const menu = useMemo(
    () => applyMenuLayout(withApprovals(getMenuForRole(role, { buddy }), role), menuLayout),
    [role, buddy, menuLayout],
  );
  // Default layout → headed sections ordered by daily use (F4). A saved
  // layout renders flat, exactly as the user arranged it.
  const hasSavedLayout = !!(menuLayout?.order?.length || menuLayout?.pinned?.length);
  const sections = useMemo(
    () => (hasSavedLayout ? null : sectionMenu(menu, role)),
    [hasSavedLayout, menu, role],
  );
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
  // The mobile drawer always renders expanded (shell.css), so flyouts are
  // only for the collapsed desktop rail.
  const isDesktop = useMediaQuery('(min-width: 861px)');
  const flyout = collapsed && isDesktop;
  const renderEntry = (item, key) => (item.children
    ? (flyout
      ? <NavFlyoutGroup key={key} item={item} />
      : <NavGroup key={key} item={item} collapsed={collapsed} forceOpen={!!q} />)
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
        ) : sections ? (
          sections.map((s) => (
            <div key={s.label} className="shell-nav-section" role="group" aria-label={s.label}>
              <div className="shell-nav-section-label" aria-hidden="true">{s.label}</div>
              {s.entries.map((item, i) => renderEntry(item, `${s.label}-${i}`))}
            </div>
          ))
        ) : (
          <>
            {pinnedItems.length > 0 && (
              <>
                {!collapsed && (
                  <div className="shell-nav-section-label">Pinned</div>
                )}
                {pinnedItems.map((item, i) => renderEntry(item, `p${i}`))}
                <div className="shell-nav-divider" aria-hidden="true" />
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
  // Alert items (e.g. Creator Library) escalate a plain unread dot into a
  // blinking, colour-inverted row when their category has unread — impossible
  // to miss. Non-alert items keep the subtle dot.
  const { counts } = useNotifications();
  const alertN = item.alert && item.category ? (counts.byCategory?.[item.category] || 0) : 0;
  return (
    <NavLink
      to={item.to}
      onPointerEnter={() => preloadPath(item.to)}
      onFocus={() => preloadPath(item.to)}
      end={item.to === '/dashboard'}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}${alertN ? ' shell-nav-link--alert' : ''}`}
    >
      <span className="icon" style={{ position: 'relative' }}>
        {Icon ? <Icon width="17" height="17" /> : null}
        {item.category && !alertN && <UnreadDot category={item.category} />}
      </span>
      <span className="label">{item.label}</span>
      {alertN > 0 && <span className="shell-nav-alert-badge">{alertN}</span>}
      {item.badge === 'approvals' && <ApprovalsBadge />}
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
        aria-label={item.label}
        aria-expanded={open}
      >
        <span className="icon" style={{ position: 'relative' }}>
          {Icon ? <Icon width="17" height="17" /> : null}
          {item.dot && item.category && <UnreadDot category={item.category} />}
        </span>
        <span className="label">{item.label}</span>
        <span className="chev"><ChevronRightIcon width="14" height="14" /></span>
      </button>
      {/* Always rendered so open/close can animate (grid rows 0fr ↔ 1fr);
          inert keeps the hidden links out of the tab order. */}
      <div className="shell-nav-sub-wrap" data-open={open} inert={!open || undefined}>
        <div className="shell-nav-sub">
          {item.children.map((c, i) => (
            <NavLink
              key={i}
              to={c.to}
              onPointerEnter={() => preloadPath(c.to)}
              onFocus={() => preloadPath(c.to)}
              end={!c.prefix}
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="label">{c.label}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </>
  );
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

// Collapsed desktop rail: a group's children open in a flyout beside the
// rail. Opens on pointer hover, click, Enter/Space or ArrowRight (not on
// focus alone, so tabbing down the rail doesn't pop every group); closes on
// Escape, an outside click, or when focus leaves. Click/keyboard "pins" it
// open so mouse-leave doesn't close it.
function NavFlyoutGroup({ item }) {
  const location = useLocation();
  const anyActive = item.children.some((c) => c.to && location.pathname.startsWith(c.to));
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const pinned = useRef(false);
  const focusFirst = useRef(false);
  const timer = useRef(null);
  const panelId = useId();
  const Icon = item.icon;

  const cancelHide = () => clearTimeout(timer.current);
  const show = () => { cancelHide(); setOpen(true); };
  const close = (refocus = false) => {
    cancelHide();
    pinned.current = false;
    setOpen(false);
    const btn = btnRef.current;
    if (refocus && btn && document.activeElement !== btn) btn.focus();
  };
  const hideSoon = () => {
    if (pinned.current) return;
    cancelHide();
    timer.current = setTimeout(() => setOpen(false), 180);
  };
  const firstLink = () => panelRef.current?.querySelector('a');
  const enterPanel = () => {
    pinned.current = true;
    const first = pos && firstLink();
    if (first) first.focus();
    else { focusFirst.current = true; show(); }
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    pinned.current = false;
    setOpen(false);
  }, [location.pathname]);

  // Measure after the (initially hidden) panel mounts, then clamp it inside
  // the viewport. Runs before paint, so it never flashes at 0,0.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const h = panelRef.current ? panelRef.current.offsetHeight : 0;
      setPos({ top: Math.max(8, Math.min(r.top, window.innerHeight - h - 8)), left: r.right + 8 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && pos && focusFirst.current) {
      focusFirst.current = false;
      firstLink()?.focus();
    }
  }, [open, pos]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const a = document.activeElement;
      close(a === btnRef.current || !!panelRef.current?.contains(a));
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onFocusOut = (e) => {
    const to = e.relatedTarget;
    if (to && (btnRef.current?.contains(to) || panelRef.current?.contains(to))) return;
    if (to) close();
    else hideSoon();
  };

  const onBtnClick = (e) => {
    if (open && pinned.current) { close(); return; }
    if (e.detail === 0) enterPanel();     // Enter / Space
    else { pinned.current = true; show(); }
  };
  const onBtnKeyDown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      enterPanel();
    } else if (e.key === 'Tab' && !e.shiftKey && open) {
      // The panel is portaled to <body>, so the browser's Tab order would
      // skip it; step into it explicitly.
      e.preventDefault();
      enterPanel();
    }
  };
  // Activating a link unmounts the panel; without this, focus drops to <body>.
  const onLinkClick = () => {
    close();
    document.querySelector('.shell-content')?.focus({ preventScroll: true });
  };

  const onPanelKeyDown = (e) => {
    const links = Array.from(panelRef.current?.querySelectorAll('a') || []);
    const i = links.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = links.length;
      if (!n) return;
      links[e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n].focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab' && (e.shiftKey ? i <= 0 : i === links.length - 1)) {
      // Leaving the panel: hand focus back to the trigger. Shift+Tab stops
      // there; plain Tab lets the browser carry on to the next rail item.
      if (e.shiftKey) e.preventDefault();
      close(true);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`shell-nav-toggle${anyActive ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        aria-label={item.label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onBtnClick}
        onKeyDown={onBtnKeyDown}
        onBlur={onFocusOut}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
      >
        <span className="icon" style={{ position: 'relative' }}>
          {Icon ? <Icon width="17" height="17" /> : null}
          {item.dot && item.category && <UnreadDot category={item.category} />}
        </span>
        <span className="label">{item.label}</span>
        <span className="chev"><ChevronRightIcon width="14" height="14" /></span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className="shell-nav-flyout"
          role="group"
          aria-label={item.label}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          onKeyDown={onPanelKeyDown}
          onBlur={onFocusOut}
        >
          <div className="shell-nav-flyout-title">{item.label}</div>
          {item.children.map((c, i) => (
            <NavLink
              key={i}
              to={c.to}
              onPointerEnter={() => preloadPath(c.to)}
              onFocus={() => preloadPath(c.to)}
              end={!c.prefix}
              className={({ isActive }) => `shell-nav-link ${isActive ? 'active' : ''}`}
              onClick={onLinkClick}
            >
              <span className="label">{c.label}</span>
            </NavLink>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// Count bubble for the Approvals entry; hidden at zero.
function ApprovalsBadge() {
  const n = useApprovalsCount();
  if (!n) return null;
  return <span className="shell-nav-alert-badge" aria-label={`${n} waiting`}>{n > 99 ? '99+' : n}</span>;
}