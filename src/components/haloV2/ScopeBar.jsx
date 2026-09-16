// ============================================================
// Halo V2 - the scope bar (round 2: decongest).
//
// Round 1 put brand, period, badge, mode toggle and four export buttons on one
// row, then a second row of View + two native date inputs + the metric pair +
// a glossary button. Seven controls and a toolbar before the answer. The review
// was blunt about it: a CMO opens Meeting and sees a dashboard, not a result.
//
// So: ONE row. A segmented view switch, a date range that collapses to a chip,
// what is being compared, and a single Share menu. Brand is not here at all
// (the page already has a brand dropdown, and showing it three times was the
// complaint). The badge is not here either; it belongs on the number it
// qualifies, in the Snapshot, once.
//
// Everything an analyst needs is still one click away in Lab, which is the
// point of having two views.
// ============================================================

import { useState } from 'react';
import { GRAIN_LABEL } from '../../lib/haloV2/grainRecommendation.js';
import { plainMetricLabel, comparisonSentence } from '../../lib/haloV2/plainLanguage.js';
import { Picker, ModeToggle, Popover } from './shared.jsx';

// ── View: Daily / Weekly / Monthly ──────────────────────────────────
// The "(recommended)" suffix and the "32 usable days here" helper moved into
// the tooltip. They are guidance for someone choosing; they do not need to
// occupy the first viewport permanently.
function ViewSegments({ grans, gran, onGran, assessments, recommendation }) {
  return (
    <div
      role="group"
      aria-label="View"
      style={{
        display: 'inline-flex', gap: 2, padding: 3, borderRadius: 999,
        background: 'var(--surface-3)', border: '1px solid var(--border-subtle)',
      }}
    >
      {grans.map((g) => {
        const on = g === gran;
        const a = assessments?.[g];
        const parts = [];
        if (recommendation?.grain === g) parts.push('Recommended for this data.');
        if (a) parts.push(`${a.usable} usable ${a.unit}s here.`);
        if (a && !a.canModel) parts.push('Charts only: not enough history for a model at this view.');
        return (
          <button
            key={g}
            type="button"
            onClick={() => onGran(g)}
            aria-pressed={on}
            title={parts.join(' ') || undefined}
            style={{
              border: 'none', background: on ? 'var(--surface-1)' : 'transparent',
              color: on ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: on ? 800 : 600, fontSize: 12, padding: '5px 12px', borderRadius: 999,
              boxShadow: on ? 'var(--shadow-sm)' : 'none', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {GRAIN_LABEL[g]}
            {recommendation?.grain === g && (
              <span aria-hidden="true" style={{ marginLeft: 5, color: 'var(--accent)', fontSize: 9 }}>●</span>
            )}
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

// Shift an ISO date by n days without touching local time.
const shiftDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

// ── Date range: one chip, a popover behind it ───────────────────────
function DateRangeChip({ range, setRange, span }) {
  const [open, setOpen] = useState(false);
  const label = range?.start && range?.end
    ? `${fmtDay(range.start)} – ${fmtDay(range.end)}`
    : 'All dates';
  const isAll = span?.start && range?.start === span.start && range?.end === span.end;

  // Presets run back from the END OF THE DATA, not from today: these sheets are
  // uploaded in batches and the last row is routinely weeks old, so "last 30
  // days" measured from today would select nothing.
  const preset = (days) => {
    if (!span?.end) return;
    const start = shiftDays(span.end, -(days - 1));
    setRange({ start: start < span.start ? span.start : start, end: span.end });
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="wx-btn wx-btn-ghost wx-btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
      >
        <i className="bi bi-calendar3" />
        {label}
        <i className={`bi bi-chevron-${open ? 'up' : 'down'}`} style={{ fontSize: 10 }} />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={272}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <label style={{ flex: 1, fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            From
            <input
              type="date" className="wx-input" style={{ width: '100%', marginTop: 3 }}
              value={range.start} min={span?.start || undefined} max={range.end || span?.end || undefined}
              onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
            />
          </label>
          <label style={{ flex: 1, fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            To
            <input
              type="date" className="wx-input" style={{ width: '100%', marginTop: 3 }}
              value={range.end} min={range.start || span?.start || undefined} max={span?.end || undefined}
              onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => preset(30)}>Last 30 days</button>
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => preset(90)}>Last 90 days</button>
          <button
            type="button"
            className="wx-btn wx-btn-ghost wx-btn-sm"
            disabled={isAll || !span?.start}
            onClick={() => setRange({ start: span.start, end: span.end })}
          >
            All data
          </button>
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

// ── Share: one button, everything that leaves the page behind it ────
function ShareMenu({ onManageLinks, onPdf, onCsv, onPng, busy, lab }) {
  const [open, setOpen] = useState(false);
  const run = (fn) => () => { setOpen(false); fn(); };

  const Item = ({ icon, label, hint, onClick, disabled }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="wx-btn wx-btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontWeight: 700,
        }}
      >
        <i className="bi bi-share" />Share
        <i className={`bi bi-chevron-${open ? 'up' : 'down'}`} style={{ fontSize: 10 }} />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={286} align="right">
        {onManageLinks && (
          <>
            <Item
              icon="bi-link-45deg"
              label="Share with a client"
              hint="Create or revoke read-only links"
              onClick={run(onManageLinks)}
            />
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '6px 2px' }} />
          </>
        )}
        <Item
          icon="bi-file-earmark-pdf"
          label={busy === 'pdf' ? 'Building the one-pager…' : 'Download one-pager (PDF)'}
          hint="The answer, one chart and the method, on a page"
          onClick={run(onPdf)}
          disabled={!!busy}
        />
        <Item
          icon="bi-filetype-csv"
          label="Export CSV for finance"
          hint="Scenarios and the series, with evidence tags"
          onClick={run(onCsv)}
        />
        {/* PNG is kept for the operator who wants to paste into a slide, and
            kept OUT of the client view, where the PDF is the one export that
            matters. */}
        {lab && onPng && (
          <Item
            icon="bi-image"
            label={busy === 'png' ? 'Building the image…' : 'Download PNG image'}
            onClick={run(onPng)}
            disabled={!!busy}
          />
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
  onGlossary, onMethodology, finder, children,
}) {
  return (
    <div className="wx-card" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <ViewSegments
          grans={grans} gran={gran} onGran={onGran}
          assessments={assessments} recommendation={recommendation}
        />
        <DateRangeChip range={range} setRange={setRange} span={span} />
        {/* Closed by default. It ranks every TikTok metric, which is a
            question worth asking occasionally and never worth a panel. */}
        {finder}

        {lab ? (
          <>
            <Picker
              label="TikTok activity" value={xKey} onChange={setXKey}
              options={tiktokFields.map((f) => ({ value: f.key, label: plainMetricLabel(f.key) }))}
              width={190}
            />
            <Picker
              label="Amazon outcome" value={yKey} onChange={setYKey}
              options={amazonFields.map((f) => ({ value: f.key, label: plainMetricLabel(f.key) }))}
              width={190}
            />
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onReset}>
              <i className="bi bi-arrow-counterclockwise" style={{ marginRight: 5 }} />Reset
            </button>
            {onGlossary && (
              <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onGlossary}>
                <i className="bi bi-question-circle" style={{ marginRight: 5 }} />Terms
              </button>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ color: 'var(--text-muted)' }}>Comparing</span>
            {/* Truncated rather than wrapped: the metric pair can be 40
                characters, and letting it wrap pushes Share onto a second row,
                which is the row this redesign exists to remove. */}
            <strong
              title={comparisonSentence(xKey, yKey)}
              style={{
                color: 'var(--text-primary)', maxWidth: 260, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {comparisonSentence(xKey, yKey)}
            </strong>
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={() => onMode('lab')}>
              Change metrics
            </button>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Methodology is a modal, not a band on the page. */}
          {onMethodology && (
            <button
              type="button"
              className="wx-btn wx-btn-ghost wx-btn-sm"
              onClick={onMethodology}
              style={{ whiteSpace: 'nowrap' }}
            >
              <i className="bi bi-journal-text" style={{ marginRight: 5 }} />Methodology
            </button>
          )}
          {/* Lab is a detour, so it needs a door back that is not a small pill.
              Change metrics drops a client straight in here. */}
          {lab && (
            <button
              type="button"
              className="wx-btn wx-btn-sm"
              onClick={() => onMode('meeting')}
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)', fontWeight: 700, whiteSpace: 'nowrap' }}
            >
              <i className="bi bi-arrow-left" style={{ marginRight: 5 }} />Back to Meeting
            </button>
          )}
          <ModeToggle mode={mode} onChange={onMode} />
          <ShareMenu
            onManageLinks={onManageLinks} onPdf={onPdf} onCsv={onCsv} onPng={onPng}
            busy={exportBusy} lab={lab}
          />
        </div>
      </div>
      {children}
    </div>
  );
}
