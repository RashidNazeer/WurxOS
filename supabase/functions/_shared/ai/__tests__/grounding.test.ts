// The grounding check (agent/grounding.ts): positive cases it must catch and negative cases it must let through.
// The incident (2026-11-02): the OL asked who has the highest score among APCs and TLs in October; Buddy named a
// FORMER APC as the highest TL and said the other TLs had no scores. The incident answer below is the real one
// with the other real names swapped for the committed fixture names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionMessage, parseLabels, redactClaims, UNVERIFIED_NOTE, verifyAnswer, type Evidence } from '../agent/grounding.ts';
import { runDataTool } from '../tools/index.ts';
import { fakeDb } from './fixtures/fakeDb.ts';

const BOSS = { userId: 'boss-1', role: 'boss' };
const PEOPLE = [
  { id: 'apc-new', display_name: 'Haseeb', role: 'apc', is_active: true, deleted_at: null },
  { id: 'apc-two', display_name: 'Umair Tariq', role: 'apc', is_active: true, deleted_at: null },
  { id: 'apc-gone', display_name: 'Ali Ahmad', role: 'apc', is_active: false, deleted_at: '2026-10-12T14:55:22+00:00' },
  { id: 'tl-a', display_name: 'Muhammad Azam', role: 'tl', is_active: true, deleted_at: null },
  { id: 'tl-b', display_name: 'Ali Hamza', role: 'tl', is_active: true, deleted_at: null },
  { id: 'ol', display_name: 'Olive Lead', role: 'ol', is_active: true, deleted_at: null },
];
const names = PEOPLE.map((p) => p.display_name);

async function perfEvidence(): Promise<string> {
  const comp: Record<string, any> = {
    'apc-new': { composite_score: 89, level: 'good' }, 'apc-two': { composite_score: 83, level: 'good' }, 'apc-gone': { composite_score: 56, level: 'warning' },
    'tl-a': { composite_score: 78, level: 'good' }, 'tl-b': { composite_score: 61, level: 'warning' },
  };
  const ratings = [{ user_id: 'apc-new', month: '2026-10', metrics: {}, overall_score: 60 }, { user_id: 'apc-gone', month: '2026-10', metrics: {}, overall_score: 12.8 }];
  const db = fakeDb({ performance_ratings: ratings, profiles: PEOPLE, performance_flags: [], performance_warnings: [], performance_month_snapshots: [] },
    { get_performance_composite: (a: any) => (comp[a.p_user] ? [comp[a.p_user]] : []) });
  return `<data id="D1" tool="get_performance">\n${(await runDataTool(db, BOSS, 'get_performance', { month: '2026-10' })).text}\n</data>`;
}
const ev = (tools: string[], extra: Partial<Evidence> = {}): Evidence => ({ tools, user: [], now: 'NOW: Monday 2026-11-02 23:40 PKT.', people: names, ...extra });
const kinds = (a: string, e: Evidence) => verifyAnswer(a, e).claims.map((c) => `${c.kind}:${c.text}`);

const INCIDENT = [
  'Here are the highest performance scores for October 2026 for Team Leads (TLs) and Affiliate Program Coordinators (APCs) [D1][D2]:',
  '',
  '**Highest Scoring APC**',
  '* **Haseeb** (APC) – **89.0 / 100** (Level: Good) [D1][D2]',
  ' * *Next highest APCs:* Umair Tariq (83.0) and Muhammad Azam (82.0) [D1][D2].',
  '',
  '**Highest Scoring TL**',
  '* **Ali Ahmad** (TL) – **56.0 / 100** (Level: Warning) [D1].',
  ' * Note: The other active Team Leads (Ali Hamza and Muhammad Azam) did not have composite score entries recorded for October [D1][D2].',
].join('\n');

const CORRECT = [
  'Here are the highest October 2026 scores among current APCs and TLs [D1]:',
  '',
  '**Team Leads**',
  '* Muhammad Azam (TL) – 78.0 / 100 (Good) [D1]',
  '* Ali Hamza (TL) – 61.0 / 100 (Warning) [D1]',
  '',
  '**APCs**',
  '* Haseeb (APC) – 89.0 / 100 (Good) [D1]',
  '* Umair Tariq (APC) – 83.0 / 100 (Good) [D1]',
  '',
  'Ali Ahmad (APC) scored 56.0 / 100 in October but is a former employee, so I left him out of the ranking [D1].',
].join('\n');

test('the real incident answer is caught: a former APC called a TL, shown as current, and TLs said to have no scores', async () => {
  const e = ev([await perfEvidence()]);
  const v = kinds(INCIDENT, e);
  assert.ok(v.some((k) => k.startsWith('role:Ali Ahmad is TL')), v.join(' | '));
  assert.ok(v.some((k) => k.startsWith('status:Ali Ahmad')), 'a former employee shown without saying so');
  assert.ok(v.some((k) => k.startsWith('number:82.0')), 'a score the tool never printed (Muhammad Azam 82.0; the tool says 78.0)');
  assert.ok(v.some((k) => k.startsWith('absence:')), 'TLs said to have no composite score while the tool printed one');
});

test('the corrected answer passes with no claims', async () => {
  const e = ev([await perfEvidence()]);
  assert.deepEqual(kinds(CORRECT, e), []);
});

test('numbers (N1): thousands separators, currency signs, K/M and rounding to the precision written', () => {
  const e = ev(['GMV was $211,580.19 for September 2026. Orders 1,345. ROI 2.05. Attendance 90.3%.']);
  for (const ok of ['GMV was $211,580.19.', 'GMV was 211580.19 dollars.', 'About $211.6K in GMV.', 'GMV was about $212K.', 'There were 1345 orders.', 'ROI was 2.05x.', 'Attendance was 90%.', 'Attendance was 90.3 %.']) {
    assert.deepEqual(kinds(ok, e), [], ok);
  }
  for (const bad of ['GMV was $215,000.', 'GMV was $211,580.91.', 'Orders were 1,354.', 'Attendance was 93%.', 'ROI was 2.5x.', 'GMV was $2.1M.']) {
    assert.ok(kinds(bad, e).some((k) => k.startsWith('number:')), bad);
  }
});

test('numbers (N2): derived figures are fine when they follow from printed ones, not when they are made up', () => {
  const e = ev(['August 2026: $235,668.46', 'September 2026: $211,580.19', '- A: PKR 50,000', '- B: PKR 60,000', '- C: PKR 70,000']);
  assert.deepEqual(kinds('GMV fell by $24,088.27 (-10.22%).', e), []);
  assert.deepEqual(kinds('A and B together are PKR 110,000.', e), []);
  assert.deepEqual(kinds('- A: PKR 50,000\n- B: PKR 60,000\n- C: PKR 70,000\nTotal: PKR 180,000.', e), []);
  assert.ok(kinds('GMV fell by $30,000.', e).some((k) => k.startsWith('number:')));
  assert.ok(kinds('Total: PKR 181,000.', e).some((k) => k.startsWith('number:')));
});

test('numbers (N3): years, weeks, dates, ordinals, citations, URLs, small counts and list markers are not figures', () => {
  const e = ev(['Revenue was $5,000.00']);
  const text = ['1. Open [Leave](/leave) 2026', '2. It is week 23 on 2026-10-05 or Oct 25 - 31, 3rd try at 14:30.', 'The top 3 and 2 steps [D1][S2] see https://example.com/a/99999.', '- item with 7 things'].join('\n');
  assert.deepEqual(kinds(text, ev(['Revenue was $5,000.00 on Oct 25 - 31 and 2026-10-05 and October 2026.'], { now: 'NOW: Monday 2026-10-05' })), []);
  assert.deepEqual(kinds('Revenue was $5,000.00 [D1].', e), []);
});

test('dates (D1): a month or day nobody mentioned is flagged; the user\'s own dates and today are fine', () => {
  const e = ev(['Performance for 2026-10 and the week Oct 25 - 31.'], { user: ['What about September 14?'] });
  assert.deepEqual(kinds('In October 2026 the week of Oct 25 - 31 was strong.', e), []);
  assert.deepEqual(kinds('On September 14 nothing was recorded.', e), []);
  assert.ok(kinds('In August the score was strong.', e).some((k) => k.startsWith('date:')));
  assert.ok(kinds('The report covers Nov 12 - 18.', e).some((k) => k.startsWith('date:')));
  assert.deepEqual(kinds('Today is 2026-11-02.', e), []);
});

test('names (P1): an invented colleague is caught; names from the tools, the user, or earlier turns are not', () => {
  const dict = [...names, 'Zed Phantom'];
  const e = ev(['Haseeb (APC) composite 89.0/100'], { people: dict, user: ['and what about Umair Tariq?'], priorAssistant: ['We talked about Ali Hamza before.'] });
  assert.ok(kinds('Zed Phantom has 80.', e).some((k) => k.startsWith('name:Zed Phantom')));
  assert.deepEqual(kinds('Haseeb (APC) has 89.0/100.', e), []);
  assert.deepEqual(kinds('You asked about Umair Tariq.', e), []);
  assert.deepEqual(kinds('Ali Hamza was discussed.', e), []);
});

test('roles (R1): must match the label the tool printed; groups and "reports to" sentences are not misread', async () => {
  const e = ev([await perfEvidence()]);
  assert.deepEqual(kinds('Muhammad Azam and Ali Hamza are Team Leads.', e), []);
  assert.deepEqual(kinds('Haseeb is an APC with 89.0.', e), []);
  assert.deepEqual(kinds('The TL Muhammad Azam scored 78.0.', e), []);
  assert.deepEqual(kinds('Haseeb has the highest score among the TLs and APCs.', e), []);
  assert.ok(kinds('Haseeb is a Team Lead.', e).some((k) => k.startsWith('role:Haseeb is TL')));
  assert.ok(kinds('The highest TL is Haseeb.', e).some((k) => k.startsWith('role:Haseeb is TL')));
  assert.ok(kinds('Muhammad Azam (APC) scored 78.0.', e).some((k) => k.startsWith('role:Muhammad Azam is APC')));
  assert.ok(kinds('| Haseeb | OL | 89.0 |', e).some((k) => k.startsWith('role:Haseeb is OL')));
  // a role the tool never printed for that person cannot be confirmed
  assert.ok(kinds('Olive Lead is the Boss.', ev(['Olive Lead (OL)'])).some((k) => k.startsWith('role:Olive Lead is BOSS')));
});

test('status (S1): a former employee must be called former; an active one must not be', async () => {
  const e = ev([await perfEvidence()]);
  assert.ok(kinds('Ali Ahmad (APC) scored 56.0 / 100.', e).some((k) => k.startsWith('status:Ali Ahmad')));
  assert.deepEqual(kinds('Ali Ahmad (APC) scored 56.0 / 100 but is a former employee.', e), []);
  assert.deepEqual(kinds('Former employees:\n- Ali Ahmad (APC): 56.0 / 100', e), []);
  assert.ok(kinds('Ali Ahmad is one of our current employees.', e).some((k) => k.startsWith('status:Ali Ahmad is a current employee')));
  assert.ok(kinds('Haseeb has left the company.', e).some((k) => k.startsWith('status:Haseeb is former')));
});

test('absence (A1): saying someone has no score when the tool printed one is caught; the tool\'s own "none returned" is not', async () => {
  const e = ev([await perfEvidence()]);
  assert.ok(kinds('Ali Hamza did not have a composite score for October.', e).some((k) => k.startsWith('absence:')));
  const none = ev(['Operation Lead (OL) (1):\n- No composite score returned for this month (the tool does not say why; do not guess a reason): Olive Lead']);
  assert.deepEqual(kinds('Olive Lead has no composite score returned for this month.', none), []);
});

test('redactClaims replaces only the offending sentence and keeps the rest', () => {
  const answer = 'Haseeb (APC) scored 89.0 [D1]. Ali Ahmad is the highest TL [D1].\n- Umair Tariq (APC): 83.0 [D1]';
  const claims = [{ kind: 'role' as const, text: 'x', sentence: 'Ali Ahmad is the highest TL [D1].', reason: 'r', unit: 1 }];
  const out = redactClaims(answer, claims);
  assert.equal(out, `Haseeb (APC) scored 89.0 [D1]. ${UNVERIFIED_NOTE}\n- Umair Tariq (APC): 83.0 [D1]`);
  assert.equal(redactClaims(answer, []), answer);
  const bullets = redactClaims('- good [D1]\n- bad 99,999\n- also good', [{ kind: 'number', text: '99,999', sentence: '', reason: '', unit: 1 }]);
  assert.equal(bullets, `- good [D1]\n- ${UNVERIFIED_NOTE}\n- also good`);
});

test('correctionMessage names every claim and tells the model to use only the tool results', () => {
  const m = correctionMessage([{ kind: 'role', text: 'Ali Ahmad is TL', sentence: 'Ali Ahmad is the highest TL.', reason: 'the tool says APC', unit: 0 }]);
  assert.ok(m.includes('Ali Ahmad is TL') && m.includes('Ali Ahmad is the highest TL.') && m.includes('the tool says APC'));
  assert.ok(m.includes('Use only facts printed in the tool results'));
});

test('parseLabels reads the who() format and the role headings', () => {
  const m = parseLabels(['- Ann Coord (APC)' + String.fromCharCode(10) + '- Gus Gone (APC, former employee – left 2026-10-12)' + String.fromCharCode(10, 10) + 'Operation Lead (OL) (1):' + String.fromCharCode(10) + '- No composite score returned: Olive Lead'], ['Olive Lead']);
  assert.ok(m.get('ann coord')!.roles.has('APC') && !m.get('ann coord')!.former);
  assert.ok(m.get('gus gone')!.former);
  assert.ok(m.get('olive lead')!.roles.has('OL'));
});

test('an answer with no names, numbers or dates produces no claims (how-to answers stay untouched)', () => {
  assert.deepEqual(kinds('Open [Leave](/leave), pick the dates, and submit. Your Team Lead approves it [S1].', ev([])), []);
});

test('periods (D2): a month the tools did not return is not taken from the calendar; "not in yet" needs a tool to say so', () => {
  const e = ev(['Performance for 2026-10 - Haseeb (APC) composite 89.0/100'], { now: 'NOW: Monday 2026-11-02 23:40 PKT.' });
  assert.deepEqual(kinds('October scores: Haseeb (APC) has 89.0/100.', e), []);
  assert.ok(kinds("November ratings aren't in yet.", e).some((k) => k.startsWith('date:')));
  assert.ok(kinds('Haseeb (APC) has 89.0/100 for October; this month is not in yet.', e).some((k) => k.startsWith('date:')));
  assert.deepEqual(kinds('Today is 2026-11-02.', e), []);
  assert.deepEqual(kinds('The October report is not yet approved.', ev(['The October report is not yet approved (figures withheld).'])), []);
});

test('role codes (E1): never expanded into words the tools did not print', () => {
  const e = ev(['- Haseeb (APC) composite 89.0/100'], {});
  assert.ok(kinds('Haseeb is an Associate Program Coordinator (APC).', e).some((k) => k.startsWith('role:')));
  assert.deepEqual(kinds('Haseeb (APC) has 89.0/100.', e), []);
  assert.deepEqual(kinds('Haseeb is an Affiliate Program Coordinator (APC).', ev(['Haseeb (APC)', 'Affiliate Program Coordinator (APC) (3):'])), []);
});
