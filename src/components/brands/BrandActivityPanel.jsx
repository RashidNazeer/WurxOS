import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { ChecklistIcon, ReportIcon, AlertIcon } from '../common/Icon';

export default function BrandActivityPanel({ brandId }) {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setErr('');
      try {
        const [tasks, reports] = await Promise.all([
          supabase.from('tasks')
            .select('id, title, status, updated_at, assignee:assignee_id(display_name)')
            .eq('brand_id', brandId)
            .order('updated_at', { ascending: false })
            .limit(8),
          supabase.from('reports')
            .select('id, type, status, period_start, updated_at, author:author_id(display_name)')
            .eq('brand_id', brandId)
            .order('updated_at', { ascending: false })
            .limit(8),
        ]);
        if (tasks.error) throw tasks.error;
        if (reports.error) throw reports.error;
        const merged = [
          ...(tasks.data || []).map((t) => ({ kind: 'task',   when: t.updated_at, ...t })),
          ...(reports.data || []).map((r) => ({ kind: 'report', when: r.updated_at, ...r })),
        ].sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 12);
        if (!cancelled) setItems(merged);
      } catch (e) { if (!cancelled) setErr(e.message); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [brandId]);

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{
        fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
      }}>
        Recent activity
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border-default)', padding: '10px 12px',
          borderRadius: 'var(--radius-md)', color: 'var(--text-muted)',
          fontSize: 12.5, textAlign: 'center',
        }}>
          No recent activity on this brand.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it) => (
            <div key={`${it.kind}-${it.id}`} style={{
              display: 'grid', gridTemplateColumns: '24px 1fr auto',
              gap: 10, alignItems: 'center',
              padding: '8px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ color: 'var(--text-muted)' }}>
                {it.kind === 'task'
                  ? <ChecklistIcon width="16" height="16" />
                  : <ReportIcon width="16" height="16" />}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)' }}>
                  {it.kind === 'task'
                    ? it.title
                    : `${it.type === 'biweekly' ? 'Bi-weekly' : 'Weekly'} report · ${fmt(it.period_start)}`}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {it.kind === 'task'
                    ? `${(it.status || '').replace('_', ' ')}${it.assignee?.display_name ? ` · ${it.assignee.display_name}` : ''}`
                    : `${it.status}${it.author?.display_name ? ` · ${it.author.display_name}` : ''}`}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {timeAgo(it.when)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function timeAgo(iso) {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60)   return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 7 * 86400) return `${Math.floor(sec / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}
