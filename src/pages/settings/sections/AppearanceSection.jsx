import { useTheme, FONT_FAMILIES, FONT_SIZES } from '../../../contexts/ThemeContext';
import { PaletteIcon, CheckIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

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
          sub="Warm cream background, terracotta accents"
          preview={(
            <div style={{
              height: '100%',
              background: 'linear-gradient(160deg, #faf7f2 0%, #fdf0e6 100%)',
              padding: 10,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ background: '#c2704e', width: 48, height: 6, borderRadius: 3 }} />
              <div style={{ background: '#e2e8f0', width: '70%', height: 5, borderRadius: 3 }} />
              <div style={{ background: '#e2e8f0', width: '55%', height: 5, borderRadius: 3 }} />
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <div style={{ background: '#c2704e', width: 28, height: 12, borderRadius: 3 }} />
                <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', width: 36, height: 12, borderRadius: 3 }} />
              </div>
            </div>
          )}
        />
        <ThemeCard
          active={theme === 'dark'}
          onClick={() => setTheme('dark')}
          label="Dark"
          sub="WurxOS signature peach on black"
          preview={(
            <div style={{
              height: '100%',
              background: 'linear-gradient(160deg, #0f0f0f 0%, #000 100%)',
              padding: 10,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ background: '#f5d5a8', width: 48, height: 6, borderRadius: 3 }} />
              <div style={{ background: 'rgba(245,213,168,0.25)', width: '70%', height: 5, borderRadius: 3 }} />
              <div style={{ background: 'rgba(245,213,168,0.2)', width: '55%', height: 5, borderRadius: 3 }} />
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <div style={{ background: '#f5d5a8', width: 28, height: 12, borderRadius: 3 }} />
                <div style={{ background: '#1a1a1a', border: '1px solid rgba(245,213,168,0.22)', width: 36, height: 12, borderRadius: 3 }} />
              </div>
            </div>
          )}
        />
      </div>

      {/* ---------------- Font family ---------------- */}
      <div className="settings-row" style={{ alignItems: 'flex-start', marginTop: 6 }}>
        <div>
          <div className="settings-row-label-title">Font family</div>
          <div className="settings-row-label-sub">
            System stacks only — no external fonts are loaded.
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
            sub={f.note}
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
                borderRadius: 10,
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
