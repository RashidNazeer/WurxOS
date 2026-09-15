// ============================================================
// Halo V2 - Plan: if we plan TikTok at these assumptions, what Amazon effect
// should we discuss?
//
// Two things were wrong with this section, in opposite directions.
//
// It once rendered three editable percentages and a persuasive table from a
// model that was not eligible to produce them, with the blockers shown as a
// warning above. A warning is not a gate: the numbers were still on screen and
// still screenshot-able.
//
// The fix for that was a hard lock: no inputs, no table, nothing. Which took
// the section away from the one meeting where it is most needed, because a
// client with thin data still has to plan next quarter. They simply do it in a
// spreadsheet instead, where nothing is labelled at all.
//
// So: Assumptions mode. When the model cannot drive the scenarios, the client
// may still enter their own revenue, spend and halo percentages, and every
// figure that comes out is tagged ASSUMED, in the table, in the CSV and in the
// one-pager. What is never allowed is a model number appearing without saying
// it came from the model, or an assumed number wearing the modelled badge.
//
// The three percentages, when the model IS eligible, are its 95% lower bound,
// point estimate and upper bound. The spread between Conservative and Upside is
// then this model's real uncertainty rather than a decorative plus or minus 50%.
// ============================================================

import { PLANNING_MODES } from '../../lib/haloV2/planningScenarios.js';
import { FieldLabel, Note, Chip, EvidenceTag, moneyWith as money } from './shared.jsx';
import { Term } from './Glossary.jsx';

const COLUMN_HELP = {
  Halo: 'Off-platform revenue as a percentage of TikTok Shop sales.',
  'Per 1': 'Amazon revenue associated with each 1 of TikTok Shop sales.',
  'Off-platform': 'The Amazon revenue this scenario assumes moves alongside TikTok Shop sales.',
  'Total influenced': 'TikTok Shop sales plus the assumed off-platform revenue. Not a total of verified sales.',
  Spend: 'The TikTok marketing spend you entered for this period.',
  Multiple: 'Total influenced revenue divided by TikTok marketing spend. An assumption-driven ratio, not a measured return.',
};

const SCENARIO_HELP = {
  Conservative: 'The cautious case. In model mode this is the low end of the 95% interval.',
  Base: 'The central case. In model mode this is the point estimate.',
  Upside: 'The optimistic case. In model mode this is the high end of the 95% interval.',
};

const COLUMNS = ['Halo', 'Per 1', 'Off-platform', 'Total influenced', 'Spend', 'Multiple'];

export default function PlanningLayer({ result, planning, setPlanning, cur }) {
  const p = result.planning;
  const derived = result.planningDerived;
  const eligibility = result.planningEligibility;
  const mode = p?.mode || (derived?.usable ? 'model' : 'assumptions');
  const modelAvailable = !!derived?.usable;
  const sym = planning.currency || cur;
  const assumed = mode !== 'model';
  // The table is gated on revenue having been ENTERED, not on the scenario
  // objects existing. analyseHalo is handed the planning state on every render
  // so an edited percentage survives; with no revenue those scenarios are all
  // zero, and a table of zeros reads as a result rather than as an empty form.
  const hasRevenue = String(planning.ttsRevenue ?? '').trim() !== '';

  const set = (k, v) => setPlanning((s) => ({ ...s, [k]: v }));
  const live = currentAssumptions(p, derived);

  // Editing a percentage is an override only when there was a model figure to
  // override. In assumptions mode the numbers were never the model's, so the
  // chip stays ASSUMED rather than implying something was overridden.
  const editAssumption = (k, v) => setPlanning((s) => ({
    ...s,
    mode: modelAvailable ? 'override' : 'assumptions',
    assumptions: { ...(s.assumptions || live), [k]: Number(v) || 0 },
  }));
  const applyModel = () => setPlanning((s) => ({ ...s, mode: 'model', assumptions: { ...derived.assumptions } }));
  const resetFromModel = () => setPlanning((s) => ({ ...s, mode: 'model', assumptions: null }));

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Chip
          tone={mode === 'model' ? 'accent' : 'assumed'}
          icon={mode === 'model' ? 'bi-cpu' : mode === 'override' ? 'bi-pencil' : 'bi-sliders'}
          title={mode === 'model' ? 'These percentages came from the adjusted model.' : 'These percentages are assumptions, not measurements.'}
        >
          {mode === 'model' ? (p?.source || PLANNING_MODES.model) : PLANNING_MODES[mode]}
        </Chip>
        {modelAvailable && mode !== 'model' && (
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" onClick={applyModel}>
            <i className="bi bi-magic" style={{ marginRight: 6 }} />
            Apply model to Conservative, Base and Upside
          </button>
        )}
        {mode === 'override' && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={resetFromModel}>
            Reset from model
          </button>
        )}
      </div>

      {mode === 'model' && (
        <Note tone="success">
          These three are the model&apos;s <strong>95% lower bound, point estimate and upper bound</strong>
          {' '}on the {derived.basisLabel} basis, so the spread between them is this model&apos;s real
          uncertainty rather than a fixed plus or minus 50%. They are still <strong>assumptions</strong> at
          the point of use, never a forecast.
          {derived.lowerFloored && (
            <> The lower bound was <strong>{derived.lowerRaw}%</strong> and is held at 0% for planning: a
            negative halo is statistically possible, but not a budget anyone plans against.</>
          )}
        </Note>
      )}

      {!modelAvailable && <AssumptionsBanner blockers={eligibility?.blockers || []} />}

      {/* ── Setup ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', margin: '12px 0' }}>
        <div>
          <FieldLabel>TikTok Shop revenue</FieldLabel>
          <input className="wx-input" style={{ width: 150 }} value={planning.ttsRevenue}
            onChange={(e) => set('ttsRevenue', e.target.value)} placeholder="100000" inputMode="decimal" />
          <Help>Your own figure for the period you are planning.</Help>
        </div>
        <div>
          <FieldLabel>TikTok marketing spend</FieldLabel>
          <input className="wx-input" style={{ width: 150 }} value={planning.marketingSpend}
            onChange={(e) => set('marketingSpend', e.target.value)} placeholder="30000" inputMode="decimal" />
          <Help>Used for the multiple at the end of each row.</Help>
        </div>
        <div>
          <FieldLabel>Period</FieldLabel>
          <input className="wx-input" style={{ width: 130 }} value={planning.periodLabel || ''}
            onChange={(e) => set('periodLabel', e.target.value)} placeholder="Q4 2026" />
          <Help>Labels the table and both exports.</Help>
        </div>
        <div>
          <FieldLabel>Currency</FieldLabel>
          <select className="wx-input" style={{ width: 96 }} value={sym} onChange={(e) => set('currency', e.target.value)}>
            {[...new Set([cur, '$', '£', '€'])].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Help>Display only. It does not convert anything.</Help>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {['conservative', 'base', 'upside'].map((k) => {
          const label = k[0].toUpperCase() + k.slice(1);
          return (
            <div key={k}>
              <FieldLabel>
                {label} halo %
                {assumed && <span style={{ color: 'var(--warning)', marginLeft: 5 }}>ASSUMED</span>}
              </FieldLabel>
              <input
                className="wx-input"
                style={{ width: 110, borderColor: assumed ? 'var(--warning)' : undefined }}
                value={live[k]}
                inputMode="decimal"
                onChange={(e) => editAssumption(k, e.target.value)}
              />
              <Help>{SCENARIO_HELP[label]}</Help>
            </div>
          );
        })}
      </div>

      {/* ── Outputs ──────────────────────────────────────────── */}
      {!hasRevenue || !p?.base ? (
        <Note tone="info">
          Enter a TikTok Shop revenue figure above to see the three scenarios in Amazon currency.
        </Note>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800 }}>
              Scenario outputs{planning.periodLabel ? ` for ${planning.periodLabel}` : ''}
            </div>
            <EvidenceTag kind={assumed ? 'assumed' : 'modelled'} />
          </div>

          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 720 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Scenario</th>
                  {COLUMNS.map((h) => (
                    <th key={h} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }} title={COLUMN_HELP[h]}>
                      {h === 'Per 1' ? `Per ${sym}1` : h}
                      <i className="bi bi-question-circle" style={{ marginLeft: 4, fontSize: '.85em', color: 'var(--text-muted)' }} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[['Conservative', p.conservative], ['Base', p.base], ['Upside', p.upside]].map(([name, s]) => {
                  const isBase = name === 'Base';
                  return (
                    <tr
                      key={name}
                      style={{
                        borderTop: '1px solid var(--border-subtle)',
                        background: isBase ? 'var(--surface-2)' : undefined,
                      }}
                    >
                      <td style={{ padding: '8px', fontWeight: isBase ? 800 : 600, whiteSpace: 'nowrap' }}>
                        {name}
                        {isBase && <span style={{ marginLeft: 6 }}><Chip tone={assumed ? 'assumed' : 'accent'}>Recommended</Chip></span>}
                        {mode === 'model' && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>
                            {isBase ? 'point estimate' : name === 'Conservative' ? '95% lower bound' : '95% upper bound'}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px' }}>{s.haloPercent}%</td>
                      <td style={{ padding: '8px' }}>{sym}{s.haloPerCurrencyUnit.toFixed(2)}</td>
                      <td style={{ padding: '8px' }}>{money(sym, s.offPlatformRevenue)}</td>
                      <td style={{ padding: '8px', fontWeight: 700 }}>{money(sym, s.totalInfluencedRevenue)}</td>
                      <td style={{ padding: '8px', color: 'var(--text-muted)' }}>{money(sym, s.marketingSpend)}</td>
                      <td style={{ padding: '8px' }}>{s.blendedMultiple == null ? 'no spend entered' : `${s.blendedMultiple.toFixed(2)}x`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, maxWidth: 860 }}>
            Every figure in this table is an <strong>assumption, not a forecast</strong>. It is{' '}
            <Term term="Modelled">modelled</Term> association applied to revenue you supplied. It is not{' '}
            <Term term="Incremental">incremental</Term> lift, and not <Term term="Attributed">attributed</Term> sales.
            {' '}Off-platform revenue is the part this scenario puts on Amazon; total influenced adds your own
            TikTok Shop figure back on, so it is not a second pot of money.
          </div>
        </>
      )}

      <Note tone="planning">{p?.disclaimer || 'Planning assumptions, not measured results.'}</Note>
    </>
  );
}

// ── Assumptions mode banner ─────────────────────────────────────────
// The blockers double as the checklist of what would unlock model-driven
// scenarios, so the client sees the route rather than only the refusal.
function AssumptionsBanner({ blockers }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 'var(--radius-lg)',
      background: 'var(--warning-soft)', border: '1px solid var(--warning)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <i className="bi bi-sliders" style={{ color: 'var(--warning)' }} />
        <strong style={{ fontSize: 13 }}>Assumptions mode</strong>
        <EvidenceTag kind="assumed" />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.55, maxWidth: 860 }}>
        The model is not eligible to set these percentages, so nothing below comes from it. You can still
        plan: enter your own figures and every output is tagged ASSUMED, here and in both exports.
      </div>
      {blockers.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '10px 0 4px' }}>
            What would unlock model-driven scenarios
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {blockers.map((b) => (
              <li key={b.code} style={{ marginBottom: 4 }}>
                {b.message}{b.fix ? <span style={{ color: 'var(--text-muted)' }}> {b.fix}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const Help = ({ children }) => (
  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, maxWidth: 160, lineHeight: 1.35 }}>
    {children}
  </div>
);

// What the three inputs should show. Read back off the COMPUTED scenarios
// rather than component state, because analyseHalo is what decided which
// assumptions were actually used; duplicating that precedence here would be a
// second place for it to be wrong.
function currentAssumptions(planningResult, derived) {
  if (planningResult?.base) {
    return {
      conservative: planningResult.conservative.haloPercent,
      base: planningResult.base.haloPercent,
      upside: planningResult.upside.haloPercent,
    };
  }
  return derived?.assumptions || { conservative: 50, base: 100, upside: 150 };
}
