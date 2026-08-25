// ============================================================
// Video-review queue — the behaviours that decide who gets messaged.
//
//   node scripts/video-review-queue-tests.mjs
//
// Pure maths against synthetic data, no DB and no file parsing. Written after
// "0 · 0 · 0 for 24 Aug" was reported as a counting bug for the second time
// when the real answer was "you already generated that day": the queue was
// right, the page just never said so. So these assert BOTH halves — the queue
// still counts correctly, and explainRun accounts for every creator who posted,
// which is what makes an empty run explainable instead of suspicious.
// ============================================================

import {
  buildDueLists, creatorState, preDoneCount, totalMilestones,
  explainRun, previouslySentLists,
} from '../src/lib/videoReviewQueue.js';

let passed = 0, failed = 0;
const out = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; out.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; out.push(`  FAIL <<<  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const key = (c) => String(c?.creator ?? c ?? '').trim().replace(/^@+/, '').toLowerCase();
const RUN = '2026-08-24';
// Creators are always clipped to days <= runDate before the queue sees them.
const clip = (cs, runDate = RUN) => cs
  .map((c) => ({ creator: c.creator, days: c.days.filter((d) => d <= runDate) }))
  .filter((c) => c.days.length);

out.push('\n-- the queue still counts correctly --');
{
  const creators = clip([
    { creator: 'firstvideotoday', days: ['2026-08-24'] },
    { creator: 'secondtoday',     days: ['2026-08-20', '2026-08-24'] },
    { creator: 'thirdtoday',      days: ['2026-08-18', '2026-08-20', '2026-08-24'] },
    { creator: 'fourthtoday',     days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-24'] },
    { creator: 'postedearlier',   days: ['2026-08-20'] },
  ]);
  const r = buildDueLists({ creators, startDate: RUN, runDate: RUN, tracker: new Map(), keyOf: key });
  const all = [...r.group1, ...r.group2, ...r.group3];
  check('1st video today lands in the 1st list', r.group1.join() === 'firstvideotoday', r.group1.join() || 'empty');
  check('2nd video today lands in the 2nd list', r.group2.join() === 'secondtoday', r.group2.join() || 'empty');
  check('3rd video today lands in the 3rd list', r.group3.join() === 'thirdtoday', r.group3.join() || 'empty');
  check('a 4th video is never messaged', !all.includes('fourthtoday'));
  check('someone who did not post today is not due', !all.includes('postedearlier'));
  check('preDoneCount only counts the first three',
    preDoneCount(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'], RUN) === 3);
  check('totalMilestones caps at three', totalMilestones(['a', 'b', 'c', 'd', 'e']) === 3);
}

out.push('\n-- spacing: one message per creator per day --');
{
  const days = ['2026-08-24', '2026-08-24', '2026-08-24'];   // three videos in one day
  const fresh = creatorState({ days, startDate: RUN, runDate: RUN });
  check('a three-video day starts at the 1st message', fresh.due && fresh.next === 1);
  const after = creatorState({ days, startDate: RUN, runDate: RUN, sentCount: 1, lastSentDate: RUN });
  check('and is then blocked for the rest of that day', !after.due && after.blockedToday === true);
  const tomorrow = creatorState({ days, startDate: RUN, runDate: '2026-08-25', sentCount: 1, lastSentDate: RUN });
  check('the 2nd message comes the next day', tomorrow.due && tomorrow.next === 2);
}

out.push('\n-- explainRun accounts for EVERY creator who posted --');
{
  const creators = clip([
    { creator: 'due1st',      days: ['2026-08-24'] },
    { creator: 'alreadysent', days: ['2026-08-24'] },
    { creator: 'pastthird',   days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-24'] },
    { creator: 'sentlater',   days: ['2026-08-24'] },
    { creator: 'spaced',      days: ['2026-08-20', '2026-08-24'] },
    { creator: 'notoday',     days: ['2026-08-19'] },
  ]);
  const tracker = new Map([
    ['alreadysent', { sentCount: 1, lastSentDate: '2026-08-24' }],
    ['sentlater',   { sentCount: 1, lastSentDate: '2026-08-26' }],
    ['spaced',      { sentCount: 1, lastSentDate: '2026-08-24' }],
  ]);
  const why = explainRun({ creators, tracker, runDate: RUN, keyOf: key });
  const lists = buildDueLists({ creators, startDate: RUN, runDate: RUN, tracker, keyOf: key });
  const bucketed = [...why.alreadySentForDate, ...why.sentOnLaterDate, ...why.pastThirdVideo,
                    ...why.finishedAllThree];

  check('counts only videos posted on the run date', why.videosOnDate === 5, `got ${why.videosOnDate}`);
  check('counts the creators behind them', why.creatorsOnDate === 5, `got ${why.creatorsOnDate}`);
  check('a creator with no video that day is ignored entirely', !bucketed.includes('notoday'));
  check('"already sent for this day" is identified', why.alreadySentForDate.includes('alreadysent'));
  check('a 4th+ video is identified as past the third', why.pastThirdVideo.includes('pastthird'));
  check('a later send date is identified', why.sentOnLaterDate.includes('sentlater'));

  // THE property that makes an empty run trustworthy: nobody is unexplained.
  const dueOnDate = [...lists.group1, ...lists.group2, ...lists.group3]
    .filter((n) => creators.find((c) => c.creator === n)?.days.includes(RUN)).length;
  check('every creator who posted is either due or explained, never neither',
    bucketed.length + dueOnDate === why.creatorsOnDate,
    `${bucketed.length} explained + ${dueOnDate} due = ${bucketed.length + dueOnDate}, posted ${why.creatorsOnDate}`);
  check('no creator appears in two buckets at once', new Set(bucketed).size === bucketed.length);
}

out.push('\n-- an empty file day explains itself rather than looking broken --');
{
  const why = explainRun({
    creators: clip([{ creator: 'x', days: ['2026-08-19'] }]),
    tracker: new Map(), runDate: RUN, keyOf: key,
  });
  check('no videos that day is reported as exactly that', why.creatorsOnDate === 0 && why.videosOnDate === 0);
}

out.push('\n-- a day already generated can be recovered --');
{
  const tracker = new Map([
    ['gotfirst',  { sentCount: 1, lastSentDate: RUN }],
    ['gotsecond', { sentCount: 2, lastSentDate: RUN }],
    ['gotthird',  { sentCount: 3, lastSentDate: RUN }],
    ['otherday',  { sentCount: 1, lastSentDate: '2026-08-23' }],
  ]);
  const prev = previouslySentLists({ tracker, runDate: RUN, nameFor: (k) => k.toUpperCase() });
  check('the 1st-review list is reconstructed', prev.group1.join() === 'GOTFIRST', prev.group1.join());
  check('the 2nd-review list is reconstructed', prev.group2.join() === 'GOTSECOND', prev.group2.join());
  check('the 3rd-review list is reconstructed', prev.group3.join() === 'GOTTHIRD', prev.group3.join());
  check('another day is not mixed in',
    ![...prev.group1, ...prev.group2, ...prev.group3].some((n) => n.toLowerCase() === 'otherday'));
  const none = previouslySentLists({ tracker, runDate: '2026-01-01' });
  check('a day never generated reconstructs to nothing',
    none.group1.length + none.group2.length + none.group3.length === 0);
}

out.push('\n-- the exclude list does not create a silent gap --');
{
  // The CSVs are filtered by the exclude list but explainRun is not, so a
  // creator can be genuinely due and still appear nowhere. That gap is closed
  // in the UI, which counts due-but-excluded creators from the SAME lists it
  // filters — deliberately not inside explainRun, both so the two can never
  // drift when the exclude list is edited without re-generating, and so an
  // exclusion cannot outrank the real reason a creator is not due.
  const creators = clip([
    { creator: 'due',    days: ['2026-08-24'] },
    { creator: 'banned', days: ['2026-08-24'] },
    { creator: 'vet',    days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-24'] },
  ]);
  const isExcluded = (n) => n === 'banned';
  const why = explainRun({ creators, tracker: new Map(), runDate: RUN, keyOf: key });
  const lists = buildDueLists({ creators, startDate: RUN, runDate: RUN, tracker: new Map(), keyOf: key });
  const due = [...lists.group1, ...lists.group2, ...lists.group3];
  const excludedDue = due.filter(isExcluded).length;          // what the page shows
  const dueAfterExclude = due.length - excludedDue;           // what totalDue shows
  const bucketed = [...why.alreadySentForDate, ...why.sentOnLaterDate, ...why.pastThirdVideo,
                    ...why.finishedAllThree];

  check('an excluded creator is still DUE as far as the queue is concerned', due.includes('banned'));
  check('an excluded creator is not bucketed as un-due', !bucketed.includes('banned'));
  check('an excluded creator still counts as having posted', why.creatorsOnDate === 3);
  check('the page can account for everyone: explained + shown + excluded == posted',
    bucketed.length + dueAfterExclude + excludedDue === why.creatorsOnDate,
    `${bucketed.length} explained + ${dueAfterExclude} shown + ${excludedDue} excluded = ${bucketed.length + dueAfterExclude + excludedDue}, posted ${why.creatorsOnDate}`);
}

out.push('\n-- a creator catching up is never both due AND explained --');
{
  // The hole this closes: someone owed their 2nd message who happens to post
  // their 5th video on the run date. They ARE due (the queue is catching up),
  // but they have no milestone that day — so a classify-before-due-check would
  // bucket them as "past their 3rd video" while ALSO listing them, making the
  // reconciliation quietly untrue and overstating the explanation.
  const creators = clip([
    { creator: 'catchup', days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-10', '2026-08-24'] },
  ]);
  const tracker = new Map([['catchup', { sentCount: 1, lastSentDate: '2026-08-05' }]]);
  const lists = buildDueLists({ creators, startDate: RUN, runDate: RUN, tracker, keyOf: key });
  const why = explainRun({ creators, tracker, runDate: RUN, keyOf: key });
  const bucketed = [...why.alreadySentForDate, ...why.sentOnLaterDate,
                    ...why.pastThirdVideo, ...why.finishedAllThree];
  check('the catching-up creator is genuinely due', lists.group2.includes('catchup'), lists.group2.join() || 'not due');
  check('and is NOT also counted as an explanation', !bucketed.includes('catchup'),
    bucketed.join() || 'no buckets');
}

out.push('\n-- "already sent" separates finished from more-to-come --');
{
  const creators = clip([
    { creator: 'donetoday', days: ['2026-08-24'] },                                  // 1 video, 1 sent = finished
    { creator: 'moretocome', days: ['2026-08-24', '2026-08-24', '2026-08-24'] },     // 3 videos, 1 sent
  ]);
  const tracker = new Map([
    ['donetoday',  { sentCount: 1, lastSentDate: RUN }],
    ['moretocome', { sentCount: 1, lastSentDate: RUN }],
  ]);
  const why = explainRun({ creators, tracker, runDate: RUN, keyOf: key });
  check('both are reported as already messaged for this day', why.alreadySentForDate.length === 2);
  check('only the one still owed a message is counted as coming tomorrow',
    why.moreComingTomorrow === 1, `got ${why.moreComingTomorrow}`);
}

out.push('\n-- an exclusion never masks the real reason --');
{
  // 'banned' is excluded AND past their 3rd video. The permanent reason must
  // survive: excluding somebody does not change why they were never due.
  const creators = clip([
    { creator: 'banned', days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-24'] },
  ]);
  const why = explainRun({ creators, tracker: new Map(), runDate: RUN, keyOf: key });
  const lists = buildDueLists({ creators, startDate: RUN, runDate: RUN, tracker: new Map(), keyOf: key });
  check('past-the-3rd is still reported for an excluded creator', why.pastThirdVideo.includes('banned'));
  check('and they are not due, so the exclude count does not double-count them',
    ![...lists.group1, ...lists.group2, ...lists.group3].includes('banned'));
}

out.push('\n-- the reported scenario, reproduced --');
{
  // 24 Aug, Inno Supps: 23 creators posted, 13 had already been sent their
  // message for that exact date and 10 were past their 3rd video.
  const creators = clip([
    ...Array.from({ length: 13 }, (_, i) => ({ creator: `sent${i}`, days: ['2026-08-24'] })),
    ...Array.from({ length: 10 }, (_, i) => ({
      creator: `veteran${i}`, days: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-24'],
    })),
  ]);
  const tracker = new Map(Array.from({ length: 13 },
    (_, i) => [`sent${i}`, { sentCount: 1, lastSentDate: RUN }]));
  const lists = buildDueLists({ creators, startDate: RUN, runDate: RUN, tracker, keyOf: key });
  const why = explainRun({ creators, tracker, runDate: RUN, keyOf: key });
  check('the run is genuinely empty',
    lists.group1.length + lists.group2.length + lists.group3.length === 0);
  check('and the reason is stated, not left blank',
    why.alreadySentForDate.length === 13 && why.pastThirdVideo.length === 10,
    `${why.alreadySentForDate.length} already sent, ${why.pastThirdVideo.length} past their 3rd`);
  const prev = previouslySentLists({ tracker, runDate: RUN });
  check('and the day is still downloadable', prev.group1.length === 13);
}

console.log(out.join('\n'));
console.log(`\n${'='.repeat(46)}\n  ${passed} passed, ${failed} failed\n${'='.repeat(46)}`);
process.exit(failed ? 1 : 0);
