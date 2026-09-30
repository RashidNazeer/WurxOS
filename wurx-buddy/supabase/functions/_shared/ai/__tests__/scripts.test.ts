// Pure helpers of the dev scripts (scripts/*.mjs): the dev-DB guard, the SQL
// runner's transaction-control check, and the SOP → KB matcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain .mjs, no types
import { checkDevUrl, findTxControl, stripBom } from '../../../../../scripts/dev-env.mjs';
// @ts-ignore: plain .mjs, no types
import { linkIds, matchSops, normTitle } from '../../../../../scripts/sop-match.mjs';

const DEV = 'abcdefghijklmnopqrst';
const PROD = 'xoaaidgvblondjpvxjqp';

test('dev guard: accepts the pooler and direct dev URLs only', () => {
  assert.equal(checkDevUrl(`postgresql://postgres.${DEV}:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`, DEV), null);
  assert.equal(checkDevUrl(`postgresql://postgres:pw@db.${DEV}.supabase.co:5432/postgres`, DEV), null);
  const refused = [
    `postgresql://postgres.${PROD}:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,   // prod pooler user
    `postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres?x=${DEV}`,                   // dev ref only in a param
    `postgresql://postgres:${DEV}@10.0.0.1:5432/postgres`,                                        // dev ref only in the password
    `postgresql://postgres.${DEV}:pw@evil.example.com:6543/postgres`,                            // right user, wrong host
    `postgresql://postgres:pw@/postgres?host=db.${DEV}.supabase.co`,                             // no host (PGHOST fallback)
    `postgresql://postgres.${DEV}:pw@aws-0.pooler.supabase.com:6543/postgres?host=db.${PROD}.supabase.co`, // host override
    'not a url',
    `mysql://postgres:pw@db.${DEV}.supabase.co/x`,
  ];
  for (const u of refused) assert.notEqual(checkDevUrl(u, DEV), null, u);
  assert.match(checkDevUrl(`postgresql://postgres:pw@db.${PROD}.supabase.co/postgres`, PROD)!, /PRODUCTION/);
  assert.notEqual(checkDevUrl(`postgresql://postgres:pw@db.${DEV}.supabase.co/postgres`, ''), null);
});

test('sql runner: finds top-level transaction control, ignores bodies, strings and comments', () => {
  assert.deepEqual(findTxControl('select 1; commit; select 2;'), ['commit']);
  assert.deepEqual(findTxControl('BEGIN;\nselect 1;\nEND;'), ['BEGIN', 'END']);
  assert.deepEqual(findTxControl('rollback; start transaction; abort'), ['rollback', 'start transaction', 'abort']);
  assert.deepEqual(findTxControl('﻿commit;'), ['commit'], 'BOM stripped first');
  const clean = `
    -- commit; in a comment
    /* rollback; */
    select 'commit; begin;' as s;
    do $$ begin perform 1; exception when others then null; end $$;
    create function f() returns void language plpgsql as $fn$ begin commit; end; $fn$;
    savepoint a; rollback to savepoint a; release savepoint a;
    select 1 as "end";`;
  assert.deepEqual(findTxControl(clean), []);
  assert.equal(stripBom('﻿select 1'), 'select 1');
});

const kbRows = [
  { id: 'k1', title: 'SOP: How to audit a brand', url: 'https://docs.google.com/document/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit', visibility: 'office' },
  { id: 'k2', title: 'BootCamp Master Doc', url: 'https://drive.google.com/file/d/1BBBBBBBBBBBBBBBBBBBBBBB/view' },
  { id: 'k3', title: 'Leave & WFH Policy', url: 'https://www.loom.com/share/0123456789abcdef0123456789abcdef' },
  { id: 'k4', title: 'Change Management - Wurx OS', url: null },
  { id: 'k5a', title: 'Shipping', url: null, sop_group_id: 'g', version: 1 },
  { id: 'k5b', title: 'Shipping', url: null, sop_group_id: 'g', version: 2 },
  { id: 'k6', title: 'Twin', url: null }, { id: 'k7', title: 'Twin', url: null },
];
const S = '\n<!--wurx-sop-import-->';
const doc = (title: string, content = `body${S}`) => ({ id: title, title, content, is_active: true, kb_article_id: null });

test('SOP matcher: exact, part, section, url id and version group are high; ambiguity and fuzz are medium', () => {
  const res = matchSops([
    doc('sop how to AUDIT a brand'),                       // normalised exact
    doc('SOP: How to audit a brand (part 2)'),            // part split
    doc('BootCamp Master Doc — SECTION 3: TOOLS'),        // section split
    doc('Something else', `see https://www.loom.com/share/0123456789abcdef0123456789abcdef ${S}`),  // url id
    doc('Shipping'),                                      // two versions of one SOP → latest
    doc('Twin'),                                          // two unrelated articles → medium
    doc('Leave and WFH policy draft'),                    // fuzzy
    doc('Change Management'),                             // " - " is not the import separator; fuzzy at best
    doc('Totally unrelated title'),
    { ...doc('Curated guide'), content: 'no sentinel' },  // not an imported SOP: ignored
  ], kbRows);
  const by = Object.fromEntries(res.map((r: any) => [r.doc.title, [r.kb?.id ?? null, r.method, r.confidence]]));
  assert.equal(res.length, 9);
  assert.deepEqual(by['sop how to AUDIT a brand'], ['k1', 'title_exact', 'high']);
  assert.deepEqual(by['SOP: How to audit a brand (part 2)'], ['k1', 'title_part', 'high']);
  assert.deepEqual(by['BootCamp Master Doc — SECTION 3: TOOLS'], ['k2', 'title_section', 'high']);
  assert.deepEqual(by['Something else'], ['k3', 'url_id', 'high']);
  assert.deepEqual(by['Shipping'], ['k5b', 'title_exact', 'high']);
  assert.deepEqual(by['Twin'].slice(1), ['title_exact_ambiguous', 'medium']);
  assert.deepEqual(by['Leave and WFH policy draft'], ['k3', 'title_fuzzy', 'medium']);
  assert.notEqual(by['Change Management'][2], 'high');
  assert.equal(by['Totally unrelated title'][2], 'none');
});

test('SOP matcher helpers', () => {
  assert.equal(normTitle('SOP: Leave & WFH  Policy!'), 'leave and wfh policy');
  assert.deepEqual(linkIds('https://docs.google.com/spreadsheets/d/1Y8tDYFIE3dZh9BT2RaXTPHG8EKMNyjhl6fg1ZkZeYAA/edit?u'),
    ['g:1Y8tDYFIE3dZh9BT2RaXTPHG8EKMNyjhl6fg1ZkZeYAA']);
  assert.deepEqual(linkIds('https://drive.google.com/open?id=1V7SSjP_FjKklB-ilpa412ZigV9YvIS1_'), ['g:1V7SSjP_FjKklB-ilpa412ZigV9YvIS1_']);
  assert.deepEqual(linkIds(null), []);
});
