// Local mock of the assistant endpoints, for testing run-eval.mjs without a
// deployed function. It replays canned answers from mock-answers.json.
//
//   node tests/eval/mock-server.mjs [--port 8787] [--answers <file>]
//
//   POST /ai-chat     v1 contract: status / delta / done{conversationId}; non-boss → 403 (as v1)
//   POST /assistant   v2 contract: status / delta / sources / done{conversationId, requestId}
//   GET  /__log/<id>  the ai_request_log shape for a v2 request (retrieved, tools, cost)
//
// Auth: "Bearer mock-<role>" (run-eval --mock-auth). The message is matched to
// a question in questions.jsonl ({person} as a wildcard); history user turns
// get `history_reply`. Answer templates:
//   {{n0}}        expected_numbers[0] formatted with its currency ($, £, PKR)
//   {{n0*1.1}}    the same value scaled (for deliberately wrong answers)
//   {{v0}}        the bare number, no currency (to put a wrong symbol in front)
//   {{person}}    the name the question was asked about
// Live rows (people_data) compute their expected value from expected_sql on
// dev, read-only, in memory: nothing is written to disk or logged.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { devDbUrl, SSL } from '../../scripts/dev-env.mjs';
import { isLive } from './grade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', '8787'));
const fx = JSON.parse(fs.readFileSync(opt('answers', path.join(HERE, 'mock-answers.json')), 'utf8'));
const questions = fs.readFileSync(path.join(HERE, 'questions.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = questions.filter((q) => fx.rows[q.id]).map((q) => ({
  q, re: new RegExp(`^${esc(q.question.trim()).replaceAll('\\{person\\}', '(.+?)')}$`, 'i'),
}));
const historyTurns = new Set(questions.flatMap((q) => (q.history ?? []).filter((h) => h.role === 'user').map((h) => h.content.trim().toLowerCase())));

let pool = null;
async function liveNumbers(q) {
  pool ??= new pg.Pool({ connectionString: devDbUrl(), ssl: SSL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('begin read only');
    return (await c.query(q.expected_sql.replaceAll(':as_user_id', "'00000000-0000-0000-0000-000000000000'::uuid"))).rows;
  } finally { await c.query('rollback').catch(() => {}); c.release(); }
}

const SYM = { USD: '$', GBP: '£', EUR: '€' };
const money = (v, cur) => {
  const s = Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur && !SYM[cur] ? `${cur} ${s}` : `${SYM[cur] ?? ''}${s}`;
};
async function render(tpl, q, person) {
  const nums = /\{\{n\d/.test(tpl) ? (isLive(q) ? await liveNumbers(q) : q.expected_numbers) : [];
  return tpl
    .replace(/\{\{n(\d+)(?:\*([\d.]+))?\}\}/g, (_, i, k) => {
      const n = nums[Number(i)];
      if (!n || n.value == null) return '(no data)';
      const v = Number(n.value) * (k ? Number(k) : 1);
      return n.unit === 'money' || n.currency ? money(v, n.currency) : n.unit === 'pct' ? `${v}%` : String(v);
    })
    .replace(/\{\{v(\d+)\}\}/g, (_, i) => (nums[Number(i)]?.value == null ? '(no data)' : money(nums[Number(i)].value, null)))
    .replaceAll('{{person}}', person ?? 'them');
}

const convos = new Map();      // conversationId → [user messages]
const logs = new Map();        // requestId → log
const sse = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
const json = (res, status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

async function handle(req, res, engine) {
  const role = /^Bearer mock-(\w+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!role) return json(res, 401, { error: 'unauthenticated' });
  if (engine === 'v1' && role !== 'boss') return json(res, 403, { error: 'The assistant is currently in limited testing and not available for your role yet.' });
  let body = '';
  for await (const c of req) body += c;
  const { message = '', conversationId, stream } = JSON.parse(body || '{}');
  if (!stream) return json(res, 400, { error: 'mock supports stream:true only' });
  const cid = conversationId && convos.has(conversationId) ? conversationId : crypto.randomUUID();
  const turns = convos.get(cid) ?? [];
  convos.set(cid, [...turns, message]);

  const text = message.trim();
  const m = matchers.map((x) => ({ x, hit: x.re.exec(text) })).find((y) => y.hit);
  let f = null, answer;
  if (m) {
    f = fx.rows[m.x.q.id];
    // A follow-up is answered properly only if its history really came first.
    const needs = (m.x.q.history ?? []).filter((h) => h.role === 'user').map((h) => h.content.trim().toLowerCase());
    const hadHistory = needs.every((h) => turns.some((t) => t.trim().toLowerCase() === h));
    answer = await render(hadHistory ? f.answer : (f.answer_without_history ?? fx.default_reply), m.x.q, m.hit[1]);
  } else {
    answer = historyTurns.has(text.toLowerCase()) ? fx.history_reply : fx.default_reply;
  }

  if (f?.http_status) return json(res, f.http_status, { error: f.error ?? 'mock error' });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  sse(res, { status: engine === 'v2' ? 'Searching the knowledge base…' : 'Thinking…' });
  if (f?.delay_ms) await new Promise((r) => setTimeout(r, f.delay_ms));
  if (f?.error) { sse(res, { error: f.error }); return res.end(); }
  for (let i = 0; i < answer.length; i += 24) sse(res, { delta: answer.slice(i, i + 24) });
  const requestId = crypto.randomUUID();
  if (engine === 'v2') {
    sse(res, { sources: f?.sources ?? [] });
    logs.set(requestId, { est_cost_usd: f?.log?.est_cost_usd ?? 0.003, tools: f?.log?.tools ?? [], retrieved: f?.log?.retrieved ?? [] });
    sse(res, { done: true, conversationId: cid, requestId });
  } else {
    sse(res, { done: true, conversationId: cid });
  }
  res.end();
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/\/+$/, '');
  const fail = (e) => { console.error('mock error:', e.message); if (!res.headersSent) json(res, 500, { error: 'mock failure' }); else res.end(); };
  if (req.method === 'POST' && route.endsWith('/ai-chat')) return handle(req, res, 'v1').catch(fail);
  if (req.method === 'POST' && route.endsWith('/assistant')) return handle(req, res, 'v2').catch(fail);
  const lm = /\/__log\/([\w-]+)$/.exec(route);
  if (req.method === 'GET' && lm) return logs.has(lm[1]) ? json(res, 200, logs.get(lm[1])) : json(res, 404, { error: 'no log' });
  json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`mock assistant on http://127.0.0.1:${PORT} (${Object.keys(fx.rows).length} canned rows)`));
