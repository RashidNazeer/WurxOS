import React, { useMemo, useRef } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, ComposedChart,
  ResponsiveContainer, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { num, pctChange } from '../../utils/reportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import RichContent, { isHtml } from '../common/RichContent';
import HighlightableContent from '../common/HighlightableContent';
import HighlighterPicker, { useHighlightStyle } from '../common/HighlighterPicker';
import BrandReportLinks, { EmbeddedLinks, useBrandReportLinks } from './BrandReportLinks';
import { useAuth } from '../../contexts/AuthContext';
import BrandSectionsPanel from '../portal/BrandSectionsPanel';

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

/* ─── Helpers ─────────────────────────────────────────────────────────── */
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

// Currency-aware money formatters. The second arg defaults to USD so older
// reports without a `currency` field keep showing '$'.
function fmt$(v, currency = DEFAULT_CURRENCY) {
  const sym = currencySymbol(currency);
  return sym + Number(num(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt$short(v, currency = DEFAULT_CURRENCY) {
  const n = num(v);
  const sym = currencySymbol(currency);
  if (n >= 1_000_000) return sym + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return sym + (n / 1_000).toFixed(1) + 'k';
  return sym + n.toFixed(0);
}
function fmtN(v) { return Number(num(v)).toLocaleString(); }
function fmtNshort(v) {
  const n = num(v);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
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

// Extracts a clean @handle from whatever the user typed into the Creator field.
// People sometimes paste the full TikTok URL there — we parse it out so the
// poster card still renders cleanly. Returns just the handle (no leading @).
function parseCreatorHandle(raw) {
  if (!raw) return '';
  const s = String(raw).trim().replace(/^@+/, '');
  if (/^https?:\/\//i.test(s) || /tiktok\.com/i.test(s)) {
    let m = s.match(/tiktok\.com\/@([a-zA-Z0-9._\-]+)/i);
    if (m) return m[1];
    m = s.match(/[/@]([a-zA-Z0-9._\-]+)\/video/i);
    if (m) return m[1];
    return ''; // unrecognised URL → empty so caller can fall back
  }
  return s;
}
function avatarColor(name) {
  // Stable hash → hue. Harmonized saturation/lightness for editorial feel.
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
  const fontSize = size === 'sm' ? '0.66rem' : '0.74rem';
  return (
    <span
      className="d-inline-flex align-items-center gap-1"
      style={{
        fontSize, fontWeight: 600,
        color: up ? C.green : C.red,
        background: up ? C.greenSoft : C.redSoft,
        padding: '2px 8px', borderRadius: 999, lineHeight: 1.2,
      }}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
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
    fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: primary ? '#a8a29e' : C.muted,
  };

  return (
    <div style={baseStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={{
        fontSize: '1.85rem', fontWeight: 700, lineHeight: 1.1, marginTop: 6,
        fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
      }}>{value}</div>
      {prevValue !== undefined && prevValue !== null && (
        <div style={{
          fontSize: '0.74rem', marginTop: 6,
          color: primary ? '#a8a29e' : C.inkDim,
        }}>
          Prev week <span style={{ fontWeight: 500 }}>{typeof prevValue === 'string' ? prevValue : ''}</span>
        </div>
      )}
      {pct !== null && (
        <div className="mt-2">
          <DeltaPill pct={pct} />
          {pct !== null && (
            <span style={{ fontSize: '0.66rem', color: primary ? '#a8a29e' : C.inkDim, marginLeft: 6 }}>
              {pct >= 0 ? '+' : ''}{(num(current) - num(prevValue)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
      )}
      {subText && (
        <div style={{ fontSize: '0.66rem', color: primary ? '#a8a29e' : C.muted, marginTop: 6 }}>{subText}</div>
      )}
      {sparkData && sparkData.length > 1 && (
        <Sparkline data={sparkData} color={primary ? C.amber : color} />
      )}
    </div>
  );
}

function SectionHead({ title, eyebrow, action }) {
  return (
    <div className="d-flex align-items-end justify-content-between mt-4 mb-3">
      <div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: C.ink, letterSpacing: '-0.01em' }}>{title}</div>
        {eyebrow && (
          <div style={{ fontSize: '0.74rem', color: C.muted, marginTop: 2 }}>{eyebrow}</div>
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
    <div className="d-flex align-items-center gap-3 px-3 py-3" style={{ borderTop: `1px solid ${C.line}` }}>
      <div style={{
        width: 22, height: 22, borderRadius: 5,
        background: rank === 1 ? '#fef3c7' : rank === 2 ? '#e2e8f0' : rank === 3 ? '#fde68a' : '#f1f5f9',
        color: C.ink, fontSize: '0.72rem', fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{rank}</div>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: avatarColor(creator.name), color: '#fff',
        fontSize: '0.7rem', fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{initials(creator.name)}</div>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.86rem', fontWeight: 600, color: C.ink }}>{creator.name}</div>
        {creator.notes && (
          <div style={{ fontSize: '0.7rem', color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{creator.notes}</div>
        )}
      </div>
      <div style={{ width: 60, textAlign: 'right', fontSize: '0.82rem', color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtN(creator.videosPosted)}</div>
      <div style={{ width: 70, textAlign: 'right', fontSize: '0.82rem', color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtN(creator.itemsSold)}</div>
      <div style={{ width: 110 }}>
        <div style={{ height: 6, background: C.line, borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, sharePct)}%`, background: C.amber, borderRadius: 999 }} />
        </div>
      </div>
      <div style={{ width: 90, textAlign: 'right', fontSize: '0.86rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt$short(gmv, currency)}</div>
    </div>
  );
}

function VideoPosterCard({ video, rank, currency = DEFAULT_CURRENCY }) {
  const gmv = num(video.gmv);
  // Prefer the Creator field; if it's blank/garbled (e.g. a URL pasted by mistake),
  // try to recover a handle from the videoLink.
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
      onMouseEnter={e => { if (linkOk) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(15,23,42,0.10)'; } }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
      title={linkOk ? 'Open TikTok video' : undefined}>
      {/* Poster (vertical 9:16-ish) */}
      <div style={{
        position: 'relative', aspectRatio: '9 / 14', background: posterGradient(rank * 17 + (handle.charCodeAt(0) || 0)),
        display: 'flex', alignItems: 'flex-end', padding: '10px',
      }}>
        {/* View count badge */}
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 999,
          fontSize: '0.7rem', fontWeight: 600, padding: '3px 9px',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <i className="bi bi-eye-fill" style={{ fontSize: '0.65rem' }} />
          {fmtNshort(video.views)}
        </div>
        {/* Rank */}
        <div style={{
          position: 'absolute', top: 10, right: 10,
          background: 'rgba(255,255,255,0.92)', color: C.ink, borderRadius: 4,
          fontSize: '0.7rem', fontWeight: 700, padding: '2px 7px', minWidth: 22, textAlign: 'center',
        }}>{rank}</div>
        {/* Big initials in middle */}
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.92)', fontSize: '2rem', fontWeight: 700, letterSpacing: '0.04em',
          textShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>{initials(handle)}</div>
        {/* Handle at bottom */}
        <div style={{
          position: 'relative', zIndex: 1, color: '#fff', fontSize: '0.78rem', fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        }}>@{handle}</div>
        {/* Play icon hint when link present */}
        {linkOk && (
          <div style={{
            position: 'absolute', right: 10, bottom: 10,
            width: 30, height: 30, borderRadius: '50%',
            background: 'rgba(255,255,255,0.95)', color: C.ink,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}>
            <i className="bi bi-play-fill" style={{ fontSize: '0.95rem', marginLeft: 1 }} />
          </div>
        )}
      </div>
      {/* Stats footer */}
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
          {fmt$(gmv, currency)}
        </div>
        <div className="d-flex align-items-center justify-content-between mt-1" style={{ fontSize: '0.7rem', color: C.muted }}>
          <span>Sold <strong style={{ color: C.ink }}>{fmtN(video.itemsSold)}</strong></span>
          <span>Clicks <strong style={{ color: C.ink }}>{video.productClicks || '—'}</strong></span>
        </div>
      </div>
    </Card>
  );
}

function ProductRow({ product, rank, gmvShare, isLast, currency = DEFAULT_CURRENCY }) {
  const gmv = num(product.gmv);
  return (
    <div className="d-flex align-items-center gap-3 px-3 py-3"
      style={{ borderTop: rank === 1 ? 'none' : `1px solid ${C.line}` }}>
      {/* Image placeholder */}
      <div style={{
        width: 44, height: 44, borderRadius: 6,
        background: C.surfaceAlt, border: `1px solid ${C.line}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        color: C.muted,
      }}>
        <i className="bi bi-box-seam" style={{ fontSize: '1.1rem' }} />
      </div>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: C.ink }}>{product.productName}</div>
        {product.productId && (
          <div style={{ fontSize: '0.66rem', color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
            ID&nbsp;{product.productId}
          </div>
        )}
        <div className="d-flex align-items-center gap-3 mt-1" style={{ fontSize: '0.7rem', color: C.inkDim }}>
          <span>Units <strong style={{ color: C.ink, fontWeight: 600 }}>{fmtN(product.unitsSold)}</strong></span>
          <span>New videos <strong style={{ color: C.ink, fontWeight: 600 }}>{fmtN(product.newVideos)}</strong></span>
          <span>Share of GMV <strong style={{ color: C.ink, fontWeight: 600 }}>{(gmvShare || 0).toFixed(1)}%</strong></span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt$short(gmv, currency)}</div>
        <div style={{ fontSize: '0.62rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>GMV</div>
      </div>
    </div>
  );
}

/* Modern long-form section wrapper — icon-circle header + clean card. */
function ContentSection({ icon, color = C.amber, title, eyebrow, children }) {
  return (
    <div className="mt-3" style={{
      background: C.surface,
      border: `1px solid ${C.line}`,
      borderRadius: 14,
      padding: '20px 22px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div className="d-flex align-items-center gap-3 mb-3">
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: color + '15', color,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <i className={`bi ${icon}`} style={{ fontSize: '1.05rem' }} />
        </div>
        <div>
          <div style={{ fontSize: '1.02rem', fontWeight: 700, color: C.ink, letterSpacing: '-0.01em', lineHeight: 1.2 }}>{title}</div>
          {eyebrow && <div style={{ fontSize: '0.7rem', color: C.muted, marginTop: 2 }}>{eyebrow}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/* Graphical comparison panel: this week vs last week, side-by-side bars per metric. */
function ComparisonRow({ label, current, previous, fmt }) {
  const max = Math.max(num(current), num(previous), 0.0001);
  const pct = pctChange(current, previous);
  return (
    <div className="d-flex flex-column gap-1" style={{ background: C.surfaceAlt, padding: '14px 16px', borderRadius: 10 }}>
      <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.7rem', fontWeight: 600, color: C.inkDim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <span>{label}</span>
        <DeltaPill pct={pct} />
      </div>
      <div className="d-flex align-items-center gap-2 mt-1">
        <span style={{ width: 64, fontSize: '0.64rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>This wk</span>
        <div style={{ flex: 1, height: 16, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(num(current) / max) * 100}%`, background: C.amber, transition: 'width 320ms ease' }} />
        </div>
        <span style={{ minWidth: 78, textAlign: 'right', fontSize: '0.78rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(current)}</span>
      </div>
      <div className="d-flex align-items-center gap-2">
        <span style={{ width: 64, fontSize: '0.64rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last wk</span>
        <div style={{ flex: 1, height: 16, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(num(previous) / max) * 100}%`, background: '#cbd5e1', transition: 'width 320ms ease' }} />
        </div>
        <span style={{ minWidth: 78, textAlign: 'right', fontSize: '0.78rem', color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt(previous)}</span>
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
    { label: 'ROI', current: current.roi, previous: previous.roi, fmt: v => num(v).toFixed(2) + '×' },
    { label: 'Videos Posted', current: current.videosPosted, previous: previous.videosPosted, fmt: fmtN },
    { label: 'Samples Approved', current: current.samplesApproved, previous: previous.samplesApproved, fmt: fmtN },
  ];
  return (
    <ContentSection
      icon="bi-bar-chart-line-fill"
      color={C.amber}
      title="Performance vs last week"
      eyebrow={prevLabel ? `Compared with ${prevLabel}` : 'This week vs last week'}
    >
      <div className="row g-3">
        {rows.map(r => (
          <div key={r.label} className="col-12 col-md-6">
            <ComparisonRow {...r} />
          </div>
        ))}
      </div>
    </ContentSection>
  );
}

/* Modern trend tooltip — rounded card, monochrome typography. */
function TrendTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10,
      padding: '8px 12px', boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
      fontSize: '0.74rem',
    }}>
      <div style={{ fontWeight: 700, color: C.ink, marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} className="d-flex align-items-center gap-2" style={{ color: C.inkDim }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={{ flex: 1 }}>{p.name}</span>
          <strong style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{p.formatter ? p.formatter(p.value) : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

/* Modern Trends panel: GMV + Orders combo, ROI line, Videos bar — all with
   visible week labels on the x-axis. Only renders when there are ≥2 weeks. */
function TrendsPanel({ trendData, currency = DEFAULT_CURRENCY }) {
  const moneyFmt = (v) => fmt$short(v, currency);
  if (!trendData || trendData.length < 2) return null;
  const firstWeek = trendData[0].week;
  const lastWeek = trendData[trendData.length - 1].week;
  const eyebrow = `${trendData.length} reporting weeks · ${firstWeek} → ${lastWeek}`;

  return (
    <ContentSection
      icon="bi-graph-up-arrow"
      color={C.amber}
      title="Trends over time"
      eyebrow={eyebrow}>
      {/* GMV + Orders dual-axis combo */}
      <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: '14px 14px 8px' }}>
        <div className="d-flex align-items-center justify-content-between mb-2">
          <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>GMV & Orders</div>
          <div className="d-flex gap-3" style={{ fontSize: '0.7rem', color: C.inkDim }}>
            <span className="d-inline-flex align-items-center gap-1"><span style={{ width: 10, height: 10, background: C.amber, borderRadius: 2 }} />GMV</span>
            <span className="d-inline-flex align-items-center gap-1"><span style={{ width: 10, height: 10, background: C.green, borderRadius: 2 }} />Orders</span>
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
      <div className="row g-3 mt-1">
        <div className="col-12 col-md-6">
          <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: '14px' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>ROI</div>
              <div style={{ fontSize: '0.7rem', color: C.inkDim }}>Return on ad spend</div>
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
        </div>
        <div className="col-12 col-md-6">
          <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: '14px' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>Videos posted</div>
              <div style={{ fontSize: '0.7rem', color: C.inkDim }}>Per week</div>
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
      </div>
    </ContentSection>
  );
}

function InsightBox({ text, report, fieldKey, highlighterActive, highlightColor, highlightIntensity }) {
  if (!text) return null;
  return (
    <div className="mt-3 mb-4 rounded-3" style={{
      background: '#fffbeb', border: `1px solid ${C.amberLine}`, padding: '14px 16px',
    }}>
      <div className="d-flex align-items-start gap-2">
        <i className="bi bi-lightbulb-fill" style={{ color: C.amber, fontSize: '0.95rem', marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          {report && fieldKey ? (
            <HighlightableContent html={text} report={report} fieldKey={fieldKey}
              highlighterActive={highlighterActive}
              highlightColor={highlightColor} highlightIntensity={highlightIntensity}
              className="insight-rich"
              style={{ fontSize: '0.8rem', color: '#7c4c00', lineHeight: 1.55 }} />
          ) : (
            <RichContent html={text} className="insight-rich"
              style={{ fontSize: '0.8rem', color: '#7c4c00', lineHeight: 1.55 }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main view ───────────────────────────────────────────────────────── */
export default function WeeklyReportView({ report, previousReport, allReports, clientView = false }) {
  const printRef = useRef();
  const { profile } = useAuth();
  const userRole = profile?.role || '';
  const [copyState, setCopyState] = React.useState('idle');
  const [highlighterActive, setHighlighterActive] = React.useState(false);
  const { color: highlightColor, setColor: setHighlightColor,
          intensity: highlightIntensity, setIntensity: setHighlightIntensity } = useHighlightStyle();

  // Brand-level Report Links (auto-embed when name matches a section).
  const { findByName: findReportLinks } = useBrandReportLinks(report?.brandId);

  // Last 8 weeks of metrics for sparklines and the Trends panel.
  const trendData = useMemo(() => {
    if (!allReports || !report) return [];
    return [...allReports]
      .filter(r => r.brandId === report.brandId)
      .sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || ''))
      .slice(-8)
      .map(r => {
        const p = r.overallPerformance || {};
        const off = r.offsitePerformance || {};
        // weekLabel is usually like "Week 14 (Apr 5 - 11)" — strip the
        // "Week N " prefix so the chart label is concise: "(Apr 5 - 11)".
        const week = (r.weekLabel || r.weekStart || '').replace(/Week\s*\d+\s*/, '').trim();
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

  const sparkFor = (key) => trendData.map(d => ({ v: d[key] }));

  if (!report) return null;

  const currency = report.currency || DEFAULT_CURRENCY;
  // Local closures so inline JSX stays readable
  const m  = (v) => fmt$(v, currency);
  const ms = (v) => fmt$short(v, currency);

  const prev = previousReport || {};
  const perf = report.overallPerformance || {};
  const prevPerf = prev.overallPerformance || {};
  const hasPrev = !!previousReport;
  const notes = report.overallNotes || {};
  const offsite = report.offsitePerformance || {};
  const prevOffsite = prev.offsitePerformance || {};

  const productData = (report.productHighlights || []).filter(p => p.productName);
  const totalProductGmv = productData.reduce((s, p) => s + num(p.gmv), 0);
  const totalCreatorGmv = (report.topCreators || [])
    .filter(c => c.name).reduce((s, c) => s + num(c.gmv), 0);
  const sortedCreators = [...(report.topCreators || [])].filter(c => c.name).sort((a, b) => num(b.gmv) - num(a.gmv));
  const sortedVideos = [...(report.topVideos || [])].filter(v => v.creatorName).sort((a, b) => num(b.gmv) - num(a.gmv));
  const sortedProducts = [...productData].sort((a, b) => num(b.gmv) - num(a.gmv));

  const handleCopyInsights = async () => {
    const insightFields = [
      report.overallInsights, report.topCreatorsInsights, report.topVideosInsights,
      report.gmvMaxInsights, report.productHighlightsInsights, report.offsiteInsights,
    ];
    const insightParts = insightFields.map(v => htmlToPlainText((v || '').toString()).trim()).filter(Boolean);
    const titled = [];
    const push = (heading, value) => {
      const t = htmlToPlainText((value || '').toString()).trim();
      if (t) titled.push(`${heading}\n${t}`);
    };
    push('Current & Upcoming Campaigns', report.upcomingCampaigns);
    push('Operational Updates', report.operationalUpdates);
    const rec = [report.recommendations, report.actionItems]
      .map(v => htmlToPlainText((v || '').toString()).trim()).filter(Boolean).join('\n\n');
    if (rec) titled.push(`Recommendations & Action Items\n${rec}`);
    if (report.customFields) {
      Object.values(report.customFields).forEach(entry => {
        const name = typeof entry === 'object' ? (entry?.name || 'Custom Field') : 'Custom Field';
        const val = typeof entry === 'object' ? entry?.value : entry;
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
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      setCopyState('done'); setTimeout(() => setCopyState('idle'), 1800);
    }
  };

  const handleExport = () => {
    const el = printRef.current;
    if (!el) return;
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><title>${report.brandName} - ${report.weekLabel}</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #0f172a; font-size: 13px; }
        .rich-content p { margin: 0 0 0.5rem 0; }
        .rich-content ul, .rich-content ol { padding-left: 1.4rem; margin: 0.25rem 0 0.6rem; }
        .rich-content li { margin: 0.15rem 0; }
        .rich-content a { color: #2563eb; text-decoration: underline; }
        .rich-content strong, .rich-content b { font-weight: 700; }
        .rich-content em, .rich-content i { font-style: italic; }
        .no-print { display: none !important; }
        @media print { body { padding: 16px; } .no-print { display: none !important; } }
      </style></head><body>`);
    win.document.write(el.innerHTML);
    win.document.write('</body></html>');
    win.document.close();
    setTimeout(() => { win.print(); }, 500);
  };

  return (
    <div>
      {/* ─── Action bar (above the canvas) — hidden in clientView ─────────── */}
      {!clientView && (
        <div className="d-flex justify-content-end gap-2 mb-3 flex-wrap">
          {highlighterActive && (
            <HighlighterPicker
              color={highlightColor} onColorChange={setHighlightColor}
              intensity={highlightIntensity} onIntensityChange={setHighlightIntensity}
            />
          )}
          <button
            type="button"
            onClick={() => setHighlighterActive(v => !v)}
            className={`btn btn-sm d-inline-flex align-items-center gap-2 ${highlighterActive ? 'btn-warning' : 'btn-outline-warning'}`}
            style={{ borderRadius: 10, fontSize: '0.78rem' }}
            title={highlighterActive
              ? 'Highlighter is ON — drag across text to highlight, drag across an existing highlight to remove it. Click to turn off.'
              : 'Turn on highlighter — then drag across any text to highlight it for everyone viewing this report.'}>
            <i className="bi bi-highlighter" />
            {highlighterActive ? 'Highlighter ON · click to stop' : 'Highlighter'}
          </button>
          {userRole === 'tl' && (
            <button className="btn btn-sm d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 10, fontSize: '0.78rem',
                background: copyState === 'done' ? C.green : C.ink,
                color: 'white', border: 'none' }}
              onClick={handleCopyInsights}
              title="Copy all insights to clipboard">
              <i className={`bi ${copyState === 'done' ? 'bi-check-circle-fill' : 'bi-clipboard-check'}`} />
              {copyState === 'done' ? 'Copied!' : 'Copy All Insights'}
            </button>
          )}
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 10, fontSize: '0.78rem', background: C.ink, color: '#fff', border: 'none' }}
            onClick={handleExport}>
            <i className="bi bi-file-earmark-pdf" /> Export PDF
          </button>
        </div>
      )}

      {/* ─── Canvas (printable) ─────────────────────────────────────────── */}
      <div ref={printRef} className="report-canvas" style={{ background: C.surfaceAlt, padding: '24px', borderRadius: 18, border: `1px solid ${C.line}` }}>

        {/* Brand chip + breadcrumb */}
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
          <div className="d-flex align-items-center gap-3">
            <div style={{
              width: 42, height: 42, borderRadius: 10, background: C.amber,
              color: '#fff', fontSize: '1.05rem', fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>{(report.brandName || '?').charAt(0).toUpperCase()}</div>
            <div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: C.ink, lineHeight: 1.1 }}>{report.brandName || 'Brand'}</div>
              <div style={{ fontSize: '0.66rem', color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>Weekly Report</div>
            </div>
          </div>
          <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.82rem', color: C.inkDim }}>
            <span style={{ color: C.muted }}>Affiliate</span>
            <span style={{ color: C.muted }}>/</span>
            <span style={{ color: C.muted }}>Weekly</span>
            <span style={{ color: C.muted }}>/</span>
            <span style={{ fontWeight: 700, color: C.ink }}>{report.weekLabel}</span>
          </div>
        </div>

        {hasPrev && (
          <div style={{ fontSize: '0.72rem', color: C.muted, marginBottom: 18 }}>
            Compared with <strong style={{ color: C.inkDim }}>{prev.weekLabel}</strong>
          </div>
        )}

        {/* ─── Hero stat grid (4 + 4) ──────────────────────────────────── */}
        <div className="row g-3 mb-3">
          <div className="col-6 col-lg-3">
            <StatCard label="GMV (Gross Merchandise Value)" value={m(perf.gmv)}
              current={num(perf.gmv)} prevValue={hasPrev ? m(prevPerf.gmv) : null}
              primary sparkData={sparkFor('gmv')} />
          </div>
          <div className="col-6 col-lg-3">
            <StatCard label="Affiliate GMV" value={m(perf.affiliateGmv)}
              current={num(perf.affiliateGmv)} prevValue={hasPrev ? m(prevPerf.affiliateGmv) : null}
              sparkData={sparkFor('affiliateGmv')} />
          </div>
          <div className="col-6 col-lg-3">
            <StatCard label="Orders" value={fmtN(perf.orders)}
              current={num(perf.orders)} prevValue={hasPrev ? fmtN(prevPerf.orders) : null}
              sparkData={sparkFor('orders')} />
          </div>
          <div className="col-6 col-lg-3">
            <StatCard label="ROI" value={num(perf.roi).toFixed(2) + '×'}
              current={num(perf.roi)} prevValue={hasPrev ? num(prevPerf.roi).toFixed(2) + '×' : null}
              color={C.green} sparkData={sparkFor('roi')} />
          </div>
        </div>
        <div className="row g-3 mb-4">
          <div className="col-6 col-lg-3">
            <StatCard label="Samples Approved" value={fmtN(perf.samplesApproved)}
              current={num(perf.samplesApproved)} prevValue={hasPrev ? fmtN(prevPerf.samplesApproved) : null}
              subText={notes.samplesApproved ? `MTD: ${fmtN(notes.samplesApproved)}` : ''}
              sparkData={sparkFor('samplesApproved')} />
          </div>
          <div className="col-6 col-lg-3">
            <StatCard label="Shop Performance Score" value={num(perf.shopPerformanceScore).toFixed(1) + ' /5'}
              current={num(perf.shopPerformanceScore)} prevValue={hasPrev ? num(prevPerf.shopPerformanceScore).toFixed(1) + ' /5' : null}
              sparkData={sparkFor('shopPerformanceScore')} />
          </div>
          <div className="col-6 col-lg-3">
            <StatCard label="Videos Posted" value={fmtN(perf.videosPosted)}
              current={num(perf.videosPosted)} prevValue={hasPrev ? fmtN(prevPerf.videosPosted) : null}
              subText={notes.videosPosted ? `Total: ${fmtN(notes.videosPosted)}` : ''}
              sparkData={sparkFor('videosPosted')} />
          </div>
          <div className="col-6 col-lg-3">
            <StatCard label="Offsite Effect" value={num(offsite.offsiteEffect).toFixed(2) + '%'}
              current={num(offsite.offsiteEffect)} prevValue={hasPrev ? num(prevOffsite.offsiteEffect).toFixed(2) + '%' : null}
              subText={offsite.offsiteGmv ? `Off-site GMV ${ms(offsite.offsiteGmv)} · Shop ${ms(offsite.tiktokShopGmv)}` : ''}
              sparkData={sparkFor('offsiteEffect')} />
          </div>
        </div>

        <InsightBox text={report.overallInsights} report={report} fieldKey="overallInsights"
          highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />

        {/* ─── Graphical comparison: this week vs last week ────────────── */}
        {hasPrev && (
          <ComparisonPanel current={perf} previous={prevPerf} prevLabel={prev.weekLabel} currency={currency} />
        )}

        {/* ─── Top Creators + Products row ─────────────────────────────── */}
        {(sortedCreators.length > 0 || sortedProducts.length > 0) && (
          <div className="row g-3">
            {/* Creators */}
            {sortedCreators.length > 0 && (
              <div className="col-12 col-lg-7">
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
                  <div className="px-3 py-3">
                    <SectionHead
                      title="Top creators this week"
                      eyebrow={`Ranked by GMV · ${sortedCreators.length} creators with data`}
                    />
                  </div>
                  {sortedCreators.map((c, i) => (
                    <CreatorRow key={i} creator={c} rank={i + 1} totalGmv={totalCreatorGmv} currency={currency} />
                  ))}
                </div>
                <InsightBox text={report.topCreatorsInsights} report={report} fieldKey="topCreatorsInsights"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />
              </div>
            )}
            {/* Products */}
            {sortedProducts.length > 0 && (
              <div className="col-12 col-lg-5">
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
                  <div className="px-3 py-3">
                    <SectionHead
                      title="Products driving GMV"
                      eyebrow={`Focus SKUs · units & content output`}
                    />
                  </div>
                  {sortedProducts.map((p, i) => (
                    <ProductRow key={i} product={p} rank={i + 1}
                      gmvShare={totalProductGmv > 0 ? (num(p.gmv) / totalProductGmv) * 100 : 0}
                      currency={currency} />
                  ))}
                </div>
                <InsightBox text={report.productHighlightsInsights} report={report} fieldKey="productHighlightsInsights"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />
              </div>
            )}
          </div>
        )}

        {/* ─── Top Videos (poster cards) ───────────────────────────────── */}
        {sortedVideos.length > 0 && (
          <>
            <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: '18px 18px 20px', marginTop: 12 }}>
              <SectionHead
                title="Top videos"
                eyebrow="Best performers by GMV this week · click any card to open the TikTok video"
              />
              <div className="row g-3">
                {sortedVideos.slice(0, 5).map((v, i) => (
                  <div key={i} className="col-6 col-md-4 col-lg-3 col-xl">
                    <VideoPosterCard video={v} rank={i + 1} currency={currency} />
                  </div>
                ))}
              </div>
            </div>
            <InsightBox text={report.topVideosInsights} report={report} fieldKey="topVideosInsights"
              highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />
          </>
        )}

        {/* ─── GMV Max + Offsite (side-by-side) ────────────────────────── */}
        {((report.gmvMax || []).some(g => g.campaign) || num(offsite.offsiteGmv) > 0 || num(offsite.tiktokShopGmv) > 0) && (
          <div className="row g-3 mt-1">
            {(report.gmvMax || []).some(g => g.campaign) && (
              <div className="col-12 col-lg-7">
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: '18px' }}>
                  <SectionHead title="GMV Max performance" eyebrow="Brand-managed campaigns · overall stats" />
                  {(report.gmvMax || []).filter(g => g.campaign).map((g, i) => {
                    const cells = [
                      { label: 'Spend', value: ms(g.spend) },
                      { label: 'GMV', value: ms(g.gmv) },
                      { label: 'ROI', value: num(g.roi).toFixed(2) + '×', accent: num(g.roi) >= 1 ? C.green : C.red },
                      { label: 'Orders', value: fmtN(g.orders) },
                      { label: 'CPO', value: m(g.cpo) },
                    ];
                    const spend = num(g.spend), gmv = num(g.gmv);
                    const ratio = spend > 0 && gmv > 0 ? Math.min(1, spend / gmv) : 0;
                    return (
                      <div key={i} className={i > 0 ? 'mt-3 pt-3' : ''} style={{ borderTop: i > 0 ? `1px solid ${C.line}` : 'none' }}>
                        <div className="d-flex flex-wrap align-items-center justify-content-between mb-2">
                          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: C.ink }}>{g.campaign}</div>
                        </div>
                        <div className="row g-2">
                          {cells.map(c => (
                            <div className="col-4 col-md" key={c.label}>
                              <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                                <div style={{ fontSize: '0.6rem', color: C.muted, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</div>
                                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: c.accent || C.ink, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{c.value}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                        {/* Spend efficiency bar */}
                        {spend > 0 && gmv > 0 && (
                          <div className="mt-3">
                            <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.66rem', color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                              <span>Spend efficiency</span>
                              <span>$1 → ${(gmv / spend).toFixed(2)}</span>
                            </div>
                            <div className="d-flex" style={{ height: 14, borderRadius: 999, overflow: 'hidden' }}>
                              <div style={{ background: C.ink, color: '#fff', fontSize: '0.66rem', fontWeight: 600, width: `${Math.max(15, ratio * 100)}%`, padding: '0 10px', display: 'flex', alignItems: 'center' }}>
                                {ms(spend)} in
                              </div>
                              <div style={{ flex: 1, background: C.amber, color: C.hero, fontSize: '0.66rem', fontWeight: 700, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                                {ms(gmv)} returned →
                              </div>
                            </div>
                          </div>
                        )}
                        {g.notes && (
                          <div className="mt-2" style={{ fontSize: '0.72rem', color: C.muted }}>{g.notes}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <InsightBox text={report.gmvMaxInsights} report={report} fieldKey="gmvMaxInsights"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />
              </div>
            )}
            {(num(offsite.offsiteGmv) > 0 || num(offsite.tiktokShopGmv) > 0) && (
              <div className="col-12 col-lg-5">
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: '18px' }}>
                  <SectionHead title="Offsite performance" eyebrow="Halo from non-TikTok channels" />
                  <div className="d-flex align-items-center gap-3 mb-3">
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
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 700, color: C.ink, lineHeight: 1 }}>{num(offsite.offsiteEffect).toFixed(2)}%</div>
                        <div style={{ fontSize: '0.55rem', color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>Effect</div>
                      </div>
                    </div>
                    <div className="flex-grow-1 d-flex flex-column gap-2">
                      <div className="d-flex justify-content-between align-items-center" style={{ background: C.surfaceAlt, padding: '10px 14px', borderRadius: 10 }}>
                        <span style={{ fontSize: '0.78rem', color: C.inkDim }}>Offsite GMV</span>
                        <span style={{ fontSize: '0.92rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{ms(offsite.offsiteGmv)}</span>
                      </div>
                      <div className="d-flex justify-content-between align-items-center" style={{ background: C.surfaceAlt, padding: '10px 14px', borderRadius: 10 }}>
                        <span style={{ fontSize: '0.78rem', color: C.inkDim }}>TikTok Shop GMV</span>
                        <span style={{ fontSize: '0.92rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{ms(offsite.tiktokShopGmv)}</span>
                      </div>
                      <div className="d-flex justify-content-between align-items-center" style={{ background: C.hero, padding: '10px 14px', borderRadius: 10 }}>
                        <span style={{ fontSize: '0.78rem', color: '#a8a29e' }}>Combined reach</span>
                        <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{ms(num(offsite.offsiteGmv) + num(offsite.tiktokShopGmv))}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <InsightBox text={report.offsiteInsights} report={report} fieldKey="offsiteInsights"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />
              </div>
            )}
          </div>
        )}

        {/* ─── Trends across reporting weeks ──────────────────────────── */}
        <TrendsPanel trendData={trendData} currency={currency} />

        {/* ─── Long-form rich-text sections (modernized) ───────────────── */}
        {(() => {
          const links = findReportLinks('Current & Upcoming Campaigns');
          const hasContent = report.upcomingCampaigns && report.upcomingCampaigns.trim();
          if (!hasContent && !links) return null;
          return (
            <ContentSection
              icon="bi-megaphone-fill"
              color="#ec4899"
              title="Current & Upcoming Campaigns"
              eyebrow="Active and planned promotional activities">
              {hasContent && (
                <HighlightableContent html={report.upcomingCampaigns} report={report} fieldKey="upcomingCampaigns"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                  style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent="#ec4899" />
            </ContentSection>
          );
        })()}

        {(() => {
          const links = findReportLinks('Operational Updates');
          const hasContent = report.operationalUpdates && report.operationalUpdates.trim();
          if (!hasContent && !links) return null;
          return (
            <ContentSection
              icon="bi-gear-fill"
              color="#6366f1"
              title="Operational Updates"
              eyebrow="What changed this week behind the scenes">
              {hasContent && (
                <HighlightableContent html={report.operationalUpdates} report={report} fieldKey="operationalUpdates"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                  style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent="#6366f1" />
            </ContentSection>
          );
        })()}

        {(() => {
          const links = findReportLinks('Recommendations & Action Items');
          const hasRec = report.recommendations && report.recommendations.trim();
          const hasAction = report.actionItems && report.actionItems.trim();
          if (!hasRec && !hasAction && !links) return null;
          return (
            <ContentSection
              icon="bi-lightbulb-fill"
              color={C.amber}
              title="Recommendations & Action Items"
              eyebrow="Where to focus next">
              {hasRec && (
                <HighlightableContent html={report.recommendations} report={report} fieldKey="recommendations"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                  className="report-priorities"
                  style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
              )}
              {hasAction && (
                <div className={hasRec ? 'mt-2' : ''}>
                  <HighlightableContent html={report.actionItems} report={report} fieldKey="actionItems"
                    highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                    className="report-priorities"
                    style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
                </div>
              )}
              <EmbeddedLinks section={links} accent={C.amber} />
            </ContentSection>
          );
        })()}

        {/* ─── Custom Fields (with embedded matching brand links) ──────── */}
        {(() => {
          const customEntries = Object.entries(report.customFields || {});
          const customNames = [];
          const renderedCustom = customEntries.map(([fieldId, entry]) => {
            const name = typeof entry === 'object' ? entry?.name : 'Custom Field';
            const value = typeof entry === 'object' ? entry?.value : entry;
            const isEmpty = !value || (typeof value === 'string' && !value.trim()) || (isHtml(value) && !value.replace(/<[^>]+>/g, '').trim());
            const links = findReportLinks(name);
            if (name) customNames.push(name);
            if (isEmpty && !links) return null;
            return (
              <ContentSection key={fieldId}
                icon="bi-sliders"
                color="#8b5cf6"
                title={name || 'Custom Field'}>
                {!isEmpty && (
                  <HighlightableContent html={value} report={report} fieldKey={`customField_${fieldId}`}
                    highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                    style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
                )}
                <EmbeddedLinks section={links} accent="#8b5cf6" />
              </ContentSection>
            );
          });

          // Brand resource sections that didn't match anything → standalone cards.
          const unmatchedKnown = [
            'Current & Upcoming Campaigns',
            'Operational Updates',
            'Recommendations & Action Items',
            ...customNames,
          ];
          return (
            <>
              {renderedCustom}
              <BrandReportLinks brandId={report.brandId} knownSectionNames={unmatchedKnown} />
            </>
          );
        })()}
      </div>

      {/* Client custom sections — read-only for app users (clients edit
          theirs via the public portal). In clientView mode the portal
          mounts its own writable panel, so we skip it here. */}
      {!clientView && (
        <BrandSectionsPanel
          brandId={report.brandId}
          brandName={report.brandName}
          reportId={report.id}
          readOnly
          selfFetch
        />
      )}
    </div>
  );
}
