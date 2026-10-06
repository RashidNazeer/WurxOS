import { useQuery } from '@tanstack/react-query';
import ClockQuickControl from '../../../components/attendance/ClockQuickControl';
import { todayKeys, fetchLeaveSummary, fetchShiftStart } from '../../../lib/todayApi';

const LEAVE_KEYS = [['wfh', 'WFH'], ['medical', 'Medical'], ['emergency', 'Emergency']];

function fmtShift(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m || 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// First thing on every clock-in role's Today page (spec F1 §1): the clock
// action, then shift start and this month's leave left.
export default function TodayStrip({ uid }) {
  const leave = useQuery({ queryKey: todayKeys.leave(uid), queryFn: () => fetchLeaveSummary(uid), enabled: !!uid, staleTime: 30 * 60_000 });
  const shift = useQuery({ queryKey: todayKeys.shift(uid), queryFn: fetchShiftStart, enabled: !!uid, staleTime: 30 * 60_000 });
  const shiftLabel = fmtShift(shift.data);
  return (
    <section className="today-strip" aria-label="Today">
      <ClockQuickControl />
      <div className="today-strip__facts">
        {shiftLabel && <div><span className="today-strip__k">Shift starts</span><span className="today-strip__v">{shiftLabel}</span></div>}
        {leave.data && (
          <div>
            <span className="today-strip__k">Leave left this month</span>
            <span className="today-strip__v">
              {LEAVE_KEYS.map(([k, label]) => {
                const left = Math.max(0, Number(leave.data.quota?.[k] || 0) - Number(leave.data.used?.[k] || 0));
                return <span key={k} className="today-strip__chip">{label} {left}/{leave.data.quota?.[k] ?? 0}</span>;
              })}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
