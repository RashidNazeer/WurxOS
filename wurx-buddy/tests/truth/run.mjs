// Truth evaluation of Wurx Buddy. See README.md.
//   node --experimental-strip-types --no-warnings wurx-buddy/tests/truth/run.mjs [--sql] [--llm] [--provider gemini|groq] [--model m] [--only a,b] [--limit n] [--pace-ms 4000]
// Leg 1 (always): every golden question's data tool is run on the REAL snapshot and checked against truth computed
//   independently from the raw rows. --sql also re-checks the key numbers with live READ-ONLY SQL on production.
// Leg 2 (--llm): the full agent loop (runTurn, grounding included) with a free model over the PSEUDONYMISED snapshot.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, bossCtx } from './load.mjs';
import { pseudonymise } from './pseudo.mjs';
import { SQL_CHECKS, truthOf } from './truth.mjs';
import { GOLDEN } from './golden.mjs';
import { runDataTool } from '../../../supabase/functions/_shared/ai/tools/index.ts';
import { runTurn } from '../../../supabase/functions/_shared/ai/agent/core.ts';
import { chatRespond } from '../../../supabase/functions/_shared/ai/llm/chat.ts';
import { turnDb } from '../../../supabase/functions/_shared/ai/__tests__/fixtures/turnDb.ts';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

// ------------------------------------------------------------------ judging
const norm = (s) => String(s).replace(/(\d),(?=\d{3})/g, '$1').replace(/\*\*/g, '');
const hit = (text, item) => {
  if (item instanceof RegExp) return item.test(text);
  if (item && item.any) return item.any.some((x) => hit(text, x));
  return norm(text).includes(norm(item));
};
const MARK = /former|left the|has left|no longer|deactivated|departed|resigned|not current|not part of|leaver/i;
// a former employee's name must sit in a line / block that says they are former
function formerProblems(text, names) {
  const out = [];
  const lines = text.replace(/reports to [^·\n]*/g, 'reports to (manager)').split('\n');
  lines.forEach((line, i) => {
    for (const n of names) {
      if (!line.includes(n)) continue;
      let ok = MARK.test(line);
      for (let k = i - 1; !ok && k >= 0 && k > i - 40; k--) { if (!lines[k].trim()) continue; if (!/^\s*(?:[-*•]|\d+[.)])/.test(lines[k])) { ok = MARK.test(lines[k]); break; } }
      if (!ok) out.push(`former employee "${n}" shown without saying so`);
    }
  });
  return [...new Set(out)];
}
function judge(text, g, S) {
  const fails = [];
  const must = typeof g.must === 'function' ? g.must(S) : g.must || [];
  const mustNot = typeof g.mustNot === 'function' ? g.mustNot(S) : g.mustNot || [];
  const formerOk = typeof g.formerOk === 'function' ? g.formerOk(S) : g.formerOk || [];
  for (const m of must) if (!hit(text, m)) fails.push(`missing: ${m instanceof RegExp ? m : JSON.stringify(m)}`);
  const textNoMgr = text.replace(/reports to [^·\n]*/g, '');
  for (const m of mustNot) if (hit(textNoMgr, m) && !(typeof m === 'string' && formerOk.includes(m))) fails.push(`must not appear: ${m instanceof RegExp ? m : JSON.stringify(m)}`);
  fails.push(...formerProblems(text, S.fnames()));
  return fails;
}
const resolveAsk = (g, S) => (typeof g.ask === 'function' ? g.ask(S) : g.ask);
const resolveTool = (g, S) => (typeof g.tool === 'function' ? g.tool(S) : g.tool);

// ------------------------------------------------------------------ leg 1
async function toolLeg(only) {
  const snap = loadSnapshot();
  const S = truthOf(snap.tables, snap.rpcData);
  const rows = [];
  for (const g of GOLDEN) {
    if (only && !only.includes(g.id)) continue;
    if (!g.tool) { rows.push({ id: g.id, area: g.area, tool: 'n/a', fails: [] }); continue; }
    try {
      const [name, args] = resolveTool(g, S);
      const r = await runDataTool(snap.db, bossCtx(), name, args);
      const fails = judge(r.text, g, S);
      if (r.truncated) fails.push('tool output truncated at the size cap');
      rows.push({ id: g.id, area: g.area, tool: fails.length ? 'FAIL' : 'pass', fails, call: `${name}(${JSON.stringify(args)})` });
    } catch (e) { rows.push({ id: g.id, area: g.area, tool: 'ERROR', fails: [String(e?.message || e).slice(0, 160)] }); }
  }
  let sql = null;
  if (flag('sql')) {
    const { q } = await import('./prodq.mjs');
    sql = [];
    for (const [id, query, expect] of SQL_CHECKS) {
      try { const [{ v }] = await q(query); const want = expect(S); sql.push({ id, sql: Number(v), js: Number(want), ok: Number(v) === Number(want) }); }
      catch (e) { sql.push({ id, ok: false, err: String(e.message).slice(0, 100) }); }
    }
  }
  return { rows, sql };
}

// ------------------------------------------------------------------ leg 2
function envDev() {
  const o = {};
  for (const line of readFileSync(resolve(here, '../../../.env.dev'), 'utf8').split(/\r?\n/)) { const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line); if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function llmLeg(only) {
  pseudonymise();
  const snap = loadSnapshot({ pseudo: true });
  const S = truthOf(snap.tables, snap.rpcData);
  const env = envDev();
  const provider = opt('provider', 'gemini');
  const cfg = provider === 'groq'
    ? { key: env.GROQ_Fallback, model: opt('model', 'llama-3.3-70b-versatile'), endpoint: 'https://api.groq.com/openai/v1/chat/completions' }
    : { key: env.Gemini_Fallback, model: opt('model', 'gemini-3-flash-preview'), endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' };
  if (!cfg.key) throw new Error(`no key for ${provider} in .env.dev`);
  const pace = Number(opt('pace-ms', '4500'));
  let last = 0, calls = 0;
  // The agent runs in "OpenAI Responses" mode (so the free-tier guard for pay data stays untouched) while this seam
  // sends the call to the free model: the data it sees is the pseudonymised snapshot, never real people or pay.
  const llm = async (r) => {
    const wait = last + pace - Date.now(); if (wait > 0) await sleep(wait);
    last = Date.now(); calls++;
    return chatRespond({ ...r, apiKey: cfg.key, model: cfg.model, endpoint: cfg.endpoint });
  };
  const rows = [];
  const limit = Number(opt('limit', '999'));
  let n = 0;
  for (const g of GOLDEN) {
    if (only && !only.includes(g.id)) continue;
    if (n++ >= limit) break;
    const turn = turnDb({ ai_assistant_config: [{ id: 1, persona: 'You are the WurxOS Assistant', model: 'gpt-5.4-mini', enabled: true, retrieval: {} }], ai_request_log: [], ai_conversations: [], ai_messages: [] });
    const db = { from: (t) => (t.startsWith('ai_') ? turn.from(t) : snap.db.from(t)), rpc: (f, a) => (f.startsWith('ai_') ? turn.rpc(f, a) : snap.db.rpc(f, a)), inserts: turn.inserts, updates: turn.updates };
    const ask = resolveAsk(g, S);
    const searchRpc = async (fn) => (fn === 'ai_search' && g.kb ? [{ chunk_id: 'c1', document_id: 'd1', chunk_index: 0, source_type: 'kb_article', source_id: 'kb-1', title: 'WurxOS how-to', url: null, section: 'sop', content: g.kb.text, brand_id: null, period_start: null, period_end: null, metadata: {}, score: 0.9 }] : []);
    const t0 = Date.now();
    try {
      const r = await runTurn({ userId: '00000000-0000-0000-0000-00000000b055', role: 'boss', message: ask },
        { admin: db, searchRpc, asUser: null, apiKey: 'unused', embed: async () => [0.1], llm, model: 'gpt-5.4-mini', modelKeySlot: 'primary', rateLimitExempt: true, now: () => new Date('2026-11-02T18:40:00Z') }, () => {});
      const log = db.inserts.ai_request_log?.[0] ?? {};
      const gr = log.flags?.grounding ?? null;
      const fails = judge(r.answer || '', g, S);
      if (r.error) fails.unshift(`turn error: ${String(r.error).slice(0, 100)}`);
      rows.push({ id: g.id, area: g.area, llm: fails.length ? 'FAIL' : 'pass', fails, ground: gr ? { retried: gr.retried, replaced: gr.replaced, ungrounded: gr.ungrounded } : null, ms: Date.now() - t0, answer: r.answer });
    } catch (e) { rows.push({ id: g.id, area: g.area, llm: 'ERROR', fails: [String(e?.message || e).slice(0, 160)], ms: Date.now() - t0 }); }
    process.stderr.write(`  ${g.id}: ${rows.at(-1).llm}\n`);
  }
  return { rows, provider, model: cfg.model, calls };
}

// ------------------------------------------------------------------ report
const only = opt('only', null)?.split(',') ?? null;
const t = await toolLeg(only);
const l = flag('llm') ? await llmLeg(only) : null;
const byId = new Map(t.rows.map((r) => [r.id, r]));
if (l) for (const r of l.rows) Object.assign(byId.get(r.id) ?? (byId.set(r.id, { id: r.id, area: r.area, fails: [] }), byId.get(r.id)), { llm: r.llm, ground: r.ground, llmFails: r.fails, answer: r.answer });
const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(`\n${pad('id', 11)}${pad('area', 13)}${pad('tool', 7)}${l ? pad('llm', 7) + pad('grounding', 24) : ''}notes`);
for (const r of byId.values()) {
  const gtxt = r.ground ? `retry=${r.ground.retried ? 'y' : 'n'} redact=${r.ground.replaced ? 'y' : 'n'} bad=${r.ground.ungrounded}` : '';
  console.log(`${pad(r.id, 11)}${pad(r.area, 13)}${pad(r.tool ?? '-', 7)}${l ? pad(r.llm ?? '-', 7) + pad(gtxt, 24) : ''}${[...(r.fails || []), ...(r.llmFails || []).map((f) => `[llm] ${f}`)].join(' | ').slice(0, 220)}`);
}
const toolRows = t.rows.filter((r) => r.tool !== 'n/a');
console.log(`\nTool leg (real snapshot, ${toolRows.length} questions with a data tool): ${toolRows.filter((r) => r.tool === 'pass').length} pass, ${toolRows.filter((r) => r.tool !== 'pass').length} fail`);
if (t.sql) { console.log('SQL twins (live, read-only):'); t.sql.forEach((s) => console.log(`  ${s.ok ? 'ok  ' : 'DIFF'} ${s.id} sql=${s.sql} js=${s.js}${s.err ? ' ' + s.err : ''}`)); }
if (l) {
  const ll = l.rows;
  console.log(`LLM leg (${l.provider} ${l.model}, pseudonymised snapshot, ${l.calls} model calls): ${ll.filter((r) => r.llm === 'pass').length}/${ll.length} pass; grounding retried ${ll.filter((r) => r.ground?.retried).length}, redacted ${ll.filter((r) => r.ground?.replaced).length}`);
}
mkdirSync(resolve(here, 'runs'), { recursive: true });
writeFileSync(resolve(here, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ tool: t, llm: l }, null, 1));
process.exit(toolRows.every((r) => r.tool === 'pass') && (!t.sql || t.sql.every((s) => s.ok)) ? 0 : 2);
