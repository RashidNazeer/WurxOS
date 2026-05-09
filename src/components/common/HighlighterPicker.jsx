import { useCallback, useEffect, useState } from 'react';

export const HIGHLIGHT_COLORS = [
  { key: 'yellow', label: 'Yellow', swatch: '#fef08a' },
  { key: 'green',  label: 'Green',  swatch: '#bbf7d0' },
  { key: 'pink',   label: 'Pink',   swatch: '#f9a8d4' },
  { key: 'blue',   label: 'Blue',   swatch: '#93c5fd' },
  { key: 'orange', label: 'Orange', swatch: '#fdba74' },
];

export const HIGHLIGHT_INTENSITIES = ['light', 'medium', 'dark'];

const COLOR_LS_KEY     = 'wurxos.highlight.color';
const INTENSITY_LS_KEY = 'wurxos.highlight.intensity';

/**
 * Persist the user's highlight color + intensity choice across reloads
 * and tabs. Returns useState-shaped pairs.
 */
export function useHighlightStyle() {
  const [color, setColorState] = useState(() => {
    try { return localStorage.getItem(COLOR_LS_KEY) || 'yellow'; } catch { return 'yellow'; }
  });
  const [intensity, setIntensityState] = useState(() => {
    try { return localStorage.getItem(INTENSITY_LS_KEY) || 'medium'; } catch { return 'medium'; }
  });
  const setColor = useCallback((c) => {
    setColorState(c);
    try { localStorage.setItem(COLOR_LS_KEY, c); } catch { /* ignore */ }
  }, []);
  const setIntensity = useCallback((i) => {
    setIntensityState(i);
    try { localStorage.setItem(INTENSITY_LS_KEY, i); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    function onStorage(e) {
      if (e.key === COLOR_LS_KEY     && e.newValue) setColorState(e.newValue);
      if (e.key === INTENSITY_LS_KEY && e.newValue) setIntensityState(e.newValue);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return { color, setColor, intensity, setIntensity };
}

/**
 * Compact color + intensity picker. Used inside the RichTextEditor
 * toolbar and next to the Highlighter toggle on report views.
 */
export default function HighlighterPicker({
  color, onColorChange,
  intensity, onIntensityChange,
  compact = false,
}) {
  const swatchSize = compact ? 18 : 22;
  const activeColor = HIGHLIGHT_COLORS.find((c) => c.key === color);

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      borderRadius: 8, padding: compact ? '3px 8px' : '4px 10px',
    }}>
      <span style={{ fontSize: compact ? 11 : 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
        {activeColor ? activeColor.label : 'Color'}
      </span>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {HIGHLIGHT_COLORS.map((c) => {
          const selected = color === c.key;
          return (
            <button key={c.key} type="button"
              onClick={() => onColorChange(c.key)}
              onMouseDown={(e) => e.preventDefault()}
              title={c.label}
              style={{
                width: swatchSize, height: swatchSize,
                borderRadius: 4,
                border: selected ? '2px solid var(--text-primary)' : '1px solid var(--border-default)',
                outline: selected ? '2px solid var(--accent)' : 'none',
                outlineOffset: 1,
                background: c.swatch,
                cursor: 'pointer', padding: 0,
                transform: selected ? 'scale(1.08)' : 'none',
                transition: 'transform 80ms ease',
              }} />
          );
        })}
      </div>
      <select
        value={intensity}
        onChange={(e) => onIntensityChange(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 6,
          padding: '2px 6px', fontSize: compact ? 11 : 12.5,
          cursor: 'pointer', color: 'var(--text-primary)', height: compact ? 26 : 30,
          fontWeight: 600,
        }}>
        {HIGHLIGHT_INTENSITIES.map((i) => (
          <option key={i} value={i}>{i.charAt(0).toUpperCase() + i.slice(1)}</option>
        ))}
      </select>
    </div>
  );
}
