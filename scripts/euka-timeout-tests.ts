// Integration test for the Euka fetch machinery in euka-report-autofill.
//
// It does NOT reimplement anything: it reads the real source file, lifts the
// actual `makeBudget` / `eukaPost` text and the actual ATTEMPT_TIMEOUT_MS /
// TOTAL_BUDGET_MS constants out of it, writes them to a temp module, and runs
// THAT against a local server that can be fast, slow, hanging or flaky.
// So a failure here is a failure of the shipped code, not of a copy.
//
// Needs Deno (the edge-function runtime), which is not a project dependency:
//   npm run test:euka-timeouts      # uses npx deno, no install required
//
// Takes ~90s: two of the cases deliberately wait out a real timeout, because
// the whole point is that the waiting is now bounded.
const SRC = new URL('../supabase/functions/euka-report-autofill/index.ts', import.meta.url);
const src = await Deno.readTextFile(SRC);

// ── Lift the constants ───────────────────────────────────────────────
function constOf(name: string): number {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`));
  if (!m) throw new Error(`could not find ${name} in the source`);
  return Number(m[1].replace(/_/g, ''));
}
const ATTEMPT = constOf('ATTEMPT_TIMEOUT_MS');
const BUDGET = constOf('TOTAL_BUDGET_MS');

// ── Lift a whole function by brace matching ──────────────────────────
function lift(startMarker: string): string {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`could not find ${startMarker}`);
  let depth = 0, j = src.indexOf('{', i);
  const from = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(from, j + 1); }
  }
  throw new Error(`unbalanced braces after ${startMarker}`);
}
const makeBudgetSrc = lift('function makeBudget(');
const eukaPostSrc = lift('async function eukaPost(');

// ── Local stand-in for Euka ──────────────────────────────────────────
let flakyHits = 0;
const ac = new AbortController();
const server = Deno.serve(
  { port: 8787, signal: ac.signal, onListen: () => {} },
  async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/dashboard/fast') return Response.json({ totalShopGMV: 123 });
    if (path === '/dashboard/slow30') {
      await new Promise((r) => setTimeout(r, 30_000));
      return Response.json({ totalShopGMV: 456 });
    }
    if (path === '/dashboard/hang') { await new Promise(() => {}); return new Response(); }
    if (path === '/dashboard/flaky') {
      flakyHits++;
      if (flakyHits < 3) return new Response('upstream boom', { status: 500 });
      return Response.json({ totalShopGMV: 789 });
    }
    return new Response('nope', { status: 404 });
  },
);

// ── Build the module under test ──────────────────────────────────────
const mod = `
const EUKA_BASE = 'http://127.0.0.1:8787';
const ATTEMPT_TIMEOUT_MS = ${ATTEMPT};
type Budget = { left: () => number };
export ${makeBudgetSrc}
export ${eukaPostSrc}
`;
const modPath = new URL('./.euka-under-test.ts', import.meta.url);
await Deno.writeTextFile(modPath, mod);
const { eukaPost, makeBudget } = await import(modPath.href);

// ── Harness ──────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}
const secs = (ms: number) => (ms / 1000).toFixed(1) + 's';

console.log(`\nLifted from source: ATTEMPT_TIMEOUT_MS=${ATTEMPT} TOTAL_BUDGET_MS=${BUDGET}\n`);

// 1. A fast reply still works, and its time is recorded.
{
  const t: Record<string, number> = {};
  const t0 = Date.now();
  const r = await eukaPost('/dashboard/fast', {}, 'k', makeBudget(BUDGET), t);
  const el = Date.now() - t0;
  ok(r?.totalShopGMV === 123, '1. a fast reply returns its data');
  ok(typeof t['/dashboard/fast'] === 'number', '1b. the call is recorded in timings', `${t['/dashboard/fast']}ms`);
  ok(el < 2000, '1c. and it is not slowed down by the new code', secs(el));
}

// 2. THE POINT OF THE CHANGE: a slow-but-working Euka must SUCCEED.
//    30s used to be cut off by the 20s cap; it must now come back.
{
  const t: Record<string, number> = {};
  const t0 = Date.now();
  let r: any = null, threw: any = null;
  try { r = await eukaPost('/dashboard/slow30', {}, 'k', makeBudget(BUDGET), t); }
  catch (e) { threw = e; }
  const el = Date.now() - t0;
  ok(threw === null && r?.totalShopGMV === 456,
    '2. a 30s reply SUCCEEDS (would have been cut off at the old 20s cap)', secs(el));
  ok(el >= 29_000 && el < ATTEMPT, '2b. it waited for the real reply, inside the attempt cap', secs(el));
}

// 3. The budget governs: a hang cannot outlive it.
{
  const t: Record<string, number> = {};
  const t0 = Date.now();
  let threw: any = null;
  try { await eukaPost('/dashboard/hang', {}, 'k', makeBudget(6_000), t); }
  catch (e) { threw = e; }
  const el = Date.now() - t0;
  ok(threw !== null, '3. a hanging Euka throws instead of hanging forever');
  ok(threw?.timedOut === true, '3b. and is flagged timedOut, so the caller can say why');
  ok(el < 9_000, '3c. within the budget it was given, not the attempt cap', secs(el));
}

// 4. The real attempt cap aborts a hang at ATTEMPT_TIMEOUT_MS.
{
  const t: Record<string, number> = {};
  const t0 = Date.now();
  let threw: any = null;
  try { await eukaPost('/dashboard/hang', {}, 'k', makeBudget(ATTEMPT + 5_000), t); }
  catch (e) { threw = e; }
  const el = Date.now() - t0;
  ok(threw !== null, `4. a hang aborts at the ${ATTEMPT / 1000}s attempt cap`, secs(el));
  ok(el >= ATTEMPT - 2_000 && el < ATTEMPT + 8_000,
    '4b. at the cap — not instantly, and not forever', secs(el));
}

// 5. Retry and backoff still work for a genuinely flaky upstream.
{
  const t: Record<string, number> = {};
  flakyHits = 0;
  const t0 = Date.now();
  const r = await eukaPost('/dashboard/flaky', {}, 'k', makeBudget(BUDGET), t);
  const el = Date.now() - t0;
  ok(r?.totalShopGMV === 789, '5. two failures then success — retry survived the change', `${flakyHits} attempts`);
  ok(el >= 1_400, '5b. and it backed off between attempts', secs(el));
}

// 6. The label keeps the two performance-overview calls apart.
{
  const t: Record<string, number> = {};
  const b = makeBudget(BUDGET);
  await eukaPost('/dashboard/fast', {}, 'k', b, t);
  await eukaPost('/dashboard/fast', {}, 'k', b, t, 'performance-overview (MTD)');
  ok(Object.keys(t).length === 2,
    '6. a labelled call does not overwrite the unlabelled one', Object.keys(t).join(' + '));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
ac.abort();
await server.finished.catch(() => {});
await Deno.remove(modPath).catch(() => {});
Deno.exit(fail === 0 ? 0 : 1);
