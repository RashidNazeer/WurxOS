import { useEffect, useState } from 'react';

// Tones are chart palette slots whose fill passes 4.5:1 with the theme's
// inverse text (light: white on 4.68–10.2; dark: near-black on >= 6.5).
// --chart-3 (amber) is skipped: white on it is only 3.64 in light.
const TONE_SLOTS = [1, 2, 4, 5, 6, 7, 8];

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function toneFor(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TONE_SLOTS[h % TONE_SLOTS.length];
}

/**
 * <Avatar name src size={32} toneKey={user.id} shape="circle|rounded" />
 * Same person → same colour everywhere (hash of toneKey, else name).
 */
export default function Avatar({ name, src, size = 32, toneKey, shape = 'circle', className = '', alt }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const slot = toneFor(toneKey ?? name);
  const showImg = src && !failed;
  return (
    <span
      className={`ui-avatar ui-avatar--${shape} ${className}`.trim()}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(12, Math.round(size * 0.38)),
        background: showImg ? undefined : `var(--chart-${slot})`,
      }}
      role="img"
      aria-label={alt ?? name ?? undefined}
    >
      {showImg
        ? <img src={src} alt="" onError={() => setFailed(true)} />
        : <span aria-hidden="true">{initialsOf(name)}</span>}
    </span>
  );
}
