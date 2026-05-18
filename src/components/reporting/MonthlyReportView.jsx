import React, { useMemo, useRef } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, ComposedChart,
  ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { num, pctChange, resolveSectionsEnabled } from '../../utils/monthlyReportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';
import RichContent, { isHtml } from '../common/RichContent';
import HighlightableContent from '../common/HighlightableContent';
import HighlighterPicker, { useHighlightStyle } from '../common/HighlighterPicker';
import BrandReportLinks, { EmbeddedLinks, useBrandReportLinks } from './BrandReportLinks';
import { useAuth } from '../../contexts/AuthContext';
import BrandSectionsPanel from '../portal/BrandSectionsPanel';
import { exportReportToPdf } from '../../utils/exportReportPdf';

/* ─── Editorial palette ───────────────────────────────────────────────────
 *   Same theme-aware structure as WeeklyReportView. Hero stays as a
 *   dark warm slab in both modes (it's deliberately inverted).
 * ─────────────────────────────────────────────────────────────────────── */
const C = {
  ink:        'var(--text-primary)',
  inkDim:     'var(--text-secondary)',
  muted:      'var(--text-muted)',
  line:       'var(--border-subtle)',
  surface:    'var(--surface-1)',
  surfaceAlt: 'var(--surface-2)',
  hero:       '#1f1208',
  amber:      'var(--warning)',
  amberSoft:  'var(--warning-soft)',
  amberLine:  'color-mix(in srgb, var(--warning) 50%, transparent)',
  green:      'var(--success)',
  greenSoft:  'var(--success-soft)',
  red:        'var(--danger)',
  redSoft:    'var(--danger-soft)',
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
function fmtN(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!isFinite(n)) return String(v); // tolerate "8.20M" style strings
  return n.toLocaleString();
}
function fmtNshort(v) {
  const n = num(v);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtRaw(v) {
  if (v == null || v === '') return '—';
  return String(v);
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
    ['#5b3a1f', '#1a0f06'],
    ['#5b2d8b', '#1d0c30'],
    ['#0f5e4a', '#062018'],
    ['#7a3d18', '#231308'],
    ['#7a1d3f', '#240a16'],
    ['#1d3e5b', '#0a1620'],
    ['#5c4a16', '#1c1605'],
  ];
  const idx = Math.abs(seed | 0) % palette.length;
  const [a, b] = palette[idx];
  return `linear-gradient(160deg, ${a} 0%, ${b} 100%)`;
}
// "March 2026" → "Mar '26" — used as compact x-axis tick on trend charts.
function shortMonthLabel(monthLabel) {
  if (!monthLabel) return '';
  const m = String(monthLabel).match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return monthLabel;
  return `${m[1].slice(0, 3)} '${m[2].slice(2)}`;
}

/* ─── Atomic pieces ───────────────────────────────────────────────────── */
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
          Prev month <span style={{ fontWeight: 500 }}>{typeof prevValue === 'string' ? prevValue : ''}</span>
        </div>
      )}
      {pct !== null && (
        <div className="mt-2">
          <DeltaPill pct={pct} />
          <span style={{ fontSize: '0.66rem', color: primary ? '#a8a29e' : C.inkDim, marginLeft: 6 }}>
            {pct >= 0 ? '+' : ''}{(num(current) - num(prevValue)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
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
    <div className="d-flex align-items-end justify-content-between mt-1 mb-3">
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

function CreatorRow({ creator, rank, totalGmv, currency = DEFAULT_CURRENCY }) {
  const gmv = num(creator.gmv);
  const sharePct = totalGmv > 0 ? (gmv / totalGmv) * 100 : 0;
  const handle = parseCreatorHandle(creator.username) || creator.username || '';
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
        background: avatarColor(handle), color: '#fff',
        fontSize: '0.7rem', fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{initials(handle)}</div>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.86rem', fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{handle}</div>
        <div style={{ fontSize: '0.7rem', color: C.muted }}>Share of top-creator GMV {sharePct.toFixed(1)}%</div>
      </div>
      <div style={{ width: 140 }}>
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
  const handle = parseCreatorHandle(video.videoLink) || (video.videoLink || 'creator');
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
      <div style={{
        position: 'relative', aspectRatio: '9 / 14',
        background: posterGradient(rank * 17 + (handle.charCodeAt(0) || 0)),
        display: 'flex', alignItems: 'flex-end', padding: '10px',
      }}>
        <div style={{
          position: 'absolute', top: 10, right: 10,
          // Pill is fixed-white in both themes (video thumbnail
          // background), so the rank text stays dark in both themes.
          background: 'rgba(255,255,255,0.92)', color: '#0f172a', borderRadius: 4,
          fontSize: '0.7rem', fontWeight: 700, padding: '2px 7px', minWidth: 22, textAlign: 'center',
        }}>{rank}</div>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.92)', fontSize: '2rem', fontWeight: 700, letterSpacing: '0.04em',
          textShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>{initials(handle)}</div>
        <div style={{
          position: 'relative', zIndex: 1, color: '#fff', fontSize: '0.78rem', fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.6)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90%',
        }}>@{handle}</div>
        {linkOk && (
          <div style={{
            position: 'absolute', right: 10, bottom: 10,
            width: 30, height: 30, borderRadius: '50%',
            // Fixed-white play icon button — text stays dark in both themes.
            background: 'rgba(255,255,255,0.95)', color: '#0f172a',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}>
            <i className="bi bi-play-fill" style={{ fontSize: '0.95rem', marginLeft: 1 }} />
          </div>
        )}
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
          {fmt$(gmv, currency)}
        </div>
        <div className="mt-1" style={{ fontSize: '0.7rem', color: C.muted }}>
          GMV generated this month
        </div>
      </div>
    </Card>
  );
}

function ProductRow({ product, rank, gmvShare, currency = DEFAULT_CURRENCY }) {
  const gmv = num(product.gmv);
  return (
    <div className="d-flex align-items-center gap-3 px-3 py-3"
      style={{ borderTop: rank === 1 ? 'none' : `1px solid ${C.line}` }}>
      <div style={{
        width: 44, height: 44, borderRadius: 6,
        background: C.surfaceAlt, border: `1px solid ${C.line}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        color: C.muted,
      }}>
        <i className="bi bi-box-seam" style={{ fontSize: '1.1rem' }} />
      </div>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis' }}>{product.productName || '—'}</div>
        {product.productId && (
          <div style={{ fontSize: '0.66rem', color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
            ID&nbsp;{product.productId}
          </div>
        )}
        <div className="d-flex align-items-center gap-3 mt-1 flex-wrap" style={{ fontSize: '0.7rem', color: C.inkDim }}>
          <span>Units <strong style={{ color: C.ink, fontWeight: 600 }}>{fmtN(product.unitsSold)}</strong></span>
          <span>Samples <strong style={{ color: C.ink, fontWeight: 600 }}>{fmtN(product.samplesApproved)}</strong></span>
          <span>Share <strong style={{ color: C.ink, fontWeight: 600 }}>{(gmvShare || 0).toFixed(1)}%</strong></span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt$short(gmv, currency)}</div>
        <div style={{ fontSize: '0.62rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>GMV</div>
      </div>
    </div>
  );
}

/* GMV Breakdown donut (pure SVG, kept from prior view) ─────────────────── */
function DonutChart({ slices, total, currencySym = '$', size = 180, thickness = 28 }) {
  const filtered = (slices || []).filter((s) => Number(s.value) > 0);
  if (filtered.length === 0 || !Number(total)) {
    return <div className="text-muted small text-center py-3">No GMV data to chart.</div>;
  }
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2;
  const Circ = 2 * Math.PI * r;

  let acc = 0;
  return (
    <div className="d-flex align-items-center gap-3 flex-wrap" style={{ minHeight: size }}>
      <svg width={size} height={size} style={{ display: 'block', flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
        {filtered.map((s, i) => {
          const v = Number(s.value);
          const pct = v / total;
          const len = pct * Circ;
          const offset = -acc * Circ + Circ / 4;
          acc += pct;
          return (
            <circle
              key={i}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${Circ - len}`}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontSize: 11, fill: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total GMV</text>
        <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: 16, fill: C.ink, fontWeight: 700 }}>
          {currencySym}{Number(total).toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </text>
      </svg>
      <div className="flex-grow-1" style={{ minWidth: 200 }}>
        {filtered.map((s, i) => {
          const v = Number(s.value);
          const pct = (v / total) * 100;
          return (
            <div key={i} className="d-flex align-items-center gap-2 mb-2">
              <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
              <span style={{ fontSize: '0.78rem', color: C.ink, flex: 1 }}>{s.label}</span>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
                {currencySym}{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              <span style={{ fontSize: '0.7rem', color: C.muted, minWidth: 44, textAlign: 'right' }}>
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Comparison panel — this-month vs last-month side-by-side bars per metric. */
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
        <span style={{ width: 70, fontSize: '0.64rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>This mo</span>
        <div style={{ flex: 1, height: 16, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(num(current) / max) * 100}%`, background: C.amber, transition: 'width 320ms ease' }} />
        </div>
        <span style={{ minWidth: 88, textAlign: 'right', fontSize: '0.78rem', fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(current)}</span>
      </div>
      <div className="d-flex align-items-center gap-2">
        <span style={{ width: 70, fontSize: '0.64rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last mo</span>
        <div style={{ flex: 1, height: 16, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(num(previous) / max) * 100}%`, background: '#cbd5e1', transition: 'width 320ms ease' }} />
        </div>
        <span style={{ minWidth: 88, textAlign: 'right', fontSize: '0.78rem', color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt(previous)}</span>
      </div>
    </div>
  );
}

function ComparisonPanel({ report, prev, currency = DEFAULT_CURRENCY, prevLabel }) {
  const moneyFmt = (v) => fmt$short(v, currency);
  const numFmt = (v) => fmtN(v);
  const cur = {
    gmv: num(report.totalSales?.monthGmv) || num(report.keyMetrics?.gmv),
    affiliateGmv: num(report.gmvBreakdown?.affiliateGmv),
    organicGmv: num(report.gmvBreakdown?.organicGmv),
    videoGmv: num(report.gmvBreakdown?.videoGmv),
    totalOrders: num(report.kpis?.totalOrders) || num(report.keyMetrics?.orders),
    completedCollabs: num(report.kpis?.completedCollabs),
    samples: num(report.kpis?.freeSamplesApproved),
    newVideos: num(report.videoPerformance?.newVideosPosted),
  };
  const prv = {
    gmv: num(prev.totalSales?.monthGmv) || num(prev.keyMetrics?.gmv),
    affiliateGmv: num(prev.gmvBreakdown?.affiliateGmv),
    organicGmv: num(prev.gmvBreakdown?.organicGmv),
    videoGmv: num(prev.gmvBreakdown?.videoGmv),
    totalOrders: num(prev.kpis?.totalOrders) || num(prev.keyMetrics?.orders),
    completedCollabs: num(prev.kpis?.completedCollabs),
    samples: num(prev.kpis?.freeSamplesApproved),
    newVideos: num(prev.videoPerformance?.newVideosPosted),
  };
  const rows = [
    { label: 'GMV', current: cur.gmv, previous: prv.gmv, fmt: moneyFmt },
    { label: 'Affiliate GMV', current: cur.affiliateGmv, previous: prv.affiliateGmv, fmt: moneyFmt },
    { label: 'Organic GMV', current: cur.organicGmv, previous: prv.organicGmv, fmt: moneyFmt },
    { label: 'Video GMV', current: cur.videoGmv, previous: prv.videoGmv, fmt: moneyFmt },
    { label: 'Total Orders', current: cur.totalOrders, previous: prv.totalOrders, fmt: numFmt },
    { label: 'Completed Collabs', current: cur.completedCollabs, previous: prv.completedCollabs, fmt: numFmt },
    { label: 'Samples Approved', current: cur.samples, previous: prv.samples, fmt: numFmt },
    { label: 'New Videos Posted', current: cur.newVideos, previous: prv.newVideos, fmt: numFmt },
  ].filter(r => num(r.current) > 0 || num(r.previous) > 0);
  if (rows.length === 0) return null;
  return (
    <ContentSection
      icon="bi-bar-chart-line-fill"
      color={C.amber}
      title="Performance vs last month"
      eyebrow={prevLabel ? `Compared with ${prevLabel}` : 'This month vs last month'}
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

/* Tooltip + Trends panel for multi-month (≥2 months of data). */
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
          <strong style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{p.value}</strong>
        </div>
      ))}
    </div>
  );
}

function TrendsPanel({ trendData, currency = DEFAULT_CURRENCY }) {
  const moneyFmt = (v) => fmt$short(v, currency);
  if (!trendData || trendData.length < 2) return null;
  const first = trendData[0].month;
  const last = trendData[trendData.length - 1].month;
  const eyebrow = `${trendData.length} reporting months · ${first} → ${last}`;

  return (
    <ContentSection
      icon="bi-graph-up-arrow"
      color={C.amber}
      title="Trends over time"
      eyebrow={eyebrow}>
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
              <linearGradient id="monthGmvFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.amber} stopOpacity={0.32} />
                <stop offset="100%" stopColor={C.amber} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} interval={0} />
            <YAxis yAxisId="gmv" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} tickFormatter={moneyFmt} />
            <YAxis yAxisId="orders" orientation="right" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: C.amber, strokeOpacity: 0.25 }} />
            <Area yAxisId="gmv" type="monotone" dataKey="gmv" stroke={C.amber} strokeWidth={2}
              fill="url(#monthGmvFill)" name="GMV" isAnimationActive={false} dot={{ r: 2.5, fill: C.amber }} />
            <Line yAxisId="orders" type="monotone" dataKey="orders" stroke={C.green} strokeWidth={2}
              dot={{ r: 2.5, fill: C.green }} name="Orders" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="row g-3 mt-1">
        <div className="col-12 col-md-6">
          <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: '14px' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>Affiliate GMV</div>
              <div style={{ fontSize: '0.7rem', color: C.inkDim }}>Per month</div>
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={trendData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
                <defs>
                  <linearGradient id="monthAffFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.green} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} interval={0} />
                <YAxis tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} tickFormatter={moneyFmt} />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: C.green, strokeOpacity: 0.25 }} />
                <Area type="monotone" dataKey="affiliateGmv" stroke={C.green} strokeWidth={2}
                  fill="url(#monthAffFill)" name="Affiliate GMV" isAnimationActive={false} dot={{ r: 2.5, fill: C.green }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="col-12 col-md-6">
          <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: '14px' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>New videos posted</div>
              <div style={{ fontSize: '0.7rem', color: C.inkDim }}>Per month</div>
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={trendData} margin={{ top: 6, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} interval={0} />
                <YAxis tick={{ fontSize: 10, fill: C.muted }} axisLine={false} tickLine={false} />
                <Tooltip content={<TrendTooltip />} cursor={{ fill: '#f1f5f9' }} />
                <Bar dataKey="newVideos" fill="#f97316" radius={[6, 6, 0, 0]} name="Videos" isAnimationActive={false} />
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

/* Stat tile (compact) for grouped metric panels (Video / Creators / Customers). */
function MetricTile({ label, value, prevValue, formatter, accent = C.amber, subText }) {
  const c = num(value);
  const p = (prevValue == null || prevValue === '') ? null : num(prevValue);
  const pct = p === null || p === 0 ? null : pctChange(c, p);
  const renderedValue = (() => {
    if (value == null || value === '') return '—';
    if (formatter) return formatter(value);
    const n = Number(value);
    return isFinite(n) ? n.toLocaleString() : String(value);
  })();
  const renderedPrev = (() => {
    if (prevValue == null || prevValue === '') return null;
    if (formatter) return formatter(prevValue);
    const n = Number(prevValue);
    return isFinite(n) ? n.toLocaleString() : String(prevValue);
  })();
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.line}`,
      borderRadius: 12, padding: '14px 14px 12px',
      boxShadow: '0 1px 3px rgba(15,23,42,0.04)', height: '100%',
    }}>
      <div style={{
        fontSize: '0.6rem', fontWeight: 700, color: C.muted,
        textTransform: 'uppercase', letterSpacing: '0.08em',
      }}>{label}</div>
      <div className="d-flex align-items-baseline gap-2 mt-1">
        <div style={{
          fontSize: '1.25rem', fontWeight: 700, color: C.ink,
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
        }}>{renderedValue}</div>
        {pct !== null && <DeltaPill pct={pct} />}
      </div>
      {renderedPrev && (
        <div style={{ fontSize: '0.66rem', color: C.muted, marginTop: 4 }}>
          Prev <span style={{ color: C.inkDim, fontWeight: 600 }}>{renderedPrev}</span>
        </div>
      )}
      {subText && (
        <div style={{ fontSize: '0.66rem', color: C.muted, marginTop: 4 }}>{subText}</div>
      )}
      <div style={{ height: 2, background: accent, borderRadius: 999, marginTop: 10, opacity: 0.65 }} />
    </div>
  );
}

function MetricGrid({ items, cols = 4 }) {
  const visible = items.filter(it => it.value != null && it.value !== '' && !(typeof it.value === 'number' && it.value === 0 && (it.prevValue == null || it.prevValue === 0)));
  if (visible.length === 0) return null;
  const colClass = cols === 4
    ? 'col-6 col-md-4 col-lg-3'
    : cols === 5
      ? 'col-6 col-md-4 col-xl'
      : 'col-6 col-md-4';
  return (
    <div className="row g-3">
      {visible.map(it => (
        <div key={it.label} className={colClass}>
          <MetricTile {...it} />
        </div>
      ))}
    </div>
  );
}

/* GMV Max single-campaign card with spend-efficiency bar. */
function GmvMaxCard({ row, currency = DEFAULT_CURRENCY, isFirst }) {
  const ms = (v) => fmt$short(v, currency);
  const m = (v) => fmt$(v, currency);
  const cells = [
    { label: 'Spend', value: ms(row.spend) },
    { label: 'GMV', value: ms(row.gmv) },
    { label: 'ROI', value: num(row.roi) ? num(row.roi).toFixed(2) + '×' : '—', accent: num(row.roi) >= 1 ? C.green : C.red },
    { label: 'Orders', value: fmtN(row.orders) },
    { label: 'CPO', value: m(row.cpo) },
  ];
  const spend = num(row.spend), gmv = num(row.gmv);
  const ratio = spend > 0 && gmv > 0 ? Math.min(1, spend / gmv) : 0;
  return (
    <div className={isFirst ? '' : 'mt-3 pt-3'} style={{ borderTop: isFirst ? 'none' : `1px solid ${C.line}` }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between mb-2">
        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: C.ink }}>{row.campaign}</div>
      </div>
      <div className="row g-2">
        {cells.map(c => (
          <div className="col-4 col-md" key={c.label}>
            <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: '0.6rem', color: C.muted, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c.label}</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: c.accent || C.ink, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{c.value}</div>
            </div>
          </div>
        ))}
      </div>
      {spend > 0 && gmv > 0 && (
        <div className="mt-3">
          <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.66rem', color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            <span>Spend efficiency</span>
            <span>$1 → ${(gmv / spend).toFixed(2)}</span>
          </div>
          <div className="d-flex" style={{ height: 14, borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ background: 'var(--accent)', color: 'var(--on-accent)', fontSize: '0.66rem', fontWeight: 600, width: `${Math.max(15, ratio * 100)}%`, padding: '0 10px', display: 'flex', alignItems: 'center' }}>
              {ms(spend)} in
            </div>
            <div style={{ flex: 1, background: C.amber, color: C.hero, fontSize: '0.66rem', fontWeight: 700, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              {ms(gmv)} returned →
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main view ───────────────────────────────────────────────────────── */
export default function MonthlyReportView({ report, previousReport, allReports, clientView = false }) {
  const printRef = useRef();
  // v2 auth shim → v1 shape (v1 destructures `userRole` directly; v2's
  // useAuth returns `{ user, profile }` so we derive role from profile).
  const { profile } = useAuth();
  const userRole = profile?.role || '';
  const [copyState, setCopyState] = React.useState('idle');
  const [highlighterActive, setHighlighterActive] = React.useState(false);
  const { color: highlightColor, setColor: setHighlightColor,
          intensity: highlightIntensity, setIntensity: setHighlightIntensity } = useHighlightStyle();

  const { findByName: findReportLinks } = useBrandReportLinks(report?.brandId);

  // Last 12 months of metrics for sparklines and the Trends panel.
  const trendData = useMemo(() => {
    if (!allReports || !report) return [];
    return [...allReports]
      .filter(r => r.brandId === report.brandId)
      .sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || ''))
      .slice(-12)
      .map(r => {
        const t = r.totalSales || {};
        const k = r.kpis || {};
        const km = r.keyMetrics || {};
        const g = r.gmvBreakdown || {};
        const v = r.videoPerformance || {};
        return {
          month: shortMonthLabel(r.monthLabel),
          gmv: num(t.monthGmv) || num(km.gmv),
          orders: num(k.totalOrders) || num(km.orders),
          affiliateGmv: num(g.affiliateGmv),
          organicGmv: num(g.organicGmv),
          newVideos: num(v.newVideosPosted),
          samples: num(k.freeSamplesApproved),
        };
      });
  }, [allReports, report]);

  const sparkFor = (key) => trendData.map(d => ({ v: d[key] }));

  if (!report) return null;

  const currency = report.currency || DEFAULT_CURRENCY;
  const m  = (v) => fmt$(v, currency);
  const ms = (v) => fmt$short(v, currency);
  const sym = currencySymbol(currency);
  const sectEnabled = resolveSectionsEnabled(report.sectionsEnabled);

  const prev = previousReport || {};
  const hasPrev = !!previousReport;

  // ─── Hero metric values ────────────────────────────────────────────────
  const monthGmv = num(report.totalSales?.monthGmv) || num(report.keyMetrics?.gmv);
  const prevMonthGmv = num(prev.totalSales?.monthGmv) || num(prev.keyMetrics?.gmv);
  const allTimeGmv = num(report.totalSales?.allTimeGmv);
  const prevAllTimeGmv = num(prev.totalSales?.allTimeGmv);
  const orders = num(report.keyMetrics?.orders) || num(report.kpis?.totalOrders);
  const prevOrders = num(prev.keyMetrics?.orders) || num(prev.kpis?.totalOrders);
  const customers = num(report.keyMetrics?.customers);
  const prevCustomers = num(prev.keyMetrics?.customers);
  const itemsSold = num(report.keyMetrics?.itemsSold);
  const prevItemsSold = num(prev.keyMetrics?.itemsSold);
  const affiliateGmv = num(report.gmvBreakdown?.affiliateGmv);
  const prevAffiliateGmv = num(prev.gmvBreakdown?.affiliateGmv);
  const completedCollabs = num(report.kpis?.completedCollabs);
  const prevCompletedCollabs = num(prev.kpis?.completedCollabs);
  const samples = num(report.kpis?.freeSamplesApproved);
  const prevSamples = num(prev.kpis?.freeSamplesApproved);

  // Sortable lists
  const sortedCreators = [...(report.topCreators || [])]
    .filter(c => c.username)
    .sort((a, b) => num(b.gmv) - num(a.gmv));
  const totalCreatorGmv = sortedCreators.reduce((s, c) => s + num(c.gmv), 0);
  const sortedVideos = [...(report.topVideos || [])]
    .filter(v => v.videoLink)
    .sort((a, b) => num(b.gmv) - num(a.gmv));
  const productData = (report.productAnalytics || []).filter(p => p.productName || p.productId);
  const totalProductGmv = productData.reduce((s, p) => s + num(p.gmv), 0);
  const sortedProducts = [...productData].sort((a, b) => num(b.gmv) - num(a.gmv));

  // ─── Action handlers ───────────────────────────────────────────────────
  const handleCopyInsights = async () => {
    const insightFields = [report.keyWinsInsights];
    const insightParts = insightFields.map(v => htmlToPlainText((v || '').toString()).trim()).filter(Boolean);
    const titled = [];
    const push = (heading, value) => {
      const t = htmlToPlainText((value || '').toString()).trim();
      if (t) titled.push(`${heading}\n${t}`);
    };
    push('Campaigns', report.campaignsText);
    push('Recommendations & Action Items', report.recommendations);
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

  // Structured PDF export — renders the real report DOM with the
  // app's real stylesheets so the PDF matches the dashboard. See
  // utils/exportReportPdf.js for the rationale.
  const handleExport = () => {
    exportReportToPdf(printRef.current, {
      title: `Monthly Report — ${report.brandName || 'Brand'} — ${report.monthLabel || ''}`.trim(),
    });
  };

  return (
    <div>
      {/* ─── Action bar — hidden in clientView ────────────────────────── */}
      {!clientView && (
        <div className="d-flex justify-content-end gap-2 mb-3 flex-wrap d-print-none">
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
          {(userRole === 'tl' || userRole === 'pctl') && (
            <button className="btn btn-sm d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 10, fontSize: '0.78rem',
                background: copyState === 'done' ? 'var(--success)' : 'var(--accent)',
                color: 'var(--on-accent)', border: 'none' }}
              onClick={handleCopyInsights}
              title="Copy all insights to clipboard">
              <i className={`bi ${copyState === 'done' ? 'bi-check-circle-fill' : 'bi-clipboard-check'}`} />
              {copyState === 'done' ? 'Copied!' : 'Copy All Insights'}
            </button>
          )}
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 10, fontSize: '0.78rem', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
            onClick={handleExport}>
            <i className="bi bi-file-earmark-pdf" /> Export PDF
          </button>
        </div>
      )}

      {/* ─── Canvas (printable) ─────────────────────────────────────── */}
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
              <div style={{ fontSize: '0.66rem', color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>Monthly Report</div>
            </div>
          </div>
          <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.82rem', color: C.inkDim }}>
            <span style={{ color: C.muted }}>Affiliate</span>
            <span style={{ color: C.muted }}>/</span>
            <span style={{ color: C.muted }}>Monthly</span>
            <span style={{ color: C.muted }}>/</span>
            <span style={{ fontWeight: 700, color: C.ink }}>{report.monthLabel}</span>
          </div>
        </div>

        {hasPrev && (
          <div style={{ fontSize: '0.72rem', color: C.muted, marginBottom: 18 }}>
            Compared with <strong style={{ color: C.inkDim }}>{prev.monthLabel}</strong>
          </div>
        )}

        {/* ─── Hero stat grid (4 + 4) ────────────────────────────────── */}
        {sectEnabled.totalSales && (
          <>
            <div className="row g-3 mb-3">
              <div className="col-6 col-lg-3">
                <StatCard label="GMV (this month)" value={m(monthGmv)}
                  current={monthGmv} prevValue={hasPrev ? m(prevMonthGmv) : null}
                  primary sparkData={sparkFor('gmv')} />
              </div>
              <div className="col-6 col-lg-3">
                <StatCard label="Affiliate GMV" value={m(affiliateGmv)}
                  current={affiliateGmv} prevValue={hasPrev ? m(prevAffiliateGmv) : null}
                  sparkData={sparkFor('affiliateGmv')} />
              </div>
              <div className="col-6 col-lg-3">
                <StatCard label="Total Orders" value={fmtN(orders)}
                  current={orders} prevValue={hasPrev ? fmtN(prevOrders) : null}
                  sparkData={sparkFor('orders')} />
              </div>
              <div className="col-6 col-lg-3">
                <StatCard label="All-time GMV" value={m(allTimeGmv)}
                  current={allTimeGmv} prevValue={hasPrev && prevAllTimeGmv ? m(prevAllTimeGmv) : null}
                  color={C.green} />
              </div>
            </div>
            {(sectEnabled.keyMetrics || sectEnabled.kpis) && (
              <div className="row g-3 mb-4">
                <div className="col-6 col-lg-3">
                  <StatCard label="Customers" value={fmtN(customers)}
                    current={customers} prevValue={hasPrev ? fmtN(prevCustomers) : null} />
                </div>
                <div className="col-6 col-lg-3">
                  <StatCard label="Items Sold" value={fmtN(itemsSold)}
                    current={itemsSold} prevValue={hasPrev ? fmtN(prevItemsSold) : null} />
                </div>
                <div className="col-6 col-lg-3">
                  <StatCard label="Completed Collabs" value={fmtN(completedCollabs)}
                    current={completedCollabs} prevValue={hasPrev ? fmtN(prevCompletedCollabs) : null} />
                </div>
                <div className="col-6 col-lg-3">
                  <StatCard label="Samples Approved" value={fmtN(samples)}
                    current={samples} prevValue={hasPrev ? fmtN(prevSamples) : null}
                    sparkData={sparkFor('samples')} />
                </div>
              </div>
            )}
          </>
        )}

        {/* Insight box pulled to top of report (Key Wins / Strategy & Insights). */}
        {sectEnabled.keyWinsInsights && (
          <InsightBox text={report.keyWinsInsights} report={report} fieldKey="keyWinsInsights"
            highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity} />
        )}

        {/* ─── Comparison panel ──────────────────────────────────────── */}
        {hasPrev && (
          <ComparisonPanel report={report} prev={prev} prevLabel={prev.monthLabel} currency={currency} />
        )}

        {/* ─── GMV Breakdown ─────────────────────────────────────────── */}
        {sectEnabled.gmvBreakdown && (() => {
          const g = report.gmvBreakdown || {};
          const slices = [
            { label: 'Affiliate GMV',   value: num(g.affiliateGmv),   color: '#0891b2' },
            { label: 'Organic GMV',     value: num(g.organicGmv),     color: '#10b981' },
            { label: 'LIVE GMV',        value: num(g.liveGmv),        color: '#ef4444' },
            { label: 'Video GMV',       value: num(g.videoGmv),       color: '#8b5cf6' },
            { label: 'Product Card GMV', value: num(g.productCardGmv), color: '#f59e0b' },
          ];
          const total = slices.reduce((s, x) => s + x.value, 0);
          if (!total) return null;
          return (
            <ContentSection icon="bi-pie-chart-fill" color="#0891b2" title="GMV breakdown" eyebrow="Revenue mix by traffic source">
              <DonutChart slices={slices} total={total} currencySym={sym} />
            </ContentSection>
          );
        })()}

        {/* ─── Top Creators + Products row ──────────────────────────── */}
        {(sortedCreators.length > 0 || sortedProducts.length > 0) && (
          <div className="row g-3 mt-1">
            {sectEnabled.topCreators && sortedCreators.length > 0 && (
              <div className="col-12 col-lg-7">
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
                  <div className="px-3 py-3">
                    <SectionHead
                      title="Top creators this month"
                      eyebrow={`Ranked by GMV · ${sortedCreators.length} creators`}
                    />
                  </div>
                  {sortedCreators.map((c, i) => (
                    <CreatorRow key={i} creator={c} rank={i + 1} totalGmv={totalCreatorGmv} currency={currency} />
                  ))}
                </div>
              </div>
            )}
            {sectEnabled.productAnalytics && sortedProducts.length > 0 && (
              <div className="col-12 col-lg-5">
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
                  <div className="px-3 py-3">
                    <SectionHead
                      title="Products driving GMV"
                      eyebrow="Focus SKUs · units & samples"
                    />
                  </div>
                  {sortedProducts.map((p, i) => (
                    <ProductRow key={i} product={p} rank={i + 1}
                      gmvShare={totalProductGmv > 0 ? (num(p.gmv) / totalProductGmv) * 100 : 0}
                      currency={currency} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── Top Videos (poster cards) ────────────────────────────── */}
        {sectEnabled.topVideos && sortedVideos.length > 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: '18px 18px 20px', marginTop: 12 }}>
            <SectionHead
              title="Top videos"
              eyebrow="Best performers by GMV this month · click any card to open the TikTok video"
            />
            <div className="row g-3">
              {sortedVideos.slice(0, 5).map((v, i) => (
                <div key={i} className="col-6 col-md-4 col-lg-3 col-xl">
                  <VideoPosterCard video={v} rank={i + 1} currency={currency} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Video Performance ──────────────────────────────────────── */}
        {sectEnabled.videoPerformance && (() => {
          const v = report.videoPerformance || {};
          const pv = prev.videoPerformance || {};
          const items = [
            { label: 'Product Impressions', value: v.productImpressions, prevValue: pv.productImpressions, formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Product Clicks',      value: v.productClicks,      prevValue: pv.productClicks,      formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Video Views',         value: v.videoViews,         prevValue: pv.videoViews,         formatter: fmtRaw, accent: '#6366f1' },
            { label: 'CTR',                 value: v.ctr,                prevValue: pv.ctr,                formatter: (x) => `${String(x).replace(/%/g, '')}%`, accent: '#6366f1' },
            { label: 'CTOR',                value: v.ctor,               prevValue: pv.ctor,               formatter: (x) => `${String(x).replace(/%/g, '')}%`, accent: '#6366f1' },
            { label: 'SKU Orders',          value: v.skuOrders,          prevValue: pv.skuOrders,          formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Video GMV',           value: v.gmv,                prevValue: pv.gmv,                formatter: m, accent: '#6366f1' },
            { label: 'New Videos Posted',   value: v.newVideosPosted,    prevValue: pv.newVideosPosted,    formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Videos 1M+ views',    value: v.videos1MViews,      prevValue: pv.videos1MViews,      formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Videos 100k+ views',  value: v.videos100kViews,    prevValue: pv.videos100kViews,    formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Videos 10k+ views',   value: v.videos10kViews,     prevValue: pv.videos10kViews,     formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Videos $1k+ GMV',     value: v.videos1000Gmv,      prevValue: pv.videos1000Gmv,      formatter: fmtRaw, accent: '#6366f1' },
            { label: 'Videos $100+ GMV',    value: v.videos100Gmv,       prevValue: pv.videos100Gmv,       formatter: fmtRaw, accent: '#6366f1' },
          ];
          const grid = <MetricGrid items={items} cols={4} />;
          if (!grid) return null;
          return (
            <ContentSection icon="bi-camera-reels-fill" color="#6366f1" title="Video performance" eyebrow="Reach, engagement and content output">
              {grid}
            </ContentSection>
          );
        })()}

        {/* ─── Creators' Performance ────────────────────────────────── */}
        {sectEnabled.creatorsPerformance && (() => {
          const c = report.creatorsPerformance || {};
          const pc = prev.creatorsPerformance || {};
          const items = [
            { label: 'Creators 1+ videos',  value: c.creators1Plus,  prevValue: pc.creators1Plus,  formatter: fmtRaw, accent: '#a855f7' },
            { label: 'Creators 3+ videos',  value: c.creators3Plus,  prevValue: pc.creators3Plus,  formatter: fmtRaw, accent: '#a855f7' },
            { label: 'Creators 10+ videos', value: c.creators10Plus, prevValue: pc.creators10Plus, formatter: fmtRaw, accent: '#a855f7' },
            { label: 'Creators $1k+ GMV',   value: c.creators1kGmv,  prevValue: pc.creators1kGmv,  formatter: fmtRaw, accent: '#a855f7' },
            { label: 'Creators $100+ GMV',  value: c.creators100Gmv, prevValue: pc.creators100Gmv, formatter: fmtRaw, accent: '#a855f7' },
          ];
          const grid = <MetricGrid items={items} cols={5} />;
          if (!grid) return null;
          return (
            <ContentSection icon="bi-person-video3" color="#a855f7" title="Creators' performance" eyebrow="Activation tiers across the affiliate roster">
              {grid}
            </ContentSection>
          );
        })()}

        {/* ─── GMV Max Performance ──────────────────────────────────── */}
        {sectEnabled.gmvMax && (() => {
          const rows = (report.gmvMax || []).filter(g => g.campaign);
          if (rows.length === 0) return null;
          const sum = rows.reduce((s, r) => ({
            spend: s.spend + num(r.spend),
            orders: s.orders + num(r.orders),
            gmv: s.gmv + num(r.gmv),
          }), { spend: 0, orders: 0, gmv: 0 });
          const overallRoi = sum.spend > 0 ? sum.gmv / sum.spend : 0;
          const overallCpo = sum.orders > 0 ? sum.spend / sum.orders : 0;
          return (
            <ContentSection icon="bi-rocket-takeoff-fill" color={C.red} title="GMV Max performance" eyebrow="Brand-managed campaigns · spend efficiency per campaign">
              {rows.map((r, i) => (
                <GmvMaxCard key={i} row={r} currency={currency} isFirst={i === 0} />
              ))}
              <div className="d-flex flex-wrap align-items-center gap-3 mt-3 p-3 rounded-3"
                style={{ background: '#fff7ed', border: `1px solid ${C.amberLine}` }}>
                <span style={{ fontSize: '0.66rem', color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Overall</span>
                <span style={{ fontSize: '0.82rem', color: C.ink }}>Spend <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{ms(sum.spend)}</strong></span>
                <span style={{ fontSize: '0.82rem', color: C.ink }}>ROI <strong style={{ color: overallRoi >= 1 ? C.green : C.red, fontVariantNumeric: 'tabular-nums' }}>{overallRoi.toFixed(2)}×</strong></span>
                <span style={{ fontSize: '0.82rem', color: C.ink }}>Orders <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtN(sum.orders)}</strong></span>
                <span style={{ fontSize: '0.82rem', color: C.ink }}>CPO <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{m(overallCpo)}</strong></span>
                <span style={{ fontSize: '0.82rem', color: C.ink }}>GMV <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{ms(sum.gmv)}</strong></span>
              </div>
            </ContentSection>
          );
        })()}

        {/* ─── Customers ────────────────────────────────────────────── */}
        {sectEnabled.customers && (() => {
          const c = report.customers || {};
          const pc = prev.customers || {};
          const items = [
            { label: 'Aware Customers',         value: c.awareCustomers,        prevValue: pc.awareCustomers,        formatter: fmtRaw, accent: '#0ea5e9' },
            { label: 'New Customers',           value: c.newCustomers,          prevValue: pc.newCustomers,          formatter: fmtRaw, accent: '#0ea5e9' },
            { label: 'Potential New Customers', value: c.potentialNewCustomers, prevValue: pc.potentialNewCustomers, formatter: fmtRaw, accent: '#0ea5e9' },
            { label: 'CRM Messages Sent',       value: c.crmMessagesSent,       prevValue: pc.crmMessagesSent,       formatter: fmtRaw, accent: '#0ea5e9' },
            { label: 'Converted Customers',     value: c.convertedCustomers,    prevValue: pc.convertedCustomers,    formatter: fmtRaw, accent: '#0ea5e9' },
          ];
          const grid = <MetricGrid items={items} cols={5} />;
          if (!grid) return null;
          return (
            <ContentSection icon="bi-people" color="#0ea5e9" title="Customers" eyebrow="Awareness, acquisition and CRM activity">
              {grid}
            </ContentSection>
          );
        })()}

        {/* ─── Trends across reporting months ──────────────────────── */}
        <TrendsPanel trendData={trendData} currency={currency} />

        {/* ─── Long-form rich-text sections ────────────────────────── */}
        {sectEnabled.campaignsText && (() => {
          const links = findReportLinks('Campaigns');
          const has = report.campaignsText && String(report.campaignsText).trim();
          if (!has && !links) return null;
          return (
            <ContentSection
              icon="bi-megaphone-fill"
              color="#ec4899"
              title="Campaigns"
              eyebrow="Active and upcoming TikTok Shop campaigns">
              {has && (
                <HighlightableContent html={report.campaignsText} report={report} fieldKey="campaignsText"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                  style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent="#ec4899" />
            </ContentSection>
          );
        })()}

        {sectEnabled.recommendations && (() => {
          const links = findReportLinks('Recommendations & Action Items');
          const has = report.recommendations && String(report.recommendations).trim();
          if (!has && !links) return null;
          return (
            <ContentSection
              icon="bi-lightbulb-fill"
              color={C.amber}
              title="Recommendations & Action Items"
              eyebrow="Where to focus next">
              {has && (
                <HighlightableContent html={report.recommendations} report={report} fieldKey="recommendations"
                  highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                  className="report-priorities"
                  style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
              )}
              <EmbeddedLinks section={links} accent={C.amber} />
            </ContentSection>
          );
        })()}

        {/* Custom Fields + unmatched brand resource sections */}
        {sectEnabled.customFields && (() => {
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
              <ContentSection key={fieldId} icon="bi-sliders" color="#8b5cf6" title={name || 'Custom Field'}>
                {!isEmpty && (
                  <HighlightableContent html={value} report={report} fieldKey={`customField_${fieldId}`}
                    highlighterActive={highlighterActive} highlightColor={highlightColor} highlightIntensity={highlightIntensity}
                    style={{ fontSize: '0.88rem', lineHeight: 1.7, color: C.ink }} />
                )}
                <EmbeddedLinks section={links} accent="#8b5cf6" />
              </ContentSection>
            );
          });
          const known = ['Key Wins / Insights', 'Key Wins', 'Campaigns', 'Recommendations & Action Items', ...customNames];
          return (
            <>
              {renderedCustom}
              <BrandReportLinks brandId={report.brandId} knownSectionNames={known} />
            </>
          );
        })()}
      </div>

      {/* Client custom sections — read-only for app users. In clientView
          the portal mounts its own writable panel after this. */}
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
