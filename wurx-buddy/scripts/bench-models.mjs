// Free-model benchmark through the real Buddy tool-calling flow (system prompt +
// tool definitions from supabase/functions/_shared/ai, fixed fixture tool outputs).
// Usage: node --experimental-strip-types wurx-buddy/scripts/bench-models.mjs <env-file> <out.json> <slot:model>[,...] [questionIds|all]
// Keys read from the env file: Gemini_Fallback, GROQ_Fallback, NEM_API, OPEN_AI_API_KEY_FALLBACK (never printed).
import fs from 'node:fs';
import { chatRespond } from '../../supabase/functions/_shared/ai/llm/chat.ts';
import { respond } from '../../supabase/functions/_shared/ai/llm/openai.ts';
import { fitRequest } from '../../supabase/functions/_shared/ai/agent/compact.ts';
import { buildInstructions, compactInstructions, BUDDY_PERSONA } from '../../supabase/functions/_shared/ai/agent/prompt.ts';
import { ALL_TOOL_DEFS } from '../../supabase/functions/_shared/ai/agent/tools.ts';
import { endpointFor, extraFor, SLOTS } from '../../supabase/functions/_shared/ai/agent/models.ts';

const [envFile, outFile, modelArg, qArg = 'all'] = process.argv.slice(2);
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Za-z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const KEYS = { gemini: env.Gemini_Fallback, groq: env.GROQ_Fallback, nvidia: env.NEM_API, fallback: env.OPEN_AI_API_KEY_FALLBACK };

const PERF = `Performance for 2026-10 (composite score, same figure as the Performance page). Only ACTIVE staff are ranked.
APC ranking:
1. Hamza Iqbal (APC) - 89 (Excellent)
2. Sana Malik (APC) - 83 (Strong)
3. Bilal Raza (APC) - 82 (Strong)
Team Leads:
1. Kamran Shah (TL) - 62 (Developing)
2. Noor Fatima (TL) - 61 (Developing)
1 further Team Lead is withheld (score not shared with you).
NOT ranked: Ali Ahmad - no longer an active employee, left out of the ranking.`;
const REPORT = `Glow Beauty - weekly report "Week 42 (13 Oct - 19 Oct 2026)", status approved, currency USD.
GMV: $12,480.50 | Orders: 412 | Items sold: 536 | Videos posted: 38 | Samples sent: 64 | ROI: 3.2
Previous approved week (Week 41): GMV $10,115.00 | Orders: 355`;
const KB = `<source id="S1" type="kb_article" title="How to apply for Work From Home (WFH)" url="/kb/wfh">
Open Leave in the sidebar, press "New request", choose the type "WFH", pick the date(s), add a short reason and press Submit. Your Team Lead gets a notification and approves or rejects it. Submit at least one day before. Approved WFH shows on the Attendance page.
</source>`;
const QS = [
  { id: 'q1', q: 'Rank our APCs by performance this month.', tools: ['get_performance'], res: { get_performance: PERF }, bad: [/Ali Ahmad[^.\n]*(rank|#|\b\d{2}\b)/i, /Kamran[^.\n]*APC/i], must: [/Hamza/, /89/, /Sana/, /83/, /Bilal/, /82/], role: 'boss' },
  { id: 'q2', q: 'Who are the Team Leads and how are they scoring?', tools: ['get_performance', 'get_employees'], res: { get_performance: PERF, get_employees: 'Team Leads (active): Kamran Shah, Noor Fatima, and one more (name withheld).' }, bad: [/Hamza[^.\n]*TL/i], must: [/Kamran/, /62/, /Noor/, /61/, /withheld|not shared|can.t see|another|one more|third/i], role: 'boss' },
  { id: 'q3', q: "What was Glow Beauty's GMV last week?", tools: ['get_reports'], res: { get_reports: REPORT }, bad: [/ROI of 4/], must: [/12,480\.50/], role: 'boss' },
  { id: 'q4', q: 'Is Glow Beauty up or down versus the week before?', tools: ['compare_periods', 'get_reports'], res: { compare_periods: REPORT, get_reports: REPORT }, bad: [], must: [/up|increase|grew|higher/i, /12,480\.50/, /10,115/], role: 'boss' },
  { id: 'q5', q: "What is Sana Malik's attendance for October?", tools: ['get_attendance'], res: { get_attendance: 'Sana Malik (APC), 2026-10: attendance 96.5%, days present 21 of 22 working days, coverage 100%, hours worked 171.5.' }, bad: [/late|absent/i], must: [/96\.5/], role: 'boss' },
  { id: 'q6', q: 'How do I apply for WFH?', tools: ['search_company_knowledge', 'search_everything'], res: { search_company_knowledge: KB, search_everything: KB }, bad: [/two days|2 days|\bHR\b|email/i], must: [/Leave/, /New request/i, /one day/i], role: 'apc' },
  { id: 'q7', q: 'Who is Ali Ahmad?', tools: ['find_person'], res: { find_person: 'Ali Ahmad - role: APC, manager: Kamran Shah, employment type: full-time, started 2025-03-01, active: NO (no longer an active employee).' }, bad: [/currently|works as|is our/i], must: [/no longer|not active|inactive|left|former/i], role: 'boss' },
  { id: 'q8', q: 'Which brands does Hamza Iqbal handle?', tools: ['get_brand_assignments', 'list_brands'], res: { get_brand_assignments: 'Hamza Iqbal (APC) permanent assignments: Glow Beauty (owner TL: Kamran Shah), Urban Threads (owner TL: Noor Fatima).', list_brands: 'Glow Beauty; Urban Threads; Peak Fitness' }, bad: [/Peak Fitness/], must: [/Glow Beauty/, /Urban Threads/], role: 'boss' },
  { id: 'q9', q: 'Who are the top creators for Glow Beauty in Week 42?', tools: ['get_top_creators'], res: { get_top_creators: 'Glow Beauty, Week 42 top creators by GMV: 1. @zaraglow - $3,210.00 (11 videos); 2. @makeupwithmina - $2,455.10 (7 videos); 3. @daily.nur - $1,380.75 (9 videos).' }, bad: [], must: [/zaraglow/, /3,210\.00/, /makeupwithmina/, /daily\.nur/], role: 'boss' },
  { id: 'q10', q: "What's Hamza's salary?", tools: ['get_salary'], res: { get_salary: 'This information is only available to the Boss.' }, bad: [/PKR\s?\d|\d{2,3},\d{3}/], must: [/Boss|can.t|not (available|able)|only/i], role: 'apc' },
  { id: 'q11', q: 'Who is the single best APC this month and why?', tools: ['get_performance'], res: { get_performance: PERF }, bad: [/because of (his|her) (attendance|reports|incentive)|consistent|reporting score|response time/i], must: [/Hamza/, /89/], role: 'boss' },
  { id: 'q12', q: 'List all APCs.', tools: ['get_employees'], res: { get_employees: 'Active APCs (4): Hamza Iqbal (manager Kamran Shah), Sana Malik (manager Kamran Shah), Bilal Raza (manager Noor Fatima), Areeba Khan (manager Noor Fatima).' }, bad: [/Ali Ahmad|Kamran Shah \(APC\)/], must: [/Hamza/, /Sana/, /Bilal/, /Areeba/], role: 'boss' },
  { id: 'q13', q: 'What does TikTok say about product card violations?', tools: ['search_tiktok_academy', 'search_everything'], res: { search_tiktok_academy: 'TikTok Shop Academy: 0 results for "product card violations".', search_everything: 'search_everything: 0 results for "product card violations".' }, bad: [/(points|strikes?|suspend|7 days|30 days|\b\d+ (violation|point))/i], must: [/no |couldn.t|didn.t|not (find|found)|nothing|n.t find/i], role: 'boss' },
];
const sel = qArg === 'all' ? QS : QS.filter((q) => qArg.split(',').includes(q.id));

const targets = modelArg.split(',').map((s) => { const [slot, ...m] = s.split(':'); return { slot, model: m.join(':') }; });
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const instr = (role) => buildInstructions({ persona: BUDDY_PERSONA, role, displayName: 'Rashid', now: new Date('2026-11-02T10:00:00Z'), web: false }).instructions;

async function run(t, q) {
  const chat = SLOTS[t.slot].api === 'openai-chat';
  const call = chat ? chatRespond : respond;
  const extra = chat ? extraFor([], { keySlot: t.slot, model: t.model }) : null;
  const input = [{ role: 'user', content: q.q }];
  const t0 = Date.now(); let ttft = null; let answer = ''; const called = []; let calls = 0; let err = null; let n = 0;
  try {
    for (let round = 0; round < 4; round++) {
      let req = { instructions: instr(q.role), input, tools: round < 3 ? ALL_TOOL_DEFS : undefined, maxOutputTokens: extra ? 8000 : 2500 };
      // BENCH_COMPACT=8000: the request is fitted to a small token budget exactly as agent/core.ts does for Groq.
      if (process.env.BENCH_COMPACT) {
        const f = fitRequest({ instructions: req.instructions, compactInstructions: compactInstructions({ persona: BUDDY_PERSONA, role: q.role, displayName: 'Rashid', now: new Date('2026-11-02T10:00:00Z') }), input, tools: req.tools, maxOutputTokens: req.maxOutputTokens }, Number(process.env.BENCH_COMPACT));
        req = { instructions: f.instructions, input: f.input, tools: f.tools, maxOutputTokens: f.maxOutputTokens };
      }
      const res = await call({ apiKey: KEYS[t.slot], model: t.model, ...req,
        effort: 'low', timeoutMs: 90000, firstByteMs: Number(process.env.BENCH_FB ?? 60000),
        ...(chat ? { endpoint: endpointFor(t.slot) } : { endpoint: 'https://api.openai.com/v1/responses' }), ...(extra ? { extra } : {}),
        onDelta: (d) => { if (ttft == null) ttft = Date.now() - t0; answer += d; } });
      calls++;
      if (!res.toolCalls.length) { if (!answer) answer = res.text; break; }
      answer = '';
      input.push(...res.output);
      for (const c of res.toolCalls) {
        called.push(c.name);
        const body = q.res[c.name] ?? `No data for ${c.name}.`;
        input.push({ type: 'function_call_output', call_id: c.call_id, output: /^<source/.test(body) ? body : `<data id="D${++n}" tool="${c.name}">\n${body}\n</data>` });
      }
    }
  } catch (e) { err = String(e.message ?? e).slice(0, 220); }
  const total = Date.now() - t0;
  const toolOk = q.tools.some((x) => called.includes(x));
  const badHits = q.bad.filter((r) => r.test(answer)).map(String);
  const missing = q.must.filter((r) => !r.test(answer)).map(String);
  return { slot: t.slot, model: t.model, q: q.id, ttft, total, calls, called, toolOk, badHits, missing, err, answer: answer.slice(0, 900) };
}
for (const t of targets) {
  if (!KEYS[t.slot]) { console.log('no key for', t.slot); continue; }
  for (const q of sel) {
    const r = await run(t, q);
    out.push(r); fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
    console.log(`${t.slot}:${t.model} ${q.id} ttft=${r.ttft} total=${r.total} tool=${r.toolOk} bad=${r.badHits.length} miss=${r.missing.length} ${r.err ? 'ERR ' + r.err : ''}`);
    await sleep(r.err && /429|rate|quota/i.test(r.err) ? 30000 : Number(process.env.BENCH_GAP ?? 4000));
  }
}
