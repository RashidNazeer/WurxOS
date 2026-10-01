import { useState } from 'react';
import { repairWeekLabels } from '../../../lib/reportsApi';
import { useConfirm } from '../../../components/ui';
import { AlertIcon, RefreshIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

// Boss-only data-maintenance utilities, moved here from the old Boss home
// page (Round 4 F1). Behaviour unchanged.
//   * Repair Week Labels — recomputes period_number + period_label for every
//     weekly report, anchored at the brand's earliest report.
export default function MaintenanceSection() {
  const confirm = useConfirm();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function runRepair() {
    if (!(await confirm({ title: 'Repair week labels?', message: 'Recompute Week labels for every weekly report on every brand? Safe — only updates labels.', confirmLabel: 'Repair labels' }))) return;
    setRunning(true); setErr(''); setResult(null);
    try {
      const r = await repairWeekLabels();
      setResult(r);
    } catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  }

  return (
    <SectionShell icon={RefreshIcon} title="Maintenance" subtitle="One-off utilities for fixing legacy data.">
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, flexWrap: 'wrap',
        padding: 14, borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
      }}>
        <div>
          <div style={{ fontWeight: 600 }}>Repair Week Labels</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Recompute every weekly report's number and label using each brand's
            earliest report as the anchor. Fixes duplicate or shifted labels caused
            by anchor drift over time. Safe to run any time.
          </div>
          {result && (
            <div className="wx-alert" style={{
              marginTop: 8,
              background: 'var(--success-soft)',
              color: 'var(--success-text)',
              border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
            }}>
              Relabelled <strong>{result.reports_relabelled}</strong> report(s) across{' '}
              <strong>{result.brands_processed}</strong> brand(s).
            </div>
          )}
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginTop: 8 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}
        </div>
        <button type="button" className="wx-btn wx-btn-ghost" onClick={runRepair} disabled={running}>
          {running ? <><span className="wx-spinner" /> Running…</> : <><RefreshIcon width="14" height="14" /> Run repair</>}
        </button>
      </div>
    </SectionShell>
  );
}
