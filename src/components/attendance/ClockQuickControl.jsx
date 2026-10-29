import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClockActions } from './useClockActions';
import { calcTimes, fmtDurationLive, fmtTime, getEffectiveStatus } from '../../lib/attendanceApi';
import { Button, StatusBadge, Skeleton } from '../ui';

// Compact clock control for the Today strip: status, live timer, Clock in
// (with the same location picker), Break, Clock out — shown under the same
// conditions as ClockWidget. All rules live in useClockActions; UI only.
// Lake City is closed (team moved to Bahria): not offered, but old records keep their label.
const LOCATIONS = [
  { key: 'bahria',   label: 'Bahria Office',    icon: 'bi-building' },
  { key: 'wfh',      label: 'Work From Home',   icon: 'bi-house-door' },
];
const RECORD_LOCATIONS = [...LOCATIONS, { key: 'lakecity', label: 'Lake City Office', icon: 'bi-buildings' }];
const STATUS = {
  'clocked-in':       { tone: 'success', label: 'Working' },
  'on-break':         { tone: 'warning', label: 'On break' },
  'pending-approval': { tone: 'info',    label: 'Pending approval' },
  'clocked-out':      { tone: 'neutral', label: 'Clocked out' },
  'auto-closed':      { tone: 'danger',  label: 'Auto-closed' },
};

export default function ClockQuickControl() {
  const {
    currentUser, record, loading, action, showClockIn, setShowClockIn, taskError,
    handleClockIn, handleBreak, handleClockOut, modals,
  } = useClockActions();
  const [, setTick] = useState(0);
  const live = record && ['clocked-in', 'on-break'].includes(record.status);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  if (!currentUser) return null;
  if (loading) return <div aria-busy="true"><Skeleton w={160} h={22} /><Skeleton w="100%" h={44} style={{ marginTop: 10 }} /></div>;

  const eff = getEffectiveStatus(record);
  const st = STATUS[eff] || { tone: 'neutral', label: 'Not clocked in' };
  const times = record ? calcTimes(record) : { totalWorkMs: 0 };
  const isClockedOut = !record || record.status === 'clocked-out';
  const location = RECORD_LOCATIONS.find((l) => l.key === record?.location);

  return (
    <div className="today-clock">
      <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
        <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
        {live && <span className="today-clock__timer">{fmtDurationLive(times.totalWorkMs)}</span>}
        {record?.clockIn && (
          <span className="today-clock__meta">
            In {fmtTime(record.clockIn)}{location ? ` · ${location.label}` : ''}
          </span>
        )}
      </div>

      {isClockedOut ? (
        showClockIn ? (
          <div className="today-clock__locations" role="group" aria-label="Where are you working today?">
            {LOCATIONS.map((loc) => (
              <Button key={loc.key} variant="secondary" size="lg" block
                icon={<i className={`bi ${loc.icon}`} />}
                loading={action === 'clockin'}
                onClick={() => handleClockIn(loc.key)}>
                {loc.label}
              </Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setShowClockIn(false)}>Cancel</Button>
          </div>
        ) : (
          <Button size="lg" block icon={<i className="bi bi-box-arrow-in-right" />}
            onClick={() => setShowClockIn(true)} disabled={!!action}>
            Clock in
          </Button>
        )
      ) : record.status !== 'pending-approval' ? (
        <div className="today-clock__actions">
          <Button variant="secondary" size="lg" onClick={handleBreak} loading={action === 'break'} disabled={!!action}
            icon={<i className={`bi ${record.status === 'on-break' ? 'bi-play-fill' : 'bi-cup-hot'}`} />}>
            {record.status === 'on-break' ? 'End break' : 'Break'}
          </Button>
          <Button variant="danger" size="lg" onClick={handleClockOut} loading={action === 'clockout'}
            disabled={!!action || record.status === 'on-break'}
            icon={<i className="bi bi-box-arrow-right" />}>
            Clock out
          </Button>
        </div>
      ) : (
        <Link to="/attendance" className="today-clock__link">Open Attendance <i className="bi bi-arrow-right" /></Link>
      )}

      {taskError && <div className="today-clock__error" role="alert">{taskError}</div>}
      {modals}
    </div>
  );
}
