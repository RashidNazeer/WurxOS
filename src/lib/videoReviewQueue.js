// ============================================================
// Video-review queue logic (file-based mode) — PURE, no I/O.
//
// This is the brain of the "generate video-review lists from an uploaded
// TikTok export" feature. It is deliberately free of React, Supabase and
// file parsing so it can be unit-tested in isolation and reused by the
// worker and the UI.
//
// Model (agreed with the Boss):
//  - A BASELINE date ("the line"): every video a creator posted BEFORE it
//    is treated as "review already given". It is not messaged, it only
//    counts toward where the creator stands.
//  - Each creator's first three videos EVER are their milestones (1st/2nd/
//    3rd review). We never send a 4th.
//  - A creator is owed a message when they have more milestones than we
//    have sent. We release ONE message per creator per day (spacing), in
//    order, until all their milestones are covered. That is the "queue":
//    a creator who dumps five videos in one day still gets 1st today, 2nd
//    tomorrow, 3rd the day after.
//  - "Sent" is tracked (per brand + creator: how many sent, and the date
//    of the last one) so we never double-send and always finish all three.
// ============================================================

// Lexicographic compare works for 'YYYY-MM-DD'.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Default creator key — MUST match videoReviewFileApi.creatorKey and the DB
// `creator` column: lowercased handle with any leading '@' stripped. Callers
// pass keyOf: creatorKey; this is the fallback so both stay in lockstep.
const defaultKey = (c) => String(c?.creator ?? '').trim().replace(/^@+/, '').toLowerCase();

// How many of a creator's first-three milestones fall BEFORE the baseline
// (so they count as already reviewed and are seeded as "sent").
// `sortedDays` = that creator's unique video days, oldest-first.
export function preDoneCount(sortedDays, startDate) {
  let n = 0;
  for (let i = 0; i < sortedDays.length && i < 3; i++) {
    if (sortedDays[i] < startDate) n++;
  }
  return n;
}

// Total milestones a creator can ever be messaged for (cap 3).
export function totalMilestones(sortedDays) {
  return Math.min(sortedDays.length, 3);
}

// Decide one creator's state as of `runDate`.
//   days         : unique video days oldest-first, all <= runDate
//   startDate    : baseline 'the line'
//   runDate      : the as-of date we're generating for (usually today)
//   sentCount    : messages already sent (from the tracker); null = new creator
//   lastSentDate : date of their last sent message (from the tracker) or null
// Returns { total, sent, owed, due, next?, blockedToday? }.
export function creatorState({ days, startDate, runDate, sentCount = null, lastSentDate = null }) {
  const total = totalMilestones(days);
  // A creator we've never tracked starts at their pre-baseline count.
  const sent = sentCount == null ? preDoneCount(days, startDate) : sentCount;
  const owed = total - sent;
  if (owed <= 0) return { total, sent, owed: 0, due: false };
  // One message per creator per calendar day.
  if (lastSentDate && cmp(lastSentDate, runDate) >= 0) {
    return { total, sent, owed, due: false, blockedToday: true };
  }
  return { total, sent, owed, due: true, next: sent + 1 };
}

// Build the three due-lists for a run.
//   creators : [{ creator, days: string[] }]  (days unique, oldest-first, <= runDate)
//   tracker  : Map(creatorKey -> { sentCount, lastSentDate })  (may be empty)
//   keyOf    : how to key a creator (default: lowercased name) — matches the tracker.
// Returns { group1, group2, group3, blockedToday, states } where each group is
// an array of the ORIGINAL creator names, sorted.
export function buildDueLists({ creators, startDate, runDate, tracker = new Map(), keyOf }) {
  const key = keyOf || defaultKey;
  const group1 = [], group2 = [], group3 = [];
  const blockedToday = [];
  const states = new Map();
  for (const c of creators) {
    const k = key(c);
    const t = tracker.get(k);
    const st = creatorState({
      days: c.days,
      startDate,
      runDate,
      sentCount: t ? t.sentCount : null,
      lastSentDate: t ? t.lastSentDate : null,
    });
    states.set(k, st);
    if (!st.due) {
      if (st.blockedToday) blockedToday.push(c.creator);
      continue;
    }
    if (st.next === 1) group1.push(c.creator);
    else if (st.next === 2) group2.push(c.creator);
    else if (st.next === 3) group3.push(c.creator);
  }
  group1.sort(cmp); group2.sort(cmp); group3.sort(cmp);
  return { group1, group2, group3, blockedToday, states };
}

// What "Mark <group> as sent" writes to the tracker: for each creator, bump
// sentCount by 1 and stamp lastSentDate = runDate. Pure — returns the rows to
// upsert; the caller persists them. `prior` is the current tracker Map (for
// creators new to the tracker we seed from pre-baseline first, then +1).
export function markSentUpdates({ creators, group, runDate, startDate, tracker = new Map(), keyOf }) {
  const key = keyOf || defaultKey;
  const byKey = new Map(creators.map((c) => [key(c), c]));
  // Key the wanted-set with the SAME key fn as byKey — a hardcoded lowercase
  // here would miss any '@'-prefixed handle (creatorKey strips '@'), silently
  // drop it from the tracker write, and re-message it every run.
  const wanted = new Set(group.map((name) => key({ creator: name })));
  const updates = [];
  for (const [k, c] of byKey) {
    if (!wanted.has(k)) continue;
    const t = tracker.get(k);
    const base = t ? t.sentCount : preDoneCount(c.days, startDate);
    updates.push({ key: k, creator: c.creator, sentCount: base + 1, lastSentDate: runDate });
  }
  return updates;
}
