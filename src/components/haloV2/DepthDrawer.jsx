// ============================================================
// Halo V2 - the Depth drawer.
//
// Book 4 Module 15 describes halo measurement as six ordered stages, and the
// page used to wear them as furniture: stage numbers in section headers, a
// stepper above the fold. That is the tool's internal vocabulary. A client
// walks See, Adjust, Estimate, Plan; an operator needs to know which stage each
// of those is, and whether it completed.
//
// So the ladder lives here, collapsed by default, with the mapping made
// explicit rather than left for the reader to infer. Stage 6 is listed as not
// done, because a validation stage nobody ran is the reason nothing on this
// page may be called incremental.
// ============================================================

import { useState } from 'react';
import StageStepper from './StageStepper.jsx';
import { stageProgress } from '../../lib/haloV2/stages.js';

const STAGE_TO_STEP = {
  descriptive: 'See',
  correlations: 'See',
  regression: 'Adjust',
  distributedLag: 'Adjust and Estimate',
  counterfactual: 'Estimate',
  validation: 'Not in this tool',
};

export default function DepthDrawer({ statuses, model, unit, referenceLabel = null }) {
  const [open, setOpen] = useState(false);
  const { done, total } = stageProgress(statuses || []);

  return (
    <div className="wx-card" style={{ padding: open ? '14px 16px 18px' : '10px 16px' }}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <i className={`bi bi-chevron-${open ? 'up' : 'down'}`} style={{ color: 'var(--text-muted)', fontSize: 12 }} />
          <span style={{ fontSize: 12.5, fontWeight: 800 }}>How this was measured</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Stages {done} of {total} complete, validation not performed
          </span>
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--accent)', fontWeight: 700 }}>{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          <StageStepper statuses={statuses} />

          <div style={{ marginTop: 14 }}>
            <Label>Where each stage appears on this page</Label>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 460 }}>
                <tbody>
                  {(statuses || []).map((s) => (
                    <tr key={s.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Stage {s.n}</td>
                      <td style={{ padding: '6px 8px', fontWeight: 600 }}>{s.title}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{STAGE_TO_STEP[s.key]}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{s.statusLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <Label>Method</Label>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <li>
                Amazon outcome is regressed on TikTok activity at several {unit} lags at once (a distributed
                lag model), so an effect that arrives late is still counted.
              </li>
              <li>
                The delayed (lagged only) figure excludes same-{unit} co-movement. That exclusion is the halo
                claim: movement inside one {unit} is just as easily a shared cause, such as a promotion.
              </li>
              {model?.available && (
                <li>
                  Standard errors: {model.covarianceKind}. Estimated on {model.sampleSize} usable {unit}s
                  with {model.parameterCount} parameters.
                </li>
              )}
              {model?.available && (
                <li>
                  Adjusted for {model.controls?.length ? model.controls.join(', ').toLowerCase() : 'nothing'}.
                  {model.controlsUnavailable?.length
                    ? ` No data in the sheet for ${model.controlsUnavailable.join(', ').toLowerCase()}.`
                    : ''}
                </li>
              )}
              {referenceLabel && (
                <li>
                  Contribution compares the model's prediction under what happened against the same
                  prediction with TikTok held at the {referenceLabel.toLowerCase()}. The reference is never
                  zero, which would sit far outside anything the model has seen.
                </li>
              )}
            </ul>
          </div>

          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface-2)', border: '1px dashed var(--border-default)',
            fontSize: 12.5, color: 'var(--text-secondary)',
          }}>
            <strong style={{ color: 'var(--text-primary)' }}>Stage 6, validation (geo or holdout): not done.</strong>
            {' '}Proving that sales would not have happened otherwise needs a controlled test with a held out
            region or audience. This tool does not run one, which is why every figure here is labelled
            modelled association rather than incremental.
          </div>
        </div>
      )}
    </div>
  );
}

const Label = ({ children }) => (
  <div style={{
    fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase',
    color: 'var(--text-muted)', marginBottom: 6,
  }}>{children}</div>
);
