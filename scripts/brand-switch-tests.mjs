// ============================================================
// Brand Switcher — preview rules (lib/brandSwitchRules.js).
//
//   node scripts/brand-switch-tests.mjs
//
// These rules MIRROR the SQL in migration 360. The preview is only worth
// showing if it computes what the database will actually do, so every rule
// here is asserted against the behaviour the SQL implements.
// ============================================================

import {
  permanentSameRole, swapPartner, assignReplaced, assignKept,
  assignOutcome, swapOutcome, SWITCH_ACTIONS,
} from '../src/lib/brandSwitchRules.js';

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const ids = (list) => (list || []).map((b) => b.id).sort().join(',');

// People. assignedAt drives "earliest"; expiresAt marks temporary cover.
const APC1 = { id: 'apc1', display_name: 'APC One',   role: 'apc', assignedAt: '2026-01-01T00:00:00Z', expiresAt: null };
const APC2 = { id: 'apc2', display_name: 'APC Two',   role: 'apc', assignedAt: '2026-02-01T00:00:00Z', expiresAt: null };
const APC3 = { id: 'apc3', display_name: 'APC Three', role: 'apc', assignedAt: '2026-03-01T00:00:00Z', expiresAt: null };
const IPC1 = { id: 'ipc1', display_name: 'IPC One',   role: 'ipc', assignedAt: '2025-06-01T00:00:00Z', expiresAt: null };
const COVER = { id: 'cov1', display_name: 'Cover APC', role: 'apc', assignedAt: '2025-12-01T00:00:00Z', expiresAt: '2026-09-30T00:00:00Z' };

const b1 = { id: 'b1', brand_name: 'Brand One' };
const b2 = { id: 'b2', brand_name: 'Brand Two' };
const b3 = { id: 'b3', brand_name: 'Brand Three' };

// ── 1 — THE EXAMPLE FROM THE REQUEST ─────────────────────────────────
// APC1 has b1, APC2 has b2.
//   assign b1 → APC2  ⇒  APC2 {b1, b2}, APC1 {}
//   swap   b1 → APC2  ⇒  APC2 {b1},     APC1 {b2}
{
  const onB1 = [APC1];
  const brandsByUser = { apc1: [b1], apc2: [b2] };

  const replaced = assignReplaced(onB1, APC2);
  const a = assignOutcome({ brand: b1, picked: APC2, replaced, brandsByUser });
  check('1. ASSIGN b1→APC2: APC2 ends with b1 AND b2', ids(a.target.after) === 'b1,b2', ids(a.target.after));
  check('1b. ASSIGN b1→APC2: APC1 ends empty', a.losers.length === 1 && a.losers[0].user.id === 'apc1'
    && a.losers[0].after.length === 0, JSON.stringify(a.losers.map((l) => [l.user.id, ids(l.after)])));

  const s = swapOutcome({ brand: b1, picked: APC2, partner: swapPartner(onB1, APC2), brandsByUser });
  check('1c. SWAP b1→APC2: APC2 ends with only b1', ids(s.target.after) === 'b1', ids(s.target.after));
  check('1d. SWAP b1→APC2: APC1 ends with b2', ids(s.partner.after) === 'b2', ids(s.partner.after));
  check('1e. the two actions genuinely differ on this input', ids(a.target.after) !== ids(s.target.after));
}

// ── 2 — Assign never touches the target's existing portfolio ─────────
{
  const brandsByUser = { apc1: [b1, b3], apc2: [b2] };
  const a = assignOutcome({ brand: b1, picked: APC2, replaced: [APC1], brandsByUser });
  check('2. the target keeps everything they had', a.target.before.every((b) => a.target.after.some((x) => x.id === b.id)));
  check('2b. the replaced APC loses ONLY this brand', ids(a.losers[0].after) === 'b3', ids(a.losers[0].after));
  check('2c. a swap on the same input would have moved b3 as well',
    ids(swapOutcome({ brand: b1, picked: APC2, partner: APC1, brandsByUser }).target.after) === 'b1,b3');
}

// ── 3 — Assign replaces the APC, never the IPC or the cover ──────────
// Since mig 359 IPCs hold brand_assignments rows, and can_view_brand reads
// that table — removing them silently revokes access to the brand.
{
  const onBrand = [IPC1, COVER, APC1];
  const replaced = assignReplaced(onBrand, APC2);
  const kept = assignKept(onBrand, APC2);
  check('3. only the permanent APC is replaced', replaced.map((u) => u.id).join(',') === 'apc1',
    replaced.map((u) => u.id).join(','));
  check('3b. the IPC is kept', kept.some((u) => u.id === 'ipc1'));
  check('3c. temporary cover is kept', kept.some((u) => u.id === 'cov1'));
  check('3d. nobody is both replaced and kept',
    !replaced.some((r) => kept.some((k) => k.id === r.id)));
  check('3e. the target is in neither list',
    !replaced.some((u) => u.id === 'apc2') && !kept.some((u) => u.id === 'apc2'));
}

// ── 4 — Swap picks the partner the way the database now does ─────────
// The modal used assignedUsers[0] from an UNORDERED embed, while the database
// took the earliest assignee of ANY role. Both are now: earliest PERMANENT
// assignee in the SAME ROLE as the target.
{
  // Deliberately out of order, with an older IPC and older cover in front.
  const onBrand = [APC3, IPC1, COVER, APC1];
  const p = swapPartner(onBrand, APC2);
  check('4. the partner is the earliest permanent APC, not array[0]', p?.id === 'apc1', p?.id);
  check('4b. an OLDER IPC is not picked as the swap partner', p?.id !== 'ipc1');
  check('4c. OLDER temporary cover is not picked as the swap partner', p?.id !== 'cov1');
  check('4d. input order does not change the answer',
    swapPartner([...onBrand].reverse(), APC2)?.id === 'apc1');

  // The regression this guards: after an Assign keeps an IPC that predates the
  // new APC, the next Swap must still pick the APC.
  const afterAssign = [IPC1, { ...APC2, assignedAt: '2026-09-01T00:00:00Z' }];
  check('4e. after an Assign keeps an older IPC, a later Swap still pairs APC with APC',
    swapPartner(afterAssign, APC3)?.id === 'apc2', swapPartner(afterAssign, APC3)?.id);
}

// ── 5 — Swap with nobody in the seat behaves like Assign ─────────────
{
  const brandsByUser = { apc2: [b2] };
  const s = swapOutcome({ brand: b1, picked: APC2, partner: swapPartner([], APC2), brandsByUser });
  const a = assignOutcome({ brand: b1, picked: APC2, replaced: [], brandsByUser });
  check('5. no partner → swap is flagged degenerate', s.degenerate === true && s.partner === null);
  check('5b. …and produces the same portfolio as an Assign', ids(s.target.after) === ids(a.target.after),
    `${ids(s.target.after)} vs ${ids(a.target.after)}`);
  check('5c. an IPC-only brand has no APC swap partner', swapPartner([IPC1], APC2) === null);
}

// ── 6 — Shared brands in a swap go to the target ─────────────────────
// brand_switch_apc skips, on the way back, any brand already moved forwards.
{
  const brandsByUser = { apc1: [b1, b3], apc2: [b2, b3] };
  const s = swapOutcome({ brand: b1, picked: APC2, partner: APC1, brandsByUser });
  check('6. a brand both hold ends up with the target', s.target.after.some((b) => b.id === 'b3'));
  check('6b. …and not with the partner', !s.partner.after.some((b) => b.id === 'b3'), ids(s.partner.after));
}

// ── 7 — Edge inputs never throw ──────────────────────────────────────
{
  let threw = null;
  try {
    permanentSameRole(null, APC2);
    permanentSameRole([APC1], null);
    assignKept(undefined, APC2);
    assignOutcome({ brand: b1, picked: APC2, replaced: undefined, brandsByUser: undefined });
    swapOutcome({ brand: b1, picked: APC2, partner: null, brandsByUser: undefined });
    swapPartner([{ ...APC1, assignedAt: 'not a date' }, APC3], APC2);
  } catch (e) { threw = e; }
  check('7. null / undefined / bad dates do not throw', threw === null, threw?.message);
  check('7b. a nonsense assignedAt sorts as earliest rather than breaking the sort',
    swapPartner([APC3, { ...APC1, assignedAt: 'not a date' }], APC2)?.id === 'apc1');
}

// ── 8 — Both actions are labelled, and Assign is described first ─────
{
  const keys = Object.keys(SWITCH_ACTIONS);
  check('8. exactly two actions are offered', keys.length === 2 && keys.includes('assign') && keys.includes('swap'));
  check('8b. assign is listed first (it is the default)', keys[0] === 'assign');
  check('8c. each carries a one-line consequence', keys.every((k) => SWITCH_ACTIONS[k].blurb.length > 20));
}

console.log('\nBrand Switcher — preview rules\n');
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
