import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Measure a sticky report header's height so the rich-text toolbars below it
 * can pin JUST beneath it instead of colliding with it.
 *
 * The report header is `position: sticky; top: var(--topbar-h)` and can WRAP
 * to a taller height on narrow windows, so a hardcoded offset is fragile.
 * This hook watches the header's real height and returns:
 *   - `headerRef`  → attach to the sticky header element
 *   - `rteTopStyle` → spread onto the form root; sets `--rte-toolbar-top` to
 *                     `calc(var(--topbar-h) + <measured header height>)` so
 *                     every RichTextEditor toolbar sticks right below it.
 *
 * Falls back to a sane default until the first measurement lands.
 */
export function useStickyHeaderOffset(fallbackPx = 96) {
  const headerRef = useRef(null);
  const [h, setH] = useState(fallbackPx);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().height);
      if (next > 0) setH(next);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return {
    headerRef,
    rteTopStyle: { '--rte-toolbar-top': `calc(var(--topbar-h, 68px) + ${h}px)` },
  };
}
