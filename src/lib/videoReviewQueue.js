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

// ── Why is a run empty? ─────────────────────────────────────────────
// "0 · 0 · 0" is a legitimate answer and, worse, it is the answer you get for
// several completely different reasons. The most common one by far is the least
// obvious: you already generated this exact day, and downloading a list marks
// it sent. Twice now that has been reported as a counting bug when the real
// story was "the work is done" — so the page has to say which reason it is.
//
// Pure, like everything else here. `creators` are already clipped to
// days <= runDate, exactly as buildDueLists receives them.
export function explainRun({ creators, tracker = new Map(), runDate, keyOf }) {
  const key = keyOf || defaultKey;
  const out = {
    videosOnDate: 0,
    creatorsOnDate: 0,
    alreadySentForDate: [],   // messaged on this exact day — the usual answer
    moreComingTomorrow: 0,    // ...of whom this many are still owed one, tomorrow
    sentOnLaterDate: [],      // the run date is BEHIND what has already been sent
    pastThirdVideo: [],       // posted that day, but it was their 4th+ video
    finishedAllThree: [],     // owed nothing further (not necessarily three sent)
  };
  for (const c of creators) {
    const idxs = [];
    c.days.forEach((d, i) => { if (d === runDate) idxs.push(i); });
    if (!idxs.length) continue;                 // did not post on the run date
    out.videosOnDate += idxs.length;
    out.creatorsOnDate += 1;

    const t = tracker.get(key(c));
    const st = creatorState({
      days: c.days, startDate: runDate, runDate,
      sentCount: t ? t.sentCount : null,
      lastSentDate: t ? t.lastSentDate : null,
    });

    // DUE FIRST, and that ordering is the whole correctness of this function.
    // Classifying before asking "is it due" let a creator be bucketed as a
    // reason AND appear in a list at the same time: someone catching up their
    // 2nd message on a day they happened to post their 5th video is genuinely
    // due, yet has no milestone that day. Counting them in both places is what
    // would make the reconciliation — every creator either due or explained,
    // never both — quietly untrue.
    if (st.due) continue;

    // Not due. Say why, most-actionable first: "you already did this day" is
    // the misreading this whole function exists to prevent.
    if (t && t.lastSentDate === runDate) {
      out.alreadySentForDate.push(c.creator);
      if (st.owed > 0) out.moreComingTomorrow += 1;   // spacing: one per day
      continue;
    }
    if (t && cmp(t.lastSentDate, runDate) > 0) { out.sentOnLaterDate.push(c.creator); continue; }
    // A milestone is one of their first THREE videos ever (index 0,1,2).
    if (!idxs.some((i) => i < 3)) { out.pastThirdVideo.push(c.creator); continue; }
    out.finishedAllThree.push(c.creator);
  }
  return out;
}

// Reconstruct the three lists that were generated for `runDate` on an earlier
// visit, so a day already sent can be downloaded again without touching the
// tracker. Needs no new storage: after a send, a creator's sentCount IS the
// milestone number they were sent, and lastSentDate is the day it happened.
export function previouslySentLists({ tracker = new Map(), runDate, nameFor }) {
  const group1 = [], group2 = [], group3 = [];
  for (const [k, t] of tracker) {
    if (!t || t.lastSentDate !== runDate) continue;
    const name = (nameFor && nameFor(k)) || k;
    if (t.sentCount === 1) group1.push(name);
    else if (t.sentCount === 2) group2.push(name);
    else if (t.sentCount === 3) group3.push(name);
  }
  group1.sort(cmp); group2.sort(cmp); group3.sort(cmp);
  return { group1, group2, group3 };
}
