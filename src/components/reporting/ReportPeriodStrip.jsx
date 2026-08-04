import { useEffect, useMemo, useRef } from 'react';
import { num, getReportStatus, REPORT_STATUSES } from '../../utils/reportingService';
import { currencySymbol, DEFAULT_CURRENCY } from '../../utils/currencies';

// A compact, sticky, horizontally-scrollable strip of a brand's reports shown
// while viewing one — click any card to jump straight to that week/period's
// report without going back to the list. Mirrors the client portal's week
// scroller but for internal users (APC/TL/OL/Boss).
//
// Works for weekly / bi-weekly / monthly: it reads whichever period fields the
// report carries (weekLabel/week/weekStart or periodLabel/monthKey/periodStart).

const sortKey = (r) => r.weekStart || r.periodStart || r.monthKey || '';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A monthly report's friendly month ("Jul 2026"), derived from year+month
// (0-indexed) or the "YYYY-MM" monthKey — so the strip shows a real month
// instead of the raw "2026-07". Falls back to any stored monthLabel.
function monthName(r) {
  if (r.year != null && r.month != null && MONTHS_SHORT[r.month]) return `${MONTHS_SHORT[r.month]} ${r.year}`;
  if (typeof r.monthKey === 'string') {
    const m = /^(\d{4})-(\d{2})$/.exec(r.monthKey);
    if (m) { const i = Number(m[2]) - 1; if (MONTHS_SHORT[i]) return `${MONTHS_SHORT[i]} ${m[1]}`; }
  }
  return r.monthLabel || null;
}

export default function ReportPeriodStrip({ reports = [], currentId, onSelect, type = 'weekly' }) {
  // The headline number + label depend on the report TYPE — the strip is shared
  // by all viewers and each stores GMV/period differently:
  //   weekly / bi-weekly → overallPerformance.gmv, week/period label
  //   monthly            → totalSales.monthGmv,    "Mon YYYY" (was showing £0 +
  //                        the raw "2026-07" because it only read the weekly fields)
  const isMonthly = type === 'monthly';
  const gmvOf   = (r) => num(isMonthly ? r.totalSales?.monthGmv : r.overallPerformance?.gmv);
  const labelOf = (r) => isMonthly
    ? (monthName(r) || r.monthKey || '—')
    : (r.weekLabel || r.periodLabel || (r.week != null ? `Week ${r.week}` : (monthName(r) || r.monthKey || '—')));
  // Newest first — the same order the lists now use.
  const sorted = useMemo(
    () => [...reports].sort((a, b) => sortKey(b).localeCompare(sortKey(a))),
    [reports],
  );

  const scrollRef = useRef(null);
  const activeRef = useRef(null);
  // Center the active card horizontally when the selection changes — without
  // touching vertical page scroll (so switching reports doesn't jump the page).
  useEffect(() => {
    const c = scrollRef.current, a = activeRef.current;
    if (c && a) c.scrollLeft = a.offsetLeft - c.clientWidth / 2 + a.clientWidth / 2;
  }, [currentId]);

  if (sorted.length <= 1) return null;

  // Convert a vertical mouse wheel into horizontal scroll while hovering the
  // strip — but only while it can still scroll that way, so at either edge the
  // wheel falls through to the page (the app keeps scrolling normally).
  const onWheel = (e) => {
    const c = scrollRef.current;
    if (!c || e.deltaY === 0) return;
    const atStart = c.scrollLeft <= 0;
    const atEnd = c.scrollLeft + c.clientWidth >= c.scrollWidth - 1;
    if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return; // let the page scroll
    c.scrollLeft += e.deltaY;
    e.preventDefault();
  };

  return (
    <div ref={scrollRef} className="rps-strip" role="tablist" aria-label="Other reports for this brand"
      onWheel={onWheel}
      style={{
        display: 'flex', flexWrap: 'nowrap', gap: 8,
        overflowX: 'auto', overflowY: 'hidden',
        width: '100%', maxWidth: '100%', minWidth: 0,
        marginTop: 8, paddingBottom: 6,
      }}>
      {sorted.map((r) => {
        const active = r.id === currentId;
        const status = getReportStatus(r);
        const cfg = REPORT_STATUSES[status] || REPORT_STATUSES.approved;
        const sym = currencySymbol(r.currency || DEFAULT_CURRENCY);
        const gmv = gmvOf(r);
        return (
          <button key={r.id} type="button" role="tab" aria-selected={active}
            ref={active ? activeRef : null}
            onClick={() => onSelect(r)}
            title={`${labelOf(r)} · ${cfg.label}`}
            style={{
              flex: '0 0 auto', minWidth: 116, textAlign: 'left',
              padding: '7px 11px', borderRadius: 10, cursor: 'pointer',
              background: active ? 'var(--accent-soft)' : 'var(--surface-1)',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
              boxShadow: active ? '0 2px 8px -4px var(--accent)' : 'none',
              transition: 'background .12s, border-color .12s',
            }}>
            <div className="d-flex align-items-center gap-1" style={{ minWidth: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: cfg.color, flexShrink: 0 }} />
              <span className="fw-semibold text-truncate" style={{ fontSize: '0.74rem', color: active ? 'var(--accent)' : 'var(--text-primary)' }}>
                {labelOf(r)}
              </span>
            </div>
            <div className="fw-bold" style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginTop: 2 }}>
              {sym}{gmv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          </button>
        );
      })}
    </div>
  );
}
