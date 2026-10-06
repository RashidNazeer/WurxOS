// The new report tools against dev data, checked against the reference values
// the Owner, Lead and QA established by hand. DEV ONLY, read-only.
//   node --experimental-strip-types scripts/test-tools-dev.mjs
// Prints report/brand facts only; people & pay tools are checked for the role
// gate, never printed.
import path from 'node:path';
import { createRequire } from 'node:module';
import { ASSISTANT, readEnv } from './dev-env.mjs';

const require = createRequire(path.join(ASSISTANT, 'package.json'));
const { createClient } = require('@supabase/supabase-js');
const env = readEnv();
{
  const ref = env.WURXOS_DEV_PROJECT_REF || '';
  let host = '';
  try { host = new URL(env.VITE_SUPABASE_URL).hostname.toLowerCase(); } catch { /* checked below */ }
  if (!/^[a-z0-9]{20}$/.test(ref) || ref === 'xoaaidgvblondjpvxjqp' || host !== `${ref}.supabase.co`) {
    console.error('Refusing: VITE_SUPABASE_URL is not the dev project (WURXOS_DEV_PROJECT_REF).');
    process.exit(1);
  }
}
const admin = createClient(env.VITE_SUPABASE_URL, env.WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const T = await import('../supabase/functions/_shared/ai/tools/index.ts');
const R = await import('../supabase/functions/_shared/ai/tools/reports.ts');

const { data: boss } = await admin.from('profiles').select('id').eq('role', 'boss').eq('is_active', true).is('deleted_at', null).limit(1);
const ctx = { userId: boss[0].id, role: 'boss' };
// "Today" for the relative periods below is the real clock; the reference
// values were taken on 2026-09-29 PKT (last week = Sep 20-26, last month = August).
const run = (name, args, c = ctx) => T.runDataTool(admin, c, name, args);

let fail = 0;
const check = (label, cond, extra = '') => { if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const has = (s, sub) => s.includes(sub);

// 1. "top Cutler Nutrition creator last week, items sold" (Owner test 1)
{
  const r = await run('get_top_creators', { brand: 'Cutler Nutrition', period: 'last week' });
  check('top creators last week: says no report is in yet for Sep 20–26 (missing, not pending)', has(r.text, 'No weekly report has been submitted for Sep 20 – 26, 2026 (PKT) yet (not in yet).') && r.data?.period_status === 'missing');
  check('top creators last week: shows Week 24 instead', has(r.text, 'Week 24 (Sep 13 - 19)'));
  check('top creators last week: Week 22 named as pending (verified), no figures', r.source.pending?.some((p) => p.period.startsWith('Week 22') && p.status === 'verified') && has(r.text, 'Week 22 (Aug 30 - Sep 5) (weekly): verified'));
  check('top creators last week: items sold present', /items sold \d/.test(r.text), r.text.split('\n').find((l) => l.startsWith('1. ')));
}
// 2. June (Owner test 3): monthly ranking + items derived from Weeks 10-12
{
  const r = await run('get_top_creators', { brand: 'Cutler Nutrition', period: 'June 2026' });
  const d = r.data;
  const top = d?.creators?.[0];
  check('June: monthly top is @tavo2real $9,302.45', top?.name === '@tavo2real' && top.gmv === 9302.45 && has(r.text, '@tavo2real — GMV $9,302.45'), JSON.stringify(top));
  check('June: items 155 derived from 3 weekly lists', top?.items_sold === 155 && top.items_source === 'weekly' && top.weeks_listed === 3);
  check('June: weeks used = Weeks 10–12', JSON.stringify(d?.weeks_used?.map((w) => w.split(' (')[0])) === JSON.stringify(['Week 10', 'Week 11', 'Week 12']), JSON.stringify(d?.weeks_used));
  check('June: Weeks 9 and 13 excluded as straddling', ['Week 9', 'Week 13'].every((w) => d?.weeks_excluded?.some((x) => x.period.startsWith(`${w} (`) && /straddles/.test(x.reason))), JSON.stringify(d?.weeks_excluded));
  check('June: disclosure fields', d?.derived_from === 'weekly' && d?.partial_per_creator === true && d?.note === 'monthly reports do not record items sold per creator');
  // The weekly-only derivation of the same month (QA/Lead reference: $6,981.42).
  const { data: weeks } = await admin.from('reports').select('id, brand_id, type, period_label, period_start, period_end, status, data, sections_enabled, brand:brand_id(brand_name, currency)')
    .eq('brand_id', (await admin.from('brands').select('id').eq('brand_name', 'Cutler Nutritions').single()).data.id).eq('type', 'weekly')
    .lte('period_start', '2026-06-30').gte('period_end', '2026-06-01');
  const w = R.monthCreatorView(null, weeks, '2026-06-01', '2026-06-30').creators.find((c) => c.handle === 'tavo2real');
  check('June weeklies: tavo2real 155 items / $6,981.42 over 3 weeks', w?.items_sold === 155 && Math.abs(w.gmv - 6981.42) < 0.005 && w.weeks_listed === 3, JSON.stringify(w));
}
// 3. last month = August (Owner test 2): monthly verified → all derived from Weeks 18–21
{
  const r = await run('get_top_creators', { brand: 'Cutler Nutrition', period: 'August 2026' });
  const d = r.data;
  check('August: no approved monthly → derived', d?.monthly_report === null && d?.derived_from === 'weekly' && has(r.text, 'the August 2026 monthly report exists but is verified, awaiting approval (figures withheld)') && d?.period_status === 'pending');
  check('August: monthly pending note (verified)', r.source.pending?.some((p) => p.period === 'August 2026' && p.status === 'verified') && has(r.text, 'August 2026 (monthly): verified'));
  check('August: weeks used = Weeks 18–21', JSON.stringify(d?.weeks_used?.map((x) => x.split(' (')[0])) === JSON.stringify(['Week 18', 'Week 19', 'Week 20', 'Week 21']), JSON.stringify(d?.weeks_used));
  check('August: Week 22 excluded (straddles; not approved)', d?.weeks_excluded?.some((x) => x.period.startsWith('Week 22') && /not approved/.test(x.reason)));
  check('August: top creator has derived items', d?.creators?.[0]?.items_sold != null, JSON.stringify(d?.creators?.[0]));
}
// 4. rank_brands, QA reference values (August, approved monthlies)
{
  const roi = await run('rank_brands', { metric: 'gmv_max_roi', period: 'August 2026', top_n: 3 });
  const top = roi.data?.ranked?.slice(0, 3).map((x) => `${x.brand} ${x.value.toFixed(2)}`);
  check('rank gmv_max_roi Aug: Klassy 2.57, Aqua Sonic 2.49, Pure Daily Care 1.75', JSON.stringify(top) === JSON.stringify(['Klassy Network 2.57', 'Aqua Sonic 2.49', 'Pure Daily Care 1.75']), JSON.stringify(top));
  check('rank gmv_max_roi Aug: Cutler excluded (verified only)', !roi.data?.ranked?.some((x) => /Cutler/.test(x.brand)));
  check('rank Aug: 16 of 19 monthly reports approved', has(roi.text, '16 of 19 monthly reports in the period are approved'), roi.text.split('\n')[1]);
  const sp = await run('rank_brands', { metric: 'gmv_max_spend', period: 'August 2026', top_n: 3 });
  check('rank gmv_max_spend Aug: Klassy $140,492.83 first', sp.data?.ranked?.[0]?.brand === 'Klassy Network' && sp.data.ranked[0].value === 140492.83, JSON.stringify(sp.data?.ranked?.[0]));
  const t = sp.data?.totals || [];
  check('rank gmv_max_spend Aug: $537,804.57 over 15 + £5,655.36 over 1, separate', t.length === 2 && t[0].currency === 'USD' && t[0].sum === 537804.57 && t[0].reports === 15 && t[1].currency === 'GBP' && t[1].sum === 5655.36 && t[1].reports === 1, JSON.stringify(t));
  check('rank output states coverage over active brands', /Coverage: \d+ of \d+ active brands/.test(sp.text));
}
// 5. compare_periods: baseline by period, currency stated
{
  const r = await run('compare_periods', { brand: 'Cutler Nutrition', metric: 'gmv', period_a: 'Week 24' });
  check('compare Week 24 vs previous → baseline Week 23', has(r.text, 'Week 23 (Sep 6 - 12) (baseline)') && /Change: [+-]\$/.test(r.text), r.text.split('\n').slice(1).join(' | '));
  const x = await run('compare_periods', { brand: 'Cutler Nutrition', metric: 'gmv', period_a: 'last week' });
  check('compare last week → no approved report, nothing computed', has(x.text, 'No weekly report has been submitted for Sep 20 – 26, 2026 (PKT) yet (not in yet).') && has(x.text, 'Nothing compared') && x.data?.period_status === 'missing');
}
// 6. get_reports keeps the pending note for the Owner's case
{
  const r = await run('get_reports', { brand_name: 'Cutler Nutrition', period: 'last week', sections: ['creators'] });
  check('get_reports last week: fallback + Week 22 pending, figures withheld', has(r.text, 'Week 24 (Sep 13 - 19) (weekly, approved)') && has(r.text, 'Week 22 (Aug 30 - Sep 5) (weekly): verified'));
}
// 7. The rest run cleanly
for (const [n, a] of [['brand_overview', { brand: 'Cutler Nutrition' }], ['get_gmv_max', { brand: 'Nama' }], ['get_agenda_tasks', { status: 'todo', limit: 5 }], ['list_brands', {}]]) {
  const r = await run(n, a);
  check(`${n} runs`, !/failed:/.test(r.text) && r.text.length <= T.TOOL_RESULT_CHAR_CAP && r.source?.table, `${r.text.length} chars, source ${r.source.table}`);
}
// 8. Role gate: a non-Boss caller
{
  // The active APC with the most brand assignments, so "narrowed" is meaningful.
  const { data: apcs } = await admin.from('profiles').select('id').eq('role', 'apc').eq('is_active', true).is('deleted_at', null);
  const { data: asg } = await admin.from('brand_assignments').select('user_id').in('user_id', apcs.map((p) => p.id));
  const count = new Map();
  (asg || []).forEach((a) => count.set(a.user_id, (count.get(a.user_id) || 0) + 1));
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const actx = { userId: best[0], role: 'apc' };
  const sal = await run('get_salary', {}, actx);
  // No caller JWT client here: people & pay fail closed (role runs: test-tools-roles.mjs).
  check('APC without a JWT client: get_salary refused', sal.text === T.NOT_YOURS);
  const lb = await run('list_brands', {}, actx);
  const all = await run('list_brands', {});
  const n = (s) => Number(s.match(/^Brands \((\d+)\)/)?.[1] || 0);
  check('APC: list_brands narrowed to viewable brands', n(lb.text) > 0 && n(lb.text) < n(all.text), `${n(lb.text)} of ${n(all.text)} (assigned to ${best[1]})${n(lb.text) ? '' : `: ${lb.text.slice(0, 120)}`}`);
  const rk = await run('rank_brands', { metric: 'gmv', period: 'August 2026' }, actx);
  check('APC: rank_brands coverage counts only viewable brands', /Coverage: \d+ of \d+ active brands/.test(rk.text) && (rk.data?.active ?? 99) <= n(lb.text), `${rk.data?.covered} of ${rk.data?.active}`);
}
console.log(`\n${fail ? `${fail} FAILED` : 'all passed'}`);
process.exit(fail ? 1 : 0);
