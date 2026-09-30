import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kbExtractor } from '../extractors/kb.ts';
import type { KbRow } from '../extractors/kb.ts';
import { aiDocExtractor, appGuideExtractor } from '../extractors/aiDoc.ts';
import type { AiDocRow } from '../extractors/aiDoc.ts';
import { ttsExtractor, markHeadings } from '../extractors/tts.ts';
import type { TtsRow } from '../extractors/tts.ts';
import { extractors } from '../extractors/index.ts';
import { chunkDocument } from '../chunker.ts';
import { chunkParamsFor } from '../config.ts';

const KB_ID = '00000000-0000-4000-8000-0000000000k1';
const kb = (over: Partial<KbRow> = {}): KbRow => ({
  id: KB_ID, title: 'How to ship samples', body: null, url: 'https://docs.example.com/sop-1',
  category: 'operational_sops', tags: ['samples'], visibility: 'role', visible_to_roles: ['tl', 'ol'],
  visible_to_users: [], created_by: '00000000-0000-4000-8000-0000000000u1', approval_status: 'approved',
  sop_group_id: '00000000-0000-4000-8000-0000000000g1', version: 2, requires_ack: false, ...over,
});
const sopDoc = (over: Partial<AiDocRow> = {}): AiDocRow => ({
  id: '00000000-0000-4000-8000-0000000000d1', title: 'SOP: Ship samples',
  content: 'SOP: Ship samples\nPurpose\n* Get samples out fast.\nStep 1: Pack the box.\n<!--wurx-sop-import-->',
  is_active: true, kind: 'doc', slug: null, meta: {}, kb_article_id: KB_ID, ...over,
});

test('registry covers the P1 source types + incentive plans', () => {
  assert.deepEqual(Object.keys(extractors).sort(), ['ai_doc', 'app_guide', 'incentive', 'kb_article', 'report', 'tts_article']);
  for (const [k, e] of Object.entries(extractors)) assert.equal(e.sourceType, k);
});

test('KB link-only article → one pointer chunk with the KB ACL', async () => {
  const row = kb();
  assert.ok(kbExtractor.indexable(row, { isLatestVersion: true }));
  assert.ok(!kbExtractor.indexable(row, { isLatestVersion: false }), 'superseded version');
  assert.ok(!kbExtractor.indexable(kb({ approval_status: 'pending' }), { isLatestVersion: true }));
  const d = kbExtractor.toDocument(row, { isLatestVersion: true });
  assert.deepEqual(d.acl, { mode: 'kb', roles: ['tl', 'ol'], users: [], authorId: row.created_by });
  assert.equal(d.metadata.visibility, 'role');
  assert.equal(d.header, '[Knowledge Base · Operational SOPs · How to ship samples]');
  const { chunks } = await chunkDocument(d, chunkParamsFor('kb_article'));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].content.includes('How to ship samples: the full SOP is at https://docs.example.com/sop-1'));
});

test('KB article with a body keeps the body and appends the link', () => {
  const d = kbExtractor.toDocument(kb({ body: '<p>Step one &amp; two.</p>', visibility: 'office' }), { isLatestVersion: true });
  assert.equal(d.sections[0].key, 'body');
  assert.ok(d.sections[0].text.startsWith('Step one & two.\n\nFull guide: https://docs.example.com/sop-1'));
});

test('one document per SOP: the linked SOP text becomes the KB article document, under the article ACL and URL', async () => {
  const row = kb({ submitted_by: '00000000-0000-4000-8000-0000000000u2', updated_at: '2026-01-01T00:00:00Z' });
  const ctx = { isLatestVersion: true, linkedDocs: [sopDoc({ updated_at: '2026-05-01T00:00:00Z' })] };
  const d = kbExtractor.toDocument(row, ctx);
  assert.deepEqual(d.acl, { mode: 'kb', roles: ['tl', 'ol'], users: [], authorId: row.created_by });
  assert.equal(d.metadata.visibility, 'role');
  assert.equal(d.metadata.submitted_by, row.submitted_by, 'kb_select also grants submitted_by');
  assert.deepEqual(d.metadata.sop_doc_ids, [sopDoc().id]);
  assert.equal(d.url, 'https://docs.example.com/sop-1');
  assert.equal(d.header, '[Knowledge Base · Operational SOPs · How to ship samples]');
  assert.deepEqual(d.sections.map((s) => [s.key, s.title]), [['sop', 'SOP']]);
  const text = d.sections[0].text;
  assert.ok(text.startsWith('SOP: Ship samples\nPurpose'), text);
  assert.ok(text.includes('Step 1: Pack the box.'));
  assert.ok(!text.includes('wurx-sop-import'), 'sentinel stripped');
  assert.ok(text.endsWith('\n\nFull guide: https://docs.example.com/sop-1\nTags: samples'));
  assert.equal(d.sourceUpdatedAt, '2026-05-01T00:00:00Z', 'newest of article and SOP');
  const { chunks } = await chunkDocument(d, chunkParamsFor('kb_article'));
  assert.ok(chunks.every((c) => !c.content.includes('the full SOP is at')), 'no pointer chunk when the text is here');
});

test('a split SOP (parts / sections) merges into one document, one section per part, in natural order', () => {
  const parts = ['BootCamp — SECTION 10: REPORTING', 'BootCamp — SECTION 3: TOOLS', 'BootCamp — 4 Limits'].map((t, i) =>
    sopDoc({ id: `00000000-0000-4000-8000-00000000000${i}`, title: t, content: `${t} text\n<!--wurx-sop-import-->` }));
  const d = kbExtractor.toDocument(kb({ title: 'BootCamp' }), { isLatestVersion: true, linkedDocs: parts });
  assert.deepEqual(d.sections.map((s) => s.title), ['4 Limits', 'SECTION 3: TOOLS', 'SECTION 10: REPORTING']);
  assert.deepEqual(d.sections.map((s) => s.key), ['sop:4-limits', 'sop:section-3-tools', 'sop:section-10-reporting']);
  assert.ok(d.sections[2].text.includes('Full guide: '), 'link once, at the end');
  assert.ok(!d.sections[0].text.includes('Full guide: '));

  const p = ['X (part 2)', 'X (part 1)'].map((t, i) => sopDoc({ id: `p${i}`, title: t }));
  assert.deepEqual(kbExtractor.toDocument(kb(), { isLatestVersion: true, linkedDocs: p }).sections.map((s) => s.title), ['Part 1', 'Part 2']);
});

test('merge ignores inactive docs and docs linked to another article; none left → pointer chunk', () => {
  const others = [sopDoc({ is_active: false }), sopDoc({ kb_article_id: 'another' })];
  const d = kbExtractor.toDocument(kb(), { isLatestVersion: true, linkedDocs: others });
  assert.deepEqual(d.sections.map((s) => s.key), ['pointer']);
  assert.deepEqual(d.metadata.sop_doc_ids, []);
});

test('imported SOP docs never index on their own: linked → merged, unlinked → fail closed', () => {
  assert.ok(!aiDocExtractor.indexable(sopDoc(), undefined));
  assert.equal(aiDocExtractor.skipReason!(sopDoc(), undefined), `merged into kb_article ${KB_ID}`);
  assert.throws(() => aiDocExtractor.toDocument(sopDoc(), undefined), /merged into kb_article .*refusing to index/);

  const orphan = sopDoc({ kb_article_id: null });
  assert.ok(!aiDocExtractor.indexable(orphan, undefined));
  assert.match(aiDocExtractor.skipReason!(orphan, undefined)!, /imported SOP not linked to a KB article.*fail closed/);
  assert.throws(() => aiDocExtractor.toDocument(orphan, undefined), /refusing to index/);

  // QA L7: inactive changes nothing: toDocument still refuses linked / imported text.
  assert.throws(() => aiDocExtractor.toDocument(sopDoc({ is_active: false }), undefined), /merged into kb_article .*refusing to index/);
  assert.throws(() => aiDocExtractor.toDocument(sopDoc({ is_active: false, kb_article_id: null }), undefined), /fail closed.*refusing to index/);
  assert.throws(() => appGuideExtractor.toDocument(sopDoc({ is_active: false, kind: 'app_guide' }), undefined), /refusing to index/);

  // a curated (non-imported) doc that someone linked by hand also merges
  assert.ok(!aiDocExtractor.indexable(sopDoc({ content: 'Plain guide.' }), undefined));
  assert.equal(aiDocExtractor.skipReason!(sopDoc({ is_active: false, kb_article_id: null, content: 'x' }), undefined), 'inactive');
});

test('unlinked curated doc (no sentinel) → indexable, acl all', () => {
  const row = sopDoc({ kb_article_id: null, content: '## Where\nOpen **Leave**.' });
  assert.ok(aiDocExtractor.indexable(row, undefined));
  assert.equal(aiDocExtractor.skipReason!(row, undefined), null);
  const d = aiDocExtractor.toDocument(row, undefined);
  assert.deepEqual(d.acl, { mode: 'all' });
  assert.ok(d.header.startsWith('[WurxOS guide · '));
});

test('KB skipReason explains unapproved and superseded rows', () => {
  assert.equal(kbExtractor.skipReason!(kb({ approval_status: 'pending' }), { isLatestVersion: true }), 'not approved (pending)');
  assert.equal(kbExtractor.skipReason!(kb(), { isLatestVersion: false }), 'superseded version');
  assert.equal(kbExtractor.skipReason!(kb(), { isLatestVersion: true }), null);
});

test('app guide: roles ACL from meta.roles, sections per ##, route as URL', () => {
  const row = sopDoc({
    kind: 'app_guide', kb_article_id: null, slug: 'leave', title: 'Leave',
    meta: { route: '/leave', roles: ['apc', 'tl'] },
    content: 'Intro line.\n## What this page is for\nAsk for time off.\n## How to apply\n1. Open Leave.\n2. Submit.',
  });
  assert.ok(appGuideExtractor.indexable(row, undefined));
  assert.ok(!aiDocExtractor.indexable(row, undefined), 'guides are not ai_doc');
  assert.equal(aiDocExtractor.skipReason!(row, undefined), 'kind app_guide is not doc');
  const d = appGuideExtractor.toDocument(row, undefined);
  assert.deepEqual(d.acl, { mode: 'roles', roles: ['apc', 'tl'] });
  assert.equal(d.url, '/leave');
  assert.deepEqual(d.sections.map((s) => [s.key, s.title]), [
    ['guide:intro', 'Overview'], ['guide:what-this-page-is-for', 'What this page is for'], ['guide:how-to-apply', 'How to apply'],
  ]);
  const open = appGuideExtractor.toDocument({ ...row, meta: { route: '/leave' } }, undefined);
  assert.deepEqual(open.acl, { mode: 'all' });
});

// Three real, public TikTok Shop Academy records.
const tts: TtsRow[] = JSON.parse(fs.readFileSync(new URL('./fixtures/tts-sample.json', import.meta.url), 'utf8'));

test('TikTok: header, acl all, URL, summary section, course breadcrumb', () => {
  const [essay, lesson] = tts;
  const d = ttsExtractor.toDocument(essay, undefined);
  assert.equal(d.header, `[TikTok Shop Academy · ${essay.breadcrumb} · ${essay.title}]`);
  assert.deepEqual(d.acl, { mode: 'all' });
  assert.equal(d.url, essay.url);
  assert.deepEqual(d.sections.map((s) => s.key), ['summary', 'body']);
  const l = ttsExtractor.toDocument({ ...lesson, breadcrumb: 'Something else' }, undefined);
  assert.ok(l.header.startsWith(`[TikTok Shop Academy · Courses > ${lesson.course!.name} · `));
  assert.ok(l.sections.find((s) => s.key === 'body')!.title.startsWith('Lesson '));
  assert.ok(!ttsExtractor.indexable({ ...essay, is_active: false }, undefined));
});

test('TikTok: toc headings become split points; long article stays under MAX and the cap', async () => {
  const long = tts[2];
  assert.ok(long.body.length > 12000);
  const marked = markHeadings(long.body, long.toc);
  assert.ok((marked.match(/^#{2,6} /gm) ?? []).length >= 4);
  const P = chunkParamsFor('tts_article');
  const d = ttsExtractor.toDocument(long, undefined);
  const r1 = await chunkDocument(d, P);
  const r2 = await chunkDocument(d, P);
  assert.deepEqual(r1, r2, 'deterministic');
  assert.ok(r1.chunks.length >= 5 && r1.chunks.length <= 40);
  for (const c of r1.chunks) {
    assert.ok(c.token_count <= P.max, `${c.token_count} > ${P.max}`);
    assert.ok(c.content.startsWith(d.header + '\n§ '));
  }
  // After the preamble, every chunk names its heading: in the § line, or as a "## " line in its text.
  for (const c of r1.chunks.slice(1)) {
    const lines = c.content.split('\n');
    assert.ok(/ › /.test(lines[1]) || lines.slice(2).some((l) => /^#{2,6} /.test(l)), `chunk ${c.chunk_index} has no heading`);
  }
});
