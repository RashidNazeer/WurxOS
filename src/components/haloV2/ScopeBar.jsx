// ============================================================
// Halo V2 - the scope bar.
//
// ONE row of controls, all the same height, all the same shape.
//
// Why the explicit sizing: `wx-btn-sm` does not exist in any stylesheet. Every
// button here was therefore rendering at full `.wx-btn` size (14px text, 11px
// padding, about 40px tall) next to 12px segmented pills about 30px tall, which
// is why the bar had two visual scales, mismatched corner radii and no
// alignment. Rather than invent an app-wide size class, the bar sizes its own
// controls from one constant.
//
// Layout, identical in both views so switching does not reshuffle the page:
//
//   [ Daily Weekly Monthly ] [ dates ] [ Halo Finder ] [ metrics ]
//                                 ... [ Methodology ] [ Meeting Lab ] [ Share ]
//
// Lab adds a second line under a divider for the analyst controls, so the main
// row never changes shape between views.
//
// The metric pair used to sit in the row as the sentence "Comparing TikTok Shop
// sales (GMV) vs Amazon revenue" followed by a Change metrics button: a run of
// loose text and a CTA wedged between pills, which is what made the row look
// broken. It is now the fourth pill: a quiet chip in Meeting, and the control
// that opens the two pickers in Lab.
// ============================================================

import { useState } from 'react';
import { GRAIN_LABEL } from '../../lib/haloV2/grainRecommendation.js';
import { plainMetricLabel, comparisonSentence } from '../../lib/haloV2/plainLanguage.js';
import { metricLabel } from '../../lib/haloV2/metricMetadata.js';
import { Popover, BarButton, barBtnStyle, BAR_H, BAR_FONT as FONT } from './shared.jsx';

const SEG_INNER_H = BAR_H - 8;          // outer padding 3px + 1px border each side

// A segmented control. Both groups in this bar use it, so View and
// Meeting/Lab cannot drift to different heights again.
function Segments({ label, options, value, onChange }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        height: BAR_H, display: 'inline-flex', alignItems: 'center', gap: 2, padding: 3,
        borderRadius: 999, background: 'var(--surface-3)', border: '1px solid var(--border-subtle)',
        boxSizing: 'border-box',
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            title={o.title}
            style={{
              height: SEG_INNER_H, display: 'inline-flex', alignItems: 'center', gap: 4,
              border: 'none', padding: '0 11px', borderRadius: 999, cursor: 'pointer',
              fontSize: FONT, fontFamily: 'inherit', lineHeight: 1,
              fontWeight: on ? 800 : 600,
              background: on ? 'var(--surface-1)' : 'transparent',
              color: on ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
            {o.dot && <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 8 }}>●</span>}
          </button>
        );
      })}
    </div>
  );
}

const fmtDay = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const shiftDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function DateRangeChip({ range, setRange, span }) {
  const [open, setOpen] = useState(false);
  // En dash, and no "to": the shortest honest label, because this pill sits in
  // a row that has to fit seven controls.
  const label = range?.start && range?.end ? `${fmtDay(range.start)} – ${fmtDay(range.end)}` : 'All dates';
  const isAll = span?.start && range?.start === span.start && range?.end === span.end;

  // Presets run back from the END OF THE DATA, not from today: these sheets
  // arrive in batches and the last row is routinely weeks old, so "last 30
  // days" measured from today would select nothing.
  const preset = (days) => {
    if (!span?.end) return;
    const start = shiftDays(span.end, -(days - 1));
    setRange({ start: start < span.start ? span.start : start, end: span.end });
  };

  return (
    <div style={{ position: 'relative' }}>
      <BarButton icon="bi-calendar3" chevron open={open} ariaExpanded={open}
        title="Change the date range" onClick={() => setOpen((s) => !s)}>
        {label}
      </BarButton>
      <Popover open={open} onClose={() => setOpen(false)} width={272}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Field label="From">
            <input
              type="date" className="wx-input" style={{ width: '100%', padding: '8px 10px', fontSize: 12.5 }}
              value={range.start} min={span?.start || undefined} max={range.end || span?.end || undefined}
              onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
            />
          </Field>
          <Field label="To">
            <input
              type="date" className="wx-input" style={{ width: '100%', padding: '8px 10px', fontSize: 12.5 }}
              value={range.end} min={range.start || span?.start || undefined} max={span?.end || undefined}
              onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
            />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <MenuChip onClick={() => preset(30)}>Last 30 days</MenuChip>
          <MenuChip onClick={() => preset(90)}>Last 90 days</MenuChip>
          <MenuChip disabled={isAll || !span?.start} onClick={() => setRange({ start: span.start, end: span.end })}>
            All data
          </MenuChip>
        </div>
        {span?.start && (
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 8 }}>
            This brand has data from {fmtDay(span.start)} to {fmtDay(span.end)}.
          </div>
        )}
      </Popover>
    </div>
  );
}

// The metric pair. A label in Meeting, a picker in Lab, the same slot and the
// same size either way.
function MetricsControl({ lab, xKey, yKey, setXKey, setYKey, tiktokFields, amazonFields }) {
  const [open, setOpen] = useState(false);
  const pair = `${metricLabel(xKey)} vs ${metricLabel(yKey)}`;
  const full = comparisonSentence(xKey, yKey);

  if (!lab) {
    return (
      <span title={full} style={{ ...barBtnStyle({ quiet: true }), borderStyle: 'dashed', color: 'var(--text-secondary)' }}>
        {/* 13px to match every other leading icon in the bar. */}
        <i className="bi bi-arrow-left-right" style={{ fontSize: 13, color: 'var(--text-muted)' }} />
        {pair}
      </span>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <BarButton icon="bi-arrow-left-right" chevron open={open} ariaExpanded={open}
        title={full} onClick={() => setOpen((s) => !s)}>
        {pair}
      </BarButton>
      <Popover open={open} onClose={() => setOpen(false)} width={300}>
        <Field label="TikTok activity">
          <select className="wx-input" style={{ width: '100%', padding: '8px 10px', fontSize: 12.5 }}
            value={xKey} onChange={(e) => setXKey(e.target.value)}>
            {tiktokFields.map((f) => <option key={f.key} value={f.key}>{plainMetricLabel(f.key)}</option>)}
          </select>
        </Field>
        <div style={{ height: 8 }} />
        <Field label="Amazon outcome">
          <select className="wx-input" style={{ width: '100%', padding: '8px 10px', fontSize: 12.5 }}
            value={yKey} onChange={(e) => setYKey(e.target.value)}>
            {amazonFields.map((f) => <option key={f.key} value={f.key}>{plainMetricLabel(f.key)}</option>)}
          </select>
        </Field>
      </Popover>
    </div>
  );
}

function ShareMenu({ onManageLinks, onPdf, onCsv, onPng, busy, lab }) {
  const [open, setOpen] = useState(false);
  const run = (fn) => () => { setOpen(false); fn(); };

  return (
    <div style={{ position: 'relative' }}>
      <BarButton icon="bi-share" chevron open={open} accent ariaExpanded={open}
        title="Share this view or download it" onClick={() => setOpen((s) => !s)}>
        Share
      </BarButton>
      <Popover open={open} onClose={() => setOpen(false)} width={288} align="right">
        {onManageLinks && (
          <>
            <MenuItem icon="bi-link-45deg" label="Share with a client"
              hint="Create or revoke read-only links" onClick={run(onManageLinks)} />
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '6px 2px' }} />
          </>
        )}
        <MenuItem
          icon="bi-file-earmark-pdf"
          label={busy === 'pdf' ? 'Building the one-pager…' : 'Download one-pager (PDF)'}
          hint="The answer, one chart and the method, on a page"
          onClick={run(onPdf)} disabled={!!busy}
        />
        <MenuItem icon="bi-filetype-csv" label="Export CSV for finance"
          hint="Scenarios and the series, with evidence tags" onClick={run(onCsv)} />
        {/* PNG is kept for the operator pasting into a slide, and kept out of
            the client view where the PDF is the export that matters. */}
        {lab && onPng && (
          <MenuItem icon="bi-image" label={busy === 'png' ? 'Building the image…' : 'Download PNG image'}
            onClick={run(onPng)} disabled={!!busy} />
        )}
      </Popover>
    </div>
  );
}

export default function ScopeBar({
  mode, onMode, lab,
  grans, gran, onGran, assessments, recommendation,
  range, setRange, span,
  xKey, yKey, setXKey, setYKey, tiktokFields, amazonFields, onReset,
  onManageLinks, onPdf, onCsv, onPng, exportBusy,
  onGlossary, onMethodology, finder, analystPanel,
}) {
  const [analystOpen, setAnalystOpen] = useState(false);

  const viewOptions = grans.map((g) => {
    const a = assessments?.[g];
    const parts = [];
    if (recommendation?.grain === g) parts.push('Recommended for this data.');
    if (a) parts.push(`${a.usable} usable ${a.unit}s here.`);
    if (a && !a.canModel) parts.push('Charts only: not enough history for a model at this view.');
    return {
      value: g,
      label: GRAIN_LABEL[g],
      dot: recommendation?.grain === g,
      title: parts.join(' ') || undefined,
    };
  });

  return (
    <div className="wx-card" style={{ padding: '10px 14px' }}>
      {/* Main row: same controls, same order, same size in both views. */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', rowGap: 8 }}>
        <Segments label="View" options={viewOptions} value={gran} onChange={onGran} />
        <DateRangeChip range={range} setRange={setRange} span={span} />
        {finder}
        <MetricsControl
          lab={lab} xKey={xKey} yKey={yKey} setXKey={setXKey} setYKey={setYKey}
          tiktokFields={tiktokFields} amazonFields={amazonFields}
        />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          {onMethodology && (
            <BarButton icon="bi-journal-text" onClick={onMethodology}
              title="How this was produced, and what it does not cover">
              Methodology
            </BarButton>
          )}
          <Segments
            label="View mode"
            value={mode}
            onChange={onMode}
            options={[
              { value: 'meeting', label: 'Meeting', title: 'The client view: the answer, the evidence behind it, and the plan.' },
              { value: 'lab', label: 'Lab', title: 'Everything in Meeting plus metric pickers, diagnostics and the stage ladder.' },
            ]}
          />
          <ShareMenu
            onManageLinks={onManageLinks} onPdf={onPdf} onCsv={onCsv} onPng={onPng}
            busy={exportBusy} lab={lab}
          />
        </div>
      </div>

      {/* Lab's own line, under a divider, so the main row keeps its shape. */}
      {lab && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <BarButton icon={`bi-chevron-${analystOpen ? 'up' : 'down'}`} onClick={() => setAnalystOpen((s) => !s)}
              ariaExpanded={analystOpen} open={analystOpen} title="Lag window, controls and chart options">
              Analyst options
            </BarButton>
            {onGlossary && (
              <BarButton icon="bi-question-circle" onClick={onGlossary} title="What the terms on this page mean">
                Terms
              </BarButton>
            )}
            <BarButton icon="bi-arrow-counterclockwise" onClick={onReset}
              title="Put the view, dates, metrics and every analyst option back to their defaults">
              Reset
            </BarButton>
          </div>
          {analystOpen && analystPanel && (
            <div style={{ marginTop: 10 }}>{analystPanel}</div>
          )}
        </div>
      )}
    </div>
  );
}

const Field = ({ label, children }) => (
  <label style={{ flex: 1, display: 'block', fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
    <span style={{ display: 'block', marginBottom: 3 }}>{label}</span>
    {children}
  </label>
);

const MenuChip = ({ children, onClick, disabled }) => (
  <button
    type="button" onClick={onClick} disabled={disabled}
    style={{
      height: 26, padding: '0 10px', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
      borderRadius: 999, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-default)',
    }}
  >{children}</button>
);

const MenuItem = ({ icon, label, hint, onClick, disabled }) => (
  <button
    type="button" onClick={onClick} disabled={disabled}
    style={{
      display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left',
      background: 'none', border: 'none', padding: '7px 8px', borderRadius: 'var(--radius-md)',
      color: 'var(--text-primary)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
      font: 'inherit', fontSize: 12.5,
    }}
    onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--surface-2)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
  >
    <i className={`bi ${icon}`} style={{ marginTop: 2, color: 'var(--text-muted)' }} />
    <span>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span>}
    </span>
  </button>
);
