// ============================================================
// QA: migration 374, rewritten 2026-09-29 to the KB SECURITY TRIGGER only
// (Owner: content arrives by the 12-hour sweep; only a KB article becoming
// less visible, or deleted, must not wait). Executes 379 + 380 + 374 INSIDE one
// transaction, drives REAL indexed KB articles through the trigger AND the real
// worker (fake embedder, no OpenAI call), checks what users can search before
// and after the drain, and ALWAYS rolls back.
//
//   node --experimental-strip-types tests/ingest/phase2b-triggers.test.mjs
//
// CREATE TRIGGER locks kb_articles against writes until the rollback: the run
// is kept to well under a minute (lock_timeout 10 s, idle-in-transaction 60 s).
// Complements scripts/test-triggers.mjs (synthetic rows) with real articles,
// the search-visibility window, RLS writers and the exclusion list.
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL, stripBom } from '../../scripts/dev-env.mjs';
import { DEFAULT_CONFIG } from '../../supabase/functions/_shared/ai/config.ts';
import { pgRpc } from '../../supabase/functions/_shared/ai/ingest/db.ts';
import { runWorker } from '../../supabase/functions/_shared/ai/ingest/worker.ts';

const results = [];
const check = (name, ok, detail = '') => results.push({ ok: !!ok, name, detail: String(detail ?? '').slice(0, 220) });
const J = (x) => JSON.stringify(x);
const migFile = (n) => fs.readdirSync(path.join(ASSISTANT, 'supabase/migrations')).find((f) => f.startsWith(`${n}_`));
const mig = (n) => stripBom(fs.readFileSync(path.join(ASSISTANT, 'supabase/migrations', migFile(n)), 'utf8'));
const TESTING_DOC = '833b9bda-8282-41dc-a8da-8ff3f032354d';
const fake = { inputs: 0 };
const vec = (t) => { const h = crypto.createHash('sha256').update(t).digest(); return Array.from({ length: DEFAULT_CONFIG.EMBED_DIMS }, (_, i) => ((h[i % 32] + i) % 97) / 97 - 0.5); };
const embed = async (texts) => { fake.inputs += texts.length; return { vectors: texts.map(vec), tokens: 1, requests: 1 }; };

const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 120_000 });
c.on('error', () => {});
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rpc = pgRpc(c, { savepoints: true });
const t0 = Date.now();
let xid = null;
try {
  await c.query(`set idle_in_transaction_session_timeout = '60s'`);
  await c.query('begin');
  xid = (await one('select pg_current_xact_id()::text x')).x;
  await c.query(`set local lock_timeout = '10s'`);
  const busy = await one(`select count(*)::int n from ai_ingest_queue where status in ('pending','processing')`);
  if (busy.n) throw new Error(`dev queue has ${busy.n} pending/processing rows; refusing`);
  const applied = new Set((await q(`select version from supabase_migrations.schema_migrations`)).map((r) => r.version));
  for (const v of ['379', '380', '374', '374']) if (!applied.has(v)) await c.query(mig(v));
  check('379 + 380 + 374 execute inside the transaction; 374 twice (idempotent)', true, [...applied].filter((v) => ['374', '379', '380'].includes(v)).join(',') || 'none recorded yet');

  // ── shape
  const trg = await q(`select t.tgrelid::regclass::text rel, t.tgname, pg_get_triggerdef(t.oid) def from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and (p.proname like 'ai\\_%' or t.tgname like 'ai\\_%') order by 1, 2`);
  // Source tables only: 380's config check and 382's ai_chunks bookkeeping trigger are not ingest triggers.
  const SOURCES = ['kb_articles', 'reports', 'tts_articles', 'incentives', 'brands', 'ai_assistant_docs', 'profiles'];
  const ingestTrg = trg.filter((t) => SOURCES.includes(t.rel));
  check('only ONE ingest trigger on the source tables: ai_kb_articles_acl on kb_articles',
    ingestTrg.length === 1 && ingestTrg[0].tgname === 'ai_kb_articles_acl' && ingestTrg[0].rel === 'kb_articles', J(trg.map((t) => `${t.rel}.${t.tgname}`)));
  check('it is AFTER UPDATE OF the 6 access columns OR DELETE, FOR EACH ROW (no INSERT, no content columns)',
    /AFTER DELETE OR UPDATE OF visibility, visible_to_roles, visible_to_users, submitted_by, created_by, approval_status ON public\.kb_articles FOR EACH ROW/.test(ingestTrg[0]?.def ?? ''), ingestTrg[0]?.def);

  const P = await one(`select (select id from profiles where role = 'boss' and is_active and deleted_at is null limit 1) boss,
      (select id from profiles where role = 'apc' and is_active and deleted_at is null order by id limit 1) apc,
      (select id from profiles where role = 'ol' and is_active and deleted_at is null order by id limit 1) ol`);
  const pending = () => q(`select source_type, source_id, op, priority, reason, extract(epoch from not_before - now())::int due from ai_ingest_queue where status = 'pending' order by id`);
  const settle = () => q(`update ai_ingest_queue set status = 'done', done_at = now() where status = 'pending'`);
  const drain = async () => { const f0 = fake.inputs; const s = await runWorker({ rpc, embed, workerId: `qa-trg-${crypto.randomUUID()}` }); return { s, inputs: fake.inputs - f0 }; };
  const asUser = async (uid, sql, params = []) => {
    await c.query('savepoint u');
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [J({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const r = await c.query(sql, params);
      await c.query('reset role');
      await c.query('release savepoint u');
      return { rows: r.rows, n: r.rowCount, err: '' };
    } catch (e) { await c.query('rollback to savepoint u'); return { rows: [], n: -1, err: `${e.code} ${e.message}` }; }
  };
  const finds = async (uid, sid, text) => (await asUser(uid, `select source_id from ai_search(null::extensions.vector, $1, array['kb_article'], null, null, null, 100)`, [text])).rows.some((r) => r.source_id === sid);

  // A real, indexed, office-wide KB article with a distinctive title word that the APC can find.
  const cands = await q(`select k.id::text id, k.title from kb_articles k join ai_documents d on d.source_type = 'kb_article' and d.source_id = k.id::text and d.status = 'active'
      where k.visibility = 'office' and k.approval_status = 'approved' and k.id::text <> $1 and length(k.title) > 12 order by k.id limit 20`, [TESTING_DOC]);
  let A = null;
  for (const k of cands) if (await finds(P.apc, k.id, k.title)) { A = k; break; }
  if (!A) throw new Error('no real office-wide indexed KB article the APC can find by title');
  check('pre: a real office-wide indexed KB article the APC finds by its title', true, A.title);

  // ── the security window: Boss restricts it to herself
  const before = await one(`select acl_mode, acl_users, metadata->>'visibility' vis from ai_documents where source_type = 'kb_article' and source_id = $1`, [A.id]);
  const upd = await asUser(P.boss, `update kb_articles set visibility = 'users', visible_to_users = $2 where id = $1`, [A.id, [P.boss]]);
  check('the Boss restricts it (visibility users = {boss}) through RLS: 1 row', upd.n === 1, upd.err);
  const pq = await pending();
  check('→ ONE acl op for it, priority 0, due now (not 12 h)', pq.length === 1 && pq[0].source_id === A.id && pq[0].op === 'acl' && pq[0].priority === 0 && pq[0].due <= 0, J(pq));
  check('before the drain the APC can still find it (the stale snapshot this trigger exists to close)', await finds(P.apc, A.id, A.title));
  const w1 = await drain();
  const after = await one(`select acl_mode, acl_users, metadata->>'visibility' vis, status from ai_documents where source_type = 'kb_article' and source_id = $1`, [A.id]);
  check('the drain (one tick) rewrites only the ACL: 0 embeds, document still active, visibility users',
    w1.s.claimed === 1 && !w1.s.failed && w1.inputs === 0 && after.status === 'active' && after.vis === 'users', J({ before, after, s: { c: w1.s.claimed, f: w1.s.failed, in: w1.inputs } }));
  // (an OL / developer reads every KB article by design: ai_can_read_document 'kb' mode, mirroring the app)
  const vis = { apc: await finds(P.apc, A.id, A.title), ol: await finds(P.ol, A.id, A.title), boss: await finds(P.boss, A.id, A.title) };
  check('after the drain: the APC no longer finds it; the Boss (and, by KB design, an OL) still do', !vis.apc && vis.boss && vis.ol, J(vis));

  // ── content edits enqueue nothing (they wait for the sweep)
  await settle();
  await q(`update kb_articles set title = title || ' (QA)', body = coalesce(body, '') || ' QA', tags = coalesce(tags, '{}') || '{qa}' where id = $1`, [A.id]);
  check('title / body / tags edit of an indexed article → nothing enqueued', !(await pending()).length, J(await pending()));
  const rep = await one(`select r.id from reports r join ai_documents d on d.source_type = 'report' and d.source_id = r.id::text where r.status = 'approved' limit 1`);
  if (rep) await q(`update reports set data = data where id = $1`, [rep.id]);
  check('an approved, indexed report edited → nothing enqueued (no report trigger any more)', !(await pending()).length);

  // ── approval withdrawn → soft delete within a tick
  const B = cands.find((k) => k.id !== A.id);
  await q(`update kb_articles set approval_status = 'pending' where id = $1`, [B.id]);
  const pb = await pending();
  const w2 = await drain();
  const db = await one(`select status from ai_documents where source_type = 'kb_article' and source_id = $1`, [B.id]);
  check('approval withdrawn → acl op p0 → the drain soft-deletes it (0 embeds); the Boss no longer finds it either',
    pb.length === 1 && pb[0].op === 'acl' && pb[0].priority === 0 && db.status === 'deleted' && w2.inputs === 0 && !(await finds(P.boss, B.id, B.title)), J({ pb, db }));

  // ── DELETE → hard delete within a tick
  const C = cands.find((k) => k.id !== A.id && k.id !== B.id);
  await q(`delete from kb_articles where id = $1`, [C.id]);
  const pc = await pending();
  const w3 = await drain();
  const dc = await one(`select count(*)::int n, (select count(*)::int from ai_chunks ch join ai_documents d on d.id = ch.document_id where d.source_type = 'kb_article' and d.source_id = $1) ch from ai_documents where source_type = 'kb_article' and source_id = $1`, [C.id]);
  check('DELETE → delete op p0 → the drain removes the document and its chunks', pc.length === 1 && pc[0].op === 'delete' && pc[0].priority === 0 && dc.n === 0 && dc.ch === 0 && !w3.s.failed, J({ pc, dc }));

  // ── the excluded testing doc: an ACL edit must not bring it back
  const tdoc = await one(`select status from ai_documents where source_type = 'kb_article' and source_id = $1`, [TESTING_DOC]);
  if (tdoc?.status === 'active') {
    await q(`update kb_articles set visibility = case when visibility = 'office' then 'role' else 'office' end where id = $1`, [TESTING_DOC]);
    const pt = await pending();
    const w4 = await drain();
    const dt = await one(`select status from ai_documents where source_type = 'kb_article' and source_id = $1`, [TESTING_DOC]);
    check('excluded testing doc: an ACL edit queues acl; the drain soft-deletes it (plan: excluded), 0 embeds, not revived',
      pt.length === 1 && dt.status === 'deleted' && w4.inputs === 0, J({ pt, dt }));
  } else check('excluded testing doc already soft-deleted on dev (post-first-sweep state)', tdoc?.status === 'deleted', J(tdoc));

  // ── an RLS writer who is not the Boss: the definer trigger still enqueues (they cannot write the queue themselves)
  const own = await one(`select k.id::text id, k.created_by from kb_articles k join ai_documents d on d.source_type = 'kb_article' and d.source_id = k.id::text and d.status = 'active'
      join profiles p on p.id = k.created_by and p.role <> 'boss' and p.is_active and p.deleted_at is null
      where k.id::text not in ($1, $2, $3, $4) order by k.id limit 1`, [A.id, B.id, C.id, TESTING_DOC]);
  if (own) {
    await settle();
    const u = await asUser(own.created_by, `update kb_articles set visible_to_roles = coalesce(visible_to_roles, '{}') || '{ol}' where id = $1`, [own.id]);
    const po = await pending();
    const direct = await asUser(own.created_by, `insert into ai_ingest_queue (source_type, source_id, op) values ('kb_article', $1, 'acl')`, [own.id]);
    check(`non-Boss author (${(await one('select role from profiles where id = $1', [own.created_by])).role}) editing access: ${u.n === 1 ? 'allowed by KB RLS → the trigger enqueues through its definer' : 'refused by KB RLS → nothing enqueued'}; they cannot write the queue directly`,
      (u.n === 1 ? po.length === 1 && po[0].op === 'acl' : po.length === 0) && /42501/.test(direct.err), J({ u: u.err || u.n, po: po.length, direct: direct.err.slice(0, 60) }));
  } else check('no non-Boss-authored indexed KB article on dev: RLS-writer case skipped', true);

  // ── kb_article switched off: nothing enqueued
  await settle();
  await q(`update ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'kb_article') where id = 1`);
  const D = cands.find((k) => ![A.id, B.id, C.id].includes(k.id));
  await q(`update kb_articles set visibility = 'role', visible_to_roles = '{ol}' where id = $1`, [D.id]);
  check('kb_article switched off in ingest_sources → an ACL change enqueues nothing', !(await pending()).length);
  await q(`update ai_assistant_config set ingest_sources = array_append(ingest_sources, 'kb_article') where id = 1`);

  // ── a failing queue insert never blocks the user's save (different mechanism from test-triggers.mjs)
  await q(`create function pg_temp.qa_boom() returns trigger language plpgsql as $$ begin raise exception 'qa queue boom'; end $$`);
  await q(`create trigger qa_boom before insert on ai_ingest_queue for each row execute function pg_temp.qa_boom()`);
  await q('savepoint g');
  let saved = '';
  try {
    const r = await q(`update kb_articles set visibility = 'office' where id = $1 returning visibility`, [D.id]);
    saved = r[0]?.visibility;
    await q('release savepoint g');
  } catch (e) { saved = `blocked: ${e.message}`; await q('rollback to savepoint g'); }
  await q(`drop trigger qa_boom on ai_ingest_queue`);
  check('a queue insert that raises: the KB save still succeeds (warning only), nothing queued', saved === 'office' && !(await pending()).length, saved);

  check('no queue row left failed', !(await one(`select count(*)::int n from ai_ingest_queue where status = 'failed'`)).n);
} catch (e) {
  check(`aborted: ${e.message}`, false, e.stack?.split('\n')[1]);
} finally {
  let intact = false;
  try { intact = (await one('select pg_current_xact_id()::text x')).x === xid; } catch { intact = true; }
  await c.query('rollback').catch(() => {});
  let post = null;
  try { post = await one(`select (select count(*)::int from pg_trigger where tgname = 'ai_kb_articles_acl') trg,
      (select count(*)::int from ai_ingest_queue where status <> 'done') q, (select count(*)::int from ai_documents where status = 'active') d`); } catch { /* */ }
  await c.end().catch(() => {});
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s. ${intact ? '(rolled back)' : '!!! transaction id changed'}`);
  console.log(`after rollback: ${J(post)}`);
  process.exitCode = failed || !intact ? 1 : 0;
}
