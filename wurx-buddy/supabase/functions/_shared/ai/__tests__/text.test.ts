import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanValue, decodeEntities, estimateTokens, htmlToText, humanize, isPlaceholder, normalizeText, stripSentinel, toEmbedText,
} from '../text.ts';
import { docHash, sha256Hex, stableStringify } from '../hash.ts';
import { DEFAULT_CONFIG, chunkParamsFor, withOverrides } from '../config.ts';

test('htmlToText: bullets, headings and breaks on their own lines', () => {
  const t = htmlToText('<p>Intro</p><h2>Plan</h2><ul><li>One</li><li>Two</li></ul>Line<br/>Next<br>Last');
  assert.equal(t, 'Intro\n\nPlan\n\n• One\n• Two\nLine\nNext\nLast');
});

test('htmlToText: entities decoded once, plain text with < and > untouched', () => {
  assert.equal(htmlToText('<p>A &amp; B &lt;tag&gt; &#8211; &#x2014; &rsquo;s&nbsp;x</p>'), "A & B <tag> – — 's x");
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(htmlToText('ROI < 2 and > 1'), 'ROI < 2 and > 1');
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
});

test('normalizeText: zero-width, nbsp, CRLF, blank-line runs and the SOP sentinel', () => {
  const s = 'a​b  c\r\n\r\n\r\n\r\nd  \n<!--wurx-sop-import-->\ne';
  assert.equal(normalizeText(s), 'ab c\n\nd\ne');
  assert.equal(stripSentinel('<!--wurx-sop-import-->\nBody'), 'Body');
  assert.ok(!htmlToText('<p>x</p><!--wurx-sop-import-->').includes('wurx'));
});

test('toEmbedText collapses whitespace and caps at EMBED_MAX_TOKENS', () => {
  assert.equal(toEmbedText('a\n\n b\tc', 10), 'a b c');
  assert.equal(toEmbedText('x'.repeat(100), 10).length, 40);
});

test('estimateTokens = ceil(chars / 4)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
});

test('placeholders are empty values', () => {
  for (const v of ['', '  ', 'N/A', 'Null', 'Not_Available_yet', null, undefined]) assert.ok(isPlaceholder(v), String(v));
  assert.ok(!isPlaceholder('0'));
  assert.equal(cleanValue(' <b>12.50</b> '), '12.50');
  assert.equal(cleanValue({}), '');
});

test('humanize', () => {
  assert.equal(humanize('shopPerformanceScore'), 'Shop performance score');
  assert.equal(humanize('operational_sops'), 'Operational SOPs');
  assert.equal(humanize('affiliateGmv'), 'Affiliate GMV');
});

test('sha256Hex known vector; stableStringify ignores key order', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('docHash ignores sourceUpdatedAt but not content, pipeline version or model', async () => {
  const doc = { title: 't', acl: { mode: 'all' as const }, metadata: {}, header: '[h]', sections: [], sourceUpdatedAt: '1' };
  const h = await docHash(doc, 'p1', 'm');
  assert.equal(await docHash({ ...doc, sourceUpdatedAt: '2' }, 'p1', 'm'), h);
  assert.notEqual(await docHash({ ...doc, title: 'u' }, 'p1', 'm'), h);
  assert.notEqual(await docHash(doc, 'p1', 'm2'), h);
  assert.notEqual(await docHash(doc, 'p2', 'm'), h);
});

test('config: per-source params and ⚙-only overrides', () => {
  assert.deepEqual(chunkParamsFor('report'), { target: 450, max: 700, overlap: 60, min: 40 });
  assert.deepEqual(chunkParamsFor('tts_article'), { target: 600, max: 750, overlap: 90, min: 60 });
  assert.deepEqual(chunkParamsFor('unknown'), { target: 450, max: 700, overlap: 50, min: 30 });
  const { config, ignored } = withOverrides({ TOP_K: 12, RERANK_ENABLED: true, EF_SEARCH: -5, MAX_CHUNKS_PER_DOC: 99, RRF_K: '60', nope: 1 });
  assert.equal(config.TOP_K, 12);
  assert.equal(config.RERANK_ENABLED, true);
  assert.equal(config.EF_SEARCH, DEFAULT_CONFIG.EF_SEARCH);
  assert.equal(config.MAX_CHUNKS_PER_DOC, 40);
  assert.deepEqual(ignored.sort(), ['EF_SEARCH', 'MAX_CHUNKS_PER_DOC', 'RRF_K', 'nope']);
  assert.equal(DEFAULT_CONFIG.TOP_K, 8, 'defaults are never mutated');
  assert.deepEqual(withOverrides(null).ignored, []);
});
