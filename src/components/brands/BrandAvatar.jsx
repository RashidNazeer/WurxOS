// Brand avatar: uses the logo if provided, otherwise a deterministic
// initials tile whose color is derived from the brand name hash.
// Colors use tokens where possible; palette is theme-independent
// (looks good on either surface background).

const PALETTE = [
  { bg: '#6366f1', fg: '#ffffff' },
  { bg: '#10b981', fg: '#ffffff' },
  { bg: '#f59e0b', fg: '#ffffff' },
  { bg: '#ec4899', fg: '#ffffff' },
  { bg: '#06b6d4', fg: '#ffffff' },
  { bg: '#8b5cf6', fg: '#ffffff' },
  { bg: '#ef4444', fg: '#ffffff' },
];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function BrandAvatar({ brand, size = 42, radius = 10 }) {
  const name = brand?.brand_name || brand?.brandName || '';
  const logo = brand?.logo_url || brand?.logoUrl;
  const { bg, fg } = PALETTE[hash(name) % PALETTE.length] || PALETTE[0];

  const baseStyle = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    borderRadius: radius,
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    border: '1px solid var(--border-subtle)',
  };

  if (logo) {
    // Logos may be transparent PNGs — use a neutral surface so the
    // palette color doesn't bleed through. `contain` fits the whole
    // logo inside the box (no cropping), with a tiny inset so the
    // edges don't touch the border.
    const inset = Math.max(2, Math.round(size * 0.08));
    return (
      <div style={{ ...baseStyle, background: 'var(--surface-1)' }}>
        <img
          src={logo}
          alt={name}
          style={{
            width: `calc(100% - ${inset * 2}px)`,
            height: `calc(100% - ${inset * 2}px)`,
            objectFit: 'contain',
          }}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      </div>
    );
  }
  return (
    <div style={{
      ...baseStyle,
      background: bg,
      color: fg,
      fontWeight: 700,
      fontSize: Math.max(11, Math.round(size * 0.36)),
    }}>
      {initials(name)}
    </div>
  );
}
