import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { AlertIcon } from '../../components/common/Icon';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { currencySymbol } from '../../utils/currencies';
import {
  listActiveBrands, getBrandMonthlyMetrics, saveBrandMonthlyMetrics, listMonthsWithData,
  listBrandMetricsForMonth,
} from '../../lib/brandMetricsApi';
import { isManagedByUs } from '../../lib/roles';

// ── The 5 metrics (each a target/achieved pair) ─────────────────────
const METRICS = [
  { key: 'gmv',        label: 'Monthly GMV Goal',   unit: '$', tCol: 'gmv_target',            aCol: 'gmv_achieved',      tLabel: 'Goal',      aLabel: 'Achieved',  higherBetter: true,  icon: 'bi-graph-up-arrow', tint: '#0ea5e9' },
  { key: 'samples',    label: 'Sample Approvals',   unit: '#', tCol: 'samples_target',        aCol: 'samples_achieved',  tLabel: 'Goal',      aLabel: 'Approved',  higherBetter: true,  icon: 'bi-box-seam',       tint: '#16a34a' },
  { key: 'paidCollab', label: 'Paid Collab Budget', unit: '$', tCol: 'paid_collab_allocated', aCol: 'paid_collab_used',  tLabel: 'Allocated', aLabel: 'Used',      higherBetter: false, icon: 'bi-people-fill',    tint: '#8b5cf6' },
  { key: 'gmvMax',     label: 'GMV Max Budget',     unit: '$', tCol: 'gmv_max_allocated',     aCol: 'gmv_max_used',      tLabel: 'Allocated', aLabel: 'Utilized',  higherBetter: false, icon: 'bi-rocket-takeoff', tint: '#d97706' },
  { key: 'roi',        label: 'Target ROI',         unit: 'x', tCol: 'roi_target',            aCol: 'roi_achieved',      tLabel: 'Target',    aLabel: 'Actual',    higherBetter: true,  icon: 'bi-star-fill',      tint: '#ec4899' },
];

// ── theme-aware dashboard styling (status colors matched to the design) ──
const BA_CSS = `
.ba-scope{
  --ba-ontrack:#00837d; --ba-ontrack-soft:rgba(0,131,125,.12); --ba-ontrack-bd:rgba(0,131,125,.32);
  --ba-behind:#d97706;  --ba-behind-soft:rgba(217,119,6,.12);  --ba-behind-bd:rgba(217,119,6,.32);
  --ba-track: color-mix(in srgb, var(--text-muted) 16%, transparent);
}
:root[data-theme="dark"] .ba-scope, [data-theme="dark"] .ba-scope{
  --ba-ontrack:#2dd4bf; --ba-ontrack-soft:rgba(45,212,191,.15); --ba-ontrack-bd:rgba(45,212,191,.35);
  --ba-behind:#fbbf24;  --ba-behind-soft:rgba(251,191,36,.15);  --ba-behind-bd:rgba(251,191,36,.35);
}
.ba-card{background:var(--surface-1);border:1px solid var(--border-subtle);border-radius:16px;transition:transform .18s ease, box-shadow .18s ease;cursor:pointer;text-align:left;width:100%;}
.ba-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg);}
.ba-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.ba-chip{padding:6px 14px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap;cursor:pointer;transition:background .15s,color .15s,border-color .15s;}
.ba-gauge-arc{transition:stroke-dashoffset 1s cubic-bezier(.22,1,.36,1);}
.ba-bar-fill{transition:width 1s cubic-bezier(.22,1,.36,1);}
@keyframes ba-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.45;transform:scale(1.6);}}
.ba-pulse{animation:ba-pulse 2s cubic-bezier(.4,0,.6,1) infinite;}
@media (prefers-reduced-motion: reduce){.ba-gauge-arc,.ba-bar-fill{transition:none;}.ba-pulse{animation:none;}}
`;

// ── month helpers ───────────────────────────────────────────────────
function pakistanToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // 'YYYY-MM-DD'
}
function pakistanMonth() { return pakistanToday().slice(0, 7); }
function addMonths(monthKey, n) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function prettyMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}
// Fraction of the month elapsed, for pace: past month=1, future=0, current=day/days.
function elapsedRatio(monthKey) {
  const cur = pakistanMonth();
  if (monthKey < cur) return 1;
  if (monthKey > cur) return 0;
  const [y, m] = monthKey.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Number(pakistanToday().slice(8, 10));
  return Math.min(1, day / days);
}

// ── value formatting ────────────────────────────────────────────────
function fmt(unit, v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (unit === '$') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === 'x') return n.toFixed(2) + 'x';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function trimTenth(x) { const s = x.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; }
function fmtCompact(v, currency) {
  const sym = currencySymbol(currency);
  const n = Number(v) || 0;
  if (n >= 1e6) return sym + trimTenth(n / 1e6) + 'M';
  if (n >= 1e3) return sym + trimTenth(n / 1e3) + 'k';
  return sym + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtFull(n) { return '$' + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function relTime(iso) {
  if (!iso) return null;
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return 'just now';
  const mins = secs / 60; if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60; if (hrs < 24) return `${Math.round(hrs)}h ago`;
  const days = hrs / 24; return `${Math.round(days)}d ago`;
}
function pctOf(target, achieved) {
  const t = Number(target);
  if (!t || t <= 0) return null;
  return (Number(achieved) || 0) / t * 100;
}

function visibleMetricsFor(brand) {
  const paidOk = isManagedByUs(brand?.paid_collab_status);
  const gmvMaxOk = isManagedByUs(brand?.gmv_max_status);
  return METRICS.filter((m) => {
    if (m.key === 'paidCollab') return paidOk;
    if (m.key === 'gmvMax' || m.key === 'roi') return gmvMaxOk;
    return true;
  });
}

// GMV pacing stats for one brand's month row.
function gmvStat(row, monthKey) {
  const goal = Number(row?.gmv_target) || 0;
  const achieved = Number(row?.gmv_achieved) || 0;
  const hasGoal = goal > 0;
  const ratio = elapsedRatio(monthKey);
  const expected = goal * ratio;
  const met = hasGoal && achieved >= goal;
  const onTrack = hasGoal && achieved >= expected;
  const pctOfGoal = hasGoal ? (achieved / goal) * 100 : 0;
  const pacePct = expected > 0 ? Math.round((achieved / expected) * 100) : null;
  const status = !hasGoal ? 'nogoal' : met ? 'met' : onTrack ? 'ontrack' : 'behind';
  return {
    goal, achieved, hasGoal, met, onTrack, pctOfGoal, pacePct,
    remaining: Math.max(0, goal - achieved),
    markerPct: Math.min(100, ratio * 100),
    isOnTrack: met || onTrack,
    status,
    updatedAt: row?.updated_at || null,
  };
}
const STATUS_COLOR = { ontrack: 'var(--ba-ontrack)', met: 'var(--ba-ontrack)', behind: 'var(--ba-behind)', nogoal: 'var(--text-muted)' };

export default function BrandAnalyticsPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  // Goals are the Boss/OL's to set (bmm_all, mig 260). An Ads Manager reads the
  // page for the brands they run ads for (bmm_select_ads_manager, mig 316), so
  // hide every edit affordance rather than let RLS reject the save.
  const canEditGoals = profile?.role === 'boss' || profile?.role === 'ol' || profile?.role === 'developer';
  const [brandId, setBrandId] = useState('');
  const [month, setMonth] = useState(pakistanMonth);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | ontrack | set | unset

  const { data: brands = [], isLoading: brandsLoading, error: brandsErr } = useQuery({
    queryKey: ['brandMetrics', 'brands'],
    queryFn: listActiveBrands,
  });
  const { data: monthMap = {} } = useQuery({
    queryKey: ['brandMetrics', 'monthMap', month],
    queryFn: () => listBrandMetricsForMonth(month),
  });

  // Live: refresh the month's metrics the moment an APC submits GMV.
  useEffect(() => {
    const ch = supabase
      .channel(`bmm-${month}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'brand_monthly_metrics', filter: `month_key=eq.${month}` },
        () => {
          qc.invalidateQueries({ queryKey: ['brandMetrics', 'monthMap', month] });
          qc.invalidateQueries({ queryKey: ['brandMetrics', brandId, month] });
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [month, brandId, qc]);

  const selectedBrand = brands.find((b) => b.id === brandId) || null;

  const { data, isLoading, isError, isSuccess, error } = useQuery({
    queryKey: ['brandMetrics', brandId, month],
    queryFn: () => getBrandMonthlyMetrics(brandId, month),
    enabled: !!brandId,
  });
  const { data: monthsWithData = [] } = useQuery({
    queryKey: ['brandMetrics', 'months', brandId],
    queryFn: () => listMonthsWithData(brandId),
    enabled: !!brandId,
  });
  const visibleMetrics = useMemo(() => visibleMetricsFor(selectedBrand), [selectedBrand]);
  const hiddenGroups = useMemo(() => {
    const groups = [];
    if (!isManagedByUs(selectedBrand?.paid_collab_status)) groups.push('Paid Collab');
    if (!isManagedByUs(selectedBrand?.gmv_max_status)) groups.push('GMV Max & Target ROI');
    return groups;
  }, [selectedBrand]);
  const hasAny = visibleMetrics.some((m) => data && (data[m.tCol] != null || data[m.aCol] != null));

  // ── dashboard aggregates + filtering ──
  const stats = useMemo(() => {
    const map = {};
    for (const b of brands) map[b.id] = gmvStat(monthMap[b.id], month);
    return map;
  }, [brands, monthMap, month]);

  const counts = useMemo(() => {
    let onTrack = 0, withGoals = 0;
    for (const b of brands) { const s = stats[b.id]; if (s.hasGoal) withGoals++; if (s.isOnTrack) onTrack++; }
    return { all: brands.length, onTrack, withGoals, needs: brands.length - withGoals };
  }, [brands, stats]);

  const summary = useMemo(() => {
    let achieved = 0, goal = 0;
    for (const b of brands) { const s = stats[b.id]; if (s.hasGoal) { achieved += s.achieved; goal += s.goal; } }
    return { achieved, goal, pct: goal > 0 ? (achieved / goal) * 100 : 0, marker: elapsedRatio(month) * 100 };
  }, [brands, stats, month]);

  const filteredBrands = useMemo(() => {
    const q = search.trim().toLowerCase();
    return brands.filter((b) => {
      if (q && !`${b.brand_name || ''} ${b.client_name || ''}`.toLowerCase().includes(q)) return false;
      const s = stats[b.id];
      if (filter === 'ontrack') return s.isOnTrack;
      if (filter === 'set') return s.hasGoal;
      if (filter === 'unset') return !s.hasGoal;
      return true;
    });
  }, [brands, search, filter, stats]);

  const err = brandsErr?.message || error?.message || '';
  const thisMonth = pakistanMonth();

  const CHIPS = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'ontrack', label: 'On track', n: counts.onTrack },
    { key: 'set', label: 'With goals', n: counts.withGoals },
    { key: 'unset', label: 'Needs goals', n: counts.needs },
  ];

  return (
    <div className="ba-scope">
      <style>{BA_CSS}</style>

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Brand analytics</h1>
          <p className="page-subtitle">Real-time tracking of affiliate GMV goals</p>
        </div>
        {selectedBrand && canEditGoals && (
          <button className="wx-btn wx-btn-primary" disabled={!isSuccess} onClick={() => setEditing(true)}>
            <i className="bi bi-pencil-square me-1" /> {hasAny ? 'Edit goals' : 'Set goals'}
          </button>
        )}
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {!selectedBrand ? (
        <>
          {/* Control bar */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 14, marginBottom: 14,
            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 14 }}>
            <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
              <i className="bi bi-search" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none' }} />
              <input className="wx-input" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search brand or client…" style={{ paddingLeft: 32, width: '100%' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflowX: 'auto', paddingBottom: 2 }}>
              <MonthNav month={month} setMonth={setMonth} thisMonth={thisMonth} />
              <div style={{ width: 1, height: 24, background: 'var(--border-subtle)', flex: 'none' }} />
              <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                {CHIPS.map((c) => {
                  const active = filter === c.key;
                  return (
                    <button key={c.key} className="ba-chip" onClick={() => setFilter(c.key)}
                      style={{
                        background: active ? 'var(--accent)' : 'var(--surface-1)',
                        color: active ? 'var(--on-accent)' : 'var(--text-secondary)',
                        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-subtle)'),
                      }}>
                      {c.label} ({c.n})
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Summary strip */}
          {counts.withGoals > 0 && (
            <div className="ba-card" style={{ cursor: 'default', padding: '14px 18px', marginBottom: 16, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--ba-ontrack)', fontWeight: 800 }}>{counts.onTrack} of {counts.withGoals}</span>
                <span style={{ color: 'var(--text-muted)' }}> on track</span>
              </div>
              <div style={{ flex: '1 1 240px', display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right' }}>{fmtFull(summary.achieved)}</span>
                <div style={{ position: 'relative', flex: 1, height: 12, background: 'var(--ba-track)', borderRadius: 999, overflow: 'hidden' }}>
                  <div className="ba-bar-fill" style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${Math.min(100, summary.pct)}%`, background: 'var(--accent)', borderRadius: 999 }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, left: `${Math.min(100, summary.marker)}%`, background: 'var(--text-primary)', opacity: 0.85 }} />
                </div>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 64 }}>{fmtFull(summary.goal)}</span>
              </div>
            </div>
          )}

          {/* Card grid */}
          {brandsLoading ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading brands…</div>
          ) : brands.length === 0 ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No active brands.</div>
          ) : filteredBrands.length === 0 ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No brands match your search or filter.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
              {filteredBrands.map((b) => (
                <BrandDashCard key={b.id} brand={b} stat={stats[b.id]}
                  onOpen={() => setBrandId(b.id)}
                  onSetGoals={canEditGoals ? () => { setBrandId(b.id); setEditing(true); } : null} />
              ))}
            </div>
          )}
        </>
      ) : (
        /* ───────── Selected brand: metrics ───────── */
        <>
          <div className="wx-card" style={{ padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="wx-btn wx-btn-ghost" onClick={() => { setBrandId(''); setEditing(false); }} style={{ padding: '8px 12px' }}>
              <i className="bi bi-arrow-left me-1" /> Brands
            </button>
            <BrandAvatar brand={selectedBrand} size={38} radius={9} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedBrand.brand_name}</div>
              {selectedBrand.client_name && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{selectedBrand.client_name}</div>}
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <MonthNav month={month} setMonth={setMonth} thisMonth={thisMonth} monthsWithData={monthsWithData} />
            </div>
          </div>

          {isLoading ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center' }}><span className="wx-spinner" /> Loading…</div>
          ) : isError ? (
            <div className="wx-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              <AlertIcon width="18" height="18" /> <span style={{ marginLeft: 6 }}>Couldn't load this month's goals (maybe a connection blip). Use the month arrows to retry.</span>
            </div>
          ) : (
            <>
              {!hasAny && (
                <div className="wx-card" style={{ padding: '22px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>No goals set for {prettyMonth(month)}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Set the targets and achieved values for {selectedBrand?.brand_name} this month.</div>
                  </div>
                  {canEditGoals && <button className="wx-btn wx-btn-primary" onClick={() => setEditing(true)}><i className="bi bi-plus-lg me-1" /> Set goals</button>}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
                {visibleMetrics.map((m) => (
                  <MetricCard key={m.key} metric={m} target={data?.[m.tCol]} achieved={data?.[m.aCol]} />
                ))}
              </div>
              {hiddenGroups.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <i className="bi bi-info-circle" style={{ marginTop: 1 }} />
                  <span>
                    Hidden for {selectedBrand?.brand_name}: <strong>{hiddenGroups.join(' · ')}</strong> — we don’t manage {hiddenGroups.length > 1 ? 'these' : 'this'} for this brand.
                    Change the brand’s status in <strong>Brands</strong> to track {hiddenGroups.length > 1 ? 'them' : 'it'}.
                  </span>
                </div>
              )}
              {data?.updated_at && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12 }}>
                  Last updated {new Date(data.updated_at).toLocaleString()}
                </div>
              )}
            </>
          )}
        </>
      )}

      {editing && selectedBrand && canEditGoals && (
        <EditModal
          brand={selectedBrand}
          month={month}
          data={data}
          metrics={visibleMetrics}
          onClose={() => setEditing(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['brandMetrics', brandId, month] });
            qc.invalidateQueries({ queryKey: ['brandMetrics', 'months', brandId] });
            qc.invalidateQueries({ queryKey: ['brandMetrics', 'monthMap', month] });
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

// ── Month navigator (shared by picker + detail) ─────────────────────
function MonthNav({ month, setMonth, thisMonth, monthsWithData }) {
  const isCur = month === thisMonth;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none', background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 3 }}>
      <button className="wx-btn wx-btn-ghost" onClick={() => setMonth((m) => addMonths(m, -1))} title="Previous month" style={{ padding: '5px 9px' }}>
        <i className="bi bi-chevron-left" style={{ fontSize: 12 }} />
      </button>
      <button type="button" onClick={() => !isCur && setMonth(thisMonth)}
        title={isCur ? 'This month' : 'Jump to this month'}
        style={{ background: 'none', border: 'none', cursor: isCur ? 'default' : 'pointer', padding: '0 8px', textAlign: 'center', minWidth: 128 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{prettyMonth(month)}</div>
        <div style={{ fontSize: 10, color: isCur ? 'var(--text-muted)' : 'var(--accent)' }}>
          {isCur ? 'This month' : 'Jump to this month'}
          {monthsWithData && !monthsWithData.includes(month) ? <span style={{ opacity: 0.6 }}> · no data</span> : null}
        </div>
      </button>
      <button className="wx-btn wx-btn-ghost" onClick={() => setMonth((m) => addMonths(m, 1))} title="Next month" style={{ padding: '5px 9px' }}>
        <i className="bi bi-chevron-right" style={{ fontSize: 12 }} />
      </button>
    </div>
  );
}

// ── Radial gauge (SVG, matches the Stitch geometry) ─────────────────
function Gauge({ pct, color, size = 92 }) {
  const r = 40, C = 2 * Math.PI * r; // 251.2
  const fill = Math.max(0, Math.min(100, pct));
  const offset = C * (1 - fill / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--ba-track)" strokeWidth="8" />
        <circle className="ba-gauge-arc" cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={offset} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 16, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>{Math.round(pct)}%</span>
      </div>
    </div>
  );
}

// ── Pace bar with a marker at "where you should be today" ───────────
function PaceBar({ fillPct, markerPct, color }) {
  return (
    <div style={{ position: 'relative', height: 8, background: 'var(--ba-track)', borderRadius: 999 }}>
      <div className="ba-bar-fill" style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${Math.max(0, Math.min(100, fillPct))}%`, background: color, borderRadius: 999 }} />
      <div style={{ position: 'absolute', top: -2, bottom: -2, width: 2, left: `${Math.max(0, Math.min(100, markerPct))}%`, background: 'var(--text-primary)', borderRadius: 1 }} />
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    met:     { label: 'Goal met', icon: 'bi-trophy-fill',        c: 'var(--ba-ontrack)', bg: 'var(--ba-ontrack-soft)', bd: 'var(--ba-ontrack-bd)' },
    ontrack: { label: 'On track', icon: 'bi-check-circle-fill',  c: 'var(--ba-ontrack)', bg: 'var(--ba-ontrack-soft)', bd: 'var(--ba-ontrack-bd)' },
    behind:  { label: 'Behind',   icon: 'bi-exclamation-triangle-fill', c: 'var(--ba-behind)', bg: 'var(--ba-behind-soft)', bd: 'var(--ba-behind-bd)' },
    nogoal:  { label: 'Needs goals', icon: null, c: 'var(--text-muted)', bg: 'var(--surface-2)', bd: 'var(--border-subtle)' },
  };
  const s = map[status] || map.nogoal;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: 8, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap', color: s.c, background: s.bg, border: `1px solid ${s.bd}` }}>
      {s.icon && <i className={`bi ${s.icon}`} style={{ fontSize: 12 }} />}{s.label}
    </span>
  );
}

// ── One brand dashboard card ────────────────────────────────────────
function BrandDashCard({ brand, stat, onOpen, onSetGoals }) {
  const color = STATUS_COLOR[stat.status];
  const fresh = stat.updatedAt && (Date.now() - new Date(stat.updatedAt).getTime()) < 12 * 3600 * 1000;
  const header = (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <BrandAvatar brand={brand} size={40} radius={10} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brand.brand_name}</span>
            {fresh && <span className="ba-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none' }} title="Recently updated" />}
          </div>
          {brand.client_name && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brand.client_name}</div>}
        </div>
      </div>
      <StatusBadge status={stat.status} />
    </div>
  );

  if (!stat.hasGoal) {
    return (
      <div className="ba-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
        style={{ padding: 16, opacity: 0.85, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {header}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '18px 0 8px' }}>
          <i className="bi bi-bar-chart-line" style={{ fontSize: 30, color: 'var(--text-muted)', opacity: 0.6 }} />
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center' }}>
            {onSetGoals ? 'Set goals to track GMV pacing.' : 'No goals set for this month yet.'}
          </div>
          {onSetGoals && (
            <button className="wx-btn wx-btn-ghost" onClick={(e) => { e.stopPropagation(); onSetGoals(); }} style={{ marginTop: 2 }}>
              <i className="bi bi-plus-lg me-1" /> Set goals
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ba-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {header}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Gauge pct={stat.pctOfGoal} color={color} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Achieved</span>
            <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(stat.achieved, brand.currency)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Goal</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(stat.goal, brand.currency)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Remaining</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(stat.remaining, brand.currency)}</span>
          </div>
        </div>
      </div>
      <div>
        <PaceBar fillPct={stat.pctOfGoal} markerPct={stat.markerPct} color={color} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{stat.updatedAt ? relTime(stat.updatedAt) : 'not updated yet'}</span>
          {stat.pacePct != null && (
            <span style={{ fontSize: 11.5, fontWeight: 700, color }}>{stat.pacePct}% of pace</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── One metric card with a progress bar (detail view) ───────────────
function MetricCard({ metric, target, achieved }) {
  const pct = pctOf(target, achieved);
  const over = pct != null && pct > 100;
  const met = pct != null && pct >= 100;
  const barColor = pct == null ? 'var(--border-default)'
    : (metric.higherBetter ? (met ? 'var(--success)' : metric.tint)
      : (over ? 'var(--danger)' : metric.tint));
  const pctText = pct == null ? '—' : `${pct.toFixed(0)}%`;

  return (
    <div className="wx-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `${metric.tint}1f`, color: metric.tint }}>
          <i className={`bi ${metric.icon}`} style={{ fontSize: '1rem' }} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{metric.label}</div>
        <div style={{ marginLeft: 'auto', fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums',
          color: pct == null ? 'var(--text-muted)' : (over && !metric.higherBetter ? 'var(--danger)' : (met ? 'var(--success)' : 'var(--text-primary)')) }}>
          {pctText}
        </div>
      </div>

      <div style={{ height: 10, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct == null ? 0 : Math.min(pct, 100)}%`, background: barColor, borderRadius: 999, transition: 'width .3s' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{metric.aLabel}</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{fmt(metric.unit, achieved)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{metric.tLabel}</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-secondary)' }}>{fmt(metric.unit, target)}</div>
        </div>
      </div>
      {over && !metric.higherBetter && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 8 }}>
          <i className="bi bi-exclamation-triangle me-1" />Over budget
        </div>
      )}
    </div>
  );
}

// ── Edit modal (centered overlay) ───────────────────────────────────
function EditModal({ brand, month, data, metrics = METRICS, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    const f = {};
    for (const m of METRICS) {
      f[m.tCol] = data?.[m.tCol] ?? '';
      f[m.aCol] = data?.[m.aCol] ?? '';
    }
    return f;
  });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const set = (col, v) => setForm((f) => ({ ...f, [col]: v }));

  async function save() {
    setSaving(true); setSaveErr('');
    try {
      await saveBrandMonthlyMetrics(brand.id, month, form);
      onSaved();
    } catch (e) {
      setSaveErr(e?.message || 'Could not save.');
      setSaving(false);
    }
  }

  const prefix = (unit) => (unit === '$' ? '$' : unit === 'x' ? '×' : '#');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(3px)' }} onClick={saving ? undefined : onClose} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 560, zIndex: 1, borderRadius: 18, maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {brand && <BrandAvatar brand={brand} size={34} radius={8} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>{brand?.brand_name} goals</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{prettyMonth(month)}</div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div style={{ padding: '16px 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {metrics.map((m) => (
            <div key={m.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <i className={`bi ${m.icon}`} style={{ color: m.tint }} />
                <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)' }}>{m.label}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <NumField label={m.tLabel} prefix={prefix(m.unit)} value={form[m.tCol]} onChange={(v) => set(m.tCol, v)} />
                <NumField label={m.aLabel} prefix={prefix(m.unit)} value={form[m.aCol]} onChange={(v) => set(m.aCol, v)} />
              </div>
            </div>
          ))}
          {saveErr && <div className="wx-alert wx-alert-danger" style={{ margin: 0 }}><AlertIcon width="15" height="15" /> {saveErr}</div>}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
            {saving ? <><span className="wx-spinner" style={{ width: 14, height: 14 }} /> Saving…</> : 'Save goals'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumField({ label, prefix, value, onChange }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <div style={{ position: 'relative', marginTop: 4 }}>
        <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none' }}>{prefix}</span>
        <input type="number" className="wx-input" inputMode="decimal" value={value}
          onChange={(e) => onChange(e.target.value)} placeholder="—"
          style={{ paddingLeft: 26, width: '100%' }} />
      </div>
    </label>
  );
}
