import { useMemo, useState, Fragment } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, ComposedChart,
  ResponsiveContainer, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { useAuth } from '../../contexts/AuthContext';
import {
  verifyReport, approveReport, rejectReport, reopenReport,
  reportPermissions, STATUS_LABEL, STATUS_COLOR,
} from '../../lib/reportsApi';
import { formatPctChange } from '../../utils/formatPctChange';
import {
  AlertIcon, CheckIcon, RefreshIcon, ChevronRightIcon,
  PencilIcon, XIcon, CopyIcon, CalendarIcon,
} from '../common/Icon';
import BrandAvatar from '../brands/BrandAvatar';
import { useBrandReportLinks, EmbeddedLinks, UnmatchedReportLinkSections } from './BrandReportLinks';
import EditReportDatesModal from './EditReportDatesModal';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import HighlightableContent from '../common/HighlightableContent';
import HighlighterPicker, { useHighlightStyle } from '../common/HighlighterPicker';
import RichContent from '../common/RichContent';
import '../../styles/reports.css';

/* ─── Editorial palette (amber accents on near-monochrome) ─────────────── */
const C = {
  ink: '#0f172a',
  inkDim: '#475569',
  muted: '#94a3b8',
  line: '#e9ecef',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
  hero: '#1f1208',
  amber: '#d97706',
  amberSoft: '#fef3c7',
  amberLine: '#fcd34d',
  green: '#16a34a',
  greenSoft: '#dcfce7',
  red: '#dc2626',
  redSoft: '#fee2e2',
};

// Brand-link section names this view considers "known" — saved sections
// whose name matches one of these embed inside the matching report
// section instead of rendering as a standalone card.
const KNOWN_REPORT_SECTION_NAMES = [
  'Current & Upcoming Campaigns',
  'Operational Updates',
  'Recommendations',
  'Recommendations & Action Items', // legacy compat
  'Action Items',
  'Top Creators',
  'Top Videos',
  'GMV Max — Best Performing Campaigns',
  'Product Highlights',
  'Offsite Performance',
  'Overall Performance',
];

/* ─── Helpers ─────────────────────────────────────────────────────────── */
const num = (v) => parseFloat(v) || 0;
const pctChange = (a, b) => { const c = num(a), p = num(b); if (p === 0) return c > 0 ? 100 : 0; return ((c - p) / p) * 100; };

// Currency-aware formatters. The second arg defaults to USD so older
// reports without a `currency` field keep showing '$', matching v1.
function fmt$(v, currency = DEFAULT_CURRENCY) {
  const sym = currencySymbol(currency);
  return sym + Number(num(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt$short(v, currency = DEFAULT_CURRENCY) {
  const n = num(v);
  const sym = currencySymbol(currency);
  if (n >= 1_000_000) return sym + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return sym + (n / 1_000).toFixed(1) + 'k';
  return sym + n.toFixed(2);
}
function fmtN(v) { return Number(num(v)).toLocaleString(); }
function fmtNshort(v) {
  const n = num(v);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function htmlToPlainText(s) {
  if (!s) return '';
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  const d = document.createElement('div');
  d.innerHTML = s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  return (d.textContent || d.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

function initials(name) {
  if (!name) return '?';
  const cleaned = String(name).replace(/^@/, '').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/[\s._\-/]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function parseCreatorHandle(raw) {
  if (!raw) return '';
  const s = String(raw).trim().replace(/^@+/, '');
  if (/^https?:\/\//i.test(s) || /tiktok\.com/i.test(s)) {
    let m = s.match(/tiktok\.com\/@([a-zA-Z0-9._\-]+)/i);
    if (m) return m[1];
    m = s.match(/[/@]([a-zA-Z0-9._\-]+)\/video/i);
    if (m) return m[1];
    return '';
  }
  return s;
}

function avatarColor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 48%)`;
}

function posterGradient(seed) {
  const palette = [
    ['#5b3a1f', '#1a0f06'],   // bronze
    ['#5b2d8b', '#1d0c30'],   // purple
    ['#0f5e4a', '#062018'],   // emerald
    ['#7a3d18', '#231308'],   // copper
    ['#7a1d3f', '#240a16'],   // ruby
    ['#1d3e5b', '#0a1620'],   // navy
    ['#5c4a16', '#1c1605'],   // olive gold
  ];
  const idx = Math.abs(seed | 0) % palette.length;
  const [a, b] = palette[idx];
  return `linear-gradient(160deg, ${a} 0%, ${b} 100%)`;
}

/* ─── Pieces ──────────────────────────────────────────────────────────── */
function DeltaPill({ pct, size = 'sm' }) {
  if (pct === null || pct === undefined || !isFinite(pct)) return null;
  const up = pct >= 0;
  const fontSize = size === 'sm' ? 11 : 13;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize, fontWeight: 600,
      color: up ? C.green : C.red,
      background: up ? C.greenSoft : C.redSoft,
      padding: '2px 8px', borderRadius: 999, lineHeight: 1.2,
    }}>
      {up ? '▲' : '▼'} {formatPctChange(pct, { withSign: false })}
    </span>
  );
}

function Sparkline({ data, color, height = 38 }) {
  if (!data || data.length < 2) return null;
  return (
    <div style={{ height, marginTop: 8 }} className="no-print">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function StatCard({ label, value, prevValue, current, color = C.amber, sparkData, primary, subText }) {
  const hasPrev = prevValue !== undefined && prevValue !== null && num(prevValue) !== 0;
  const pct = hasPrev ? pctChange(current !== undefined ? current : value, prevValue) : null;

  const baseStyle = {
    borderRadius: 14,
    padding: '18px 18px 16px',
    height: '100%',
    border: `1px solid ${C.line}`,
    background: primary ? C.hero : C.surface,
    color: primary ? '#f5f5f4' : C.ink,
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
  };
  const labelStyle = {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: primary ? '#a8a29e' : C.muted,
  };

  return (
    <div style={baseStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={{
        fontSize: 30, fontWeight: 700, lineHeight: 1.1, marginTop: 6,
        fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
      }}>{value}</div>
      {prevValue !== undefined && prevValue !== null && (
        <div style={{
          fontSize: 12, marginTop: 6,
          color: primary ? '#a8a29e' : C.inkDim,
        }}>
          Prev <span style={{ fontWeight: 500 }}>{typeof prevValue === 'string' ? prevValue : ''}</span>
        </div>
      )}
      {pct !== null && (
        <div style={{ marginTop: 8 }}>
          <DeltaPill pct={pct} />
          <span style={{ fontSize: 11, color: primary ? '#a8a29e' : C.inkDim, marginLeft: 6 }}>
            {pct >= 0 ? '+' : ''}{(num(current) - num(prevValue)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </div>
      )}
      {subText && (
        <div style={{ fontSize: 11, color: primary ? '#a8a29e' : C.muted, marginTop: 6 }}>{subText}</div>
      )}
      {sparkData && sparkData.length > 1 && (
        <Sparkline data={sparkData} color={primary ? C.amber : color} />
      )}
    </div>
  );
}

function SectionHead({ title, eyebrow, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      marginTop: 4, marginBottom: 14,
    }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, letterSpacing: '-0.01em' }}>{title}</div>
        {eyebrow && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{eyebrow}</div>
        )}
      </div>
      {action}
    </div>
  );
}

function CreatorRow({ creator, rank, totalGmv, currency = DEFAULT_CURRENCY }) {
  const gmv = num(creator.gmv);
  const sharePct = totalGmv > 0 ? (gmv / totalGmv) * 100 : 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px',
      borderTop: `1px solid ${C.line}`,
    }}>
      <div style={{
        width: 22, height: 22, borderRadius: 5,
        background: rank === 1 ? '#fef3c7' : rank === 2 ? '#e2e8f0' : rank === 3 ? '#fde68a' : '#f1f5f9',
        color: C.ink, fontSize: 12, fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{rank}</div>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: avatarColor(creator.name), color: '#fff',
        fontSize: 11, fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{initials(creator.name)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{creator.name}</div>
        {creator.notes && (
          <div style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{creator.notes}</div>
        )}
      </div>
      <div style={{ width: 56, textAlign: 'right', fontSize: 13, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtN(creator.videosPosted)}</div>
      <div style={{ width: 64, textAlign: 'right', fontSize: 13, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtN(creator.itemsSold)}</div>
      <div style={{ width: 100 }}>
        <div style={{ height: 6, background: C.line, borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, sharePct)}%`, background: C.amber, borderRadius: 999 }} />
        </div>
      </div>
      <div style={{ width: 80, textAlign: 'right', fontSize: 13.5, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt$short(gmv, currency)}</div>
    </div>
  );
}

function VideoPosterCard({ video, rank, currency = DEFAULT_CURRENCY }) {
  const gmv = num(video.gmv);
  const handle = parseCreatorHandle(video.creatorName) || parseCreatorHandle(video.videoLink) || 'creator';
  const linkOk = !!(video.videoLink && /^https?:\/\//i.test(video.videoLink));
  const Card = linkOk ? 'a' : 'div';
  return (
    <Card
      href={linkOk ? video.videoLink : undefined}
      target={linkOk ? '_blank' : undefined}
      rel={linkOk ? 'noopener noreferrer' : undefined}
      style={{
        display: 'block', textDecoration: 'none', color: 'inherit',
        borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.line}`,
        background: C.surface, transition: 'transform 120ms ease, box-shadow 120ms ease',
      }}
      onMouseEnter={(e) => { if (linkOk) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(15,23,42,0.10)'; } }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
      title={linkOk ? 'Open TikTok video' : undefined}>
      {/* Poster (vertical 9:16-ish) */}
      <div style={{
        position: 'relative', aspectRatio: '9 / 14',
        background: posterGradient(rank * 17 + (handle.charCodeAt(0) || 0)),
        display: 'flex', alignItems: 'flex-end', padding: '10px',
      }}>
        {/* View count badge */}
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 999,
          fontSize: 11, fontWeight: 600, padding: '3px 9px',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          👁 {fmtNshort(video.views)}
        </div>
        {/* Rank */}
        <div style={{
          position: 'absolute', top: 10, right: 10,
          background: 'rgba(255,255,255,0.92)', color: C.ink, borderRadius: 4,
          fontSize: 11, fontWeight: 700, padding: '2px 7px', minWidth: 22, textAlign: 'center',
        }}>{rank}</div>
        {/* Big initials in middle */}
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.92)', fontSize: 32, fontWeight: 700, letterSpacing: '0.04em',
          textShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>{initials(handle)}</div>
        {/* Handle at bottom */}
        <div style={{
          position: 'relative', zIndex: 1, color: '#fff', fontSize: 12.5, fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        }}>@{handle}</div>
        {/* Play icon hint when link present */}
        {linkOk && (
          <div style={{
            position: 'absolute', right: 10, bottom: 10,
            width: 30, height: 30, borderRadius: '50%',
            background: 'rgba(255,255,255,0.95)', color: C.ink,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)', fontSize: 14,
          }}>▶</div>
        )}
      </div>
      {/* Stats footer */}
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
          {fmt$(gmv, currency)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: C.muted }}>
          <span>Sold <strong style={{ color: C.ink }}>{fmtN(video.itemsSold)}</strong></span>
          <span>Clicks <strong style={{ color: C.ink }}>{video.productClicks || '—'}</strong></span>
        </div>
      </div>
    </Card>
  );
}

function ProductRow({ product, rank, gmvShare, currency = DEFAULT_CURRENCY }) {
  const gmv = num(product.gmv);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px',
      borderTop: rank === 1 ? 'none' : `1px solid ${C.line}`,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 6,
        background: C.surfaceAlt, border: `1px solid ${C.line}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        color: C.muted, fontSize: 18,
      }}>📦</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{product.productName}</div>
        {product.productId && (
          <div style={{ fontSize: 11, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
            ID&nbsp;{product.productId}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: 11, color: C.inkDim }}>
          <span>Units <strong style={{ color: C.ink, fontWeight: 600 }}>{fmtN(product.unitsSold)}</strong></span>
          <span>New videos <strong style={{ color: C.ink, fontWeight: 600 }}>{fmtN(product.newVideos)}</strong></span>
          <span>Share <strong style={{ color: C.ink, fontWeight: 600 }}>{(gmvShare || 0).toFixed(1)}%</strong></span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt$short(gmv, currency)}</div>
        <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>GMV</div>
      </div>
    </div>
  );
}

/* Modern long-form section wrapper — icon-circle header + clean card. */
function ContentSection({ icon, color = C.amber, title, eyebrow, children }) {
  return (
    <div style={{
      marginTop: 12,
      background: C.surface,
      border: `1px solid ${C.line}`,
      borderRadius: 14,
      padding: '20px 22px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: color + '15', color,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, fontSize: 17,
        }}>{icon}</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, letterSpacing: '-0.01em', lineHeight: 1.2 }}>{title}</div>
          {eyebrow && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{eyebrow}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function ComparisonRow({ label, current, previous, fmt }) {
  const max = Math.max(num(current), num(previous), 0.0001);
  const pct = pctChange(current, previous);
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      background: C.surfaceAlt, padding: '14px 16px', borderRadius: 10,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 11, fontWeight: 600, color: C.inkDim,
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        <span>{label}</span>
        <DeltaPill pct={pct} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ width: 56, fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>This</span>
        <div style={{ flex: 1, height: 16, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(num(current) / max) * 100}%`, background: C.amber, transition: 'width 320ms ease' }} />
        </div>
        <span style={{ minWidth: 78, textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(current)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 56, fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last</span>
        <div style={{ flex: 1, height: 16, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(num(previous) / max) * 100}%`, background: '#cbd5e1', transition: 'width 320ms ease' }} />
        </div>
        <span style={{ minWidth: 78, textAlign: 'right', fontSize: 12.5, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt(previous)}</span>
      </div>
    </div>
  );
}

function ComparisonPanel({ current, previous, prevLabel, currency = DEFAULT_CURRENCY }) {
  const fmtMoney = (v) => fmt$short(v, currency);
  const rows = [
    { label: 'GMV', current: current.gmv, previous: previous.gmv, fmt: fmtMoney },
    { label: 'Affiliate GMV', current: current.affiliateGmv, previous: previous.affiliateGmv, fmt: fmtMoney },
    { label: 'Orders', current: current.orders, previous: previous.orders, fmt: fmtN },
    { label: 'ROI', current: current.roi, previous: previous.roi, fmt: (v) => num(v).toFixed(2) + '×' },
    { label: 'Videos Posted', current: current.videosPosted, previous: previous.videosPosted, fmt: fmtN },
    { label: 'Samples Approved', current: current.samplesApproved, previous: previous.samplesApproved, fmt: fmtN },
  ];
  return (
    <ContentSection
      icon="📊"
      color={C.amber}
      title="Performance vs last week"
      eyebrow={prevLabel ? `Compared with ${prevLabel}` : 'This week vs last week'}
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
        gap: 12,
      }}>
        {rows.map((r) => <ComparisonRow key={r.label} {...r} />)}
      </div>
    </ContentSection>
  );
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10,
      padding: '8px 12px', boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
      fontSize: 12,
    }}>
      <div style={{ fontWeight: 700, color: C.ink, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.inkDim }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={{ flex: 1 }}>{p.name}</span>
          <strong style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{p.value}</strong>
        </div>
      ))}
    </div>
  );
}

function TrendsPanel({ trendData, currency = DEFAULT_CURRENCY }) {
  const moneyFmt = (v) => fmt$short(v, currency);
  if (!trendData || trendData.length < 2) return null;
  const firstWeek = trendData[0].week;
  const lastWeek = trendData[trendData.length - 1].week;
  const eyebrow = `${trendData.length} reporting weeks · ${firstWeek} → ${lastWeek}`;

  return (
    <ContentSection
      icon="📈"
      color={C.amber}
      title="Trends over time"
      eyebrow={eyebrow}>
      {/* GMV + Orders dual-axis combo */}
      <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: '14px 14px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>GMV & Orders</div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.inkDim }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: C.amber, borderRadius: 2 }} />GMV</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: C.green, borderRadius: 2 }} />Orders</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={trendData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id="gmvFillModern" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.amber} stopOpacity={0.32} />
                <stop offset="100%" stopColor={C.amber} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="week" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} interval={0} />
            <YAxis yAxisId="gmv" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} tickFormatter={moneyFmt} />
            <YAxis yAxisId="orders" orientation="right" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: C.amber, strokeOpacity: 0.25 }} />
            <Area yAxisId="gmv" type="monotone" dataKey="gmv" stroke={C.amber} strokeWidth={2}
              fill="url(#gmvFillModern)" name="GMV" isAnimationActive={false} dot={{ r: 2.5, fill: C.amber }} />
            <Line yAxisId="orders" type="monotone" dataKey="orders" stroke={C.green} strokeWidth={2}
              dot={{ r: 2.5, fill: C.green }} name="Orders" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Side-by-side: ROI + Videos */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
        gap: 12, marginTop: 12,
      }}>
        <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>ROI</div>
            <div style={{ fontSize: 11, color: C.inkDim }}>Return on ad spend</div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={trendData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} tickFormatter={(v) => v.toFixed(1) + '×'} />
              <Tooltip content={<TrendTooltip />} cursor={{ stroke: C.green, strokeOpacity: 0.25 }} />
              <Line type="monotone" dataKey="roi" stroke={C.green} strokeWidth={2.5}
                dot={{ r: 3, fill: C.green }} name="ROI" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>Videos posted</div>
            <div style={{ fontSize: 11, color: C.inkDim }}>Per week</div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={trendData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
              <Tooltip content={<TrendTooltip />} cursor={{ fill: '#f1f5f9' }} />
              <Bar dataKey="videosPosted" fill="#f97316" radius={[6, 6, 0, 0]} name="Videos" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ContentSection>
  );
}

function InsightBox({ text, report, fieldKey, highlighterOn, hlColor, hlIntensity }) {
  if (!text) return null;
  return (
    <div style={{
      marginTop: 12, marginBottom: 4,
      background: '#fffbeb', border: `1px solid ${C.amberLine}`,
      borderRadius: 12, padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ color: C.amber, fontSize: 14, marginTop: 2 }}>💡</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {report && fieldKey ? (
            <HighlightableContent
              html={text} report={report} fieldKey={fieldKey}
              highlighterActive={highlighterOn}
              highlightColor={hlColor} highlightIntensity={hlIntensity}
              style={{ fontSize: 13, color: '#7c4c00', lineHeight: 1.55 }} />
          ) : (
            <RichContent html={text} style={{ fontSize: 13, color: '#7c4c00', lineHeight: 1.55 }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main view ───────────────────────────────────────────────────────── */
export default function ReportView({ report, allReports = [], previousReport, onBack, onSaved, onEditDraft }) {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenTarget, setReopenTarget] = useState('verified');
  const [reopenNote, setReopenNote] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const [editDatesOpen, setEditDatesOpen] = useState(false);
  const [highlighterOn, setHighlighterOn] = useState(false);
  const {
    color: hlColor, setColor: setHlColor,
    intensity: hlIntensity, setIntensity: setHlIntensity,
  } = useHighlightStyle();

  const perms = reportPermissions({
    report, role, uid: user?.id, brandOwnerId: report?.brand?.owner_id,
  });

  // Currency selected on the report (USD default for legacy rows).
  // `m`/`ms` are local closures so the inline JSX below stays compact.
  const currency = report?.data?.currency || DEFAULT_CURRENCY;
  const m  = (v) => fmt$(v, currency);
  const ms = (v) => fmt$short(v, currency);

  // Brand-default report links
  const { findByName, getUnmatched } = useBrandReportLinks(report?.brand_id);
  const customFieldNames = useMemo(() => {
    const cf = report?.data?.customFields || {};
    return Object.values(cf)
      .map((v) => (typeof v === 'object' ? v?.name : null))
      .filter(Boolean);
  }, [report?.data?.customFields]);
  const unmatchedLinkSections = getUnmatched([
    ...KNOWN_REPORT_SECTION_NAMES,
    ...customFieldNames,
  ]);

  // Last 8 periods for sparklines + trends
  const trendData = useMemo(() => {
    if (!report || !allReports?.length) return [];
    return [...allReports]
      .filter((r) => r.brand_id === report.brand_id && r.type === report.type)
      .sort((a, b) => (a.period_start || '').localeCompare(b.period_start || ''))
      .slice(-8)
      .map((r) => {
        const p = r.data?.overallPerformance || {};
        const off = r.data?.offsitePerformance || {};
        const week = (r.period_label || r.period_start || '').replace(/Week\s*\d+\s*/, '').trim();
        return {
          week,
          gmv: num(p.gmv),
          affiliateGmv: num(p.affiliateGmv),
          orders: num(p.orders),
          roi: num(p.roi),
          samplesApproved: num(p.samplesApproved),
          shopPerformanceScore: num(p.shopPerformanceScore),
          videosPosted: num(p.videosPosted),
          offsiteEffect: num(off.offsiteEffect),
        };
      });
  }, [allReports, report]);

  const sparkFor = (key) => trendData.map((d) => ({ v: d[key] }));

  if (!report) return null;

  const d         = report.data || {};
  const perf      = d.overallPerformance || {};
  const notes     = d.overallNotes || {};
  const offsite   = d.offsitePerformance || {};
  const prev      = previousReport?.data || {};
  const prevPerf  = prev.overallPerformance || {};
  const prevOffsite = prev.offsitePerformance || {};
  const hasPrev   = !!previousReport;

  const productData     = (d.productHighlights || []).filter((p) => p.productName);
  const totalProductGmv = productData.reduce((s, p) => s + num(p.gmv), 0);
  const totalCreatorGmv = (d.topCreators || []).filter((c) => c.name).reduce((s, c) => s + num(c.gmv), 0);
  const sortedCreators = [...(d.topCreators || [])].filter((c) => c.name).sort((a, b) => num(b.gmv) - num(a.gmv));
  const sortedVideos   = [...(d.topVideos   || [])].filter((v) => v.creatorName).sort((a, b) => num(b.gmv) - num(a.gmv));
  const sortedProducts = [...productData].sort((a, b) => num(b.gmv) - num(a.gmv));

  const statusColor = STATUS_COLOR[report.status] || STATUS_COLOR.approved;
  const typeLabel   = report.type === 'biweekly' ? 'Bi-Weekly' : 'Weekly';

  // ---- staged actions ----
  async function run(fn) {
    try { setSaving(true); setError(''); const r = await fn(); onSaved?.(r); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  const handleVerify  = () => run(() => verifyReport(report.id));
  const handleApprove = () => run(() => approveReport(report.id));
  const handleReject = () => {
    if (!rejectNote.trim()) { setError('Please add a reason for sending this back.'); return; }
    run(() => rejectReport(report.id, { note: rejectNote.trim() }))
      .then(() => { setRejectOpen(false); setRejectNote(''); });
  };
  const handleReopen = () => {
    if (reopenTarget !== 'verified' && !reopenNote.trim()) {
      setError('Please add a note for the person you\'re reopening to.'); return;
    }
    run(() => reopenReport(report.id, { target: reopenTarget, note: reopenTarget === 'verified' ? null : reopenNote.trim() }))
      .then(() => { setReopenOpen(false); setReopenNote(''); setReopenTarget('verified'); });
  };

  // Copy all insights → clipboard (plain text).
  const handleCopyInsights = async () => {
    const insightFields = [
      d.overallInsights, d.topCreatorsInsights, d.topVideosInsights,
      d.gmvMaxInsights, d.productHighlightsInsights, d.offsiteInsights,
    ];
    const insightParts = insightFields.map((v) => htmlToPlainText((v || '').toString()).trim()).filter(Boolean);
    const titled = [];
    const push = (heading, value) => {
      const t = htmlToPlainText((value || '').toString()).trim();
      if (t) titled.push(`${heading}\n${t}`);
    };
    push('Current & Upcoming Campaigns', d.upcomingCampaigns);
    push('Operational Updates',          d.operationalUpdates);
    push('Recommendations',              d.recommendations);
    push('Action Items',                 d.actionItems);
    if (d.customFields) {
      Object.values(d.customFields).forEach((entry) => {
        const name = typeof entry === 'object' ? (entry?.name || 'Custom Field') : 'Custom Field';
        const val  = typeof entry === 'object' ? entry?.value : entry;
        push(name, val);
      });
    }
    const combined = [...insightParts, ...titled];
    if (!combined.length) return;
    const text = combined.join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 1800);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* no-op */ }
      document.body.removeChild(ta);
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 1800);
    }
  };

  return (
    <div className="report-page report-view">
      <button type="button" className="report-back" onClick={onBack}>
        <ChevronRightIcon width="14" height="14" style={{ transform: 'rotate(180deg)' }} />
        Back to reports
      </button>

      {/* Action bar — actions live on top so they stay one click away */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {perms.canEditDates && (
          <button type="button"
            className="wx-btn wx-btn-ghost"
            onClick={() => setEditDatesOpen(true)}
            title="Change this report's period without affecting other reports">
            <CalendarIcon width="13" height="13" /> Edit dates
          </button>
        )}
        <button type="button"
          className="wx-btn wx-btn-ghost"
          onClick={handleCopyInsights}
          title="Copy all insights and narrative sections to the clipboard">
          <CopyIcon width="13" height="13" />
          {copyState === 'done' ? 'Copied!' : 'Copy All Insights'}
        </button>
        <button type="button"
          className={`wx-btn ${highlighterOn ? 'wx-btn-primary' : 'wx-btn-ghost'}`}
          onClick={() => setHighlighterOn((v) => !v)}
          title={highlighterOn ? 'Click to stop highlighting' : 'Highlighter mode — drag across text to highlight (drag across a highlight to remove)'}>
          ✏︎ {highlighterOn ? 'Highlighting…' : 'Highlight'}
        </button>
        {highlighterOn && (
          <HighlighterPicker
            color={hlColor} onColorChange={setHlColor}
            intensity={hlIntensity} onIntensityChange={setHlIntensity}
            compact />
        )}
        <span className="report-status-badge" style={{ background: statusColor.bg, color: statusColor.fg }}>
          <span className="report-status-badge-dot" /> {STATUS_LABEL[report.status]}
        </span>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}

      {report.status === 'approved' && (
        <div className="report-approved-banner" style={{ marginBottom: 12 }}>
          <CheckIcon width="18" height="18" />
          Approved on {report.approved_at ? new Date(report.approved_at).toLocaleDateString() : ''}
        </div>
      )}
      {report.status !== 'draft' && report.rejection_note && (
        <div className="report-rejection-note" style={{ marginBottom: 12 }}>
          <strong>Revision note:</strong> {report.rejection_note}
        </div>
      )}

      {/* ─── Editorial canvas ───────────────────────────────────────────── */}
      <div className="report-canvas" style={{
        background: C.surfaceAlt,
        padding: 24,
        borderRadius: 18,
        border: `1px solid ${C.line}`,
      }}>
        {/* Brand chip + breadcrumb */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, marginBottom: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flexShrink: 0 }}>
              <BrandAvatar brand={report.brand} size={42} />
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, lineHeight: 1.1 }}>
                {report.brand?.brand_name || 'Brand'}
              </div>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>
                {typeLabel} Report
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.inkDim }}>
            <span style={{ color: C.muted }}>Affiliate</span>
            <span style={{ color: C.muted }}>/</span>
            <span style={{ color: C.muted }}>{typeLabel}</span>
            <span style={{ color: C.muted }}>/</span>
            <span style={{ fontWeight: 700, color: C.ink }}>{report.period_label}</span>
          </div>
        </div>

        {hasPrev && (
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 18 }}>
            Compared with <strong style={{ color: C.inkDim }}>{previousReport.period_label}</strong>
          </div>
        )}

        {/* ─── Hero stat grid (4 + 4) ──────────────────────────────────── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
          gap: 12, marginBottom: 12,
        }}>
          <StatCard label="GMV (Gross Merchandise Value)" value={m(perf.gmv)}
            current={num(perf.gmv)} prevValue={hasPrev ? m(prevPerf.gmv) : null}
            primary sparkData={sparkFor('gmv')} />
          <StatCard label="Affiliate GMV" value={m(perf.affiliateGmv)}
            current={num(perf.affiliateGmv)} prevValue={hasPrev ? m(prevPerf.affiliateGmv) : null}
            sparkData={sparkFor('affiliateGmv')} />
          <StatCard label="Orders" value={fmtN(perf.orders)}
            current={num(perf.orders)} prevValue={hasPrev ? fmtN(prevPerf.orders) : null}
            sparkData={sparkFor('orders')} />
          <StatCard label="ROI" value={num(perf.roi).toFixed(2) + '×'}
            current={num(perf.roi)} prevValue={hasPrev ? num(prevPerf.roi).toFixed(2) + '×' : null}
            color={C.green} sparkData={sparkFor('roi')} />
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
          gap: 12, marginBottom: 18,
        }}>
          <StatCard label="Samples Approved" value={fmtN(perf.samplesApproved)}
            current={num(perf.samplesApproved)} prevValue={hasPrev ? fmtN(prevPerf.samplesApproved) : null}
            subText={notes.samplesApproved ? `MTD: ${fmtN(notes.samplesApproved)}` : ''}
            sparkData={sparkFor('samplesApproved')} />
          <StatCard label="Shop Performance Score" value={num(perf.shopPerformanceScore).toFixed(1) + ' /5'}
            current={num(perf.shopPerformanceScore)} prevValue={hasPrev ? num(prevPerf.shopPerformanceScore).toFixed(1) + ' /5' : null}
            sparkData={sparkFor('shopPerformanceScore')} />
          <StatCard label="Videos Posted" value={fmtN(perf.videosPosted)}
            current={num(perf.videosPosted)} prevValue={hasPrev ? fmtN(prevPerf.videosPosted) : null}
            subText={notes.videosPosted ? `Total: ${fmtN(notes.videosPosted)}` : ''}
            sparkData={sparkFor('videosPosted')} />
          <StatCard label="Offsite Effect" value={num(offsite.offsiteEffect).toFixed(2) + '%'}
            current={num(offsite.offsiteEffect)} prevValue={hasPrev ? num(prevOffsite.offsiteEffect).toFixed(2) + '%' : null}
            subText={offsite.offsiteGmv ? `Off-site GMV ${ms(offsite.offsiteGmv)} · Shop ${ms(offsite.tiktokShopGmv)}` : ''}
            sparkData={sparkFor('offsiteEffect')} />
        </div>

        <InsightBox text={d.overallInsights} report={report} fieldKey="overallInsights"
          highlighterOn={highlighterOn} hlColor={hlColor} hlIntensity={hlIntensity} />

        {/* ─── Comparison panel ─────────────────────────────────────────── */}
        {hasPrev && (
          <ComparisonPanel current={perf} previous={prevPerf} prevLabel={previousReport.period_label} currency={currency} />
        )}

        {/* ─── Top Creators + Products ─────────────────────────────────── */}
        {(sortedCreators.length > 0 || sortedProducts.length > 0) && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))',
            gap: 12, marginTop: 12,
          }}>
            {sortedCreators.length > 0 && (
              <div>
                <div style={{
                  background: C.surface, border: `1px solid ${C.line}`,
                  borderRadius: 14, overflow: 'hidden',
                }}>
                  <div style={{ padding: '14px 16px' }}>
                    <SectionHead
                      title="Top creators this week"
                      eyebrow={`Ranked by GMV · ${sortedCreators.length} creators with data`}
                    />
                  </div>
                  {sortedCreators.map((c, i) => (
                    <CreatorRow key={i} creator={c} rank={i + 1} totalGmv={totalCreatorGmv} currency={currency} />
                  ))}
                </div>
                <InsightBox text={d.topCreatorsInsights} report={report} fieldKey="topCreatorsInsights"
                  highlighterOn={highlighterOn} hlColor={hlColor} hlIntensity={hlIntensity} />
              </div>
            )}
            {sortedProducts.length > 0 && (
              <div>
                <div style={{
                  background: C.surface, border: `1px solid ${C.line}`,
                  borderRadius: 14, overflow: 'hidden',
                }}>
                  <div style={{ padding: '14px 16px' }}>
                    <SectionHead
                      title="Products driving GMV"
                      eyebrow="Focus SKUs · units & content output"
                    />
                  </div>
                  {sortedProducts.map((p, i) => (
                    <ProductRow key={i} product={p} rank={i + 1}
                      gmvShare={totalProductGmv > 0 ? (num(p.gmv) / totalProductGmv) * 100 : 0}
                      currency={currency} />
                  ))}
                </div>
                <InsightBox text={d.productHighlightsInsights} report={report} fieldKey="productHighlightsInsights"
                  highlighterOn={highlighterOn} hlColor={hlColor} hlIntensity={hlIntensity} />
              </div>
            )}
          </div>
        )}

        {/* ─── Top Videos (poster cards) ───────────────────────────────── */}
        {sortedVideos.length > 0 && (
          <>
            <div style={{
              background: C.surface, border: `1px solid ${C.line}`,
              borderRadius: 14, padding: '18px 18px 20px', marginTop: 12,
            }}>
              <SectionHead
                title="Top videos"
                eyebrow="Best performers by GMV this week · click any card to open the TikTok video"
              />
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
                gap: 12,
              }}>
                {sortedVideos.slice(0, 5).map((v, i) => (
                  <VideoPosterCard key={i} video={v} rank={i + 1} currency={currency} />
                ))}
              </div>
            </div>
            <InsightBox text={d.topVideosInsights} report={report} fieldKey="topVideosInsights"
              highlighterOn={highlighterOn} hlColor={hlColor} hlIntensity={hlIntensity} />
          </>
        )}

        {/* ─── GMV Max + Offsite (side-by-side) ────────────────────────── */}
        {((d.gmvMax || []).some((g) => g.campaign) || num(offsite.offsiteGmv) > 0 || num(offsite.tiktokShopGmv) > 0) && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))',
            gap: 12, marginTop: 12,
          }}>
            {(d.gmvMax || []).some((g) => g.campaign) && (
              <div>
                <div style={{
                  background: C.surface, border: `1px solid ${C.line}`,
                  borderRadius: 14, padding: 18,
                }}>
                  <SectionHead title="GMV Max performance" eyebrow="Brand-managed campaigns · overall stats" />
                  {(d.gmvMax || []).filter((g) => g.campaign).map((g, i) => {
                    const cells = [
                      { label: 'Spend', value: ms(g.spend) },
                      { label: 'GMV',   value: ms(g.gmv) },
                      { label: 'ROI',   value: num(g.roi).toFixed(2) + '×', accent: num(g.roi) >= 1 ? C.green : C.red },
                      { label: 'Orders', value: fmtN(g.orders) },
                      { label: 'CPO',   value: m(g.cpo) },
                    ];
                    const spend = num(g.spend), gmv = num(g.gmv);
                    const ratio = spend > 0 && gmv > 0 ? Math.min(1, spend / gmv) : 0;
                    return (
                      <div key={i} style={{
                        marginTop: i > 0 ? 14 : 0,
                        paddingTop: i > 0 ? 14 : 0,
                        borderTop: i > 0 ? `1px solid ${C.line}` : 'none',
                      }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, marginBottom: 8 }}>{g.campaign}</div>
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(min(80px, 100%), 1fr))',
                          gap: 8,
                        }}>
                          {cells.map((c) => (
                            <div key={c.label} style={{
                              background: C.surfaceAlt, borderRadius: 8,
                              padding: '10px 12px', textAlign: 'center',
                            }}>
                              <div style={{ fontSize: 9.5, color: C.muted, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</div>
                              <div style={{ fontSize: 17, fontWeight: 700, color: c.accent || C.ink, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{c.value}</div>
                            </div>
                          ))}
                        </div>
                        {/* Spend efficiency bar */}
                        {spend > 0 && gmv > 0 && (
                          <div style={{ marginTop: 14 }}>
                            <div style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              marginBottom: 4, fontSize: 10, color: C.muted, fontWeight: 600,
                              textTransform: 'uppercase', letterSpacing: '0.08em',
                            }}>
                              <span>Spend efficiency</span>
                              <span>{currencySymbol(currency)}1 → {currencySymbol(currency)}{(gmv / spend).toFixed(2)}</span>
                            </div>
                            <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden' }}>
                              <div style={{
                                background: C.ink, color: '#fff', fontSize: 10, fontWeight: 600,
                                width: `${Math.max(15, ratio * 100)}%`, padding: '0 10px',
                                display: 'flex', alignItems: 'center',
                              }}>{ms(spend)} in</div>
                              <div style={{
                                flex: 1, background: C.amber, color: C.hero, fontSize: 10, fontWeight: 700,
                                padding: '0 10px',
                                display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                              }}>{ms(gmv)} returned →</div>
                            </div>
                          </div>
                        )}
                        {g.notes && (
                          <div style={{ marginTop: 8, fontSize: 11.5, color: C.muted }}>{g.notes}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <InsightBox text={d.gmvMaxInsights} report={report} fieldKey="gmvMaxInsights"
                  highlighterOn={highlighterOn} hlColor={hlColor} hlIntensity={hlIntensity} />
              </div>
            )}
            {(num(offsite.offsiteGmv) > 0 || num(offsite.tiktokShopGmv) > 0) && (
              <div>
                <div style={{
                  background: C.surface, border: `1px solid ${C.line}`,
                  borderRadius: 14, padding: 18,
                }}>
                  <SectionHead title="Offsite performance" eyebrow="Halo from non-TikTok channels" />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 110, height: 110, position: 'relative', flexShrink: 0 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={[
                            { v: Math.max(0, Math.min(100, num(offsite.offsiteEffect))) },
                            { v: Math.max(0, 100 - num(offsite.offsiteEffect)) },
                          ]} dataKey="v" cx="50%" cy="50%" innerRadius={36} outerRadius={52}
                            startAngle={90} endAngle={-270} paddingAngle={0} stroke="none">
                            <Cell fill={C.amber} />
                            <Cell fill={C.line} />
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
                      }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, lineHeight: 1 }}>{num(offsite.offsiteEffect).toFixed(2)}%</div>
                        <div style={{ fontSize: 9, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>Effect</div>
                      </div>
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.surfaceAlt, padding: '10px 14px', borderRadius: 10 }}>
                        <span style={{ fontSize: 12.5, color: C.inkDim }}>Offsite GMV</span>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{ms(offsite.offsiteGmv)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.surfaceAlt, padding: '10px 14px', borderRadius: 10 }}>
                        <span style={{ fontSize: 12.5, color: C.inkDim }}>TikTok Shop GMV</span>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{ms(offsite.tiktokShopGmv)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.hero, padding: '10px 14px', borderRadius: 10 }}>
                        <span style={{ fontSize: 12.5, color: '#a8a29e' }}>Combined reach</span>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{ms(num(offsite.offsiteGmv) + num(offsite.tiktokShopGmv))}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <InsightBox text={d.offsiteInsights} report={report} fieldKey="offsiteInsights"
                  highlighterOn={highlighterOn} hlColor={hlColor} hlIntensity={hlIntensity} />
              </div>
            )}
          </div>
        )}

        {/* ─── Trends ──────────────────────────────────────────────────── */}
        <TrendsPanel trendData={trendData} currency={currency} />

        {/* ─── Long-form sections ──────────────────────────────────────── */}
        {(() => {
          const links = findByName('Current & Upcoming Campaigns');
          const has = d.upcomingCampaigns && d.upcomingCampaigns.trim();
          if (!has && !links) return null;
          return (
            <ContentSection icon="📅" color="#ec4899"
              title="Current & Upcoming Campaigns"
              eyebrow="Active and planned promotional activities">
              {has && (
                <HighlightableContent html={d.upcomingCampaigns}
                  report={report} fieldKey="upcomingCampaigns"
                  highlighterActive={highlighterOn}
                  highlightColor={hlColor} highlightIntensity={hlIntensity}
                  style={{ fontSize: 14, lineHeight: 1.65, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent="#ec4899" />
            </ContentSection>
          );
        })()}

        {(() => {
          const links = findByName('Operational Updates');
          const has = d.operationalUpdates && d.operationalUpdates.trim();
          if (!has && !links) return null;
          return (
            <ContentSection icon="⚙" color="#6366f1"
              title="Operational Updates"
              eyebrow="What changed this week behind the scenes">
              {has && (
                <HighlightableContent html={d.operationalUpdates}
                  report={report} fieldKey="operationalUpdates"
                  highlighterActive={highlighterOn}
                  highlightColor={hlColor} highlightIntensity={hlIntensity}
                  style={{ fontSize: 14, lineHeight: 1.65, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent="#6366f1" />
            </ContentSection>
          );
        })()}

        {(() => {
          const links = findByName('Recommendations & Action Items')
            || findByName('Recommendations');
          const has = d.recommendations && d.recommendations.trim();
          if (!has && !links) return null;
          return (
            <ContentSection icon="💡" color={C.amber}
              title="Recommendations"
              eyebrow="Where to focus next">
              {has && (
                <HighlightableContent html={d.recommendations}
                  report={report} fieldKey="recommendations"
                  highlighterActive={highlighterOn}
                  highlightColor={hlColor} highlightIntensity={hlIntensity}
                  className="report-priorities"
                  style={{ fontSize: 14, lineHeight: 1.65, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent={C.amber} />
            </ContentSection>
          );
        })()}

        {(() => {
          // Action Items — separate from Recommendations. v1 keeps these
          // distinct so the "do this" list reads cleanly below the
          // narrative. Brand-link section called "Action Items" embeds
          // here when present.
          const links = findByName('Action Items');
          const has = d.actionItems && d.actionItems.trim();
          if (!has && !links) return null;
          return (
            <ContentSection icon="✅" color={C.green}
              title="Action Items"
              eyebrow="Concrete next steps">
              {has && (
                <HighlightableContent html={d.actionItems}
                  report={report} fieldKey="actionItems"
                  highlighterActive={highlighterOn}
                  highlightColor={hlColor} highlightIntensity={hlIntensity}
                  className="report-priorities"
                  style={{ fontSize: 14, lineHeight: 1.65, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent={C.green} />
            </ContentSection>
          );
        })()}

        {/* ─── Custom Fields (with embedded matching brand links) ──────── */}
        {(() => {
          if (!d.customFields) return null;
          const entries = Object.entries(d.customFields);

          // Group entries that came from brand-defined table sections or
          // built-in section extras so they render as a single card with
          // label/value rows. Everything else (legacy user-level fields
          // and kind: 'long_text') keeps the previous one-card-per-entry
          // behavior.
          const groups = new Map(); // key -> { name, rows: [] }
          const passthrough = [];
          for (const [fid, entry] of entries) {
            if (entry && typeof entry === 'object' && entry.kind === 'table' && entry.sectionId) {
              const key = `tbl:${entry.sectionId}`;
              if (!groups.has(key)) groups.set(key, { name: entry.sectionName || 'Section', rows: [] });
              groups.get(key).rows.push({ fid, label: entry.name || '—', value: entry.value, type: entry.type || 'text' });
            } else if (entry && typeof entry === 'object' && entry.kind === 'builtin_extra' && entry.sectionKey) {
              // Built-in extras render inline within their parent
              // section in the new WeeklyReportView. The legacy view
              // doesn't have that hero-grid layout, so fall through to
              // a generic label/value card here.
              const key = `bx:${entry.sectionKey}`;
              if (!groups.has(key)) groups.set(key, { name: `${entry.sectionTitle || entry.sectionKey} — Additional fields`, rows: [] });
              groups.get(key).rows.push({ fid, label: entry.name || '—', value: entry.value, type: entry.type || 'text' });
            } else {
              passthrough.push([fid, entry]);
            }
          }

          const curSym = report?.currencySymbol || report?.currency || '';
          const renderedGroups = [...groups.entries()].map(([gkey, group]) => {
            const nonEmpty = group.rows.filter((r) => r.value !== '' && r.value != null);
            if (nonEmpty.length === 0) return null;
            return (
              <ContentSection key={gkey} icon="🧮" color="#0ea5e9" title={group.name}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 30%) 1fr', rowGap: 6, columnGap: 16 }}>
                  {nonEmpty.map((r) => {
                    let display;
                    if (r.type === 'url' && r.value) {
                      display = <a href={String(r.value)} target="_blank" rel="noopener noreferrer">{String(r.value)}</a>;
                    } else if (r.type === 'currency') {
                      const n = Number(r.value);
                      display = Number.isFinite(n) ? `${curSym}${n.toLocaleString()}` : String(r.value);
                    } else {
                      display = String(r.value);
                    }
                    return (
                      <Fragment key={r.fid}>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{r.label}</div>
                        <div style={{ fontSize: 14, color: C.ink, wordBreak: 'break-word' }}>{display}</div>
                      </Fragment>
                    );
                  })}
                </div>
              </ContentSection>
            );
          });

          const renderedCustom = passthrough.map(([fid, entry]) => {
            const name  = typeof entry === 'object' ? (entry?.name || 'Custom Field') : 'Custom Field';
            const value = typeof entry === 'object' ? entry?.value : entry;
            const isEmpty = !value || (typeof value === 'string' && !String(value).replace(/<[^>]+>/g, '').trim());
            const links = findByName(name);
            if (isEmpty && !links) return null;
            return (
              <ContentSection key={fid} icon="🧩" color="#8b5cf6" title={name}>
                {!isEmpty && (
                  <HighlightableContent html={value}
                    report={report} fieldKey={`customField_${fid}`}
                    highlighterActive={highlighterOn}
                    highlightColor={hlColor} highlightIntensity={hlIntensity}
                    style={{ fontSize: 14, lineHeight: 1.65, color: C.ink }} />
                )}
                <EmbeddedLinks section={links} accent="#8b5cf6" />
              </ContentSection>
            );
          });

          return <>{renderedGroups}{renderedCustom}</>;
        })()}

        {/* Brand resource sections that didn't match anything → standalone cards. */}
        <UnmatchedReportLinkSections sections={unmatchedLinkSections} />

        {/* Reject popover */}
        {rejectOpen && (
          <div className="wx-card" style={{ padding: 14, border: '1px solid var(--danger)', marginTop: 14 }}>
            <div style={{ fontWeight: 700, color: 'var(--danger)', marginBottom: 6 }}>Send back for revision</div>
            <textarea className="wx-input" rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)}
                      placeholder="Reason (required)…" />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="wx-btn wx-btn-ghost" onClick={() => { setRejectOpen(false); setRejectNote(''); }}>Cancel</button>
              <button className="wx-btn wx-btn-primary" onClick={handleReject} disabled={saving}>
                {saving ? <><span className="wx-spinner" /> Sending…</> : 'Send back'}
              </button>
            </div>
          </div>
        )}

        {/* Reopen popover */}
        {reopenOpen && (
          <div className="wx-card" style={{ padding: 14, border: '1px solid var(--accent)', marginTop: 14 }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 8 }}>Reopen approved report</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {[
                { v: 'verified',  label: 'Keep verified (I\'ll edit)' },
                { v: 'submitted', label: 'Send back to TL' },
                { v: 'draft',     label: 'Send back to APC' },
              ].map((o) => (
                <button key={o.v} type="button" onClick={() => setReopenTarget(o.v)}
                  className={`wx-role-chip ${reopenTarget === o.v ? 'wx-role-chip-active' : ''}`}>
                  {o.label}
                </button>
              ))}
            </div>
            {reopenTarget !== 'verified' && (
              <textarea className="wx-input" rows={3} value={reopenNote} onChange={(e) => setReopenNote(e.target.value)}
                        placeholder="Note (required)…" />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="wx-btn wx-btn-ghost" onClick={() => { setReopenOpen(false); setReopenNote(''); setReopenTarget('verified'); }}>Cancel</button>
              <button className="wx-btn wx-btn-primary" onClick={handleReopen} disabled={saving}>
                {saving ? <><span className="wx-spinner" /> Reopening…</> : 'Reopen'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Sticky action bar — verify/approve/reject/reopen lifecycle */}
      <div className="report-page-actions">
        <button className="wx-btn wx-btn-ghost" onClick={onBack} disabled={saving}>Close</button>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {perms.canEditContent && (
            <button className="wx-btn wx-btn-ghost" onClick={onEditDraft} disabled={saving}>
              <PencilIcon width="14" height="14" /> Edit draft
            </button>
          )}
          {perms.canReject && !rejectOpen && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setRejectOpen(true)} disabled={saving}>
              <XIcon width="14" height="14" /> Send back
            </button>
          )}
          {perms.canVerify && (
            <button className="wx-btn wx-btn-primary" onClick={handleVerify} disabled={saving}>
              <CheckIcon width="15" height="15" /> Verify
            </button>
          )}
          {perms.canApprove && (
            <button className="wx-btn wx-btn-primary" onClick={handleApprove} disabled={saving}>
              <CheckIcon width="15" height="15" /> Approve
            </button>
          )}
          {perms.canReopen && !reopenOpen && (
            <button className="wx-btn wx-btn-primary" onClick={() => setReopenOpen(true)} disabled={saving}>
              <RefreshIcon width="15" height="15" /> Reopen
            </button>
          )}
        </div>
      </div>

      {/* Edit-dates modal — Boss/OL only. */}
      {editDatesOpen && (
        <EditReportDatesModal
          report={report}
          onClose={() => setEditDatesOpen(false)}
          onSaved={(saved) => {
            setEditDatesOpen(false);
            onSaved?.(saved);
          }}
        />
      )}
    </div>
  );
}
