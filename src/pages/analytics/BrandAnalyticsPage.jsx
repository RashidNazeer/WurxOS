import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { paidCollabStatusLabel } from '../../lib/roles';
import {
  AlertIcon, RefreshIcon, StoreIcon, ReportIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

export default function BrandAnalyticsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['analytics', 'brands'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('brands')
        .select('id, brand_name, tier, gmv, status, logo_url, paid_collab_status, owner:owner_id(display_name)')
        .eq('status', 'active')
        .order('gmv', { ascending: false, nullsFirst: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
  });
  const err  = queryError?.message || '';
  const load = () => qc.invalidateQueries({ queryKey: ['analytics', 'brands'] });

  const stats = useMemo(() => {
    const totalBrands = rows.length;
    const totalGmv = rows.reduce((s, r) => s + (Number(r.gmv) || 0), 0);
    const withGmv  = rows.filter((r) => Number(r.gmv) > 0).length;
    const avgGmv   = withGmv > 0 ? totalGmv / withGmv : 0;
    return { totalBrands, totalGmv, avgGmv, withGmv };
  }, [rows]);

  const tierBreakdown = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = (r.tier || 'Untiered').trim() || 'Untiered';
      if (!map.has(key)) map.set(key, { count: 0, gmv: 0 });
      const agg = map.get(key);
      agg.count += 1;
      agg.gmv   += Number(r.gmv) || 0;
    }
    return Array.from(map.entries())
      .map(([tier, v]) => ({ tier, ...v }))
      .sort((a, b) => b.gmv - a.gmv);
  }, [rows]);

  const topBrands = rows.slice(0, 10);
  const topGmv = topBrands[0]?.gmv ? Number(topBrands[0].gmv) : 1;

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Brand analytics</h1>
          <p className="page-subtitle">Active brands, tier distribution, and 30-day GMV.</p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={load} disabled={loading}>
          <RefreshIcon width="15" height="15" /> Refresh
        </button>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* Top stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <StatCard label="Active brands" value={stats.totalBrands} icon={<StoreIcon width="18" height="18" />} />
        <StatCard label="Total 30d GMV" value={`$${formatBig(stats.totalGmv)}`} icon={<ReportIcon width="18" height="18" />} />
        <StatCard label="Average GMV" value={`$${formatBig(stats.avgGmv)}`} sub={`${stats.withGmv} brands with GMV`} />
        <StatCard label="Tier buckets" value={tierBreakdown.length} />
      </div>

      {/* Tier table */}
      <div className="wx-card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', fontWeight: 700, fontSize: 14 }}>
          Tier breakdown
        </div>
        {loading ? (
          <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
        ) : tierBreakdown.length === 0 ? (
          <div className="wx-empty">No active brands yet.</div>
        ) : (
          <div style={{ padding: '8px 0' }}>
            {tierBreakdown.map((t) => {
              const pct = stats.totalGmv > 0 ? (t.gmv / stats.totalGmv) * 100 : 0;
              return (
                <div key={t.tier} style={{
                  display: 'grid', gridTemplateColumns: '160px 80px 1fr 120px',
                  gap: 14, alignItems: 'center',
                  padding: '10px 18px',
                  borderTop: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.tier}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{t.count} brand{t.count === 1 ? '' : 's'}</div>
                  <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: 'var(--accent)',
                    }} />
                  </div>
                  <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                    ${formatBig(t.gmv)}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11, marginLeft: 4 }}>
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Top brands */}
      <div className="wx-card" style={{ padding: 0 }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', fontWeight: 700, fontSize: 14 }}>
          Top brands by GMV
        </div>
        {loading ? (
          <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
        ) : topBrands.length === 0 ? (
          <div className="wx-empty">No brands yet.</div>
        ) : (
          topBrands.map((b) => {
            const gmv = Number(b.gmv) || 0;
            const pct = (gmv / topGmv) * 100;
            return (
              <div
                key={b.id}
                onClick={() => navigate('/brands')}
                style={{
                  display: 'grid', gridTemplateColumns: '40px 1fr 120px 120px',
                  gap: 12, alignItems: 'center',
                  padding: '10px 18px',
                  borderTop: '1px solid var(--border-subtle)',
                  cursor: 'pointer',
                }}
              >
                <BrandAvatar brand={b} size={36} radius={8} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{b.brand_name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {b.tier || 'Untiered'}
                    {b.owner?.display_name && <> · TL: {b.owner.display_name}</>}
                    {b.paid_collab_status && b.paid_collab_status !== 'not_applicable' && (
                      <> · {paidCollabStatusLabel(b.paid_collab_status)}</>
                    )}
                  </div>
                </div>
                <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)' }} />
                </div>
                <div style={{ textAlign: 'right', fontWeight: 700 }}>
                  ${formatBig(gmv)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function StatCard({ label, value, sub, icon }) {
  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: 6,
      }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function formatBig(n) {
  if (!n || n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)      return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
