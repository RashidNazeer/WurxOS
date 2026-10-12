// ============================================================
// Migration 374 (the KB security trigger) test: executes 374 INSIDE one
// transaction, mutates SYNTHETIC rows, asserts the queue rows, and ALWAYS
// rolls back. DEV ONLY. The trigger never exists outside this transaction
// until the Owner's go.
//
//   node --experimental-strip-types scripts/test-triggers.mjs
//
// Owner, 2026-09-29: content reaches the store on the 12-hour sweep, so every
// content change must enqueue NOTHING; only a KB access change (or delete) of
// an article that is in the store enqueues, due now. The sweep itself is
// tested by scripts/test-schedule.mjs.
//
// CREATE TRIGGER locks kb_articles against writes until the rollback, so the
// run is kept to a few seconds (lock_timeout 10 s, idle-in-transaction 60 s).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL, stripBom } from './dev-env.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push({ ok: !!ok, name, detail: String(detail).slice(0, 180) }); };
const mig = (n) => stripBom(fs.readFileSync(path.join(ASSISTANT, '..', 'supabase/migrations', fs.readdirSync(path.join(ASSISTANT, '..', 'supabase/migrations')).find((f) => f.startsWith(`${n}_`))), 'utf8'));

const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 120_000 });
c.on('error', () => {});
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let xid = null;
try {
  // L6: if this process dies mid-run, the server ends the session (and its locks).
  await c.query(`set idle_in_transaction_session_timeout = '60s'`);
  await c.query('begin');
  xid = (await one('select pg_current_xact_id()::text as x')).x;
  await c.query(`set local lock_timeout = '10s'`);
  const busy = await one(`select count(*)::int n from public.ai_ingest_queue where status in ('pending','processing')`);
  if (busy.n) throw new Error(`dev queue has ${busy.n} pending/processing rows; refusing`);
  await c.query(mig(374));
  check('374 executes inside the transaction (needs 377, applied)', true);
  await c.query(mig(374));
  check('374 re-runs cleanly (idempotent)', true);

  const trg = await q(`select tgname, tgrelid::regclass::text rel from pg_trigger where tgname like 'ai\\_%' and not tgisinternal
      and tgrelid in ('public.reports'::regclass, 'public.kb_articles'::regclass, 'public.ai_assistant_docs'::regclass,
                      'public.tts_articles'::regclass, 'public.incentives'::regclass, 'public.brands'::regclass)`);   // the source tables only (380, 382, 383 add their own ai_* triggers elsewhere)
  check('exactly one ingest trigger: ai_kb_articles_acl on kb_articles', trg.length === 1 && trg[0].tgname === 'ai_kb_articles_acl' && trg[0].rel === 'kb_articles', JSON.stringify(trg));
  const oldFns = await one(`select string_agg(proname, ',') s from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('ai_trg_reports','ai_trg_kb_articles','ai_trg_ai_assistant_docs','ai_trg_tts_articles','ai_trg_incentives','ai_trg_brands')`);
  check('the content-trigger functions of the earlier draft do not exist', !oldFns.s, oldFns.s);

  const allPending = () => q(`select source_type, source_id, op, priority, reason, extract(epoch from not_before - now())::int as due_in
      from public.ai_ingest_queue where status = 'pending' order by id`);
  const settle = () => q(`update public.ai_ingest_queue set status = 'done', done_at = now() where status = 'pending'`);
  const fmt = (rows) => JSON.stringify(rows);
  const nothing = async (what) => { const p = await allPending(); check(`${what} → nothing enqueued`, p.length === 0, fmt(p)); await settle(); };

  const ppl = await one(`select (select id from public.brands where status = 'active' order by id limit 1) brand,
      (select id from public.profiles where role = 'boss' and is_active limit 1) boss,
      (select id from public.profiles where role = 'apc' and is_active order by id limit 1) apc`);

  // ---------------------------------------------------------- content: never enqueued
  const rep = (await one(`insert into public.reports (brand_id, author_id, type, period_start, period_end, period_label, status, data)
      values ($1, $2, 'weekly', '2099-02-02', '2099-02-08', 'QA Zq', 'draft', '{"overallInsights":"a"}') returning id`, [ppl.brand, ppl.apc])).id;
  await q(`update public.reports set status = 'approved' where id = $1`, [rep]);
  await q(`update public.reports set data = jsonb_set(data, '{overallInsights}', '"edited"') where id = $1`, [rep]);
  await q(`update public.reports set status = 'submitted' where id = $1`, [rep]);
  await q('delete from public.reports where id = $1', [rep]);
  await nothing('report: insert, approve, edit, reopen, delete');
  await q(`insert into public.tts_articles (knowledge_id, kind, url, title, body, content_hash) values ('qa-trg-1', 'essay', 'https://x', 'QA', 'body', 'h1')`);
  await q(`update public.tts_articles set content_hash = 'h2', is_active = false where knowledge_id = 'qa-trg-1'`);
  await nothing('tts_articles: insert, content change, retire');
  const inc = (await one(`insert into public.incentives (user_id, month, incentives) values ($1, '2099-02',
      '[{"id":"a","text":"QA Zq goal","targetValue":10,"amount":100}]') returning id`, [ppl.apc])).id;
  await q(`update public.incentives set incentives = jsonb_set(incentives, '{0,targetValue}', '12'), verified = true where id = $1`, [inc]);
  await q('delete from public.incentives where id = $1', [inc]);
  await nothing('incentives: insert, plan change, verify, delete');
  const b = await one(`select id from public.brands where status = 'active' and exists (select 1 from public.reports r where r.brand_id = brands.id and r.status = 'approved') order by id limit 1`);
  await q(`update public.brands set brand_name = brand_name || ' QA', currency = case when currency = 'GBP' then 'USD' else 'GBP' end where id = $1`, [b.id]);
  await nothing('brands: rename + currency change (no cascade)');
  const kbDraft = (await one(`insert into public.kb_articles (title, url, category, visibility, approval_status, created_by, version)
      values ('QA Zq KB draft', 'https://example.com/qa-d', 'operational_sops', 'office', 'pending', $1, 1) returning id`, [ppl.boss])).id;
  const doc = (await one(`insert into public.ai_assistant_docs (title, content, is_active, kind, kb_article_id)
      values ('QA Zq SOP', 'text', true, 'doc', $1) returning id`, [kbDraft])).id;
  await q(`update public.ai_assistant_docs set content = 'text 2', kind = 'app_guide' where id = $1`, [doc]);
  await nothing('ai_assistant_docs: insert, edit, kind change; kb_articles: a new article');
  await q(`update public.kb_articles set visibility = 'role', visible_to_roles = '{ol}', approval_status = 'approved' where id = $1`, [kbDraft]);
  await nothing('kb: an ACL / approval change of an article NOT in the store (it cannot leak; the sweep indexes it)');

  // ---------------------------------------------------------- kb in the store: access changes → acl, now
  const kb = (await one(`insert into public.kb_articles (title, url, category, visibility, approval_status, created_by, version)
      values ('QA Zq KB', 'https://example.com/qa', 'operational_sops', 'office', 'approved', $1, 1) returning id`, [ppl.boss])).id;
  await q(`insert into public.ai_documents (source_type, source_id, title, acl_mode, doc_hash) values ('kb_article', $1, 'QA Zq KB', 'kb', 'x')`, [kb]);
  await q(`update public.kb_articles set title = 'QA Zq KB (edited)', tags = '{qa}' where id = $1`, [kb]);
  await nothing('kb in the store: title / tags edit');
  for (const [col, val] of [['visibility', 'role'], ['visible_to_roles', '{ol}'], ['visible_to_users', `{${ppl.apc}}`],
                            ['submitted_by', ppl.apc], ['created_by', ppl.apc], ['approval_status', 'pending']]) {
    await q(`update public.kb_articles set ${col} = $2 where id = $1`, [kb, val]);
    const k = await allPending();
    check(`kb in the store: ${col} change → one acl op, priority 0, due now`, k.length === 1 && k[0].source_id === kb && k[0].op === 'acl' && k[0].priority === 0 && k[0].due_in <= 0, fmt(k));
    await settle();
  }
  await q(`update public.kb_articles set visibility = 'office' where id = $1`, [kb]);
  await q(`update public.kb_articles set visibility = 'private' where id = $1`, [kb]);
  const k2 = await allPending();
  check('two ACL changes collapse into one pending acl row', k2.length === 1 && k2[0].op === 'acl', fmt(k2));
  await settle();
  await q(`update public.ai_documents set status = 'deleted' where source_type = 'kb_article' and source_id = $1`, [kb]);
  await q(`update public.kb_articles set visibility = 'office' where id = $1`, [kb]);
  await nothing('kb soft-deleted in the store: an ACL change (already hidden)');
  await q(`update public.ai_documents set status = 'active' where source_type = 'kb_article' and source_id = $1`, [kb]);
  await q('delete from public.kb_articles where id = $1', [kb]);
  const k3 = await allPending();
  check('kb in the store: DELETE → delete op, priority 0, due now', k3.length === 1 && k3[0].op === 'delete' && k3[0].priority === 0 && k3[0].due_in <= 0, fmt(k3));
  await settle();

  // ---------------------------------------------------------- kb_article switched off
  const kbOff = (await one(`insert into public.kb_articles (title, url, category, visibility, approval_status, created_by, version)
      values ('QA Zq KB off', 'https://example.com/qa-off', 'operational_sops', 'office', 'approved', $1, 1) returning id`, [ppl.boss])).id;
  await q(`insert into public.ai_documents (source_type, source_id, title, acl_mode, doc_hash) values ('kb_article', $1, 'QA', 'kb', 'x')`, [kbOff]);
  await q(`update public.ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'kb_article')`);
  await q(`update public.kb_articles set visibility = 'private' where id = $1`, [kbOff]);
  await nothing('kb_article switched off in ingest_sources: an ACL change');
  await q(`update public.ai_assistant_config set ingest_sources = array_append(ingest_sources, 'kb_article')`);

  // ---------------------------------------------------------- guard: a broken enqueue never blocks a save
  await q(`create or replace function public.ai_enqueue(p_type text, p_id text, p_op text, p_priority int default 5,
      p_debounce interval default interval '0', p_reason text default 'trigger') returns void language plpgsql as $$ begin raise exception 'boom'; end $$`);
  let saved = false;
  try {
    await q('savepoint g');
    await q(`update public.kb_articles set visibility = 'office' where id = $1`, [kbOff]);
    saved = (await one(`select visibility from public.kb_articles where id = $1`, [kbOff])).visibility === 'office';
    await q('release savepoint g');
  } catch (e) { await q('rollback to savepoint g'); check(`guard error: ${e.message}`, false); }
  check('a failing ai_enqueue never blocks the user\'s save (warning only)', saved);
} catch (e) {
  check(`test aborted: ${e.message}`, false);
} finally {
  let intact = false;
  try { intact = (await one('select pg_current_xact_id()::text as x')).x === xid; } catch { intact = true; }
  await c.query('rollback').catch(() => {});
  await c.end().catch(() => {});
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed. ${intact ? '(rolled back: the trigger and every row are gone)' : '!!! transaction id changed: something may have been COMMITTED'}`);
  process.exitCode = failed || !intact ? 1 : 0;
}
