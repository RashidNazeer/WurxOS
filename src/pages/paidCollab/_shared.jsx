// Shared UI primitives for the Paid Collab pages.
import { ChevronLeftIcon, ChevronRightIcon, CalendarIcon, TiktokIcon } from '../../components/common/Icon';
import { formatMonth } from '../../lib/paidCollabRemote';

// Current month as YYYY-MM
export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ymKey "YYYY-MM" → shift by +/-1 month
export function shiftMonth(ymKey, delta) {
  const [y, m] = ymKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Renders the back/forward/today/all-time bar used by both
// Creators and Videos pages. `month` is 'all' or YYYY-MM.
export function MonthNavigator({ month, onChange, availableMonths = [] }) {
  const isAll = month === 'all';
  const today = currentMonthKey();

  const minMonth = availableMonths.length ? availableMonths[availableMonths.length - 1] : null;
  const maxMonth = availableMonths.length ? availableMonths[0] : null;
  const canBack = !isAll && (!minMonth || month > minMonth);
  const canFwd  = !isAll && (!maxMonth || month < maxMonth);

  return (
    <div className="pc-monthbar">
      <div className="pc-monthbar-left">
        <button
          type="button"
          className="pc-month-nav-btn"
          onClick={() => onChange(shiftMonth(isAll ? today : month, -1))}
          disabled={isAll ? false : !canBack}
          aria-label="Previous month"
        >
          <ChevronLeftIcon width="15" height="15" />
        </button>
        <div className="pc-month-label">
          {isAll ? 'All time' : formatMonth(month)}
        </div>
        <button
          type="button"
          className="pc-month-nav-btn"
          onClick={() => onChange(shiftMonth(isAll ? today : month, 1))}
          disabled={isAll ? false : !canFwd}
          aria-label="Next month"
        >
          <ChevronRightIcon width="15" height="15" />
        </button>
        <button
          type="button"
          className="pc-month-today"
          onClick={() => onChange(today)}
        >Today</button>
      </div>
      <button
        type="button"
        className={`pc-month-alltime ${isAll ? 'is-active' : ''}`}
        onClick={() => onChange(isAll ? today : 'all')}
      >
        <CalendarIcon width="14" height="14" />
        {isAll ? 'Back to month view' : 'View All Time'}
      </button>
    </div>
  );
}

// Initials avatar — used in Creators/Videos cards to match the v1 UI.
export function CreatorAvatar({ name = '', size = 40 }) {
  const initials = (name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((s) => s[0]).join('').toUpperCase() || '?';
  return (
    <div
      className="pc-creator-card-avatar"
      style={{ width: size, height: size, fontSize: size <= 34 ? 11 : 13 }}
    >{initials}</div>
  );
}

// TikTok icon link — renders a disabled-looking icon if no handle.
export function TiktokHandle({ handle, onClick }) {
  if (!handle) {
    return (
      <span className="pc-creator-card-tiktok" style={{ opacity: 0.35, cursor: 'default' }}>
        <TiktokIcon width="18" height="18" />
      </span>
    );
  }
  const url = /^https?:/i.test(handle)
    ? handle
    : `https://www.tiktok.com/@${String(handle).replace(/^@/, '')}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="pc-creator-card-tiktok"
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      aria-label="Open on TikTok"
    >
      <TiktokIcon width="18" height="18" />
    </a>
  );
}
