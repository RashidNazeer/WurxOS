import { useEffect, useMemo, useState } from 'react';
import {
  listReports, getBiWeeklyAnchor, setBiWeeklyAnchor,
  makeWeekFromStart, detectNextWeek, detectNextBiWeeklyPeriod,
  getWeeksForMonth, getBiWeeklyPeriodsFromAnchor,
} from '../../lib/reportsApi';
import BrandAvatar from '../brands/BrandAvatar';
import { XIcon, AlertIcon, ArrowRightIcon, CheckIcon } from '../common/Icon';

/**
 * Picks the period for a new report.
 *
 * Weekly — needs no per-brand anchor; picks Monday-of-Monday 7-day window
 *          starting from an earlier report's start (or from a user-chosen date if none).
 * Biweekly — uses bi_weekly_anchors: if no anchor → let user set one via calendar;
 *            otherwise compute next unused 14-day period from anchor.
 *
 * Props:
 *   brand, type ('weekly'|'biweekly'), onClose, onPicked(period, existingReport?)
 */
export default function PeriodPicker({ brand, type, onClose, onPicked }) {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [anchorDate, setAnchorDate] = useState('');
  const [reports, setReports] = useState([]);
  const [anchor, setAnchor]   = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [savingAnchor, setSavingAnchor] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [list, a] = await Promise.all([
          listReports({ brandId: brand.id, type }),
          type === 'biweekly' ? getBiWeeklyAnchor(brand.id) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setReports(list);
        setAnchor(a);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [brand.id, type]);

  // ----- Weekly -----
  const weeklyAnchor = useMemo(() => {
    if (type !== 'weekly') return null;
    if (reports.length === 0) return anchorDate || null;
    const earliest = [...reports].sort((a, b) => a.period_start.localeCompare(b.period_start))[0];
    return earliest?.period_start || null;
  }, [type, reports, anchorDate]);

  const usedStarts = useMemo(
    () => new Set(reports.map((r) => r.period_start)),
    [reports],
  );

  const nextWeekly = useMemo(() => {
    if (type !== 'weekly' || !weeklyAnchor) return null;
    const nextNum = reports.length + 1;
    const next = detectNextWeek(reports, weeklyAnchor);
    return next;
  }, [type, weeklyAnchor, reports]);

  // ----- Biweekly -----
  const allBiweekly = useMemo(() => {
    if (type !== 'biweekly' || !anchor) return [];
    return getBiWeeklyPeriodsFromAnchor(anchor.anchor_start, 30);
  }, [type, anchor]);

  const nextBiweekly = useMemo(() => {
    if (type !== 'biweekly' || !anchor) return null;
    return detectNextBiWeeklyPeriod(reports, anchor.anchor_start);
  }, [type, anchor, reports]);

  async function handleSaveBiweeklyAnchor() {
    if (!anchorDate) { setError('Pick the start date of Period 1.'); return; }
    try {
      setSavingAnchor(true);
      const a = await setBiWeeklyAnchor(brand.id, anchorDate);
      setAnchor(a);
    } catch (err) { setError(err.message); }
    finally { setSavingAnchor(false); }
  }

  // ----- Render -----
  const allWeeklyOptions = useMemo(() => {
    if (type !== 'weekly' || !weeklyAnchor) return [];
    const out = [];
    for (let i = 0; i < 30; i++) {
      const start = new Date(parseDate(weeklyAnchor));
      start.setDate(start.getDate() + i * 7);
      out.push(makeWeekFromStart(start, i + 1));
    }
    return out;
  }, [type, weeklyAnchor]);

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BrandAvatar brand={brand} size={36} />
            <div>
              <div className="wx-modal-title">New {type === 'biweekly' ? 'Bi-Weekly' : 'Weekly'} Report</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{brand.brand_name}</div>
            </div>
          </div>
          <button className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="wx-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div className="wx-alert wx-alert-danger">
              <AlertIcon width="16" height="16" /> <span>{error}</span>
            </div>
          )}
          {loading ? (
            <div style={{ color: 'var(--text-muted)' }}>
              <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
            </div>
          ) : (
            <>
              {/* Bi-weekly — no anchor yet → ask for anchor */}
              {type === 'biweekly' && !anchor && (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
                    This brand doesn't have a bi-weekly anchor yet. Pick the <strong>start date of Period 1</strong> —
                    every subsequent 14-day period is derived from this date. This can only be set once.
                  </div>
                  <div>
                    <label className="wx-label">Period 1 start date</label>
                    <input
                      type="date"
                      className="wx-input"
                      value={anchorDate}
                      onChange={(e) => setAnchorDate(e.target.value)}
                      disabled={savingAnchor}
                    />
                  </div>
                  <button
                    className="wx-btn wx-btn-primary"
                    onClick={handleSaveBiweeklyAnchor}
                    disabled={savingAnchor || !anchorDate}
                  >
                    {savingAnchor ? <><span className="wx-spinner" /> Saving anchor…</> : <>Set anchor <ArrowRightIcon width="15" height="15" /></>}
                  </button>
                </>
              )}

              {/* Weekly — no reports yet → ask for first week start.
                  Condition intentionally does NOT check `anchorDate` — the
                  user types into that field while this branch is visible,
                  so gating on an empty value would hide the input + Start
                  button the moment they pick a date. */}
              {type === 'weekly' && reports.length === 0 && (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
                    No weekly reports yet for this brand. Pick the <strong>start date of Week 1</strong>.
                  </div>
                  <div>
                    <label className="wx-label">Week 1 start date</label>
                    <input
                      type="date"
                      className="wx-input"
                      value={anchorDate}
                      onChange={(e) => setAnchorDate(e.target.value)}
                    />
                  </div>
                  <button
                    className="wx-btn wx-btn-primary"
                    onClick={() => {
                      if (!anchorDate) { setError('Pick a start date.'); return; }
                      const w = makeWeekFromStart(new Date(parseDate(anchorDate)), 1);
                      onPicked(w);
                    }}
                    disabled={!anchorDate}
                  >
                    Start Week 1 <ArrowRightIcon width="15" height="15" />
                  </button>
                </>
              )}

              {/* Next detected period (both types) */}
              {((type === 'weekly'  && reports.length > 0 && nextWeekly) ||
                (type === 'biweekly' && anchor && nextBiweekly)) && !showAll && (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
                    Next {type === 'biweekly' ? 'period' : 'week'} detected based on prior reports:
                  </div>
                  <button
                    onClick={() => onPicked(type === 'biweekly' ? nextBiweekly : nextWeekly)}
                    className="period-picker-item"
                    style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    <CheckIcon width="16" height="16" />
                    <span style={{ fontWeight: 700 }}>
                      {(type === 'biweekly' ? nextBiweekly : nextWeekly).label}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => setShowAll(true)}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Pick a different period →
                  </button>
                </>
              )}

              {/* Show all options */}
              {showAll && (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
                    All {type === 'biweekly' ? 'periods' : 'weeks'} (from anchor). Greyed-out rows already have a report.
                  </div>
                  <div className="period-picker-list">
                    {(type === 'biweekly' ? allBiweekly : allWeeklyOptions).map((p) => {
                      const used = usedStarts.has(p.startDate);
                      return (
                        <button
                          key={p.startDate}
                          type="button"
                          className="period-picker-item"
                          data-used={used ? 'true' : 'false'}
                          disabled={used}
                          onClick={() => onPicked(p)}
                        >
                          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                            {type === 'biweekly' ? `Period ${p.period}` : `Week ${p.week}`}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                            · {p.label.replace(/^(Period|Week)\s+\d+\s*\(?/, '').replace(/\)$/, '')}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
