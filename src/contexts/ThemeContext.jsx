import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY      = 'wurxos-theme';
const FONT_FAMILY_KEY  = 'wurxos-font-family';
const FONT_SIZE_KEY    = 'wurxos-font-size';

// Curated modern fonts loaded from Google Fonts in index.html.
// Keys match the data-attribute values handled in tokens.css.
//
// The `stack` field is used in the Appearance picker to render each
// card's live preview in that family, even when it isn't currently
// selected globally.
export const FONT_FAMILIES = [
  { key: 'inter',   label: 'Inter',             note: 'Modern, clean — default',
    stack: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" },
  { key: 'jakarta', label: 'Plus Jakarta Sans', note: 'Friendly, rounded',
    stack: "'Plus Jakarta Sans', -apple-system, sans-serif" },
  { key: 'manrope', label: 'Manrope',           note: 'Soft geometric',
    stack: "'Manrope', -apple-system, sans-serif" },
  { key: 'dm-sans', label: 'DM Sans',           note: 'Bold geometric',
    stack: "'DM Sans', -apple-system, sans-serif" },
  { key: 'outfit',  label: 'Outfit',            note: 'Distinctive display',
    stack: "'Outfit', -apple-system, sans-serif" },
  { key: 'lora',    label: 'Lora',              note: 'Reader-friendly serif',
    stack: "'Lora', Georgia, serif" },
  { key: 'mono',    label: 'JetBrains Mono',    note: 'For code-minded folks',
    stack: "'JetBrains Mono', ui-monospace, Menlo, monospace" },
];

// Font sizes applied via CSS `zoom` on the content area — scales
// padding + icons + text together, which is what users actually
// expect from a "font size" control.
export const FONT_SIZES = [
  { key: 'compact',     label: 'Compact',     zoom: 0.925 },
  { key: 'default',     label: 'Default',     zoom: 1.0   },
  { key: 'comfortable', label: 'Comfortable', zoom: 1.075 },
  { key: 'large',       label: 'Large',       zoom: 1.15  },
];

function safeGet(key, allowed, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = localStorage.getItem(key);
  return allowed.includes(v) ? v : fallback;
}

function getInitialTheme() {
  return safeGet(STORAGE_KEY, ['light', 'dark'], 'dark');
}
function getInitialFontFamily() {
  return safeGet(FONT_FAMILY_KEY, FONT_FAMILIES.map((f) => f.key), 'inter');
}
function getInitialFontSize() {
  return safeGet(FONT_SIZE_KEY, FONT_SIZES.map((s) => s.key), 'default');
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState]           = useState(getInitialTheme);
  const [fontFamily, setFontFamilyState] = useState(getInitialFontFamily);
  const [fontSize, setFontSizeState]     = useState(getInitialFontSize);

  // Theme → data-theme attribute + meta color
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#000000' : '#c2704e',
    );
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Font family → data-font-family attribute, tokens.css swaps --font-sans
  useEffect(() => {
    document.documentElement.setAttribute('data-font-family', fontFamily);
    localStorage.setItem(FONT_FAMILY_KEY, fontFamily);
  }, [fontFamily]);

  // Font size → data-font-size attribute, global.css applies zoom
  useEffect(() => {
    document.documentElement.setAttribute('data-font-size', fontSize);
    localStorage.setItem(FONT_SIZE_KEY, fontSize);
  }, [fontSize]);

  const setTheme      = useCallback((t) => setThemeState(t), []);
  const toggleTheme   = useCallback(
    () => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')),
    [],
  );
  const setFontFamily = useCallback((f) => setFontFamilyState(f), []);
  const setFontSize   = useCallback((s) => setFontSizeState(s), []);

  return (
    <ThemeContext.Provider value={{
      theme, setTheme, toggleTheme,
      fontFamily, setFontFamily,
      fontSize, setFontSize,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
