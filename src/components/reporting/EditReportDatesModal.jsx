import React, { useMemo, useState } from 'react';
import { editReportDates } from '../../utils/reportingService';
import { editBiWeeklyReportDates } from '../../utils/biWeeklyReportingService';
import { editMonthlyReportMonth } from '../../utils/monthlyReportingService';

/**
 * OL/Boss edit-the-dates modal. No cascade — only the picked report's dates
 * change. We surface a yellow warning when the new range overlaps another
 * report's range for the same brand+APC, but we still let the user save.
 *
 * Props:
 *   report   — full report doc (must include brandId, weekStart/weekEnd OR periodStart/periodEnd OR year/month, createdBy)
 *   type     — 'weekly' | 'biweekly' | 'monthly'
 *   siblings — every other report for the same brand (filter out `report.id`)
 *   onSaved  — callback(newReportId)
 *   onClose  — close handler
 */
export default function EditReportDatesModal({ report, type, siblings = [], onSaved, onClose }) {
  if (type === 'monthly') return <MonthlyEditor report={report} siblings={siblings} onSaved={onSaved} onClose={onClose} />;
  return <RangeEditor report={report} type={type} siblings={siblings} onSaved={onSaved} onClose={onClose} />;
}

/* ── Weekly + BiWeekly: pick start + end ─────────────────────────────────── */
function RangeEditor({ report, type, siblings, onSaved, onClose }) {
  const isWeekly = type === 'weekly';
  const startKey = isWeekly ? 'weekStart' : 'periodStart';
  const endKey   = isWeekly ? 'weekEnd'   : 'periodEnd';
  const [startDate, setStartDate] = useState(report[startKey] || '');
  const [endDate,   setEndDate]   = useState(report[endKey]   || '');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  // Restrict overlap-check to siblings of the same APC so we don't cross-contaminate
  // multiple APCs covering the same brand.
  const apcSiblings = useMemo(() => siblings.filter(s => s.createdBy === report.createdBy), [siblings, report.createdBy]);

  const overlaps = useMemo(() => {
    if (!startDate || !endDate) return [];
    const s = startDate, e = endDate;
    return apcSiblings.filter(r => {
      const rs = r[startKey] || '';
      const re = r[endKey] || '';
      if (!rs || !re) return false;
      // Two ranges overlap if start <= other.end AND end >= other.start
      return s <= re && e >= rs;
    });
  }, [apcSiblings, startDate, endDate, startKey, endKey]);

  async function handleSave() {
    if (!startDate || !endDate) { setError('Pick both a start and end date.'); return; }
    if (endDate < startDate) { setError('End date must be on or after start date.'); return; }
    setSaving(true);
    setError('');
    try {
      const fn = isWeekly ? editReportDates : editBiWeeklyReportDates;
      const newId = await fn(report.id, startDate, endDate, report);
      onSaved && onSaved(newId);
    } catch (err) {
      setError('Save failed: ' + (err.message || err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell title={`Edit ${isWeekly ? 'week' : 'period'} dates`} subtitle={report.brandName} onClose={onClose}>
      <div className="row g-2 mb-3">
        <div className="col-6">
          <label className="form-label small fw-semibold">Start date</label>
          <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8 }}
            value={startDate} onChange={e => setStartDate(e.target.value)} />
        </div>
        <div className="col-6">
          <label className="form-label small fw-semibold">End date</label>
          <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8 }}
            value={endDate} onChange={e => setEndDate(e.target.value)} />
        </div>
      </div>
      <div className="rounded-2 p-2 mb-3" style={{ background: '#f1f5f9', fontSize: '0.72rem', color: '#475569' }}>
        <i className="bi bi-info-circle me-1" />
        Only this report's dates change. Other reports for this brand stay where they are. The "previous report" comparison is based on creation order, so you can shift dates without breaking deltas.
      </div>

      {overlaps.length > 0 && (
        <div className="rounded-2 p-2 mb-3 d-flex align-items-start gap-2" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
          <i className="bi bi-exclamation-triangle-fill" style={{ color: '#d97706', marginTop: 2 }} />
          <div style={{ fontSize: '0.72rem', color: '#78350f', lineHeight: 1.5 }}>
            <strong>Heads up — these dates overlap {overlaps.length} other report{overlaps.length === 1 ? '' : 's'} for this brand:</strong>
            <ul className="mb-0 mt-1" style={{ paddingLeft: 18 }}>
              {overlaps.slice(0, 5).map(r => (
                <li key={r.id}>
                  <code>{r[startKey]} → {r[endKey]}</code>
                  {r.weekLabel || r.periodLabel ? <span className="text-muted"> ({r.weekLabel || r.periodLabel})</span> : null}
                </li>
              ))}
              {overlaps.length > 5 && <li>…and {overlaps.length - 5} more</li>}
            </ul>
            You can still save — just confirm this is intentional.
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger small py-2 px-3 mb-3">{error}</div>}

      <Footer saving={saving} onSave={handleSave} onClose={onClose} />
    </Shell>
  );
}

/* ── Monthly: pick year + month ──────────────────────────────────────────── */
function MonthlyEditor({ report, siblings, onSaved, onClose }) {
  const [year, setYear]   = useState(report.year ?? new Date().getFullYear());
  const [month, setMonth] = useState(report.month ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const apcSiblings = useMemo(() => siblings.filter(s => s.createdBy === report.createdBy), [siblings, report.createdBy]);
  const conflict = apcSiblings.find(r => r.monthKey === monthKey);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const newId = await editMonthlyReportMonth(report.id, year, month, report);
      onSaved && onSaved(newId);
    } catch (err) {
      setError('Save failed: ' + (err.message || err));
    } finally {
      setSaving(false);
    }
  }

  const months = Array.from({ length: 12 }, (_, i) => new Date(2025, i, 1).toLocaleString('en-US', { month: 'long' }));
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 3 + i);

  return (
    <Shell title="Edit report month" subtitle={report.brandName} onClose={onClose}>
      <div className="row g-2 mb-3">
        <div className="col-6">
          <label className="form-label small fw-semibold">Month</label>
          <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
            value={month} onChange={e => setMonth(Number(e.target.value))}>
            {months.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
        </div>
        <div className="col-6">
          <label className="form-label small fw-semibold">Year</label>
          <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
            value={year} onChange={e => setYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <div className="rounded-2 p-2 mb-3" style={{ background: '#f1f5f9', fontSize: '0.72rem', color: '#475569' }}>
        <i className="bi bi-info-circle me-1" />
        Only this report's month changes. Other monthly reports for this brand stay where they are.
      </div>

      {conflict && (
        <div className="rounded-2 p-2 mb-3 d-flex align-items-start gap-2" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
          <i className="bi bi-x-circle-fill" style={{ color: '#dc2626', marginTop: 2 }} />
          <div style={{ fontSize: '0.72rem', color: '#7f1d1d', lineHeight: 1.5 }}>
            <strong>{conflict.monthLabel || conflict.monthKey}</strong> already has a report for this brand. Pick a different month.
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger small py-2 px-3 mb-3">{error}</div>}

      <Footer saving={saving || !!conflict} onSave={handleSave} onClose={onClose} disabled={!!conflict} />
    </Shell>
  );
}

/* ── Shared shell + footer ───────────────────────────────────────────────── */
function Shell({ title, subtitle, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 480, zIndex: 1, borderRadius: 14, overflow: 'hidden' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-0 d-flex align-items-center gap-2">
                <i className="bi bi-calendar-event" style={{ color: '#2563eb' }} /> {title}
              </h6>
              {subtitle && <div className="text-muted small mt-1">{subtitle}</div>}
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 30, height: 30, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.8rem' }} />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function Footer({ saving, disabled, onSave, onClose }) {
  return (
    <div className="d-flex justify-content-end gap-2">
      <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="btn btn-sm btn-dark px-4 d-inline-flex align-items-center gap-1"
        style={{ borderRadius: 8 }} onClick={onSave} disabled={saving || disabled}>
        {saving ? <><span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} /> Saving…</> : <><i className="bi bi-check-lg" /> Save dates</>}
      </button>
    </div>
  );
}
