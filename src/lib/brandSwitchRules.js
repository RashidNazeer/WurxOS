// ============================================================
// Brand Switcher — the rules the preview shows, as pure functions.
//
// These MIRROR the SQL in migration 360 and must stay in step with it:
//   * swapPartner      ↔ brand_switch_apc's choice of the old APC
//   * assignReplaced   ↔ brand_assign_apc's v_replaced
//   * swapOutcome      ↔ brand_switch_apc's x_to_y / y_to_x
//   * assignOutcome    ↔ brand_assign_apc
//
// They live apart from brandsApi.js because that file imports the Supabase
// client, which throws without env vars — keeping these dependency-free is what
// lets scripts/brand-switch-tests.mjs exercise them in plain Node.
//
// Why a preview needs its own copy of the rule at all: the modal used to show
// `assignedUsers[0]` as the swap partner. That list comes from an embedded
// PostgREST select with NO ordering, while the database picked the
// earliest-assigned user. On a brand with two or more people the modal could
// preview one person's portfolio being swapped while the database swapped
// someone else's. The preview has to compute the same answer the database
// will, or it is decoration.
// ============================================================

const ts = (v) => {
  const n = v ? new Date(v).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
};

/**
 * The seat being filled: permanent assignees (no expires_at) in the SAME ROLE
 * as the target, excluding the target, earliest first.
 *
 * Same role, because assigning an APC replaces the brand's APC — not its IPC.
 * Permanent only, because a row with expires_at is time-boxed leave cover.
 */
export function permanentSameRole(assignedUsers, picked) {
  if (!picked) return [];
  return (assignedUsers || [])
    .filter((u) => u && u.id !== picked.id && !u.expiresAt && u.role === picked.role)
    .sort((a, b) => ts(a.assignedAt) - ts(b.assignedAt));
}

/** Who a Swap exchanges portfolios with, or null when the brand has nobody in that seat. */
export function swapPartner(assignedUsers, picked) {
  return permanentSameRole(assignedUsers, picked)[0] || null;
}

/** Who an Assign removes from this brand. Usually one person; never IPCs or cover. */
export function assignReplaced(assignedUsers, picked) {
  return permanentSameRole(assignedUsers, picked);
}

/** Everyone an Assign deliberately leaves on the brand (IPCs, temporary cover). */
export function assignKept(assignedUsers, picked) {
  const replaced = new Set(assignReplaced(assignedUsers, picked).map((u) => u.id));
  return (assignedUsers || []).filter((u) => u && u.id !== picked?.id && !replaced.has(u.id));
}

const byName = (a, b) => String(a?.brand_name || '').localeCompare(String(b?.brand_name || ''));
const uniqById = (list) => {
  const seen = new Set();
  return list.filter((b) => b && !seen.has(b.id) && seen.add(b.id));
};

/**
 * Portfolios after an Assign. brandsByUser: { [userId]: [{ id, brand_name }] }.
 *
 *   APC1 = {b1}, APC2 = {b2}, assign b1 → APC2  ⇒  APC2 {b1, b2}, APC1 {}
 */
export function assignOutcome({ brand, picked, replaced, brandsByUser }) {
  const map = brandsByUser || {};
  const targetBefore = map[picked.id] || [];
  return {
    target: {
      user: picked,
      before: targetBefore,
      after: uniqById([...targetBefore, brand]).sort(byName),
    },
    losers: (replaced || []).map((u) => {
      const before = map[u.id] || [];
      return { user: u, before, after: before.filter((b) => b.id !== brand.id) };
    }),
  };
}

/**
 * Portfolios after a Swap.
 *
 * brand_switch_apc moves EVERY brand the partner holds to the target, then
 * moves the target's brands to the partner — skipping any brand already moved
 * the first way, which is why a shared brand ends up with the target.
 *
 *   APC1 = {b1}, APC2 = {b2}, swap b1 → APC2  ⇒  APC2 {b1}, APC1 {b2}
 *
 * With no partner the database degenerates to moving just this one brand, so
 * the outcome is the same as an Assign — and the preview says so.
 */
export function swapOutcome({ brand, picked, partner, brandsByUser }) {
  const map = brandsByUser || {};
  if (!partner) {
    const out = assignOutcome({ brand, picked, replaced: [], brandsByUser: map });
    return { ...out, partner: null, degenerate: true };
  }
  const xBrands = map[partner.id] || [];
  const yBrands = map[picked.id] || [];
  const xIds = new Set(xBrands.map((b) => b.id));
  return {
    target: { user: picked, before: yBrands, after: [...xBrands].sort(byName) },
    partner: {
      user: partner,
      before: xBrands,
      after: yBrands.filter((b) => !xIds.has(b.id)).sort(byName),
    },
    degenerate: false,
  };
}

export const SWITCH_ACTIONS = {
  assign: {
    label: 'Assign only',
    blurb: 'Move this one brand. The new APC keeps every brand they already have.',
  },
  swap: {
    label: 'Swap portfolios',
    blurb: 'Both APCs exchange their whole book of brands.',
  },
};
