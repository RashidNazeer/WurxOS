// Brand avatar: uses the logo if provided, otherwise a deterministic
// initials tile whose colour is a chart-palette slot picked by the name hash
// (theme-aware; --text-inverse reads on every slot except amber 3, skipped).

const PALETTE = [6, 2, 1, 5, 4, 7, 8].map((n) => ({ bg: `var(--chart-${n})`, fg: 'var(--text-inverse)' }));

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

// Callers pass px numbers; snap them onto the shared radius scale.
function snapRadius(r) {
  if (typeof r !== 'number') return r;
  if (r <= 4) return 'var(--radius-xs)';
  if (r <= 8) return 'var(--radius-sm)';
  if (r <= 12) return 'var(--radius-md)';
  if (r <= 16) return 'var(--radius-lg)';
  return 'var(--radius-xl)';
}

export default function BrandAvatar({ brand, size = 42, radius = 10 }) {
  const name = brand?.brand_name || brand?.brandName || '';
  const logo = brand?.logo_url || brand?.logoUrl;
  const { bg, fg } = PALETTE[hash(name) % PALETTE.length] || PALETTE[0];

  const baseStyle = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    borderRadius: snapRadius(radius),
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    border: '1px solid var(--border-subtle)',
  };

  if (logo) {
    // Logos are often transparent PNGs drawn for white backgrounds, so they
    // sit on a light plate in BOTH themes (a dark logo vanished on the dark
    // surface). --spotlight-fg is the near-white text-on-dark token in both
    // themes; a dedicated --logo-plate token would be cleaner. `contain`
    // fits the whole logo inside the box, with a tiny inset off the border.
    const inset = Math.max(2, Math.round(size * 0.08));
    return (
      <div style={{ ...baseStyle, background: 'var(--logo-plate, var(--spotlight-fg))' }}>
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
