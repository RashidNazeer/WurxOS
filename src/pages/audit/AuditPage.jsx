import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  AlertIcon, RefreshIcon, SearchIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

const ENTITY_TYPES = ['all', 'brands', 'tasks', 'reports', 'leave_requests', 'brand_switch_requests'];
const ACTIONS      = ['all', 'insert', 'update', 'delete'];

export default function AuditPage() {
  const [entity, setEntity]   = useState('all');
  const [action, setAction]   = useState('all');
  const [q, setQ]             = useState('');

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['audit', entity, action],
    queryFn: async () => {
      let qb = supabase
        .from('audit_log')
        .select('*, actor:actor_id(display_name, role)')
        .order('created_at', { ascending: false })
        .limit(250);
      if (entity !== 'all') qb = qb.eq('entity_type', entity);
      if (action !== 'all') qb = qb.eq('action', action);
      const { data, error } = await qb;
      if (error) throw new Error(error.message);
      return data || [];
    },
  });
  const err  = queryError?.message || '';
  const load = () => qc.invalidateQueries({ queryKey: ['audit'] });

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return rows;
    return rows.filter((r) =>
      (r.actor?.display_name || '').toLowerCase().includes(qq) ||
      (r.entity_type || '').toLowerCase().includes(qq) ||
      JSON.stringify(r.before || {}).toLowerCase().includes(qq) ||
      JSON.stringify(r.after  || {}).toLowerCase().includes(qq),
    );
  }, [rows, q]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-subtitle">Most recent 250 changes across brands, tasks, reports, leaves, and switch requests.</p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={load} disabled={loading}>
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      <div className="wx-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 220 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input className="wx-input" placeholder="Search actor or payload…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 200 }} value={entity} onChange={(e) => setEntity(e.target.value)}>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t === 'all' ? 'All entities' : t}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 140 }} value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => <option key={a} value={a}>{a === 'all' ? 'All actions' : a}</option>)}
        </select>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <div className="wx-list">
        <div className="wx-list-row wx-list-header audit-row" style={{ gridTemplateColumns: '160px 1.2fr 140px 1fr 140px' }}>
          <div>When</div><div>Actor</div><div>Action</div><div>Summary</div><div>Entity</div>
        </div>
        {loading ? (
          <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="wx-empty">
            <div className="wx-empty-title">Nothing logged</div>
            <div>No entries match the current filters.</div>
          </div>
        ) : filtered.map((r) => <AuditRow key={r.id} row={r} />)}
      </div>
    </>
  );
}

function AuditRow({ row }) {
  const tone = actionTone(row.action);
  const summary = summarize(row);
  return (
    <div className="wx-list-row audit-row" style={{ gridTemplateColumns: '160px 1.2fr 140px 1fr 140px', alignItems: 'start' }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
        {new Date(row.created_at).toLocaleString()}
      </div>
      <div style={{ fontSize: 12.5 }}>
        <div style={{ fontWeight: 600 }}>{row.actor?.display_name || 'System'}</div>
        {row.actor?.role && <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{row.actor.role}</div>}
      </div>
      <div>
        <span style={{
          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
          padding: '2px 8px', borderRadius: 'var(--radius-pill)',
          background: tone.bg, color: tone.fg,
        }}>{row.action}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{summary}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
        {row.entity_type}
      </div>
    </div>
  );
}

function summarize(row) {
  const primary =
    row.after?.title
    || row.before?.title
    || row.after?.brand_name
    || row.before?.brand_name
    || row.after?.status
    || row.before?.status
    || row.entity_id?.slice(0, 8);

  if (row.action === 'update' && row.before && row.after) {
    const diffs = [];
    for (const k of Object.keys(row.after)) {
      if (k === 'updated_at' || k === 'created_at') continue;
      if (JSON.stringify(row.before[k]) !== JSON.stringify(row.after[k])) diffs.push(k);
    }
    const changed = diffs.slice(0, 3).join(', ');
    return `${primary} · changed: ${changed || '—'}${diffs.length > 3 ? ` (+${diffs.length - 3})` : ''}`;
  }
  return primary || '—';
}

function actionTone(a) {
  if (a === 'insert') return { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', fg: 'var(--success)' };
  if (a === 'delete') return { bg: 'color-mix(in srgb, var(--danger) 18%, transparent)',  fg: 'var(--danger)' };
  return { bg: 'color-mix(in srgb, var(--accent) 18%, transparent)', fg: 'var(--accent)' };
}
