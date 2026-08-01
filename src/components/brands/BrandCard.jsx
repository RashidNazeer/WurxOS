import { useNavigate } from 'react-router-dom';
import BrandAvatar from './BrandAvatar';
import { PencilIcon, RefreshIcon, ChevronRightIcon } from '../common/Icon';
import { currencySymbol } from '../../utils/currencies';

/**
 * Single brand card. Shows logo/initials, name, client, status badge,
 * owner, assigned APC avatars, and optional actions.
 *
 * Props:
 *   brand     — brand row with owner + assignedUsers
 *   canEdit   — show the Edit button?
 *   canSwitch — show the Switch owner button? (Boss/OL only)
 *   onEdit
 *   onSwitch
 */
export default function BrandCard({ brand, canEdit, canSwitch, onEdit, onSwitch }) {
  const navigate = useNavigate();
  const owner = brand.owner;
  const apcs  = brand.assignedUsers || [];
  const visibleApcs = apcs.slice(0, 4);
  const extra = apcs.length - visibleApcs.length;
  const tierLabel = formatTier(brand.tier);

  const statusClass =
    brand.status === 'active' ? 'brand-status-badge-active' : 'brand-status-badge-inactive';

  // Click anywhere on the card (except explicit buttons) navigates to the detail page.
  function openDetail(e) {
    if (e.target.closest('button, a')) return;
    navigate(`/brands/${brand.id}`);
  }

  return (
    <div className="brand-card brand-card-clickable" onClick={openDetail}
      role="link" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/brands/${brand.id}`); } }}>
      <div className="brand-card-head">
        <BrandAvatar brand={brand} size={42} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="brand-card-name">{brand.brand_name}</div>
          <div className="brand-card-client">{brand.client_name || '—'}</div>
        </div>
        <span className={`wx-badge ${statusClass}`} style={{ flex: '0 0 auto' }}>
          <span className="wx-badge-dot" /> {brand.status === 'active' ? 'Active' : 'Inactive'}
        </span>
      </div>

      <div className="brand-card-meta">
        {tierLabel && (
          <span
            style={{
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 600,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              borderRadius: 'var(--radius-pill)',
            }}
          >
            Tier · {tierLabel}
          </span>
        )}
        {brand.gmv != null && (
          <span
            style={{
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 600,
              background: 'var(--success-soft)',
              color: 'var(--success)',
              borderRadius: 'var(--radius-pill)',
            }}
            title="30-day GMV"
          >
            GMV · {formatMoney(brand.gmv, brand.currency)}
          </span>
        )}
        {owner && (
          <span style={{ color: 'var(--text-muted)' }}>
            TL: <strong style={{ color: 'var(--text-secondary)' }}>{owner.display_name}</strong>
          </span>
        )}
      </div>

      <div className="brand-card-footer">
        <div className="brand-apc-stack" title={apcs.map((a) => a.display_name).join(', ') || 'No APCs assigned'}>
          {visibleApcs.length === 0 && (
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No APCs assigned
            </span>
          )}
          {visibleApcs.map((u) => (
            <div key={u.id} className="brand-apc-chip" title={u.display_name}>
              {initials(u.display_name)}
            </div>
          ))}
          {extra > 0 && <div className="brand-apc-chip brand-apc-chip-more">+{extra}</div>}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {canSwitch && (
            <button
              className="wx-btn wx-btn-ghost"
              onClick={onSwitch}
              style={{ padding: '5px 10px', fontSize: 12 }}
              title="Switch Team Lead"
            >
              <RefreshIcon width="13" height="13" /> Switch
            </button>
          )}
          {canEdit && (
            <button
              className="wx-btn wx-btn-ghost"
              onClick={onEdit}
              style={{ padding: '5px 10px', fontSize: 12 }}
            >
              <PencilIcon width="13" height="13" /> Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function initials(name) {
  return (name || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}

function formatMoney(n, currency = 'USD') {
  if (n == null) return '—';
  const sym = currencySymbol(currency);
  const num = Number(n);
  if (num >= 1_000_000) return `${sym}${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `${sym}${(num / 1_000).toFixed(1)}K`;
  return `${sym}${num.toFixed(0)}`;
}

// Normalise a brand's tier for display + filtering so it's always a concrete number
// ("2K" -> "2000") and "unlimited" is shown consistently. Free-text values differ
// across brands, so this fixes the display without touching the stored data.
export function formatTier(tier) {
  if (tier == null) return null;
  const s = String(tier).trim();
  if (!s) return null;
  if (/unlimited/i.test(s)) return 'Unlimited';
  const k = s.match(/^([\d.,]+)\s*[kK]$/); // "2K", "2.5k", "10 K"
  if (k) { const n = parseFloat(k[1].replace(/,/g, '')); if (Number.isFinite(n)) return String(Math.round(n * 1000)); }
  const n = Number(s.replace(/,/g, '')); // "2000", "2,000"
  if (Number.isFinite(n)) return String(n);
  return s; // unknown format — show as-is
}
