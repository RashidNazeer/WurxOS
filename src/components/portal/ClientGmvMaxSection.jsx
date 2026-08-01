import { useMemo, useState } from 'react';
import { GMV_MAX_FIELDS, formatGmvField, monthLabel, CAMPAIGN_STATUSES } from '../../lib/gmvMaxApi';
import { formatPctChange } from '../../utils/formatPctChange';
import { currencySymbol } from '../../utils/currencies';

/* Wurx theme tokens — pure black + warm peach + cream. */
const WURX = {
  bgDarkest: '#000000', bgDeep: '#0a0a0a', bgRich: '#121212', bgWarm: '#1f1714',
  peach: '#f5d5a8', peachDeep: '#d4a574', cream: '#faf7f2',
  border: 'rgba(245, 213, 168, 0.18)', borderSoft: 'rgba(245, 213, 168, 0.10)',
  glow: 'rgba(245, 213, 168, 0.30)',
  lightTintBg: '#fdf8f0', lightTintBorder: '#f0e3cf',
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FIELD_TINTS = {
  cost: '#0ea5e9', skuOrders: '#16a34a', costPerOrder: '#8b5cf6',
  grossRevenue: '#d97706', roi: '#ec4899',
};
const FIELD_EMOJI = { cost: '💰', skuOrders: '📦', costPerOrder: '🧾', grossRevenue: '📈', roi: '⭐' };

function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
function statusCfg(key) { return CAMPAIGN_STATUSES.find(s => s.key === key) || CAMPAIGN_STATUSES[0]; }
function formatScheduleTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Metric tile ────────────────────────────────────────────────────
function MetricTile({ field, value, prevValue, dark, currency = 'USD' }) {
  const v = Number(value) || 0;
  const pv = Number(prevValue) || 0;
  let delta = null;
  if (prevValue != null && pv !== 0 && value != null && value !== '') {
    const change = ((v - pv) / pv) * 100;
    delta = { pct: change, up: change > 0 };
  }
  const tint = FIELD_TINTS[field.key] || WURX.peachDeep;
  const has = value != null && value !== '';

  return (
    <div style={{
      flex: '1 1 calc(33.333% - 12px)', minWidth: 150,
      background: dark
        ? (has ? `linear-gradient(135deg, rgba(245, 213, 168, 0.10) 0%, rgba(245, 213, 168, 0.03) 100%)` : 'rgba(245, 213, 168, 0.04)')
        : (has ? `linear-gradient(135deg, ${tint}10 0%, ${tint}03 100%)` : 'var(--surface-2)'),
      border: `1px solid ${dark ? WURX.borderSoft : (has ? tint + '22' : 'var(--border)')}`,
      borderRadius: 14, padding: '14px 16px',
      position: 'relative', overflow: 'hidden',
      backdropFilter: dark ? 'blur(10px) saturate(1.05)' : 'none',
      transition: 'transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: dark ? 'rgba(245, 213, 168, 0.15)' : (has ? tint + '1f' : 'var(--surface-3, #e2e8f0)'),
          color: dark ? WURX.peach : (has ? tint : 'var(--text-muted)'),
          display: 'grid', placeItems: 'center', fontSize: 13,
          boxShadow: dark ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
        }}>{FIELD_EMOJI[field.key] || '•'}</div>
        {field.suffix && (
          <span style={{
            fontSize: 9.5, fontWeight: 700,
            color: dark ? WURX.peach : (has ? tint : 'var(--text-muted)'),
            background: dark ? 'rgba(245, 213, 168, 0.12)' : (has ? tint + '15' : 'var(--surface-2)'),
            padding: '2px 8px', borderRadius: 999,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>{field.suffix}</span>
        )}
      </div>
      <div style={{
        fontSize: 10.5, fontWeight: 600,
        color: dark ? 'rgba(250, 247, 242, 0.55)' : 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4,
      }}>{field.label}</div>
      <div style={{
        fontSize: 23, fontWeight: 800,
        color: dark ? WURX.cream : (has ? 'var(--text-primary)' : 'var(--text-muted)'),
        letterSpacing: '-0.025em', lineHeight: 1.1,
      }}>
        {has ? formatGmvField(field.key, value, currency) : '—'}
      </div>
      {delta && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8,
          padding: '3px 10px', borderRadius: 999,
          background: delta.up ? (dark ? 'rgba(34, 197, 94, 0.22)' : '#dcfce7') : (dark ? 'rgba(239, 68, 68, 0.22)' : '#fef2f2'),
          color: delta.up ? (dark ? '#86efac' : '#15803d') : (dark ? '#fca5a5' : '#991b1b'),
          fontSize: 10.5, fontWeight: 700,
          backdropFilter: dark ? 'blur(8px)' : 'none',
        }}>
          {delta.up ? '↗' : '↘'} {delta.up ? '+' : ''}{formatPctChange(delta.pct, { withSign: false })}
        </div>
      )}
    </div>
  );
}

// ── Monthly Overview hero card ─────────────────────────────────────
function MonthlyCard({ label, sublabel, report, prevReport, isPrimary, currency = 'USD' }) {
  const empty = !report;
  return (
    <div style={{
      background: isPrimary
        ? `radial-gradient(circle at 20% 0%, rgba(245, 213, 168, 0.18), transparent 55%),
           radial-gradient(circle at 80% 100%, rgba(212, 165, 116, 0.12), transparent 55%),
           linear-gradient(135deg, ${WURX.bgDeep} 0%, ${WURX.bgRich} 50%, ${WURX.bgWarm} 100%)`
        : `linear-gradient(135deg, #ffffff 0%, ${WURX.lightTintBg} 100%)`,
      borderRadius: 22, padding: 24, position: 'relative', overflow: 'hidden',
      boxShadow: isPrimary
        ? `0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px ${WURX.border}, inset 0 1px 0 rgba(245, 213, 168, 0.08)`
        : `0 6px 18px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04)`,
      border: isPrimary ? 'none' : `1px solid ${WURX.lightTintBorder}`,
      minHeight: 280, color: isPrimary ? WURX.cream : '#0f172a',
    }}>
      {isPrimary && (
        <>
          <div style={{ position: 'absolute', top: -80, right: -60, width: 280, height: 280, borderRadius: '50%', background: `radial-gradient(circle, ${WURX.peach}, transparent 70%)`, opacity: 0.18, filter: 'blur(40px)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', bottom: -100, left: -80, width: 320, height: 320, borderRadius: '50%', background: `radial-gradient(circle, ${WURX.peachDeep}, transparent 70%)`, opacity: 0.12, filter: 'blur(50px)', pointerEvents: 'none' }} />
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 14, position: 'relative' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: isPrimary ? WURX.peach : '#94a3b8', marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: isPrimary ? WURX.cream : '#0f172a', letterSpacing: '-0.025em', lineHeight: 1.15 }}>{sublabel}</div>
          {report && <div style={{ fontSize: 11.5, color: isPrimary ? 'rgba(250, 247, 242, 0.55)' : '#64748b', marginTop: 4 }}>{report.period_start} → {report.period_end}</div>}
        </div>
        {prevReport && report && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: '4px 10px',
            background: isPrimary ? 'rgba(245, 213, 168, 0.15)' : '#fef3e2',
            color: isPrimary ? WURX.peach : '#92400e',
            fontSize: 10, fontWeight: 700,
            backdropFilter: 'blur(8px)',
            border: isPrimary ? `1px solid ${WURX.borderSoft}` : 'none',
          }}>
            ↔ vs prev month
          </div>
        )}
      </div>

      {empty ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px 0', position: 'relative', minHeight: 180 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: isPrimary ? 'rgba(245, 213, 168, 0.15)' : '#fef3e2',
            color: isPrimary ? WURX.peach : '#d4a574',
            display: 'grid', placeItems: 'center', fontSize: 22,
            border: isPrimary ? `1px solid ${WURX.borderSoft}` : 'none',
          }}>📊</div>
          <div style={{ marginTop: 12, fontWeight: 700, fontSize: 14, color: isPrimary ? WURX.cream : '#475569' }}>No data yet</div>
          <div style={{ fontSize: 12, color: isPrimary ? 'rgba(250, 247, 242, 0.6)' : '#94a3b8', marginTop: 4 }}>GMV Max metrics for this period haven't been added yet.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, position: 'relative' }}>
          {GMV_MAX_FIELDS.map(f => (
            <MetricTile key={f.key} field={f}
              value={camelGet(report, f.key)}
              prevValue={prevReport ? camelGet(prevReport, f.key) : null}
              dark={isPrimary} currency={currency} />
          ))}
        </div>
      )}

      {report?.notes && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 12,
          background: isPrimary ? 'rgba(245, 213, 168, 0.06)' : `linear-gradient(135deg, #ffffff, ${WURX.lightTintBg})`,
          border: isPrimary ? `1px solid ${WURX.borderSoft}` : `1px solid ${WURX.lightTintBorder}`,
          backdropFilter: 'blur(8px)', position: 'relative',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: isPrimary ? WURX.peach : WURX.peachDeep }}>Notes</span>
          </div>
          <div style={{ fontSize: 13, color: isPrimary ? WURX.cream : '#334155', lineHeight: 1.5 }}>{report.notes}</div>
        </div>
      )}
    </div>
  );
}

// ── Campaign card ─────────────────────────────────────────────────
function MetaPill({ label, value, dark }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999,
      background: dark ? 'rgba(245, 213, 168, 0.10)' : '#fdf8f0',
      color: dark ? WURX.peach : WURX.peachDeep,
      border: dark ? `1px solid ${WURX.borderSoft}` : `1px solid ${WURX.lightTintBorder}`,
      padding: '5px 13px', fontSize: 11, fontWeight: 600,
      backdropFilter: 'blur(8px)',
    }}>
      <span style={{ opacity: 0.75, fontWeight: 500 }}>{label}</span>
      <span style={{ fontWeight: 700, color: dark ? WURX.cream : '#1f1714' }}>{value}</span>
    </div>
  );
}

function CampaignCard({ campaign, prevCampaign, currency = 'USD' }) {
  const st = statusCfg(campaign.status);
  const isActive = campaign.status === 'active';
  const dark = isActive;

  return (
    <div style={{
      background: isActive
        ? `radial-gradient(circle at 25% 0%, rgba(245, 213, 168, 0.20), transparent 50%),
           radial-gradient(circle at 75% 100%, rgba(212, 165, 116, 0.14), transparent 55%),
           linear-gradient(135deg, ${WURX.bgDeep} 0%, ${WURX.bgRich} 50%, ${WURX.bgWarm} 100%)`
        : `linear-gradient(135deg, #ffffff 0%, ${WURX.lightTintBg} 100%)`,
      borderRadius: 22, padding: 24, position: 'relative', overflow: 'hidden',
      boxShadow: isActive
        ? `0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px ${WURX.border}, inset 0 1px 0 rgba(245, 213, 168, 0.08)`
        : `0 6px 18px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04)`,
      border: isActive ? 'none' : `1px solid ${WURX.lightTintBorder}`,
      marginBottom: 16, color: isActive ? WURX.cream : '#0f172a',
    }}>
      {isActive && (
        <>
          <div style={{ position: 'absolute', top: -90, right: -70, width: 320, height: 320, borderRadius: '50%', background: `radial-gradient(circle, ${WURX.peach}, transparent 70%)`, opacity: 0.20, filter: 'blur(50px)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', bottom: -100, left: -90, width: 360, height: 360, borderRadius: '50%', background: `radial-gradient(circle, ${WURX.peachDeep}, transparent 70%)`, opacity: 0.14, filter: 'blur(60px)', pointerEvents: 'none' }} />
        </>
      )}

      <div style={{ marginBottom: 14, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: dark ? WURX.peach : '#94a3b8', marginBottom: 4 }}>
              📣 Campaign
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: dark ? WURX.cream : '#0f172a', letterSpacing: '-0.02em', lineHeight: 1.2, wordBreak: 'break-word' }}>
              {campaign.campaignName || 'Untitled Campaign'}
            </div>
          </div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
            background: dark ? `linear-gradient(135deg, ${WURX.peach}, ${WURX.peachDeep})` : st.bg,
            color: dark ? '#1f1714' : st.color,
            padding: '6px 16px', fontSize: 11, fontWeight: 700,
            boxShadow: dark ? `0 4px 14px ${WURX.glow}` : 'none',
            flexShrink: 0,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dark ? '#1f1714' : st.color }} />
            {st.label}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {campaign.campaignId && <MetaPill label="ID" value={campaign.campaignId} dark={dark} />}
          {campaign.targetRoi != null && Number(campaign.targetRoi) !== 0 && (
            <MetaPill label="Target ROI" value={`${Number(campaign.targetRoi).toFixed(2)}x`} dark={dark} />
          )}
          {campaign.scheduleTime && <MetaPill label="Scheduled" value={formatScheduleTime(campaign.scheduleTime)} dark={dark} />}
          {campaign.campaignBudget != null && Number(campaign.campaignBudget) !== 0 && (
            <MetaPill label="Budget" value={currencySymbol(currency) + Number(campaign.campaignBudget).toLocaleString('en-US', { maximumFractionDigits: 0 })} dark={dark} />
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, position: 'relative' }}>
        {GMV_MAX_FIELDS.map(f => (
          <MetricTile key={f.key} field={f} value={campaign[f.key]} prevValue={prevCampaign ? prevCampaign[f.key] : null} dark={dark} currency={currency} />
        ))}
      </div>

      {campaign.notes && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 12,
          background: dark ? 'rgba(245, 213, 168, 0.06)' : `linear-gradient(135deg, #ffffff, ${WURX.lightTintBg})`,
          border: dark ? `1px solid ${WURX.borderSoft}` : `1px solid ${WURX.lightTintBorder}`,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: dark ? WURX.peach : WURX.peachDeep, marginBottom: 4 }}>Notes</div>
          <div style={{ fontSize: 13, color: dark ? WURX.cream : '#334155', lineHeight: 1.5 }}>{campaign.notes}</div>
        </div>
      )}
    </div>
  );
}

// ── Brand block ───────────────────────────────────────────────────
function BrandBlock({ brand, allReports, year, monthIdx, view }) {
  const currency = brand.currency || 'USD';
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && monthIdx === today.getMonth();
  const selectedKey = monthKey(year, monthIdx);
  const prevKey = monthIdx === 0 ? monthKey(year - 1, 11) : monthKey(year, monthIdx - 1);

  const monthlyReports = useMemo(() =>
    allReports.filter(r => r.brand_id === brand.id && r.period === 'monthly'),
    [allReports, brand.id]);

  const selected = monthlyReports.find(r => (r.period_start || '').slice(0, 7) === selectedKey);
  const prev     = monthlyReports.find(r => (r.period_start || '').slice(0, 7) === prevKey);

  const campaigns = (selected?.campaigns || []);
  const prevByName = useMemo(() => {
    const m = new Map();
    (prev?.campaigns || []).forEach(c => { if (c.campaignName) m.set(c.campaignName.trim().toLowerCase(), c); });
    return m;
  }, [prev]);

  const sortedCampaigns = useMemo(() => [...campaigns].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    return (Number(b.grossRevenue) || 0) - (Number(a.grossRevenue) || 0);
  }), [campaigns]);

  return (
    <div style={{ marginBottom: 36 }}>
      {/* Brand header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, padding: 14, borderRadius: 12,
        background: `linear-gradient(135deg, ${WURX.lightTintBg}, #ffffff)`,
        border: `1px solid ${WURX.lightTintBorder}`,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10,
          background: `linear-gradient(135deg, ${WURX.peach}, ${WURX.peachDeep})`,
          color: '#1f1714', display: 'grid', placeItems: 'center',
          fontSize: 14, fontWeight: 800,
          boxShadow: `0 6px 16px ${WURX.glow}, inset 0 1px 0 rgba(255,255,255,0.3)`,
          letterSpacing: '0.02em', flexShrink: 0,
        }}>
          {brand.brand_name?.slice(0, 2).toUpperCase() || '??'}
        </div>
        <div style={{ minWidth: 0 }}>
          <h5 style={{ margin: 0, fontWeight: 800, color: '#1f1714', letterSpacing: '-0.02em', fontSize: 17 }}>{brand.brand_name}</h5>
          <div style={{ fontSize: 11.5, color: WURX.peachDeep, fontWeight: 600, letterSpacing: '0.02em', marginTop: 2 }}>
            {view === 'campaigns' ? 'Per-campaign performance' : 'Monthly overview'} · {MONTH_NAMES[monthIdx]} {year}
          </div>
        </div>
      </div>

      {view === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
          <MonthlyCard
            label="Previous Month"
            sublabel={`${MONTH_SHORT[monthIdx === 0 ? 11 : monthIdx - 1]} ${monthIdx === 0 ? year - 1 : year}`}
            report={prev} prevReport={null} isPrimary={false} currency={currency} />
          <MonthlyCard
            label={isCurrentMonth ? 'This Month (so far)' : 'Selected Month'}
            sublabel={`${MONTH_SHORT[monthIdx]} ${year}`}
            report={selected} prevReport={prev} isPrimary={true} currency={currency} />
        </div>
      )}

      {view === 'campaigns' && (
        sortedCampaigns.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '36px 16px', borderRadius: 14, background: 'var(--surface-2)', border: '2px dashed var(--border)' }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: '#f1f5f9', color: '#94a3b8',
              display: 'inline-grid', placeItems: 'center', marginBottom: 10, fontSize: 22,
            }}>📣</div>
            <div style={{ fontWeight: 700, color: '#475569', fontSize: 14 }}>
              No campaigns for {MONTH_NAMES[monthIdx]} {year}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
              Try a different month, or check the Overview tab for the monthly roll-up.
            </div>
          </div>
        ) : (
          <div>
            {sortedCampaigns.map(c => {
              const prevForThis = c.campaignName ? prevByName.get(c.campaignName.trim().toLowerCase()) : null;
              return <CampaignCard key={c.id} campaign={c} prevCampaign={prevForThis} currency={currency} />;
            })}
          </div>
        )
      )}
    </div>
  );
}

// Helpers — RPC returns snake_case for monthly overview fields, but
// jsonb campaigns are camelCase. Allow lookup by either.
function camelGet(obj, key) {
  if (!obj) return null;
  if (obj[key] != null) return obj[key];
  const snake = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
  return obj[snake];
}

// ── Top-level ──────────────────────────────────────────────────────
export default function ClientGmvMaxSection({ gmv = [], brands = [] }) {
  const [view, setView] = useState('overview');
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(today.getMonth());

  const prevMonthClick = () => {
    if (monthIdx === 0) { setYear(y => y - 1); setMonthIdx(11); }
    else setMonthIdx(m => m - 1);
  };
  const nextMonthClick = () => {
    if (monthIdx === 11) { setYear(y => y + 1); setMonthIdx(0); }
    else setMonthIdx(m => m + 1);
  };
  const goToCurrent = () => { setYear(today.getFullYear()); setMonthIdx(today.getMonth()); };
  const isCurrent = year === today.getFullYear() && monthIdx === today.getMonth();
  const hasAnyData = gmv.length > 0;

  return (
    <div>
      {/* Hero */}
      <div style={{
        background: `radial-gradient(circle at 15% 20%, rgba(245, 213, 168, 0.16), transparent 45%),
                     radial-gradient(circle at 85% 100%, rgba(212, 165, 116, 0.10), transparent 50%),
                     linear-gradient(135deg, ${WURX.bgDarkest} 0%, ${WURX.bgDeep} 50%, ${WURX.bgWarm} 100%)`,
        borderRadius: 22, padding: '22px 26px', marginBottom: 22,
        position: 'relative', overflow: 'hidden',
        boxShadow: `0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px ${WURX.border}`,
      }}>
        <div style={{ position: 'absolute', top: -120, right: -100, width: 380, height: 380, borderRadius: '50%', background: `radial-gradient(circle, ${WURX.peach}, transparent 70%)`, opacity: 0.18, filter: 'blur(60px)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: -120, left: -60, width: 320, height: 320, borderRadius: '50%', background: `radial-gradient(circle, ${WURX.peachDeep}, transparent 70%)`, opacity: 0.12, filter: 'blur(60px)', pointerEvents: 'none' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 52, height: 52, borderRadius: 14,
              background: `linear-gradient(135deg, ${WURX.peach}, ${WURX.peachDeep})`,
              display: 'grid', placeItems: 'center', fontSize: 22,
              boxShadow: `0 6px 20px ${WURX.glow}, inset 0 1px 0 rgba(255,255,255,0.25)`,
            }}>📊</div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: WURX.peach }}>GMV Max Reporting</div>
              <h4 style={{ margin: '2px 0 4px', fontWeight: 800, fontSize: 22, color: WURX.cream, letterSpacing: '-0.025em', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {monthLabel(year, monthIdx)}
                {isCurrent && (
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    background: `linear-gradient(135deg, ${WURX.peach}, ${WURX.peachDeep})`,
                    color: '#1f1714',
                    padding: '4px 12px', borderRadius: 999,
                    letterSpacing: '0.1em',
                    boxShadow: `0 4px 12px ${WURX.glow}`,
                  }}>LIVE</span>
                )}
              </h4>
              <div style={{ fontSize: 12, color: 'rgba(250, 247, 242, 0.55)', marginTop: 2 }}>
                GMV Max ads from TikTok Ads Manager and TikTok Seller Center
              </div>
            </div>
          </div>

          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <NavBtn onClick={prevMonthClick}>‹</NavBtn>
            <select value={monthIdx} onChange={e => setMonthIdx(Number(e.target.value))}
              style={navSelect}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i} style={{ color: '#0f172a', background: '#fff' }}>{m}</option>)}
            </select>
            <select value={year} onChange={e => setYear(Number(e.target.value))} style={navSelect}>
              {[today.getFullYear() - 2, today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1].map(y => (
                <option key={y} value={y} style={{ color: '#0f172a', background: '#fff' }}>{y}</option>
              ))}
            </select>
            <NavBtn onClick={nextMonthClick}>›</NavBtn>
            {!isCurrent && (
              <button onClick={goToCurrent} style={{
                background: `linear-gradient(135deg, ${WURX.peach}, ${WURX.peachDeep})`,
                color: '#1f1714', border: 'none', borderRadius: 10,
                padding: '7px 16px', fontSize: 12, fontWeight: 700,
                boxShadow: `0 4px 14px ${WURX.glow}`, cursor: 'pointer',
              }}>↺ Today</button>
            )}
          </div>
        </div>
      </div>

      {/* Tab toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{
          display: 'flex', padding: 4, borderRadius: 12,
          background: WURX.lightTintBg, border: `1px solid ${WURX.lightTintBorder}`,
          boxShadow: 'inset 0 1px 2px rgba(31, 23, 20, 0.04)',
        }}>
          {[
            { key: 'overview',  label: '📊 Monthly Overview' },
            { key: 'campaigns', label: '📣 Campaigns' },
          ].map(t => {
            const isActive = view === t.key;
            return (
              <button key={t.key} type="button" onClick={() => setView(t.key)}
                style={{
                  background: isActive ? `linear-gradient(135deg, ${WURX.bgDeep}, ${WURX.bgWarm})` : 'transparent',
                  color: isActive ? WURX.peach : '#75584a',
                  border: 'none', borderRadius: 10,
                  padding: '8px 18px', fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em',
                  boxShadow: isActive ? `0 4px 14px rgba(0,0,0,0.25), 0 0 0 1px ${WURX.borderSoft}` : 'none',
                  transition: 'all 150ms ease', cursor: 'pointer',
                }}>
                {t.label}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 12, color: '#75584a', marginLeft: 4 }}>
          {view === 'overview'
            ? 'Aggregate monthly comparison — current vs previous month.'
            : 'Per-campaign performance for the selected month, with active campaigns highlighted.'}
        </span>
      </div>

      {!hasAnyData ? (
        <div style={{
          textAlign: 'center',
          background: `linear-gradient(135deg, #ffffff, ${WURX.lightTintBg})`,
          border: `2px dashed ${WURX.lightTintBorder}`,
          borderRadius: 22, padding: '52px 24px',
        }}>
          <div style={{
            width: 84, height: 84, borderRadius: '50%',
            background: `linear-gradient(135deg, ${WURX.peach}, ${WURX.peachDeep})`,
            display: 'inline-grid', placeItems: 'center', fontSize: 32,
            boxShadow: `0 12px 28px ${WURX.glow}, inset 0 1px 0 rgba(255,255,255,0.25)`,
            marginBottom: 16,
          }}>📊</div>
          <h5 style={{ fontWeight: 800, marginBottom: 6, color: '#1f1714', letterSpacing: '-0.02em' }}>No GMV Max data yet</h5>
          <p style={{ maxWidth: 380, margin: '0 auto', fontSize: 13, color: '#75584a' }}>
            Your account team has not entered any GMV Max metrics yet. Check back soon — this section updates as new data is added.
          </p>
        </div>
      ) : (
        brands.map(b => (
          <BrandBlock key={b.id} brand={b} allReports={gmv} year={year} monthIdx={monthIdx} view={view} />
        ))
      )}
    </div>
  );
}

const navSelect = {
  background: 'rgba(245, 213, 168, 0.08)',
  color: WURX.cream,
  border: `1px solid ${WURX.borderSoft}`,
  borderRadius: 10,
  padding: '7px 12px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

function NavBtn({ onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'rgba(245, 213, 168, 0.08)', color: WURX.peach,
      border: `1px solid ${WURX.borderSoft}`, borderRadius: 10,
      width: 36, height: 36, display: 'grid', placeItems: 'center',
      cursor: 'pointer', fontSize: 16,
    }}>{children}</button>
  );
}
