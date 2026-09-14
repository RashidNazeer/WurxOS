// ============================================================
// Halo V2 - the one-pager (PDF or PNG).
//
// A purpose-built document, not a screenshot of the page. Capturing the live
// explorer would produce several feet of output containing dropdowns,
// disclosure buttons and an empty-state panel, none of which a client can use
// in a file. This renders what belongs in front of a CMO and nothing else:
// the snapshot, one chart, what we adjusted for, the Base scenario, and the
// method line.
//
// Rendered OFF-SCREEN at a fixed 820px so the raster has a stable page width
// regardless of the browser window, and wrapped in data-theme="light" so the
// document is light whatever theme the app is in. tokens.css scopes its palette
// on [data-theme='...'] selectors, so nesting the attribute re-resolves every
// token inside this subtree, with no hardcoded hex needed.
//
// It is laid out (left: -10000px), NOT display:none: the capture goes through
// the real browser renderer, and an element with no layout box rasterises to
// nothing.
// ============================================================

import { fmtValue } from '../../lib/haloFields';
import { plainMetricLabel, comparisonSentence } from '../../lib/haloV2/plainLanguage.js';
import { GRAIN_LABEL } from '../../lib/haloV2/grainRecommendation.js';
import { NOT_CLAIM_LINE } from '../../lib/haloV2/snapshot.js';
import { OverTimeChart } from './SeeLayer.jsx';
import { moneyWith as money } from './shared.jsx';

export const SUMMARY_WIDTH = 820;

export default function ClientSummarySheet({
  sheetRef, result, takeaway, snapshot, planning, periods = [], gran, range, xKey, yKey, cur, brandName,
}) {
  const m = result?.adjustedModel || {};
  const plan = result?.planning || null;
  const unit = gran;
  const hasRevenue = String(planning?.ttsRevenue ?? '').trim() !== '';
  const assumed = (plan?.mode || 'assumptions') !== 'model';
  const sym = planning?.currency || cur;

  return (
    <div aria-hidden="true" style={{ position: 'fixed', left: -10000, top: 0, pointerEvents: 'none' }}>
      <div
        ref={sheetRef}
        data-theme="light"
        style={{
          width: SUMMARY_WIDTH,
          padding: 36,
          background: 'var(--surface-1)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.01em' }}>Amazon Halo V2</div>
            {brandName && <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 2 }}>{brandName}</div>}
          </div>
          <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <div>{GRAIN_LABEL[gran] || gran} view</div>
            {range?.start && range?.end && <div>{range.start} to {range.end}</div>}
            <div>Generated {new Date().toLocaleString()}</div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, paddingBottom: 14, borderBottom: '2px solid var(--border-default)' }}>
          Comparing <strong>{comparisonSentence(xKey, yKey)}</strong>
        </div>

        {/* ── The answer ─────────────────────────────────────── */}
        <div style={{ marginTop: 18 }}>
          <SectionLabel>What happened</SectionLabel>
          <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.35, marginTop: 6 }}>
            {takeaway?.headline}
          </div>
        </div>

        {/* ── Snapshot, the same four cards as the page ──────── */}
        {snapshot && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            <Figure label={snapshot.effect.label} value={snapshot.effect.value} sub={snapshot.effect.sub} primary />
            <Figure label={snapshot.range.label} value={snapshot.range.value} sub={snapshot.range.sub} />
            <Figure
              label="Signal strength"
              value={`${snapshot.signal.level}${snapshot.signal.confidenceLabel ? ` (${snapshot.signal.confidenceLabel})` : ''}`}
              sub={snapshot.signal.why}
            />
            <Figure label="Next action" value={snapshot.action.verdict} sub={snapshot.action.detail} />
          </div>
        )}

        <div style={{
          marginTop: 14, padding: 12, borderRadius: 8,
          background: 'var(--warning-soft)', border: '1px solid var(--warning)',
        }}>
          <div style={{
            display: 'inline-block', fontSize: 11, fontWeight: 800, letterSpacing: '.06em',
            padding: '3px 8px', borderRadius: 4, marginBottom: 6,
            background: 'var(--surface-1)', color: 'var(--warning)', border: '1px solid var(--warning)',
          }}>
            MODELLED · NOT INCREMENTAL
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>{NOT_CLAIM_LINE}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
            {takeaway?.caveat}
          </div>
        </div>

        {/* ── One chart ──────────────────────────────────────── */}
        {periods.length > 1 && (
          <div style={{ marginTop: 18 }}>
            <SectionLabel>{plainMetricLabel(yKey)} against {plainMetricLabel(xKey)}, by {unit}</SectionLabel>
            <div style={{ marginTop: 6 }}>
              <OverTimeChart
                periods={periods} xKey={xKey} yKey={yKey} unit={unit}
                height={210} width={SUMMARY_WIDTH - 72} compact
              />
            </div>
          </div>
        )}

        {/* ── What we adjusted for ───────────────────────────── */}
        <div style={{ marginTop: 18 }}>
          <SectionLabel>What the model adjusted for</SectionLabel>
          {!m.available ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
              <strong>{m.headline}</strong> {m.message}
            </div>
          ) : (
            <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6 }}>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Adjusted for: </span>
                <strong>{m.controls?.length ? m.controls.join(', ') : 'nothing'}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Not adjusted for: </span>
                <strong>{m.controlsUnavailable?.length ? m.controlsUnavailable.join('; ') : 'nothing outstanding'}</strong>
              </div>
              {result?.historicalContribution && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Modelled contribution in this window: </span>
                  <strong>{fmtValue(result.historicalContribution.amount, 'money')}</strong>
                  {result.historicalContribution.lower != null && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}(95% {fmtValue(result.historicalContribution.lower, 'money')} to{' '}
                      {fmtValue(result.historicalContribution.upper, 'money')}), against the{' '}
                      {result.historicalContribution.referenceLabel.toLowerCase()}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── The Base scenario ──────────────────────────────── */}
        {hasRevenue && plan?.base && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <SectionLabel>
                Base scenario{planning?.periodLabel ? ` for ${planning.periodLabel}` : ''}
              </SectionLabel>
              <span style={{
                fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', padding: '2px 6px', borderRadius: 4,
                background: assumed ? 'var(--warning-soft)' : 'var(--surface-2)',
                color: assumed ? 'var(--warning)' : 'var(--text-secondary)',
                border: `1px solid ${assumed ? 'var(--warning)' : 'var(--border-default)'}`,
              }}>
                {assumed ? 'ASSUMED' : 'MODELLED'}
              </span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, marginTop: 6 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px' }}>Scenario</th>
                  <th style={{ padding: '4px 6px' }}>Halo</th>
                  <th style={{ padding: '4px 6px' }}>Off-platform</th>
                  <th style={{ padding: '4px 6px' }}>Total influenced</th>
                  <th style={{ padding: '4px 6px' }}>Spend</th>
                  <th style={{ padding: '4px 6px' }}>Multiple</th>
                </tr>
              </thead>
              <tbody>
                {[['Conservative', plan.conservative], ['Base', plan.base], ['Upside', plan.upside]].map(([name, s]) => (
                  <tr key={name} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '4px 6px', fontWeight: name === 'Base' ? 800 : 600 }}>{name}</td>
                    <td style={{ padding: '4px 6px' }}>{s.haloPercent}%</td>
                    <td style={{ padding: '4px 6px' }}>{money(sym, s.offPlatformRevenue)}</td>
                    <td style={{ padding: '4px 6px', fontWeight: 700 }}>{money(sym, s.totalInfluencedRevenue)}</td>
                    <td style={{ padding: '4px 6px' }}>{money(sym, s.marketingSpend)}</td>
                    <td style={{ padding: '4px 6px' }}>{s.blendedMultiple == null ? 'no spend entered' : `${s.blendedMultiple.toFixed(2)}x`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
              {plan.disclaimer}
            </div>
          </div>
        )}

        {/* ── Method line and footer ─────────────────────────── */}
        <div style={{
          marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--border-subtle)',
          fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.6,
        }}>
          <div>
            <strong>Method.</strong> Amazon outcome regressed on TikTok activity at several {unit} lags at
            once, after the controls listed above. The headline figure excludes same-{unit} co-movement.
            {m.available && (
              <> Estimated on {m.sampleSize} usable {unit}s with {m.parameterCount} parameters,
              {' '}{m.covarianceKind} standard errors.</>
            )}
          </div>
          <div style={{ marginTop: 3 }}>
            Modelled association. Not incremental, and not geo validated. Correlation is not causation, and
            a controlled test (a geo or holdout experiment) is what would establish cause. This tool does
            not run one.
          </div>
        </div>
      </div>
    </div>
  );
}

const SectionLabel = ({ children }) => (
  <div style={{
    fontSize: 9.5, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase',
    color: 'var(--text-muted)',
  }}>{children}</div>
);

function Figure({ label, value, sub, primary = false }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: primary ? 'var(--accent-soft)' : 'var(--surface-2)',
      border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-subtle)'}`,
    }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, marginTop: 3, lineHeight: 1.25 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

/** Filename for the downloaded one-pager. */
export function summaryFilename({ brandName, gran, range }) {
  const slug = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
  const parts = ['Amazon Halo V2', slug(brandName), GRAIN_LABEL[gran] || gran];
  if (range?.start && range?.end) parts.push(`${range.start} to ${range.end}`);
  return parts.filter(Boolean).join(' - ');
}
