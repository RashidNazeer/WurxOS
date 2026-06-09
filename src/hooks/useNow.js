import { useState, useEffect } from 'react';
import { getNowDate } from '../lib/serverTime';

/**
 * Re-renders on an interval so time-based UI (unlock gates, countdowns)
 * updates live without a manual refresh. Anchored to server time
 * (serverTime.js, synced at app boot), so it can't be fooled by a skewed
 * client clock. Default tick is 30s — fine for minute-granularity gates.
 */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => getNowDate());
  useEffect(() => {
    const id = setInterval(() => setNow(getNowDate()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
