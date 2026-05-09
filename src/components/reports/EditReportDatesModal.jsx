import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { editReportDates, listSiblingReports } from '../../lib/reportsApi';
import { AlertIcon, CheckIcon, XIcon, CalendarIcon } from '../common/Icon';

/**
 * OL/Boss edit-the-dates modal — change a single report's period
 * without cascading to siblings. v2 just UPDATEs the row (no
 * Firestore-style doc rewrite needed).
 *
 * Surfaces a yellow non-blocking warning when the new range overlaps
 * another report's range for the same brand + author. User can still
 * save — it's intentional sometimes.
 *
 * Props:
 *   report  — full report object (must include id, brand_id, type, author_id, period_start, period_end)
 *   onSaved — (savedReport) => void
 *   onClose — close handler
 */
export default function EditReportDatesModal({ report, onSaved, onClose }) {
  const [startDate, setStartDate] = useState(report.period_start || '');
  const [endDate,   setEndDate]   = useState(report.period_end   || '');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  const { data: siblings = [] } = useQuery({
    queryKey: ['report-siblings', report.brand_id, report.type, report.id],
    queryFn: () => listSiblingReports({ brandId: report.brand_id, type: report.type, excludeId: report.id }),
    enabled: !!report.brand_id && !!report.type,
  });

  // Restrict overlap-check to siblings authored by the same person so
  // we don't flag legitimately-different APCs covering the same brand.
  const apcSiblings = useMemo(
    () => siblings.filter((s) => s.author_id === report.author_id),
    [siblings, report.author_id],
  );

  const overlaps = useMemo(() => {
    if (!startDate || !endDate) return [];
    return apcSiblings.filter((r) => {
      if (!r.period_start || !r.period_end) return false;
      // Two ranges overlap iff start <= other.end AND end >= other.start
      return startDate <= r.period_end && endDate >= r.period_start;
    });
  }, [apcSiblings, startDate, endDate]);

  async function handleSave() {
    if (!startDate || !endDate) { setError('Pick both a start and end date.'); return; }
    if (endDate < startDate)    { setError('End date must be on or after start date.'); return; }
    setSaving(true);
    setError('');
    try {
      const saved = await editReportDates(report.id, { startDate, endDate });
      onSaved?.(saved);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  const typeLabel = report.type === 'biweekly' ? 'period' : 'week';

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 32, height: 32, borderRadius: 'var(--radius-md)',
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <CalendarIcon width="16" height="16" />
            </span>
            <div>
              <div>Edit {typeLabel} dates</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                {report.brand?.brand_name || ''}
              </div>
            </div>
          </div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="wx-modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <label className="wx-label">Start date</label>
              <input type="date" className="wx-input"
                value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={saving} />
            </div>
            <div>
              <label className="wx-label">End date</label>
              <input type="date" className="wx-input"
                value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={saving} />
            </div>
          </div>

          <div style={{
            padding: '8px 12px', borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)', color: 'var(--text-secondary)',
            fontSize: 12, lineHeight: 1.45, marginBottom: 12,
          }}>
            Only this report's dates change. Other reports for this brand stay where they are. The "previous report" comparison is based on creation order, so you can shift dates without breaking deltas.
          </div>

          {overlaps.length > 0 && (
            <div className="wx-alert" style={{
              background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
              borderColor: 'color-mix(in srgb, var(--warning) 30%, transparent)',
              color: 'var(--text-primary)',
              alignItems: 'flex-start',
            }}>
              <AlertIcon width="16" height="16" style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <strong>Heads up — these dates overlap {overlaps.length} other report{overlaps.length === 1 ? '' : 's'} for this brand:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {overlaps.slice(0, 5).map((r) => (
                    <li key={r.id}>
                      <code style={{ fontSize: 11.5 }}>{r.period_start} → {r.period_end}</code>
                      {r.period_label && <span style={{ color: 'var(--text-muted)' }}> ({r.period_label})</span>}
                    </li>
                  ))}
                  {overlaps.length > 5 && <li>…and {overlaps.length - 5} more</li>}
                </ul>
                <div style={{ marginTop: 4 }}>You can still save — just confirm this is intentional.</div>
              </div>
            </div>
          )}

          {error && (
            <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}>
              <AlertIcon width="14" height="14" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save dates</>}
          </button>
        </div>
      </div>
    </div>
  );
}
