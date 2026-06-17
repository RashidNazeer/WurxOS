import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { maybeGuardLeave } from '../../lib/reportLeaveGuard';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import BrandAvatar from '../brands/BrandAvatar';
import {
  SearchIcon, XIcon, StoreIcon, ChecklistIcon, ReportIcon, UsersIcon,
} from '../common/Icon';

export default function GlobalSearch() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const boxRef   = useRef(null);

  const [open, setOpen]     = useState(false);
  const [q, setQ]           = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState({ brands: [], users: [], tasks: [], reports: [] });
  const [pos, setPos]       = useState(null);  // {top,left,width}

  // Keyboard shortcut: Ctrl/Cmd+K opens, Esc closes
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Click-outside / scroll closes
  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)
          && !e.target.closest?.('.global-search-trigger')) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) { setResults({ brands: [], users: [], tasks: [], reports: [] }); return; }
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const like = `%${term}%`;
        const [br, us, ta, re] = await Promise.all([
          supabase.from('brands').select('id, brand_name, logo_url, paid_collab_status')
            .or(`brand_name.ilike.${like},client_name.ilike.${like}`)
            .eq('status', 'active').limit(5),
          supabase.from('profiles').select('id, display_name, email, role')
            .or(`display_name.ilike.${like},email.ilike.${like}`)
            .eq('is_active', true).limit(5),
          supabase.from('tasks').select('id, title, status, brand:brand_id(brand_name)')
            .ilike('title', like).limit(5),
          supabase.from('reports').select('id, type, status, period_start, brand:brand_id(brand_name)')
            .limit(8),  // reports have no text to ILIKE against; filter client-side by brand_name
        ]);
        const reports = (re.data || [])
          .filter((r) => (r.brand?.brand_name || '').toLowerCase().includes(term.toLowerCase()))
          .slice(0, 5);
        setResults({
          brands: br.data || [],
          users: us.data || [],
          tasks: ta.data || [],
          reports,
        });
      } finally { setLoading(false); }
    }, 180);
    return () => clearTimeout(h);
  }, [q, open]);

  // Position the panel under the trigger
  useEffect(() => {
    if (!open) return;
    function reposition() {
      const trig = document.querySelector('.global-search-trigger');
      if (!trig) return;
      const r = trig.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, width: Math.max(380, r.width) });
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

  const total = results.brands.length + results.users.length + results.tasks.length + results.reports.length;

  return (
    <>
      <button
        type="button"
        className="global-search-trigger"
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
      >
        <SearchIcon width="14" height="14" />
        <span className="global-search-label">Search…</span>
        <span className="global-search-kbd">⌘K</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={boxRef}
          className="global-search-panel"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          <div className="global-search-input-row">
            <SearchIcon width="15" height="15" style={{ color: 'var(--text-muted)' }} />
            <input
              ref={inputRef}
              className="global-search-input"
              placeholder="Search brands, users, tasks, reports…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && (
              <button type="button" onClick={() => setQ('')} className="global-search-clear" aria-label="Clear">
                <XIcon width="13" height="13" />
              </button>
            )}
          </div>

          <div className="global-search-body">
            {!q.trim() ? (
              <div className="global-search-hint">Start typing to search across the app.</div>
            ) : loading ? (
              <div className="global-search-hint">
                <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Searching…
              </div>
            ) : total === 0 ? (
              <div className="global-search-hint">No matches for "{q}".</div>
            ) : (
              <>
                <Group icon={<StoreIcon width="14" height="14" />} title="Brands" items={results.brands}
                  render={(b) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <BrandAvatar brand={b} size={24} radius={5} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{b.brand_name}</div>
                        {b.paid_collab_status && b.paid_collab_status !== 'not_applicable' && (
                          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Paid collab</div>
                        )}
                      </div>
                    </div>
                  )}
                  onClick={() => go('/brands')} />
                <Group icon={<UsersIcon width="14" height="14" />} title="People" items={results.users}
                  render={(u) => (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{u.display_name || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.email} · {u.role}</div>
                    </div>
                  )}
                  onClick={(u) => go(userRoute(u.role))} />
                <Group icon={<ChecklistIcon width="14" height="14" />} title="Tasks" items={results.tasks}
                  render={(t) => (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{t.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t.brand?.brand_name || 'Personal'} · {t.status.replace('_', ' ')}
                      </div>
                    </div>
                  )}
                  onClick={() => go('/tasks')} />
                <Group icon={<ReportIcon width="14" height="14" />} title="Reports" items={results.reports}
                  render={(r) => (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{r.brand?.brand_name || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {r.type === 'biweekly' ? 'Bi-weekly' : 'Weekly'} · {fmt(r.period_start)} · {r.status}
                      </div>
                    </div>
                  )}
                  onClick={() => go('/reports')} />
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function Group({ icon, title, items, render, onClick }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="global-search-group">
      <div className="global-search-group-title">{icon} {title}</div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className="global-search-item"
          onClick={() => onClick(it)}
        >
          {render(it)}
        </button>
      ))}
    </div>
  );
}

function userRoute(role) {
  const map = { tl: 'tls', pctl: 'pctls', ol: 'ols', apc: 'apcs', ipc: 'ipcs', developer: 'developers' };
  return '/boss/manage/' + (map[role] || 'tls');
}

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
