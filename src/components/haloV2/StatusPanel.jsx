// ============================================================
// Halo V2 — the guided status panel (brief §A3).
//
// This replaces the failure mode the brief opens with: a grid of em dashes, a
// blocked model, and no indication of whether the tool was broken, the data was
// missing, or the user had picked the wrong view.
//
// The panel answers four questions in a fixed order, because that is the order
// someone actually has them:
//   1. What is not available (and specifically, is it correlations, the model,
//      or both)?
//   2. What can I still see regardless?
//   3. Why exactly — the real numbers, n against the requirement.
//   4. What do I do about it, as a button I can press right now.
//
// The primary action is almost always "switch grain", because it usually costs
// nothing: the data is already loaded and another bucketing of it works.
// ============================================================

import { Note, ProgressMeter } from './shared.jsx';

export default function StatusPanel({
  assessment,           // assessGrain() for the CURRENT grain
  recommendation,       // recommendGrain() across all grains
  suggestion,           // grainSwitchSuggestion() or null
  onSwitchGrain,
  onKeepExploring,
  hasSeries,
  blockedCorrelations,
  blockedModel,
}) {
  if (!assessment) return null;

  // Name precisely what is blocked. "Not enough history" is unhelpfully vague
  // when correlations work fine and only the regression is short.
  const what = blockedCorrelations && blockedModel ? 'correlations or an adjusted model'
    : blockedModel ? 'an adjusted model'
    : 'correlations';

  return (
    <div
      className="wx-card"
      style={{
        padding: 18,
        borderLeft: '3px solid var(--warning, #f59e0b)',
        background: 'linear-gradient(to right, rgba(245,158,11,.05), transparent 60%)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <i className="bi bi-signpost-split" style={{ color: 'var(--warning, #f59e0b)' }} />
        <h3 style={{ fontSize: '1rem', fontWeight: 800, margin: 0 }}>
          Not enough history for {what} at {assessment.label} yet
        </h3>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 12px', maxWidth: 720 }}>
        This is a data-volume limit, not an error. {recommendation?.reason}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        {/* 2 — what still works. Deliberately FIRST of the two columns: the
            reassurance has to arrive before the arithmetic. */}
        <div>
          <SectionLabel>What you can still see</SectionLabel>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {hasSeries && <li>Descriptive charts over time and the scatter — Stage 1 is complete.</li>}
            {!blockedCorrelations && <li>Signed correlations at every lag with enough overlap.</li>}
            {blockedCorrelations && (
              <li>
                Correlations unlock at ≥ {assessment.correlationRequired} overlapping periods
                — this view has {assessment.correlationObs}.
              </li>
            )}
            {assessment.canModel && assessment.lagReduced && (
              <li>
                A reduced {assessment.feasibleLag === 0 ? `same-${assessment.unit}` : `${assessment.feasibleLag}-${assessment.unit}`} model,
                which this history can support.
              </li>
            )}
          </ul>
        </div>

        {/* 3 — why, with the real numbers rather than a vague shortage. */}
        <div>
          <SectionLabel>What is blocked, and why</SectionLabel>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {blockedModel ? (
              <>
                The adjusted model needs about <strong>{assessment.required}</strong> usable {assessment.unit}s
                to estimate {assessment.parameterCount} parameters
                {assessment.droppedToLags > 0 && (
                  <> (the lag window costs the first {assessment.droppedToLags} {assessment.droppedToLags === 1 ? assessment.unit : `${assessment.unit}s`})</>
                )}
                . This view has <strong>{assessment.usable}</strong>.
              </>
            ) : (
              <>The adjusted model is available at this grain.</>
            )}
          </div>
          {blockedModel && (
            <ProgressMeter
              usable={assessment.usable}
              required={assessment.required}
              unit={assessment.unit}
              almostThere={assessment.almostThere}
            />
          )}
        </div>
      </div>

      {/* 4 — the action. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        {suggestion && (
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" onClick={() => onSwitchGrain(suggestion.grain)}>
            <i className="bi bi-arrow-repeat" style={{ marginRight: 6 }} />{suggestion.cta}
          </button>
        )}
        {onKeepExploring && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onKeepExploring}>
            Keep {assessment.label} and explore charts only
          </button>
        )}
      </div>
      {suggestion && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{suggestion.detail}</div>
      )}

      {/* When even switching grain will not help, the only honest answer is
          more time or a wider range — say that rather than offering a button
          that changes nothing. */}
      {!suggestion && blockedModel && (
        <Note tone="info">
          No other grain does better over this date range. Widening the dates, or
          waiting for {Math.max(1, assessment.shortfall)} more {assessment.shortfall === 1 ? assessment.unit : `${assessment.unit}s`} of
          data, is what unlocks the adjusted model.
        </Note>
      )}
    </div>
  );
}

const SectionLabel = ({ children }) => (
  <div style={{
    fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase',
    color: 'var(--text-muted)', marginBottom: 6,
  }}>{children}</div>
);
