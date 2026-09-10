// ============================================================
// Halo V2 — Scenarios: "What if we invest more?" (brief §H + builder §86.1–2).
//
// This section is now HARD GATED. Previously an ineligible model still rendered
// three editable percentages and a full scenario table, with the blockers shown
// as a warning above them. That is a warning, not a gate: the persuasive output
// — off-platform revenue, total influenced revenue, a blended multiple — was
// still on screen, still screenshot-able, and still looked like a result. On an
// Items-sold-vs-NTB pair those figures were not even dimensionally meaningful.
//
// So when the gates fail there is no table and no inputs. There is a lock, the
// reason, and the two things that would unlock it. Nothing persuasive renders
// from data that cannot support it.
//
// Every label carries one line of help, because "Blended multiple" means
// nothing to a brand manager and this is the section they are most likely to
// act on.
// ============================================================

import { fmtValue } from '../../lib/haloFields';
import { FieldLabel, Note, ModelledBadge } from './shared.jsx';
import { Term } from './Glossary.jsx';

const COLUMN_HELP = {
  Halo: 'Off-platform revenue as a percentage of TikTok Shop sales.',
  'Per 1': 'Amazon revenue associated with each 1 of TikTok Shop sales.',
  'Off-platform': 'The Amazon revenue this scenario assumes moves alongside TikTok Shop sales.',
  'Total influenced': 'TikTok Shop sales plus the assumed off-platform revenue. Not a total of verified sales.',
  'Blended multiple': 'Total influenced revenue divided by TikTok marketing spend. An assumption-driven ratio, not a measured return.',
};

const SCENARIO_HELP = {
  Conservative: 'The cautious case — the low end of the model’s 95% interval.',
  Base: 'The central case — the model’s point estimate.',
  Upside: 'The optimistic case — the high end of the model’s 95% interval.',
};

export default function PlanningLayer({ result, planning, setPlanning, cur }) {
  const p = result.planning;
  const derived = result.planningDerived;
  const eligibility = result.planningEligibility;
  const mode = p?.mode || 'assumptions';
  const locked = !derived?.usable;

  const set = (k, v) => setPlanning((s) => ({ ...s, [k]: v }));

  // ── Locked: no inputs, no table, no persuasive numbers ──────────
  if (locked) {
    const blockers = eligibility?.blockers || [];
    const isMoneyProblem = blockers.some((b) => b.code === 'not_monetary');
    return (
      <div style={{
        padding: '16px 18px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px dashed var(--border-default)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <i className="bi bi-lock" style={{ color: 'var(--warning, #f59e0b)' }} />
          <strong style={{ fontSize: 13.5 }}>Planning is locked</strong>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {blockers.length === 1 ? (
            <>Planning is locked because {lowerFirst(blockers[0].message)}</>
          ) : (
            <>
              Planning is locked because:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {blockers.map((b) => <li key={b.code} style={{ marginBottom: 4 }}>{b.message}</li>)}
              </ul>
            </>
          )}
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginTop: 10, fontWeight: 600 }}>
          {isMoneyProblem
            ? 'Switch to a money-to-money pair (for example TikTok Shop sales against Amazon revenue), or widen the date range.'
            : 'Widen the date range, or switch to a view with more usable periods.'}
        </div>

        {/* Say WHY the lock exists, not just that it does. A lock without a
            rationale reads as the tool being broken or withholding. */}
        <Note tone="info">
          Spend scenarios multiply a modelled percentage across your revenue, so a
          percentage the data cannot support produces a confident-looking number that
          means nothing. The evidence above is still valid — it needs far less data
          than a scenario does.
        </Note>
      </div>
    );
  }

  const live = currentAssumptions(p, derived);

  const editAssumption = (k, v) => setPlanning((s) => ({
    ...s,
    mode: 'override',
    assumptions: { ...(s.assumptions || live), [k]: Number(v) || 0 },
  }));
  const applyModel = () => setPlanning((s) => ({ ...s, mode: 'model', assumptions: { ...derived.assumptions } }));
  const resetFromModel = () => setPlanning((s) => ({ ...s, mode: 'model', assumptions: null }));

  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <ModeChip mode={mode} source={p?.source} />
        {mode !== 'model' && (
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" onClick={applyModel}>
            <i className="bi bi-magic" style={{ marginRight: 6 }} />
            Apply model to Conservative / Base / Upside
          </button>
        )}
        {mode === 'override' && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={resetFromModel}>
            Reset from model
          </button>
        )}
        {eligibility?.weakHaloClaim && <ModelledBadge weakHalo />}
      </div>

      {mode === 'model' && (
        <Note tone="success">
          These three are the model&apos;s <strong>95% lower bound, point estimate and upper bound</strong>
          {' '}on the {derived.basisLabel} basis — so the spread between them is this model&apos;s real
          uncertainty, not a fixed ±50%. They are still <strong>assumptions</strong> at the point of use,
          never a forecast.
          {derived.lowerFloored && (
            <> The lower bound was <strong>{derived.lowerRaw}%</strong> and is floored at 0% for planning:
            a negative halo is statistically possible, but not a budget anyone plans against.</>
          )}
        </Note>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', margin: '12px 0' }}>
        <div>
          <FieldLabel>TikTok Shop revenue</FieldLabel>
          <input className="wx-input" style={{ width: 160 }} value={planning.ttsRevenue}
            onChange={(e) => set('ttsRevenue', e.target.value)} placeholder="100000" />
          <Help>Your own figure for the period you are planning.</Help>
        </div>
        <div>
          <FieldLabel>TikTok marketing spend</FieldLabel>
          <input className="wx-input" style={{ width: 160 }} value={planning.marketingSpend}
            onChange={(e) => set('marketingSpend', e.target.value)} placeholder="30000" />
          <Help>Used only for the blended multiple.</Help>
        </div>
        {['conservative', 'base', 'upside'].map((k) => {
          const label = k[0].toUpperCase() + k.slice(1);
          return (
            <div key={k}>
              <FieldLabel>
                {label} %
                {mode !== 'model' && <span style={{ color: 'var(--warning, #f59e0b)', marginLeft: 4 }}>ASSUMED</span>}
              </FieldLabel>
              <input
                className="wx-input"
                style={{ width: 110, borderColor: mode !== 'model' ? 'rgba(245,158,11,.45)' : undefined }}
                value={live[k]}
                onChange={(e) => editAssumption(k, e.target.value)}
              />
              <Help>{SCENARIO_HELP[label]}</Help>
            </div>
          );
        })}
      </div>

      {!p?.base ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>
          Enter a TikTok Shop revenue figure to see the three scenarios.
        </p>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 660 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Scenario</th>
                  {['Halo', 'Per 1', 'Off-platform', 'Total influenced', 'Blended multiple'].map((h) => (
                    <th key={h} style={{ padding: '6px 8px' }} title={COLUMN_HELP[h]}>
                      {h === 'Per 1' ? `Per ${cur}1` : h}
                      <i className="bi bi-question-circle" style={{ marginLeft: 4, fontSize: '.85em', color: 'var(--text-muted)' }} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[['Conservative', p.conservative], ['Base', p.base], ['Upside', p.upside]].map(([name, s]) => (
                  <tr key={name} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>
                      {name}
                      {mode === 'model' && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>
                          {name === 'Base' ? 'point estimate' : name === 'Conservative' ? '95% lower' : '95% upper'}
                        </span>
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
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
            Every figure in this table is an <strong>assumption, not a forecast</strong>. It is
            {' '}<Term term="Modelled">modelled</Term> association applied to your revenue —
            not <Term term="Incremental">incremental</Term> lift, and not{' '}
            <Term term="Attributed">attributed</Term> sales.
          </div>
        </>
      )}

      <Note tone="planning">{p?.disclaimer || 'Planning assumptions — not measured results.'}</Note>
    </>
  );
}

const Help = ({ children }) => (
  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, maxWidth: 170, lineHeight: 1.35 }}>
    {children}
  </div>
);

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

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
  return derived?.assumptions || { conservative: 0, base: 0, upside: 0 };
}

function ModeChip({ mode, source }) {
  const c = mode === 'model'
    ? { bg: 'rgba(34,197,94,.14)', bd: 'rgba(34,197,94,.4)', fg: 'var(--success, #22c55e)', icon: 'bi-cpu', text: source || 'From adjusted model' }
    : { bg: 'rgba(99,102,241,.14)', bd: 'rgba(99,102,241,.4)', fg: 'var(--accent)', icon: 'bi-pencil', text: 'Manual override' };
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
