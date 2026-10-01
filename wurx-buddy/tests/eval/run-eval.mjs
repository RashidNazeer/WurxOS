// Eval runner (architecture.md §16.2; scoring rules in README.md).
//
//   node tests/eval/run-eval.mjs --engine v1|v2 --base-url <functions base> [options]
//   node tests/eval/run-eval.mjs --compare <old.json> --to <new.json>      diff two runs, no calls
//
// Options:
//   --label <name>          run name (default: the engine)       --file <jsonl>   question set
//   --ids a,b  --category c --limit n                            which rows
//   --judge-model <m>       default gpt-5.4-mini (fixed per comparison)
//   --compare <run.json>    after the run, print the diff against that run
//   --baseline <run.json>   baseline for the cost gate (mean $/question × 1.3)
//   --concurrency <n>       default 2         --timeout-ms <n>  default 120000
//   --yes                   run even when the judge estimate is over $1
//   --judge-price-in/-out   $ per 1M tokens for the estimate (assumed list price; verify)
//   --mock-auth             local mock server only: "Bearer mock-<role>" instead of a sign-in
//
// Endpoint: POST <base-url>/ai-chat (v1) or /assistant (v2), body
// {conversationId?, message, stream:true}, SSE events status / delta / sources /
// done{conversationId, requestId} / error (A§13).
//
// Auth: each row runs as a dev test user of its `role`, signed in through
// supabase-js with EVAL_<ROLE>_EMAIL / EVAL_<ROLE>_PASSWORD from the environment
// (never from a file). Missing credentials skip that role's rows (reported).
//
// Privacy: live rows (people_data, anything reading pay / attendance / leave /
// performance / profiles) get their expected values from SQL at grade time, in
// memory. Their answer, labels and values are written to disk as [value] only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { checkDevUrl, readEnv, SSL } from '../../scripts/dev-env.mjs';
import { checkCitations, computeMetrics, evaluateGates, findLeaks, findPatternLeaks, isLive, matchNumbers, missingMentions, needsRetrieval, recallAtK, redact } from './grade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD_REF = 'xoaaidgvblondjpvxjqp';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const die = (msg) => { console.error(msg); process.exit(1); };

const A = {
  engine: opt('engine'), baseUrl: opt('base-url'), label: opt('label'),
  file: opt('file', path.join(HERE, 'questions.jsonl')),
  ids: opt('ids')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null,
  category: opt('category'), limit: opt('limit') ? Number(opt('limit')) : null,
  judgeModel: opt('judge-model', 'gpt-5.4-mini'),
  compare: opt('compare'), to: opt('to'), baseline: opt('baseline'),
  concurrency: Number(opt('concurrency', '2')), timeoutMs: Number(opt('timeout-ms', '120000')),
  yes: flag('yes'), mockAuth: flag('mock-auth'),
  priceIn: Number(opt('judge-price-in', '1.00')), priceOut: Number(opt('judge-price-out', '6.00')),
  outDir: opt('out-dir', path.join(HERE, 'runs')),
};

// ── compare ──────────────────────────────────────────────────────────────
function printCompare(oldRun, newRun) {
  console.log(`\nDiff: ${oldRun.meta.label} (${oldRun.meta.date}) → ${newRun.meta.label} (${newRun.meta.date})`);
  const fmt = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(3));
  console.table(Object.keys(newRun.metrics).filter((k) => !k.endsWith('_rows') && k !== 'numeric_required').map((k) => ({
    metric: k, before: fmt(oldRun.metrics[k]), after: fmt(newRun.metrics[k]),
    delta: oldRun.metrics[k] != null && newRun.metrics[k] != null ? fmt(newRun.metrics[k] - oldRun.metrics[k]) : '—',
  })));
  const before = new Map(oldRun.rows.map((r) => [r.id, r]));
  const changed = [];
  for (const r of newRun.rows) {
    const o = before.get(r.id);
    if (!o) changed.push({ id: r.id, before: '(absent)', after: r.status });
    else if (o.status !== r.status) changed.push({ id: r.id, before: o.status, after: r.status, why: (r.reason ?? r.error ?? '').slice(0, 80) });
  }
  for (const o of oldRun.rows) if (!newRun.rows.some((r) => r.id === o.id)) changed.push({ id: o.id, before: o.status, after: '(absent)' });
  if (changed.length) console.table(changed); else console.log('No row changed status.');
  console.log(`Gate: ${oldRun.gate?.overall ?? '—'} → ${newRun.gate?.overall ?? '—'}`);
}
const loadRun = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

if (A.compare && A.to && !A.engine) { printCompare(loadRun(A.compare), loadRun(A.to)); process.exit(0); }

// ── guards ───────────────────────────────────────────────────────────────
if (!['v1', 'v2'].includes(A.engine)) die('usage: --engine v1|v2 --base-url <url> (see header)');
if (!A.baseUrl) die('--base-url is required');
const base = new URL(A.baseUrl.replace(/\/+$/, ''));
if (base.href.includes(PROD_REF)) die('Refusing: --base-url is the PRODUCTION project.');
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(base.hostname);
if (A.mockAuth && !local) die('Refusing: --mock-auth is only for a local mock server.');

const env = readEnv();
const devRef = env.WURXOS_DEV_PROJECT_REF || '';
const dbWhy = checkDevUrl(env.WURXOS_DEV_DB_URL || '', devRef);
if (dbWhy) die(`Refusing: ${dbWhy}.`);
if (!local && base.hostname !== `${devRef}.supabase.co`) die('Refusing: --base-url is neither the dev project nor a local server.');
const supaUrl = env.VITE_SUPABASE_URL || '';
if (!A.mockAuth && new URL(supaUrl).hostname !== `${devRef}.supabase.co`) die('Refusing: VITE_SUPABASE_URL in ../.env.dev is not the dev project.');

const endpoint = `${base.href.replace(/\/+$/, '')}/${A.engine === 'v1' ? 'ai-chat' : 'assistant'}`;
const judgePrompt = fs.readFileSync(path.join(HERE, 'judge-prompt.md'), 'utf8');

// ── rows ─────────────────────────────────────────────────────────────────
let rows = fs.readFileSync(A.file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
if (A.ids) rows = A.ids.map((id) => rows.find((r) => r.id === id) ?? die(`unknown id ${id}`));
if (A.category) rows = rows.filter((r) => r.category === A.category);
if (A.limit) rows = rows.slice(0, A.limit);
if (!rows.length) die('No rows selected.');

// ── dev DB, read-only (expected/forbidden/person/precondition SQL, request log) ──
const pool = new pg.Pool({ connectionString: env.WURXOS_DEV_DB_URL, ssl: SSL, max: 3 });
async function ro(sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin read only');
    await c.query(`set local statement_timeout = '30s'`);
    return (await c.query(sql, params)).rows;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
const withUser = (sql, uid) => sql.replaceAll(':as_user_id', `'${UUID_RE.test(uid) ? uid : ZERO_UUID}'::uuid`);

// ── auth ─────────────────────────────────────────────────────────────────
const sessions = {};          // role → { token, uid } | { skip }
for (const role of [...new Set(rows.map((r) => r.role || 'boss'))]) {
  if (A.mockAuth) { sessions[role] = { token: `mock-${role}`, uid: ZERO_UUID }; continue; }
  const email = process.env[`EVAL_${role.toUpperCase()}_EMAIL`];
  const password = process.env[`EVAL_${role.toUpperCase()}_PASSWORD`];
  if (!email || !password) { sessions[role] = { skip: `no EVAL_${role.toUpperCase()}_EMAIL/PASSWORD in the environment` }; continue; }
  const sb = createClient(supaUrl, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  sessions[role] = error || !data?.session
    ? { skip: `sign-in failed for the ${role} test user: ${error?.message ?? 'no session'}` }
    : { token: data.session.access_token, uid: data.user.id };
}

// ── judge ────────────────────────────────────────────────────────────────
const judgeMode = (r) =>
  r.grading === 'facts' ? 'facts'
    : r.grading === 'must_clarify' ? 'clarify'
      : r.grading === 'must_refuse' ? (r.must_refuse ? 'refuse' : null)
        : r.grading === 'exact_number' && r.expected_facts?.length ? 'facts'
          : null;

const runnable = rows.filter((r) => !sessions[r.role || 'boss'].skip);
const judged = runnable.filter(judgeMode);
const estTokIn = judged.reduce((s, r) => s + (judgePrompt.length + JSON.stringify([r.question, r.history, r.expected_facts]).length + 2400 + (A.engine === 'v2' ? 8000 : 0)) / 4, 0);
const estTokOut = judged.length * 1000;
const estCost = (estTokIn * A.priceIn + estTokOut * A.priceOut) / 1e6;
console.log(`Rows: ${rows.length} selected, ${runnable.length} runnable, ${judged.length} need the judge (${A.judgeModel}).`);
console.log(`Judge estimate: ~${Math.round(estTokIn).toLocaleString('en-US')} in + ~${estTokOut.toLocaleString('en-US')} out tokens ≈ $${estCost.toFixed(4)} (at $${A.priceIn}/$${A.priceOut} per 1M, assumed).`);
if (estCost > 1 && !A.yes) { await pool.end(); die('Aborting: judge estimate is over $1. Re-run with --yes to accept.'); }

let judgeUsage = { in: 0, out: 0, calls: 0 };
async function judge(payload) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPEN_AI_API_KEY}` },
      body: JSON.stringify({
        model: A.judgeModel,
        messages: [{ role: 'system', content: judgePrompt }, { role: 'user', content: JSON.stringify(payload) }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 4000,
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e) }));
    if (res.ok) {
      const j = await res.json();
      judgeUsage.calls++;
      judgeUsage.in += j.usage?.prompt_tokens ?? 0;
      judgeUsage.out += j.usage?.completion_tokens ?? 0;
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    }
    if (attempt >= 3 || (res.status && res.status !== 429 && res.status < 500)) {
      throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

// ── endpoint ─────────────────────────────────────────────────────────────
async function ask(session, message, conversationId) {
  const t0 = Date.now();
  const out = { answer: '', statuses: 0, sources: null, conversationId, requestId: null, error: null, httpStatus: null, latency_ms: null, first_token_ms: null };
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'text/event-stream',
        authorization: `Bearer ${session.token}`,
        ...(A.mockAuth ? {} : { apikey: env.VITE_SUPABASE_ANON_KEY }),
      },
      body: JSON.stringify({ message, stream: true, ...(conversationId ? { conversationId } : {}) }),
      signal: AbortSignal.timeout(A.timeoutMs),
    });
  } catch (e) {
    out.error = `request failed: ${e?.message ?? e}`;
    return out;
  }
  out.httpStatus = res.status;
  const ctype = res.headers.get('content-type') || '';
  if (!res.ok || !ctype.includes('text/event-stream')) {
    const body = await res.text().catch(() => '');
    let j = null; try { j = JSON.parse(body); } catch { /* not json */ }
    if (res.ok && j?.reply) { out.answer = j.reply; out.conversationId = j.conversationId ?? conversationId; }
    else out.error = `HTTP ${res.status}: ${(j?.error ?? body).toString().slice(0, 200)}`;
    out.latency_ms = Date.now() - t0;
    return out;
  }
  const dec = new TextDecoder();
  let buf = '';
  const onEvent = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    let e; try { e = JSON.parse(data); } catch { return; }
    if (typeof e.delta === 'string') { if (out.first_token_ms == null) out.first_token_ms = Date.now() - t0; out.answer += e.delta; }
    if (e.status) out.statuses++;
    if (Array.isArray(e.sources)) out.sources = e.sources;
    if (e.done) { out.conversationId = e.conversationId ?? out.conversationId; out.requestId = e.requestId ?? null; }
    if (e.error) out.error = String(e.error).slice(0, 300);
  };
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop();
      parts.forEach(onEvent);
    }
    if (buf.trim()) onEvent(buf);
  } catch (e) {
    out.error = `stream broke: ${e?.message ?? e}`;
  }
  out.latency_ms = Date.now() - t0;
  return out;
}

// ai_request_log for this request: retrieved chunks (with their source and
// text), tools and cost. The mock serves the same shape at /__log/<id>.
async function loadLog(requestId) {
  if (!requestId) return null;
  if (A.mockAuth) {
    const r = await fetch(`${base.href.replace(/\/+$/, '')}/__log/${encodeURIComponent(requestId)}`).catch(() => null);
    return r?.ok ? r.json() : null;
  }
  if (!UUID_RE.test(requestId)) return null;
  for (let i = 0; i < 4; i++) {        // the function may log just after `done`
    try {
      const [row] = await ro(`
        select l.est_cost_usd::float as est_cost_usd, l.tokens_in, l.tokens_out, l.tools,
               coalesce((select json_agg(json_build_object(
                          'rank', e.ord, 'chunk_id', e.x->>'chunk_id', 'cited', (e.x->>'cited')::boolean,
                          'source_type', d.source_type, 'source_id', d.source_id, 'title', d.title,
                          'content', left(c.content, 1500)) order by e.ord)
                   from jsonb_array_elements(l.retrieved) with ordinality e(x, ord)
                   left join public.ai_chunks c on c.id = nullif(e.x->>'chunk_id','')::uuid
                   left join public.ai_documents d on d.id = coalesce(c.document_id, nullif(e.x->>'document_id','')::uuid)), '[]') as retrieved
          from public.ai_request_log l where l.id = $1`, [requestId]);
      if (row) return row;
    } catch { return null; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// Evidence for the faithfulness judge, capped at ~12k chars.
function evidenceFrom(log) {
  if (!log) return null;
  let budget = 12_000;
  const retrieved = [];
  for (const r of log.retrieved ?? []) {
    const content = String(r.content ?? '').slice(0, Math.max(0, budget));
    budget -= content.length;
    retrieved.push({ rank: r.rank, source: `${r.source_type}:${r.source_id}`, title: r.title, content });
    if (budget <= 0) break;
  }
  return { retrieved, tools: (log.tools ?? []).map((t) => ({ name: t.name, args: t.args, result: t.result ?? t.result_preview ?? '(result not logged)' })) };
}

// ── one row ──────────────────────────────────────────────────────────────
async function runRow(r) {
  const live = isLive(r);
  const rec = {
    id: r.id, category: r.category, grading: r.grading, role: r.role || 'boss', live,
    status: null, reason: null, question: r.question, answer: null, numbers: [], judge: null,
    leaked: false, leaks: null, citations: null, recall: null, latency_ms: null, first_token_ms: null,
    cost_usd: null, conversation_id: null, request_id: null, error: null,
  };
  const skip = (why) => Object.assign(rec, { status: 'skip', reason: why });
  const session = sessions[rec.role];
  if (session.skip) return skip(session.skip);

  const names = [];
  let question = r.question;
  if (r.person_sql) {
    const [p] = await ro(withUser(r.person_sql, session.uid));
    if (!p?.display_name) return skip('person_sql returned no one');
    names.push(p.display_name);
    question = question.replaceAll('{person}', p.display_name);
  }
  if (r.precondition_sql) {
    const pre = await ro(withUser(r.precondition_sql, session.uid));
    if (!pre.length || pre.some((x) => x.ok !== true)) return skip('precondition_sql not met for this test user');
  }

  let expected = r.expected_numbers ?? [];
  if (live && r.expected_sql) {
    expected = (await ro(withUser(r.expected_sql, session.uid))).map((x) => ({
      value: x.value == null ? null : Number(x.value), currency: x.currency ?? null, unit: x.unit ?? null, label: x.label ?? null,
      ...(r.tolerance_abs != null ? { tolerance_abs: r.tolerance_abs } : { tolerance: r.tolerance ?? 0.005 }),
    }));
  }
  const forbidden = r.forbidden_sql ? (await ro(withUser(r.forbidden_sql, session.uid))).map((x) => String(x.forbidden ?? '')).filter(Boolean) : [];

  // History first (user turns only; the drafted assistant turns are the
  // endpoint's to produce), in one conversation.
  let conversationId = null;
  for (const h of (r.history ?? []).filter((t) => t.role === 'user')) {
    const hr = await ask(session, h.content, conversationId);
    if (hr.error) return Object.assign(rec, { status: 'error', error: `history turn: ${hr.error}` });
    conversationId = hr.conversationId;
  }
  const res = await ask(session, question, conversationId);
  Object.assign(rec, { latency_ms: res.latency_ms, first_token_ms: res.first_token_ms, conversation_id: res.conversationId, request_id: res.requestId });
  if (res.error) return Object.assign(rec, { status: 'error', error: res.error, answer: live ? '[redacted: live row]' : res.answer || null });
  const answer = res.answer;
  rec.answer = live ? '[redacted: live row]' : answer;

  const log = await loadLog(res.requestId);
  if (log?.est_cost_usd != null) rec.cost_usd = Number(log.est_cost_usd);
  if (needsRetrieval(r) && log) rec.recall = recallAtK(log.retrieved, r.expected_sources);

  const fails = [];
  // Hard string checks, every row.
  const leaks = findLeaks(answer, r.must_not_contain ?? [], forbidden);
  rec.leaked = leaks.mustNotContain.length + leaks.forbidden.length > 0;
  rec.leaks = { must_not_contain: leaks.mustNotContain.map((i) => r.must_not_contain[i]), forbidden: leaks.forbidden.length };
  if (rec.leaked) fails.push(`leak: ${[...rec.leaks.must_not_contain.map((s) => `"${s}"`), ...(leaks.forbidden.length ? [`${leaks.forbidden.length} forbidden value(s)`] : [])].join(', ')}`);
  const patternHits = findPatternLeaks(answer, r.must_not_match ?? []);
  if (patternHits.length) fails.push(`must_not_match: ${patternHits.map((i) => `/${r.must_not_match[i]}/`).join(', ')}`);
  const missing = missingMentions(answer, r.must_mention ?? []);
  if (missing.length) fails.push(`must_mention: none of ${missing.map((i) => JSON.stringify(r.must_mention[i])).join('; ')}`);

  // Citation validity, every row that got a sources event.
  rec.citations = checkCitations(answer, res.sources, r.expected_sources ?? []);
  if (rec.citations.valid === false) fails.push(`unknown citation id(s): ${rec.citations.unknown.join(', ')}`);
  const banned = (r.forbidden_sources ?? []).map((s) => `${s.source_type}:${s.source_id}`).filter((k) => (rec.citations.citedKeys ?? []).includes(k));
  if (banned.length) fails.push(`cited a forbidden source: ${banned.join(', ')}`);

  if (r.grading === 'exact_number') {
    const m = matchNumbers(answer, expected, question);
    rec.numbers = m.map((x) => ({
      label: live ? '[label]' : expected[x.index].label, expected: live ? '[value]' : expected[x.index].value,
      currency: expected[x.index].currency, unit: expected[x.index].unit, required: x.required, matched: x.matched,
      reason: live && x.reason ? x.reason.replace(/\d[\d,.]*/g, '[value]') : x.reason,
    }));
    const req = rec.numbers.filter((n) => n.required);
    if (!req.length) return skip('no expected numbers (the SQL returned none)');
    const missed = req.filter((n) => !n.matched);
    if (missed.length) fails.push(`numbers: ${missed.length}/${req.length} not matched (${missed.map((n) => `${n.label}: ${n.reason}`).join('; ')})`);
  }
  if (r.grading === 'citation') {
    if (rec.citations.valid == null) fails.push('no sources event (the engine does not cite)');
    else if (!rec.citations.correct) fails.push('no cited source is an expected source');
  }

  const mode = judgeMode(r);
  if (mode && !(mode === 'refuse' && rec.leaked)) {
    const payload = {
      mode,
      question: redactNames(question, names),
      history: r.history ?? [],
      expected_facts: r.expected_facts ?? [],
      answer: live ? redact(answer, names) : answer,
      // Numbers on exact_number rows are graded by rule, and tool results are not
      // logged, so faithfulness is judged on facts rows only.
      evidence: r.grading === 'facts' ? evidenceFrom(log) : null,
    };
    let j;
    try { j = await judge(payload); } catch (e) { return Object.assign(rec, { status: 'error', error: e.message }); }
    rec.judge = { mode, ...j };
    if (live) rec.judge.reason = '[redacted: live row]';
    if (mode === 'facts') {
      const c = Number(j.correctness);
      rec.judge.correctness = Number.isFinite(c) ? c : null;
      rec.judge.faithfulness = j.faithfulness === 0 || j.faithfulness === 1 ? j.faithfulness : null;
      if (r.grading === 'facts') {
        if (!(c >= 4)) fails.push(`correctness ${j.correctness}`);
        if (rec.judge.faithfulness === 0) fails.push('not faithful to the evidence');
      }
    } else if (mode === 'clarify') {
      if (!j.asks) fails.push('did not ask a clarifying question');
      if (j.commits) fails.push('committed to a guess');
      if (j.names_options === false) fails.push('did not name the real options');
    } else if (mode === 'refuse') {
      if (!j.declines) fails.push('did not decline');
      if (!j.polite) fails.push('not polite');
      if (!j.offers_alternative) fails.push('did not say what the user can ask instead');
    }
  }

  rec.status = fails.length ? 'fail' : 'pass';
  rec.reason = fails.join(' | ') || null;
  return rec;
}
const redactNames = (t, names) => names.reduce((s, n) => s.replaceAll(n, '[person]'), t);

// ── run ──────────────────────────────────────────────────────────────────
const started = new Date();
const results = new Array(rows.length);
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, Math.min(A.concurrency, rows.length)) }, async () => {
  while (next < rows.length) {
    const i = next++;
    try { results[i] = await runRow(rows[i]); } catch (e) {
      results[i] = { id: rows[i].id, category: rows[i].category, grading: rows[i].grading, role: rows[i].role || 'boss', status: 'error', error: String(e?.message ?? e).slice(0, 300) };
    }
    const r = results[i];
    console.log(`${{ pass: '✓', fail: '✗', skip: '·', error: '!' }[r.status]} ${r.id.padEnd(8)} ${r.status}${r.reason ? `  ${r.reason}` : ''}${r.error ? `  ${r.error}` : ''}`);
  }
}));
await pool.end();

const metrics = computeMetrics(results);
const baselineCost = A.baseline ? loadRun(A.baseline).metrics?.cost_mean_usd ?? null : null;
const gate = evaluateGates(metrics, baselineCost, results.filter((r) => r.status === 'error').length);

// per-category table
const cats = [...new Set(results.map((r) => r.category))];
console.log('\nBy category');
console.table(Object.fromEntries(cats.map((c) => {
  const rs = results.filter((r) => r.category === c);
  const n = (s) => rs.filter((r) => r.status === s).length;
  const graded = n('pass') + n('fail');
  return [c, { rows: rs.length, pass: n('pass'), fail: n('fail'), skip: n('skip'), error: n('error'), 'pass %': graded ? Math.round((100 * n('pass')) / graded) : '—' }];
})));

const fmtVal = (k, v) => (v == null ? 'n/a' : k === 'latency_p95_ms' ? `${(v / 1000).toFixed(1)} s` : k === 'cost_mean_usd' ? `$${v.toFixed(5)}` : k === 'correctness_mean' ? v.toFixed(2) : `${(v * 100).toFixed(1)} %`);
console.log('Gates (A§16.3, single run; cutover uses the mean of 3 runs)');
console.table(gate.gates.map((g) => ({
  metric: g.key, value: fmtVal(g.key, g.value),
  gate: g.limit == null ? (g.key === 'cost_mean_usd' ? 'baseline × 1.3 (pass --baseline)' : '—') : `${g.op} ${fmtVal(g.key, g.limit)}`,
  status: g.status,
})));
const skipped = results.filter((r) => r.status === 'skip');
if (skipped.length) {
  const why = {};
  for (const r of skipped) why[r.reason] = (why[r.reason] ?? 0) + 1;
  console.log('Skipped:'); for (const [w, n] of Object.entries(why)) console.log(`  ${n} × ${w}`);
}
const judgeCost = (judgeUsage.in * A.priceIn + judgeUsage.out * A.priceOut) / 1e6;
console.log(`Judge: ${judgeUsage.calls} calls, ${judgeUsage.in} in / ${judgeUsage.out} out tokens ≈ $${judgeCost.toFixed(4)}`);
console.log(`OVERALL GATE: ${gate.overall}`);

const date = started.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const label = (A.label ?? A.engine).replace(/[^\w.-]+/g, '-');
const run = {
  meta: {
    date, label, engine: A.engine, endpoint_host: base.host, mock_auth: A.mockAuth,
    judge_model: A.judgeModel, judge_prompt_sha256: crypto.createHash('sha256').update(judgePrompt).digest('hex'),
    questions_file: path.basename(A.file), questions_sha256: crypto.createHash('sha256').update(fs.readFileSync(A.file)).digest('hex'),
    started_at: started.toISOString(), finished_at: new Date().toISOString(),
    rows: results.length, counts: Object.fromEntries(['pass', 'fail', 'skip', 'error'].map((s) => [s, results.filter((r) => r.status === s).length])),
    judge_usage: { ...judgeUsage, est_cost_usd: +judgeCost.toFixed(5), estimate_before_run_usd: +estCost.toFixed(5) },
  },
  metrics, gate, rows: results,
};
fs.mkdirSync(A.outDir, { recursive: true });
let outFile = path.join(A.outDir, `${date}-${label}.json`);
for (let n = 2; fs.existsSync(outFile); n++) outFile = path.join(A.outDir, `${date}-${label}-${n}.json`);
fs.writeFileSync(outFile, JSON.stringify(run, null, 2));
console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);

if (A.compare) printCompare(loadRun(A.compare), run);
process.exitCode = gate.overall === 'PASS' ? 0 : 2;
