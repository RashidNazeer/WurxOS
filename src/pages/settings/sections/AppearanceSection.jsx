import { useTheme, FONT_FAMILIES, FONT_SIZES } from '../../../contexts/ThemeContext';
import { PaletteIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

// Foundation applies these to --font-content only (reading surfaces), not the UI chrome.
const READING_FONTS = new Set(['lora', 'mono']);

export default function AppearanceSection() {
  const {
    theme, setTheme,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
  } = useTheme();

  return (
    <SectionShell
      icon={PaletteIcon}
      title="Appearance"
      subtitle="Theme, font, and size. Changes apply instantly and stick to this browser."
    >
      {/* ---------------- Theme ---------------- */}
      <div className="settings-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="settings-row-label-title">Theme</div>
          <div className="settings-row-label-sub">Light or dark — picks saved per browser.</div>
        </div>
        <div />
      </div>
      <div className="theme-picker">
        <ThemeCard
          active={theme === 'light'}
          onClick={() => setTheme('light')}
          label="Light"
          sub="Warm cream background, chocolate text, terracotta accents"
          preview={<ThemePreview theme="light" />}
        />
        <ThemeCard
          active={theme === 'dark'}
          onClick={() => setTheme('dark')}
          label="Dark"
          sub="WurxOS signature peach on near-black"
          preview={<ThemePreview theme="dark" />}
        />
      </div>

      {/* ---------------- Font family ---------------- */}
      <div className="settings-row" style={{ alignItems: 'flex-start', marginTop: 6 }}>
        <div>
          <div className="settings-row-label-title">Font family</div>
          <div className="settings-row-label-sub">
            Sans fonts set the whole interface; Lora and JetBrains Mono apply to report and rich-text content only. Loaded from Google Fonts; your system font shows until it arrives.
          </div>
        </div>
        <div />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {FONT_FAMILIES.map((f) => (
          <FontFamilyCard
            key={f.key}
            active={fontFamily === f.key}
            onClick={() => setFontFamily(f.key)}
            label={f.label}
            sub={READING_FONTS.has(f.key) ? `Reading font — applies to report and rich-text content. ${f.note}` : f.note}
            stack={f.stack}
          />
        ))}
      </div>

      {/* ---------------- Font size ---------------- */}
      <div className="settings-row" style={{ alignItems: 'flex-start', marginTop: 6 }}>
        <div>
          <div className="settings-row-label-title">Font size</div>
          <div className="settings-row-label-sub">
            Scales the whole interface — text, padding, and icons.
          </div>
        </div>
        <div />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FONT_SIZES.map((s) => {
          const on = fontSize === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setFontSize(s.key)}
              className="wx-btn"
              style={{
                background: on ? 'var(--accent)' : 'transparent',
                color:      on ? 'var(--on-accent)' : 'var(--text-secondary)',
                border:     on ? 'none' : '1px solid var(--border-subtle)',
                fontWeight: 600,
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {on && <CheckIcon width="14" height="14" />}
              {s.label}
            </button>
          );
        })}
      </div>
    </SectionShell>
  );
}

// Mini mock-up rendered with the real theme tokens: nesting data-theme
// re-scopes every token inside, so the preview always matches the theme.
function ThemePreview({ theme }) {
  const bar = (bg, width, height = 5) => <div style={{ background: bg, width, height, borderRadius: 'var(--radius-xs)' }} />;
  return (
    <div data-theme={theme} data-bs-theme={theme} style={{
      height: '100%',
      background: 'linear-gradient(160deg, var(--surface-1) 0%, var(--surface-0) 100%)',
      padding: 10,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {bar('var(--accent)', 48, 6)}
      {bar('var(--surface-3)', '70%')}
      {bar('var(--surface-3)', '55%')}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 4 }}>
        {bar('var(--accent)', 28, 12)}
        <div style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', width: 36, height: 12, borderRadius: 'var(--radius-xs)' }} />
      </div>
    </div>
  );
}

function ThemeCard({ active, onClick, label, sub, preview }) {
  return (
    <button type="button" className="theme-card" data-active={active} onClick={onClick}>
      <div className="theme-card-preview">{preview}</div>
      <div className="theme-card-label">
        {label}
        {active && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
      </div>
      <div className="theme-card-sub">{sub}</div>
    </button>
  );
}

// Font family cards show a live preview of the family name rendered
// in its own font. Each card gets its own font stack so the preview
// shows even when the family isn't globally selected.
function FontFamilyCard({ active, onClick, label, sub, stack }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="theme-card"
      data-active={active}
      style={{ padding: 12 }}
    >
      <div
        style={{
          height: 64,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-2)',
          display: 'grid', placeItems: 'center',
          fontFamily: stack,
          fontSize: 22,
          fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: '-0.01em',
          marginBottom: 10,
          padding: '0 8px',
          textAlign: 'center',
          lineHeight: 1.1,
        }}
      >
        {label}
      </div>
      <div className="theme-card-label">
        {label}
        {active && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
      </div>
      <div className="theme-card-sub">{sub}</div>
    </button>
  );
}
