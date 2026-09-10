// ============================================================
// Halo V2 — Layer C, Investment Planning (brief §H).
//
// The old version had one button: "Use adjusted model estimate as Base (167%)".
// It set Base alone, from the FULL cumulative — a figure carrying same-period
// co-movement — and left Conservative and Upside at 50% and 150%. One click put
// a number that was not a halo into a plan, flanked by two arbitrary ones.
//
// Now the model either drives ALL THREE scenarios from its interval, or it
// drives none and says why. There is no middle state where a plan is part
// measurement and part round number without saying which is which — that
// ambiguity is the thing §H exists to remove.
// ============================================================

import { fmtValue } from '../../lib/haloFields';
import { DEFAULT_ASSUMPTIONS } from '../../lib/haloV2/planningScenarios.js';
import { FieldLabel, Note, ModelledBadge } from './shared.jsx';

export default function PlanningLayer({ result, planning, setPlanning, cur }) {
  const p = result.planning;
  const derived = result.planningDerived;
  const eligibility = result.planningEligibility;
  const mode = p?.mode || 'assumptions';

  const set = (k, v) => setPlanning((s) => ({ ...s, [k]: v }));

  // Editing ANY scenario flips the mode to override. The label has to stop
  // saying "From adjusted model" the moment a number stops coming from it.
  const editAssumption = (k, v) => setPlanning((s) => ({
    ...s,
    mode: 'override',
    assumptions: { ...(s.assumptions || currentAssumptions(p, derived)), [k]: Number(v) || 0 },
  }));

  const applyModel = () => setPlanning((s) => ({ ...s, mode: 'model', assumptions: { ...derived.assumptions } }));
  // null assumptions → analyseHalo re-reads the derived values, so a reset
  // follows the model if the date range or metric pair has moved on since.
  const resetFromModel = () => setPlanning((s) => ({ ...s, mode: 'model', assumptions: null }));

  const live = currentAssumptions(p, derived);
  const assumed = mode !== 'model';

  return (
    <>
      {/* ── Mode banner ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <ModeChip mode={mode} source={p?.source} />
        {derived?.usable && mode !== 'model' && (
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" onClick={applyModel}>
            <i className="bi bi-magic" style={{ marginRight: 6 }} />
            Apply model to Conservative / Base / Upside
          </button>
        )}
        {derived?.usable && mode === 'override' && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={resetFromModel}>
            Reset from model
          </button>
        )}
        {eligibility?.weakHaloClaim && <ModelledBadge weakHalo />}
      </div>

      {/* ── Assumptions mode: say why, and how to fix it ─────────── */}
      {!derived?.usable && (
        <Note tone="planning">
          <strong>Planning assumptions — the model is not eligible to drive these.</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {(eligibility?.blockers || []).map((b) => (
              <li key={b.code} style={{ marginBottom: 4 }}>
                {b.message} <span style={{ color: 'var(--text-muted)' }}>{b.fix}</span>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
            The figures below are editable placeholders. They are not measurements and
            not derived from anything on this page.
          </div>
        </Note>
      )}

      {derived?.usable && mode === 'model' && (
        <Note tone="success">
          Conservative, Base and Upside are the model&apos;s{' '}
          <strong>95% lower bound, point estimate and upper bound</strong> on the{' '}
          {derived.basisLabel} basis — so the spread between them is this model&apos;s actual
          uncertainty rather than a fixed ±50%.
          {derived.lowerFloored && (
            <> The lower bound was <strong>{derived.lowerRaw}%</strong> and has been floored at 0% for
            planning: a negative halo is a statistical possibility, but not a budget anyone plans against.</>
          )}
        </Note>
      )}

      {/* ── Inputs ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', margin: '12px 0' }}>
        <div>
          <FieldLabel>TikTok Shop revenue</FieldLabel>
          <input className="wx-input" style={{ width: 160 }} value={planning.ttsRevenue}
            onChange={(e) => set('ttsRevenue', e.target.value)} placeholder="100000" />
        </div>
        <div>
          <FieldLabel>TikTok marketing spend</FieldLabel>
          <input className="wx-input" style={{ width: 160 }} value={planning.marketingSpend}
            onChange={(e) => set('marketingSpend', e.target.value)} placeholder="30000" />
        </div>
        {['conservative', 'base', 'upside'].map((k) => (
          <div key={k}>
            <FieldLabel>
              {k[0].toUpperCase() + k.slice(1)} %
              {assumed && <span style={{ color: 'var(--warning, #f59e0b)', marginLeft: 4 }}>ASSUMED</span>}
            </FieldLabel>
            <input
              className="wx-input"
              style={{ width: 110, borderColor: assumed ? 'rgba(245,158,11,.45)' : undefined }}
              value={live[k]}
              onChange={(e) => editAssumption(k, e.target.value)}
            />
          </div>
        ))}
      </div>

      {/* ── Scenario table ──────────────────────────────────────── */}
      {!p?.base ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>
          Enter a TikTok Shop revenue figure to model conservative, base and upside halo scenarios.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 620 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Scenario</th>
                <th style={{ padding: '6px 8px' }}>Halo</th>
                <th style={{ padding: '6px 8px' }}>Per {cur}1</th>
                <th style={{ padding: '6px 8px' }}>Off-platform</th>
                <th style={{ padding: '6px 8px' }}>Total influenced</th>
                <th style={{ padding: '6px 8px' }}>Blended multiple</th>
              </tr>
            </thead>
            <tbody>
              {[['Conservative', p.conservative], ['Base', p.base], ['Upside', p.upside]].map(([name, s]) => (
                <tr key={name} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>
                    {name}
                    {mode === 'model' && name === 'Base' && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>point estimate</span>
                    )}
                    {mode === 'model' && name === 'Conservative' && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>95% lower</span>
                    )}
                    {mode === 'model' && name === 'Upside' && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>95% upper</span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{s.haloPercent}%</td>
                  <td style={{ padding: '6px 8px' }}>{cur}{s.haloPerCurrencyUnit.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px' }}>{fmtValue(s.offPlatformRevenue, 'money')}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 700 }}>{fmtValue(s.totalInfluencedRevenue, 'money')}</td>
                  <td style={{ padding: '6px 8px' }}>{s.blendedMultiple == null ? '—' : `${s.blendedMultiple.toFixed(2)}x`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Note tone="planning">{p?.disclaimer || 'Planning assumptions — not measured results.'}</Note>
    </>
  );
}

// What the three inputs should show.
//
// Read back off the COMPUTED scenarios rather than from component state,
// because analyseHalo is what decided which assumptions were actually used
// (an explicit override if there is one, the derived figures if the model is
// driving, the placeholders otherwise). Duplicating that precedence here would
// be a second place for it to be wrong.
//
// Before any revenue is entered there are no scenarios to read, so fall back to
// the same order analyseHalo would have applied.
function currentAssumptions(planningResult, derived) {
  if (planningResult?.base) {
    return {
      conservative: planningResult.conservative.haloPercent,
      base: planningResult.base.haloPercent,
      upside: planningResult.upside.haloPercent,
    };
  }
  if (derived?.usable) return derived.assumptions;
  return DEFAULT_ASSUMPTIONS;
}

function ModeChip({ mode, source }) {
  const c = mode === 'model'
    ? { bg: 'rgba(34,197,94,.14)', bd: 'rgba(34,197,94,.4)', fg: 'var(--success, #22c55e)', icon: 'bi-cpu', text: source || 'From adjusted model' }
    : mode === 'override'
      ? { bg: 'rgba(99,102,241,.14)', bd: 'rgba(99,102,241,.4)', fg: 'var(--accent)', icon: 'bi-pencil', text: 'Manual override' }
      : { bg: 'rgba(245,158,11,.14)', bd: 'rgba(245,158,11,.4)', fg: 'var(--warning, #f59e0b)', icon: 'bi-sliders', text: 'Planning assumptions' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999,
      background: c.bg, border: `1px solid ${c.bd}`, color: c.fg,
    }}>
      <i className={`bi ${c.icon}`} />{c.text}
    </span>
  );
}
