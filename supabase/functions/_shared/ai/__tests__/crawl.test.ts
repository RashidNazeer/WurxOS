import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, linkedIds, pageRecords, sitemapItems, TTS_SITEMAP } from '../crawl/ttsPages.ts';
import { runCrawl } from '../crawl/runner.ts';
import type { Rpc } from '../ingest/db.ts';

// Synthetic Academy pages in the shape the server embeds (window._ROUTER_DATA).
const page = (loaderData: unknown) =>
  `<html><head></head><body><div id="root"></div><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData })};</script></body></html>`;
const essayData = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  knowledge_detail: { knowledge_id: id, knowledge_name: `Essay ${id}`, knowledge_plain_content: text, keywords: 'a, b' },
  learning_info: { learning_id: id, views: 7, create_time: 1700000000, modify_time: 1710000000 },
  sidebar_contents: { content_id: 'root', content_name: 'Seller', sub_contents: [{ content_id: id, content_name: `Essay ${id}`, content_type: 2 }] },
  ...extra,
});
const courseData = (lid: string, lessons: [string, string][]) => ({
  course_detail: { info: { name: `Course ${lid}`, description: 'd', views: 3, modify_time: 1710000000000 } },
  course_contents: lessons.map(([id, text]) => ({
    content_id: id, type: 1,
    knowledge: { knowledge_id: id, knowledge_name: `Lesson ${id}`, knowledge_content: JSON.stringify({ deltas: { 0: { ops: [{ insert: text }] } } }) },
  })),
});
const sitemap = (ess: string[], courses: [string, string][]) => JSON.stringify({ data: [
  ...ess.map((id) => ({ loc: `https://seller-us.tiktok.com/university/essay?knowledge_id=${id}` })),
  ...courses.map(([lid, cid]) => ({ loc: `https://seller-us.tiktok.com/university/course?learning_id=${lid}&content_id=${cid}` })),
  { loc: 'https://seller-us.tiktok.com/university/course?learning_id=L1&content_id=other' },   // same course twice
  { loc: 'not a url' },
] });

test('sitemap: essays then one entry per course; junk ignored', () => {
  const items = sitemapItems(JSON.parse(sitemap(['1', '2'], [['L1', 'c1']])));
  assert.deepEqual(items.map((i) => i.key), ['essay:1', 'essay:2', 'course:L1']);
  assert.match(items[0].url, /essay\?knowledge_id=1&lang=en$/);
  assert.match(items[2].url, /learning_id=L1&content_id=c1&lang=en$/);
});

test('classifyPage: content, JS shell (retry), dead, throttled', () => {
  assert.equal(classifyPage(200, page({ 'essay/page': essayData('1', 'x') }), 'essay/page').kind, 'ok');
  assert.deepEqual(classifyPage(200, '<html><script src="app.js"></script></html>', 'essay/page'), { kind: 'retry', reason: 'js-only shell' });
  assert.deepEqual(classifyPage(200, page({ other: {} }), 'essay/page'), { kind: 'retry', reason: 'no essay/page data' });
  assert.equal(classifyPage(200, '<p>The content you are looking for does not exist</p>', 'essay/page').kind, 'dead');
  assert.equal(classifyPage(404, '', 'essay/page').kind, 'dead');
  assert.deepEqual(classifyPage(429, '', 'essay/page'), { kind: 'retry', reason: 'HTTP 429' });
});

test('essay and course pages → crawl records; links found for essays', () => {
  const e = pageRecords({ key: 'essay:1', kind: 'essay', item_id: '1', url: 'u' },
    essayData('1', 'Hello&nbsp;world ​\n\n\n\nbye', { next_knowledge: { learning_type: 2, learning_id: '9' } }));
  assert.equal(e.records.length, 1);
  assert.deepEqual({ ...e.records[0], toc: undefined }, { ...e.records[0], toc: undefined, id: '1', kind: 'essay', text: 'Hello world\n\nbye', breadcrumb: 'Seller', keywords: ['a', 'b'] });
  assert.equal(e.records[0].modified_at, new Date(1710000000 * 1000).toISOString(), 'essay times are seconds');
  assert.deepEqual(e.links.sort(), ['1', '9']);
  const c = pageRecords({ key: 'course:L1', kind: 'course', item_id: 'L1', url: 'u' }, courseData('L1', [['a', 'one'], ['b', 'two']]));
  assert.deepEqual(c.records.map((r) => [r.id, r.kind, r.text, (r.course as any).lesson_index]), [['a', 'course_lesson', 'one', 0], ['b', 'course_lesson', 'two', 1]]);
  assert.equal(c.records[0].modified_at, new Date(1710000000000).toISOString(), 'course times are ms');
  assert.deepEqual(c.links, []);
  assert.deepEqual(linkedIds({ rec_content: [{ learning_type: 1, learning_id: 'x' }] }), []);
});

// ── the runner against an in-memory model of the mig 380 functions ──────
function fakeDb() {
  const st = { status: 'discover', owner: null as string | null, after: null as string | null, finished: null as unknown };
  const items = new Map<string, { key: string; kind: string; item_id: string; url: string; status: string; attempts: number; due: number; records: any[] }>();
  const applied: any[] = [];
  let clock = 0;
  const calls: string[] = [];
  const rpc: Rpc = async (fn, a: any = {}) => {
    calls.push(fn);
    if (fn === 'ai_crawl_lease') { if (st.status === 'idle' || st.owner) return null; st.owner = a.p_worker; return { status: st.status, finalize_after: st.after }; }
    if (fn === 'ai_crawl_release') { if (st.owner === a.p_worker) st.owner = null; return null; }
    if (st.owner !== a.p_worker) return { ok: false, reason: 'lost_lease' };
    switch (fn) {
      case 'ai_crawl_add_items':
        for (const x of a.p_items) if (!items.has(x.key)) items.set(x.key, { ...x, status: 'pending', attempts: 0, due: 0, records: [] });
        if (st.status === 'discover') st.status = 'crawl';
        return { ok: true };
      case 'ai_crawl_note_error': return { ok: true };
      case 'ai_crawl_next': {
        const pend = [...items.values()].filter((i) => i.status === 'pending');
        if (!pend.length && st.status === 'crawl') st.status = 'finalize';
        return { ok: true, status: st.status, items: pend.filter((i) => i.due <= clock).slice(0, a.p_limit), waiting: pend.filter((i) => i.due > clock).length };
      }
      case 'ai_crawl_put': {
        const i = items.get(a.p_key)!;
        i.attempts++;
        if (a.p_outcome === 'done') { i.status = 'done'; i.records = a.p_records; }
        else if (a.p_outcome === 'dead') i.status = 'dead';
        else { i.status = i.attempts >= 6 ? 'failed' : 'pending'; i.due = clock + 1; }
        return { ok: true, status: i.status };
      }
      case 'ai_crawl_read_records': {
        const recs = [...items.values()].flatMap((i) => i.records).filter((r) => a.p_after === null || r.id > a.p_after);
        const ids = [...new Set(recs.map((r) => r.id))].sort().slice(0, a.p_limit);
        return { ok: true, last: ids.at(-1) ?? null, records: recs.filter((r) => ids.includes(r.id)) };
      }
      case 'ai_tts_apply': applied.push(...a.p_rows); st.after = a.p_last; return { ok: true };
      case 'ai_crawl_finish': st.status = 'idle'; st.finished = { pages: items.size }; return { ok: true, stats: st.finished };
    }
    throw new Error(`unexpected ${fn}`);
  };
  return { st, items, applied, calls, rpc, tick: () => { clock++; } };
}

test('runner: discover → crawl (shell retried, dead skipped, link followed) → finalize with the importer rules → idle', async () => {
  const db = fakeDb();
  let shellOnce = true;
  const pages: Record<string, string> = {
    [TTS_SITEMAP]: sitemap(['1', '2', '3'], [['L1', 'a']]),
  };
  const fetch = async (url: string) => {
    if (url === TTS_SITEMAP) return { status: 200, text: pages[url] };
    const id = /knowledge_id=([^&]+)/.exec(url)?.[1] ?? /learning_id=([^&]+)/.exec(url)?.[1];
    if (id === '2' && shellOnce) { shellOnce = false; return { status: 200, text: '<html>shell</html>' }; }
    if (id === '3') return { status: 404, text: '' };
    if (id === 'L1') return { status: 200, text: page({ 'course/page': courseData('L1', [['1', 'lesson text'], ['b', 'other']]) }) };
    return { status: 200, text: page({ 'essay/page': essayData(id!, `text ${id}`, id === '1' ? { next_knowledge: { learning_type: 2, learning_id: '4' } } : {}) }) };
  };
  const sleeps: number[] = [];
  let t = 0;
  const opts = { rpc: db.rpc, fetch, workerId: 'w1', now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, random: () => 0 };

  const r1 = await runCrawl(opts);
  assert.equal(db.st.owner, null, 'lease released');
  assert.equal(r1.stopped, 'waiting for 1 page(s) to retry');
  assert.equal(db.items.get('essay:4')?.status, 'done', 'a linked essay missing from the sitemap is crawled too');
  assert.equal(db.items.get('essay:3')?.status, 'dead');
  assert.equal(db.items.get('essay:2')?.status, 'pending');
  assert.ok(sleeps.length >= 4 && sleeps.every((s) => s === 2500), `polite gaps: ${sleeps}`);

  db.tick();
  const r2 = await runCrawl(opts);
  assert.equal(r2.status, 'idle');
  assert.deepEqual(r2.finished, { pages: 5 });
  // id 1 is both an essay and a course lesson: one row, the essay wins, the course is kept.
  const rows = new Map(db.applied.map((r) => [r.knowledge_id, r]));
  assert.deepEqual([...rows.keys()].sort(), ['1', '2', '4', 'b']);
  assert.equal(rows.get('1').kind, 'essay');
  assert.equal(rows.get('1').course[0].learning_id, 'L1');
  assert.match(rows.get('1').content_hash, /^[0-9a-f]{64}$/);
});

test('runner: a small time budget stops between pages; finalize resumes after the saved cursor', async () => {
  const db = fakeDb();
  const fetch = async (url: string) => url === TTS_SITEMAP
    ? { status: 200, text: sitemap(['1', '2', '3', '4', '5', '6'], []) }   // + course L1 (the helper's duplicate entry)
    : url.includes('learning_id=')
      ? { status: 200, text: page({ 'course/page': courseData('L1', [['7', 'lesson']]) }) }
      : { status: 200, text: page({ 'essay/page': essayData(/knowledge_id=(\d+)/.exec(url)![1], 'x') }) };
  let t = 0;
  const base = { rpc: db.rpc, fetch, workerId: 'w', now: () => t, sleep: async (ms: number) => { t += ms; }, random: () => 0, followLinks: false };
  const r1 = await runCrawl({ ...base, budgetMs: 6000 });
  assert.equal(r1.stopped, 'time budget');
  assert.ok(r1.pages >= 2 && r1.pages < 7, `pages ${r1.pages}`);
  let guard = 0;
  let r;
  do { t = 0; r = await runCrawl({ ...base, budgetMs: 40_000, finalizeGroup: 2 }); } while (r.status !== 'idle' && ++guard < 10);
  assert.equal(r.status, 'idle');
  assert.deepEqual(db.applied.map((x) => x.knowledge_id), ['1', '2', '3', '4', '5', '6', '7'], 'each id applied once, in cursor order');
});

test('runner: nothing to do → no lease, no fetch; a lost lease stops the call cleanly', async () => {
  const db = fakeDb();
  db.st.status = 'idle';
  let fetched = 0;
  const r = await runCrawl({ rpc: db.rpc, fetch: async () => { fetched++; return { status: 200, text: '' }; }, workerId: 'w' });
  assert.equal(r.status, 'idle_or_busy');
  assert.equal(fetched, 0);

  const db2 = fakeDb();
  db2.st.status = 'crawl';
  db2.items.set('essay:1', { key: 'essay:1', kind: 'essay', item_id: '1', url: 'https://x/essay?knowledge_id=1', status: 'pending', attempts: 0, due: 0, records: [] });
  const r2 = await runCrawl({ rpc: db2.rpc, workerId: 'w', sleep: async () => {},
    fetch: async () => { db2.st.owner = 'someone-else'; return { status: 200, text: page({ 'essay/page': essayData('1', 'x') }) }; } });
  assert.equal(r2.stopped, 'lost the lease');
  assert.equal(db2.items.get('essay:1')!.status, 'pending', 'nothing written after the lease was lost');
});

test('runner: the politeness gap holds across calls (mig 384: the lease reports the last fetch)', async () => {
  const db = fakeDb();
  db.st.status = 'crawl';
  db.items.set('essay:1', { key: 'essay:1', kind: 'essay', item_id: '1', url: 'https://x/essay?knowledge_id=1', status: 'pending', attempts: 0, due: 0, records: [] });
  const rpc: Rpc = async (fn, a) => { const r = await db.rpc(fn, a); return fn === 'ai_crawl_lease' && r ? { ...r, since_last_fetch_ms: 1000 } : r; };
  const sleeps: number[] = [];
  let t = 0;
  await runCrawl({ rpc, workerId: 'w', now: () => t, random: () => 0, sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    fetch: async () => ({ status: 200, text: page({ 'essay/page': essayData('1', 'x') }) }) });
  assert.equal(sleeps[0], 1500, 'the first fetch waits out the rest of the 2.5 s gap left by the previous call');
});
