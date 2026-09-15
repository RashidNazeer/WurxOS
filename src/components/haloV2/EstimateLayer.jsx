// ============================================================
// Halo V2 - Estimate: how much Amazon looks tied to TikTok in this window?
//
// Book 4 Stage 5. It used to be buried inside the old Layer B under a stage
// number, which is why nobody could find it: a client asking "how much Amazon
// revenue is this worth" was reading a section headed with a Roman letter.
//
// Two things are deliberately kept apart here:
//
//   HISTORICAL contribution. What the model says already happened in this
//   window, measured against a reference level rather than against zero.
//   FORWARD scenario. What the model implies about a future increase. Same
//   coefficient, completely different claim, so it gets its own box and its own
//   label rather than sitting inline with the historical number.
//
// The reference rule is apparatus, so the picker is Lab only. Which reference
// was used is not apparatus, so it is stated in both views.
// ============================================================

import { fmtValue } from '../../lib/haloFields';
import { REFERENCE_METHOD_SPECS } from '../../lib/haloV2/counterfactual.js';
import { plainMetricLabel } from '../../lib/haloV2/plainLanguage.js';
import ContributionChart from './ContributionChart.jsx';
import { FieldLabel, Picker, Note, Stat, ModelledBadge } from './shared.jsx';
import { Term } from './Glossary.jsx';

export default function EstimateLayer({
  result, unit, cur, xKey, yKey, refMethod, setRefMethod, customRef, setCustomRef,
  scenarioPct, setScenarioPct, customChange, setCustomChange, lab = false,
}) {
  const m = result.adjustedModel;
  const contrib = result.historicalContribution;
  const sens = result.referenceSensitivity;
  const marg = result.marginal;

  if (!m.available) {
    return (
      <Note tone="info">
        A contribution figure needs the adjusted model, and there is not enough history for one over this
        window. The Adjust step above says how much more is needed.
      </Note>
    );
  }

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Stat
          label="Modelled contribution"
          value={contrib ? fmtValue(contrib.amount, 'money') : 'Not available'}
          sub={contrib
            ? (contrib.lower != null
              ? `95%: ${fmtValue(contrib.lower, 'money')} to ${fmtValue(contrib.upper, 'money')}`
              : `Measured against the ${contrib.referenceLabel.toLowerCase()}`)
            : 'The model could not produce one for this window.'}
          tone={contrib && contrib.amount < 0 ? 'neg' : 'pos'}
          badge={<ModelledBadge compact />}
          emphasis
        />
        {contrib && (
          <>
            <Stat
              label="Periods above the reference"
              value={fmtValue(contrib.positiveAmount, 'money')}
              sub={`${contrib.periods} ${unit}s in this window`}
              tone="muted"
            />
            <Stat
              label="Periods below the reference"
              value={fmtValue(contrib.negativeAmount, 'money')}
              sub="Kept in the total rather than floored at zero"
              tone="muted"
            />
          </>
        )}
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '12px 0 0', maxWidth: 820 }}>
        This compares Amazon revenue predicted under the TikTok activity that actually happened against the
        same prediction with TikTok held at a quiet reference level. The gap between the two lines below is
        the figure above. The reference is never zero, which would sit far outside anything the model has
        seen. <Term term="Counterfactual">What is a counterfactual?</Term>
      </p>

      {lab ? (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
          <Picker
            label="Reference level"
            value={refMethod || result.recommendedReference}
            onChange={(v) => setRefMethod(v)}
            options={REFERENCE_METHOD_SPECS.map((s) => ({
              value: s.name,
              label: s.name === result.recommendedReference ? `${s.short} (recommended)` : s.short,
            }))}
            width={230}
            hint={contrib?.referenceDescribe}
          />
          {(refMethod || result.recommendedReference) === 'custom' && (
            <div>
              <FieldLabel>Custom baseline</FieldLabel>
              <input className="wx-input" style={{ width: 150 }} value={customRef}
                onChange={(e) => setCustomRef(e.target.value)} placeholder="e.g. 1200" />
            </div>
          )}
        </div>
      ) : contrib && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10 }}>
          Reference: {contrib.referenceLabel.toLowerCase()} ({fmtValue(contrib.referenceValue, 'num')}).
          {' '}Switch to Lab view to compare other reference rules.
        </div>
      )}

      {contrib?.referenceNote && <Note tone="info">{contrib.referenceNote}</Note>}
      {sens?.message && (
        <Note tone={sens.signFlip ? 'danger' : 'warn'}>
          {sens.message}
          <table style={{ marginTop: 6, fontSize: 11.5, borderCollapse: 'collapse' }}>
            <tbody>
              {sens.entries.map((e) => (
                <tr key={e.method}>
                  <td style={{ padding: '2px 10px 2px 0', color: 'var(--text-muted)' }}>{e.label}</td>
                  <td style={{ padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>{fmtValue(e.amount, 'money')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Note>
      )}

      {contrib && (
        <>
          <ContributionChart contribution={contrib} unit={unit} yLabel={plainMetricLabel(yKey)} />
          {contrib.spansZero && (
            <Note tone="warn">
              The interval on the contribution includes zero, so over this window the total cannot be told
              apart from no contribution at all.
            </Note>
          )}
        </>
      )}

      {/* ── Forward scenario. Same model, different claim. ────── */}
      <div className="wx-card" style={{ padding: 12, marginTop: 16, background: 'var(--surface-2)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 800 }}>What if TikTok activity rises?</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
            Forward looking. This is not the historical contribution above.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Picker
            label="By percent"
            value={String(scenarioPct)}
            onChange={(v) => { setScenarioPct(Number(v)); setCustomChange(''); }}
            options={[5, 10, 20, 50].map((p) => ({ value: String(p), label: `+${p}%` }))}
            width={110}
          />
          <div>
            <FieldLabel>Or by amount</FieldLabel>
            <input className="wx-input" style={{ width: 150 }} placeholder="e.g. 2000" value={customChange}
              onChange={(e) => setCustomChange(e.target.value)} />
          </div>
          {marg && (
            <div style={{ fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                {marg.changeLabel} on an average {unit} of {fmtValue(marg.basePeriodActivity, 'num')} gives{' '}
              </span>
              <strong style={{ color: marg.estimated >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {fmtValue(marg.estimated, 'money')}
              </strong>
              {marg.lower != null && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}({fmtValue(marg.lower, 'money')} to {fmtValue(marg.upper, 'money')})
                </span>
              )}
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Basis: {marg.basisLabel}. Of {plainMetricLabel(xKey)}, on {plainMetricLabel(yKey)}.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
