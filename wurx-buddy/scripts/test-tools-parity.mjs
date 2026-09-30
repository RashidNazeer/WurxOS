// Parity: the 9 ported data tools vs v1's OWN code, on dev data. DEV ONLY, read-only.
//   node --experimental-strip-types scripts/test-tools-parity.mjs
//
// v1 (app repo supabase/functions/ai-chat/index.ts) is a Deno entry point: it
// reads Deno.env and calls Deno.serve at load, so it can't be imported as is.
// This script lifts its tool code VERBATIM (ROLE_LABEL, and everything from
// `const money =` up to `Deno.serve(`), strips the types with Node's own
// stripTypeScriptTypes and imports the result from a data: URL. Nothing is
// re-typed by hand, so a v1 change shows up here as a diff.
//
// Pass rules:
//   • 8 tools: v2 text === v1 text (after the shared 6,000-char bound).
//   • get_reports: v2, minus its currency labels on non-USD lines, ===
//     v1-run-on-approved-rows-only + an optional pending block, which must
//     carry no figures. The raw v1 row count is printed too. Where v1 finds no
//     label at all, v2's date fallback is checked instead (DATE-FALLBACK).
//   • get_performance: v2 bounds and retries the composite calls and says when
//     one fails; a difference passes only as V1-FLAKE (a later v1 run equals
//     v2) or V2-REPORTED-FAILURE.
//
// Output never contains tool text for people & pay tools (salaries, names):
// only PASS/FAIL, lengths and the first differing line NUMBER. Person args are
// shown as <person#n>.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
import { ASSISTANT, ROOT, readEnv } from './dev-env.mjs';

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

// ---- v1, lifted verbatim
export function extractV1(src) {
  const role = src.match(/^const ROLE_LABEL: Record<string, string> = \{[\s\S]*?\r?\n\};\r?\n/m);
  const a = src.search(/^const money = /m);
  const b = src.search(/^Deno\.serve\(/m);
  if (!role || a < 0 || b < a) throw new Error('v1 layout changed: ROLE_LABEL / money / Deno.serve markers not found');
  return stripTypeScriptTypes(`${role[0]}\n${src.slice(a, b)}\nexport { runTool };\n`);
}
const v1src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'ai-chat', 'index.ts'), 'utf8');
const v1 = await import(`data:text/javascript;base64,${Buffer.from(extractV1(v1src)).toString('base64')}`);
const v2 = await import('../supabase/functions/_shared/ai/tools/index.ts');

// v1 with reports narrowed to approved rows: the expected v2 body.
const approvedOnly = new Proxy(admin, {
  get(t, p) {
    if (p !== 'from') return Reflect.get(t, p);
    return (table) => {
      const b = t.from(table);
      if (table !== 'reports') return b;
      return new Proxy(b, { get(bt, bp) { return bp === 'select' ? (...a) => bt.select(...a).eq('status', 'approved') : Reflect.get(bt, bp); } });
    };
  },
});

// ---- cases (people picked from dev at run time, never written down)
const { data: boss } = await admin.from('profiles').select('id').eq('role', 'boss').eq('is_active', true).is('deleted_at', null).limit(1);
if (!boss?.length) throw new Error('no active boss on dev');
const ctx = { userId: boss[0].id, role: 'boss' };
const { data: staff } = await admin.from('profiles').select('display_name').eq('is_active', true).is('deleted_at', null).in('role', ['apc', 'tl']).order('display_name').limit(40);
const unique = [];
for (const s of staff || []) {
  const full = String(s.display_name || '').trim();
  const { data: m } = await admin.from('profiles').select('id').ilike('display_name', `%${full}%`).is('deleted_at', null).limit(2);
  if (m?.length === 1) unique.push(full);
  if (unique.length === 2) break;
}
const [p1, p2] = unique;
const alias = new Map([[p1, '<person#1>'], [p2, '<person#2>']]);
const month = (await admin.from('incentives').select('month').order('month', { ascending: false }).limit(1)).data?.[0]?.month;
const prevMonth = month ? (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })() : undefined;

const CASES = [
  ['find_person', { name: p1 }], ['find_person', { name: 'zz-nobody-zz' }], ['find_person', { name: 'a' }],
  ['get_employees', {}], ['get_employees', { role: 'apc' }], ['get_employees', { include_inactive: true, search: 'a' }],
  ['get_incentives', { person_name: p1 }], ['get_incentives', {}], ['get_incentives', { person_name: p2, month: prevMonth }],
  ['get_salary', { person_name: p1 }], ['get_salary', {}], ['get_salary', { person_name: 'zz-nobody-zz' }],
  ['get_performance', { person_name: p1 }], ['get_performance', {}], ['get_performance', { person_name: p2, month: prevMonth }],
  ['get_attendance', { person_name: p1 }], ['get_attendance', { person_name: p2, month: prevMonth, detail: true }], ['get_attendance', {}],
  ['get_leave', {}], ['get_leave', { status: 'approved', month: prevMonth }], ['get_leave', { person_name: p1 }],
  ['list_brands', {}],
  ['get_reports', { brand_name: 'Cutler', period: 'Week 2' }],
  ['get_reports', { brand_name: 'Cutler' }],
  ['get_reports', { period: 'August 2026', type: 'monthly' }],
  ['get_reports', { brand_name: 'Longevity', period: 'August 2026', sections: ['metrics', 'gmvmax'] }],   // GBP labels
  ['get_reports', { brand_name: 'Nama', period: 'June', sections: ['all'] }],
  // v1 finds no "July" label for Nama and answers nothing; v2 then matches by
  // dates and falls back to the latest approved report (the Lead's "last week"
  // case). Checked as a DATE-FALLBACK case, not as parity.
  ['get_reports', { brand_name: 'Nama', period: 'July', sections: ['all'] }],
  ['get_reports', { brand_name: 'Cutler Nutrition', period: 'last week', sections: ['creators'] }],
  ['get_reports', {}],
  ['get_reports', { brand_name: 'Cutler', sections: ['creators'], type: 'weekly' }],
];
const SENSITIVE = new Set(['find_person', 'get_employees', 'get_incentives', 'get_salary', 'get_performance', 'get_attendance', 'get_leave']);
const showArgs = (a) => JSON.stringify(a, (k, v) => (typeof v === 'string' && alias.has(v) ? alias.get(v) : v));
const mask = (s) => s.replace(/\d/g, '#');
const PENDING = /^\n\nNot yet approved \(figures withheld; never quote them\):\n(- [^\n]+ \((weekly|biweekly|monthly)\): [^\n]+)(\n- [^\n]+ \((weekly|biweekly|monthly)\): [^\n]+)*$/;

function firstDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { i, a: x[i] ?? '(none)', b: y[i] ?? '(none)' };
  return null;
}

async function check(tool, args) {
  const got = await v2.runDataTool(admin, ctx, tool, args);
  if (tool !== 'get_reports') {
    const want = v2.bound(await v1.runTool(admin, tool, args)).text;
    if (got.text === want) return { ok: true, detail: `len ${want.length}` };
    if (tool === 'get_performance') {
      // v2 loads composites 4 at a time with a retry and SAYS when one fails;
      // v1 fires them all and silently falls back. So a difference is v1
      // flaking (another v1 run matches v2) or a failure v2 reported.
      for (let i = 0; i < 2; i++) {
        if (v2.bound(await v1.runTool(admin, tool, args)).text === got.text) return { ok: true, kind: 'V1-FLAKE', detail: `len ${got.text.length}; v1's first run differed, a later v1 run equals v2` };
      }
      if (got.text.includes('composite could not be loaded')) return { ok: true, kind: 'V2-REPORTED-FAILURE', detail: 'a composite lookup failed twice and v2 said so' };
    }
    const d = firstDiff(want, got.text);
    const again = v2.bound(await v1.runTool(admin, tool, args)).text;
    const perm = want.split('\n').sort().join('\n') === got.text.split('\n').sort().join('\n');
    return { ok: false, detail: `len ${want.length} vs ${got.text.length}; first diff at line ${d?.i + 1}; v1 repeatable: ${again === want}; same lines, other order: ${perm}` + (SENSITIVE.has(tool) ? ' (text withheld: sensitive)' : `: v1 "${mask(d.a).slice(0, 140)}" vs v2 "${mask(d.b).slice(0, 140)}"`) };
  }
  const want = v2.bound(await v1.runTool(approvedOnly, tool, args)).text;
  const raw = await v1.runTool(admin, tool, args);
  const rows = (s) => s.match(/^Reports \((\d+) matched\)/m)?.[1] ?? 0;
  if (/^No matching reports found/.test(raw) && !got.text.startsWith(want)) {
    // Date fallback: v1 had no label match at all. v2 must say so plainly and
    // show approved figures only (its body lines all end "(<type>, approved)").
    const said = /^(\(Matched "|No \w+ ?report has been submitted for |The \w+ ?report for .* exists but is )/.test(got.text);
    const onlyApproved = !/^- .*\((weekly|biweekly|monthly), (?!approved\))/m.test(got.text);
    return { ok: said && onlyApproved, kind: 'DATE-FALLBACK', detail: `v1: no label match; v2 rows ${rows(got.text)}; first line "${mask(got.text.split('\n')[0]).slice(0, 140)}"` };
  }
  // Decision 1: non-USD report lines carry their currency. Remove exactly those
  // labels, then v2 must equal v1-on-approved-rows.
  const labels = (got.text.match(/ \((?:money in )?(?:GBP|EUR|PKR)\)/g) || []).length;
  const bare = got.text.replace(/ \((?:money in )?(?:GBP|EUR|PKR)\)/g, '');
  const rest = bare.startsWith(want) ? bare.slice(want.length) : null;
  const ok = rest !== null && (rest === '' || (PENDING.test(rest) && !/GMV|ROI|orders/i.test(rest)));
  let detail = `v1 rows ${rows(raw)} → approved ${rows(want)}; pending notes ${(rest?.match(/\n- /g) || []).length}${labels ? `; currency labels ${labels}` : ''}`;
  if (!ok) { const d = firstDiff(want, bare); if (d) detail += `; line ${d.i + 1}: v1 "${mask(d.a).slice(0, 140)}" vs v2 "${mask(d.b).slice(0, 140)}"`; }
  return { ok, detail };
}

let fail = 0;
for (const [tool, args] of CASES) {
  let r = await check(tool, args);
  // v1 swallows RPC errors (e.g. one of ~20 parallel get_performance_composite
  // calls timing out on the dev pooler) and prints a different fallback line.
  // One retry separates that flake from a real divergence; it is reported.
  if (!r.ok) { const again = await check(tool, args); if (again.ok) r = { ...again, detail: `${again.detail} (passed on retry; first run: ${r.detail})` }; }
  if (!r.ok) fail++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}${r.kind ? ` [${r.kind}]` : ''}  ${tool} ${showArgs(args)}  ${r.detail}`);
}
console.log(`\n${CASES.length - fail}/${CASES.length} parity cases pass.`);
process.exit(fail ? 1 : 0);
