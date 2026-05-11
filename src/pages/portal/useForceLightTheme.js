import { useLayoutEffect } from 'react';

/**
 * Forces the document into light theme for the lifetime of the
 * component that calls this hook, then restores the previous theme
 * on unmount.
 *
 * Why: portal routes (/portal/access/:token, /portal/reports/:token)
 * are viewed by external clients who don't have a WurxOS account.
 * The app's default theme is 'dark', which can render their reports
 * with the wrong palette. We always want clients to see the polished
 * light-mode presentation regardless of any cached theme value.
 *
 * Uses useLayoutEffect (not useEffect) so the attribute change is
 * applied before paint — no dark-mode flash on initial load.
 */
export function useForceLightTheme() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    return () => {
      // On unmount, restore whatever theme was active before this
      // portal page mounted. If nothing was set, default back to
      // the app's preferred dark.
      if (prev) root.setAttribute('data-theme', prev);
      else      root.setAttribute('data-theme', 'dark');
    };
  }, []);
}
