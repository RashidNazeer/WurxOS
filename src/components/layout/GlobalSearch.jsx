import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { listVisits } from '../../lib/recentVisits';
import BrandAvatar from '../brands/BrandAvatar';
import {
  SearchIcon, XIcon, StoreIcon, ChecklistIcon, ReportIcon, UsersIcon, ClockIcon,
} from '../common/Icon';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;
const EMPTY = { brands: [], users: [], tasks: [], reports: [] };

const REPORT_TYPE_LABEL = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly' };
const MANAGE_PATH = {
  tl: 'tls', pctl: 'pctls', ol: 'ols', apc: 'apcs', ipc: 'ipcs',
  ads_manager: 'ads-managers', developer: 'developers',
};

// Where a person result goes depends on who is searching. Everyone else
// sees no People group (those pages would bounce them).
function peopleScope(role) {
  if (role === 'boss') return 'all';
  if (role === 'ol') return 'all';
  if (role === 'tl') return 'team';
  return null;
}
function personPath(viewerRole, person) {
  if (viewerRole === 'boss') return `/boss/manage/${MANAGE_PATH[person.role] || 'tls'}`;
  if (viewerRole === 'ol') return '/team-hierarchy';
  return '/tl/team';
}

export default function GlobalSearch() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const role = profile?.role;
  const scope = peopleScope(role);
  const inputRef = useRef(null);
  const triggerRef = useRef(null);
  const boxRef = useRef(null);
  const seq = useRef(0);
  const listId = useId();

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(EMPTY);
  const [pos, setPos] = useState(null);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState([]);

  const openPanel = () => {
    setRecent(listVisits(user?.id));
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const closePanel = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Ctrl/Cmd+K opens; Esc closes and hands focus back to the trigger.
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openPanel();
      } else if (e.key === 'Escape' && open) {
        closePanel(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)
          && !triggerRef.current?.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Debounced, abortable search. Each run gets a sequence id so a slow,
  // older response can never overwrite a newer one.
  useEffect(() => {
    if (!open) return undefined;
    const term = q.trim();
    if (term.length < MIN_CHARS) { setResults(EMPTY); setLoading(false); return undefined; }
    setLoading(true);
    const ctrl = new AbortController();
    const mine = ++seq.current;
    const h = setTimeout(async () => {
      const like = `%${term}%`;
      const people = scope
        ? (() => {
          let qy = supabase.from('profiles').select('id, display_name, email, role')
            .or(`display_name.ilike.${like},email.ilike.${like}`)
            .eq('is_active', true).limit(5);
          if (scope === 'team') qy = qy.eq('reports_to', user?.id);
          return qy.abortSignal(ctrl.signal);
        })()
        : Promise.resolve({ data: [] });
      try {
        const [br, us, ta, re] = await Promise.all([
          supabase.from('brands').select('id, brand_name, logo_url, paid_collab_status')
            .or(`brand_name.ilike.${like},client_name.ilike.${like}`)
            .eq('status', 'active').limit(5).abortSignal(ctrl.signal),
          people,
          supabase.from('tasks').select('id, title, status, brand:brand_id(brand_name)')
            .ilike('title', like).limit(5).abortSignal(ctrl.signal),
          supabase.from('reports')
            .select('id, type, status, period_start, brand_id, brand:brand_id!inner(brand_name)')
            .ilike('brand.brand_name', like)
            .order('period_start', { ascending: false })
            .limit(6)
            .abortSignal(ctrl.signal),
        ]);
        if (mine !== seq.current) return;
        setResults({
          brands: br.data || [],
          users: us.data || [],
          tasks: ta.data || [],
          reports: re.data || [],
        });
        setActive(0);
      } catch {
        // aborted or offline: keep whatever is on screen
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(h); ctrl.abort(); };
  }, [q, open, scope, user?.id]);

  // Desktop: under the trigger, clamped to the viewport. Phones (<640px):
  // a full-width sheet under the topbar.
  useEffect(() => {
    if (!open) return undefined;
    function reposition() {
      const trig = triggerRef.current;
      if (!trig) return;
      const r = trig.getBoundingClientRect();
      const vw = window.innerWidth;
      const top = r.bottom + 6;
      const maxHeight = Math.max(200, window.innerHeight - top - 8);
      if (vw < 640) { setPos({ top, left: 8, width: vw - 16, maxHeight }); return; }
      const width = Math.min(Math.max(380, r.width), vw - 24);
      const left = Math.max(12, Math.min(r.left, vw - width - 12));
      setPos({ top, left, width, maxHeight: Math.min(460, maxHeight) });
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  function go(path) {
    setOpen(false);
    setQ('');
    const run = () => navigate(path);
    if (!maybeGuardLeave(run)) run();
  }

  const term = q.trim();
  const showRecent = term.length < MIN_CHARS;

  // One flat list drives both rendering order and arrow-key navigation.
  const options = useMemo(() => {
    if (showRecent) {
      return recent.map((v) => ({ id: `v:${v.path}`, group: 'recent', item: v, path: v.path }));
    }
    return [
      ...results.brands.map((b) => ({ id: `b:${b.id}`, group: 'brands', item: b, path: `/brands/${b.id}` })),
      ...results.reports.map((r) => ({ id: `r:${r.id}`, group: 'reports', item: r, path: `/r/${r.id}` })),
      ...results.tasks.map((t) => ({ id: `t:${t.id}`, group: 'tasks', item: t, path: `/tasks?task=${t.id}` })),
      ...results.users.map((u) => ({ id: `u:${u.id}`, group: 'users', item: u, path: personPath(role, u) })),
    ];
  }, [showRecent, recent, results, role]);

  const optId = (o) => `${listId}-${o.id.replace(/[^\w-]/g, '_')}`;
  const activeOpt = options[Math.min(active, options.length - 1)];

  function onInputKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (options.length) setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length) setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' && activeOpt) {
      e.preventDefault();
      go(activeOpt.path);
    }
  }

  const renderOption = (o) => {
    const { item } = o;
    switch (o.group) {
      case 'recent':
        return (
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{item.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.path}</div>
          </div>
        );
      case 'brands':
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandAvatar brand={item} size={24} radius={5} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{item.brand_name}</div>
              {item.paid_collab_status && item.paid_collab_status !== 'not_applicable' && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Paid collab</div>
              )}
            </div>
          </div>
        );
      case 'reports':
        return (
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{item.brand?.brand_name || '—'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {REPORT_TYPE_LABEL[item.type] || 'Report'} · {fmt(item.period_start)} · {item.status}
            </div>
          </div>
        );
      case 'tasks':
        return (
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{item.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {item.brand?.brand_name || 'Personal'} · {String(item.status || '').replace('_', ' ')}
            </div>
          </div>
        );
      default:
        return (
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{item.display_name || '—'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.email} · {item.role}</div>
          </div>
        );
    }
  };

  const GROUPS = [
    ['recent', 'Recently visited', <ClockIcon key="i" width="14" height="14" />],
    ['brands', 'Brands', <StoreIcon key="i" width="14" height="14" />],
    ['reports', 'Reports', <ReportIcon key="i" width="14" height="14" />],
    ['tasks', 'Tasks', <ChecklistIcon key="i" width="14" height="14" />],
    ['users', 'People', <UsersIcon key="i" width="14" height="14" />],
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="global-search-trigger"
        onClick={openPanel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Search"
      >
        <SearchIcon width="14" height="14" />
        <span className="global-search-label">Search…</span>
        <span className="global-search-kbd">{IS_MAC ? '⌘K' : 'Ctrl K'}</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={boxRef}
          className="global-search-panel"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
        >
          <div className="global-search-input-row">
            <SearchIcon width="15" height="15" style={{ color: 'var(--text-muted)' }} />
            <input
              ref={inputRef}
              className="global-search-input"
              placeholder={scope ? 'Search brands, reports, tasks, people…' : 'Search brands, reports, tasks…'}
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0); }}
              onKeyDown={onInputKeyDown}
              role="combobox"
              aria-expanded={options.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOpt ? optId(activeOpt) : undefined}
              aria-label="Search"
            />
            {q && (
              <button type="button" onClick={() => { setQ(''); inputRef.current?.focus(); }} className="global-search-clear" aria-label="Clear">
                <XIcon width="13" height="13" />
              </button>
            )}
          </div>

          <div className="global-search-body" id={listId} role="listbox" aria-label="Search results">
            {showRecent && options.length === 0 ? (
              <div className="global-search-hint">Type at least {MIN_CHARS} letters to search across the app.</div>
            ) : !showRecent && loading && options.length === 0 ? (
              <div className="global-search-hint">
                <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Searching…
              </div>
            ) : !showRecent && options.length === 0 ? (
              <div className="global-search-hint">No matches for "{term}".</div>
            ) : (
              GROUPS.map(([key, title, icon]) => {
                const rows = options.filter((o) => o.group === key);
                if (!rows.length) return null;
                return (
                  <div key={key} className="global-search-group" role="group" aria-label={title}>
                    <div className="global-search-group-title" aria-hidden="true">{icon} {title}</div>
                    {rows.map((o) => {
                      const selected = activeOpt?.id === o.id;
                      return (
                        <div
                          key={o.id}
                          id={optId(o)}
                          role="option"
                          aria-selected={selected}
                          className={`global-search-item${selected ? ' is-active' : ''}`}
                          onMouseEnter={() => setActive(options.indexOf(o))}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => go(o.path)}
                        >
                          {renderOption(o)}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
