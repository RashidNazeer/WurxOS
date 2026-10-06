// Incentives extractor: one document per public.incentives row (employee ×
// month). Indexes the PLAN — each incentive/bonus goal's text, target, amount
// and what it is linked to — so "what are Ali's goals for September?" or "who
// has a GMV Max bonus on Bentgo?" retrieve it.
//
// Never indexed: achievedValue / completed / completedAt / completedBy. They are
// derived live by read-time overlays (attendance %, OL-brands %, GMV Max,
// commission tier; see ai-chat and src/lib/incentivesApi.js), so a stored copy
// is stale by design. A commission_tier amount is derived too (FX), and basic
// salary is never indexed at all. Every section says to use the incentives tool.
//
// verified / payout_cleared are volatile: metadata only, so verifying or paying
// a month rewrites one document row and no chunk.
//
// ACL 'incentive' mirrors the app's inc_select policy (mig 213): the employee,
// Boss, active OL, or the employee's manager (reports_to).

import { cleanValue, humanize } from '../text.ts';
import type { DocSection, ExtractedDoc, Extractor } from '../types.ts';

export type IncentiveItem = {
  id?: string;
  text?: string | null;
  amount?: number | string | null;
  targetValue?: number | string | null;
  suffix?: string | null;
  source?: string | null;          // null (manual) | attendance | gmv_max | commission_tier | ol_brands
  brandId?: string | null;
  brandName?: string | null;
  commissionPct?: number | string | null;
  [k: string]: unknown;
};

export type IncentiveRow = {
  id: string;
  user_id: string;
  month: string;                   // "YYYY-MM"
  incentives: IncentiveItem[] | null;
  bonuses: IncentiveItem[] | null;
  verified?: boolean | null;
  payout_cleared?: boolean | null;
  updated_at?: string | null;
};

export type IncentiveCtx = {
  person?: { name?: string | null; role?: string | null } | null;
  brandNames?: Record<string, string> | null;   // live names for the items' brandIds
};

// Derived at read time: stripped here AND in SQL (ai_incentive_items, mig 373).
export const INCENTIVE_DERIVED_KEYS = ['achievedValue', 'completed', 'completedAt', 'completedBy', '_commissionInfo'] as const;

const ROLE: Record<string, string> = {
  apc: 'APC', tl: 'TL', pctl: 'PCTL', ipc: 'IPC', ol: 'OL', boss: 'Boss', developer: 'Developer', ads_manager: 'Ads manager',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(m: string): string {
  const x = /^(\d{4})-(\d{2})$/.exec(String(m ?? ''));
  return x && +x[2] >= 1 && +x[2] <= 12 ? `${MONTHS[+x[2] - 1]} ${x[1]}` : String(m ?? '');
}

// Deterministic in Node and Deno (no locale data): PKR 12,500.00
export function pkr(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const [i, f] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}PKR ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : cleanValue(String(v)));

function linkLabel(it: IncentiveItem, brand: string): string {
  switch (it.source) {
    case 'attendance': return 'linked to: monthly attendance %';
    case 'ol_brands': return "linked to: % of the OL's curated brands whose GMV goal was met";
    case 'gmv_max': return `linked to: GMV Max result${brand ? ` of ${brand}` : ''}`;
    case 'commission_tier': return `commission on ${brand ? `${brand} ` : ''}GMV above the benchmark`;
    default: return it.source ? `linked to: ${humanize(String(it.source))}` : '';
  }
}

export function goalLine(it: IncentiveItem, brandNames: Record<string, string> = {}): string {
  const brand = cleanValue((it.brandId && brandNames[it.brandId]) || it.brandName);
  const sfx = cleanValue(it.suffix);
  const target = num(it.targetValue);
  const parts = [`Goal: ${cleanValue(it.text) || 'Untitled goal'}`];
  if (it.source === 'commission_tier') {
    if (target) parts.push(`benchmark: ${target}${sfx}`);
    const pct = num(it.commissionPct);
    if (pct) parts.push(`commission: ${pct}%`);
    parts.push('amount: computed from the commission at payout');
  } else {
    if (target) parts.push(`target: ${target}${sfx}`);
    const amt = pkr(it.amount);
    if (amt) parts.push(`amount: ${amt}`);
  }
  const link = linkLabel(it, brand);
  if (link) parts.push(link);
  if (brand && it.source !== 'gmv_max' && it.source !== 'commission_tier') parts.push(`brand: ${brand}`);
  return `- ${parts.join('; ')}`;
}

const items = (v: unknown): IncentiveItem[] =>
  (Array.isArray(v) ? v : []).filter((x): x is IncentiveItem => !!x && typeof x === 'object' && !Array.isArray(x));

const TOOL_NOTE = '- Current progress and payout: use the incentives tool (achieved values and completion are computed live).';

export const incentiveExtractor: Extractor<IncentiveRow, IncentiveCtx | undefined> = {
  sourceType: 'incentive',

  skipReason: (row) => (items(row.incentives).length + items(row.bonuses).length ? null : 'no goals'),
  indexable: (row) => items(row.incentives).length + items(row.bonuses).length > 0,

  toDocument(row, ctx) {
    const name = cleanValue(ctx?.person?.name) || 'Unknown employee';
    const roleKey = cleanValue(ctx?.person?.role).toLowerCase();
    const role = ROLE[roleKey] ?? (roleKey ? humanize(roleKey) : '');
    const who = role ? `${name} (${role})` : name;
    const month = monthLabel(row.month);
    const brands = ctx?.brandNames ?? {};

    const sections: DocSection[] = [];
    for (const [key, title, list] of [['incentives', 'Incentive goals', items(row.incentives)], ['bonuses', 'Bonus goals', items(row.bonuses)]] as const) {
      if (!list.length) continue;
      sections.push({ key, title, kind: 'table', text: [...list.map((it) => goalLine(it, brands)), TOOL_NOTE].join('\n') });
    }

    return {
      title: `Incentive plan · ${name} · ${month}`,
      url: '/incentives',
      acl: { mode: 'incentive', authorId: row.user_id },
      metadata: {
        incentive_id: row.id,
        user_id: row.user_id,
        person_name: name,
        role: roleKey || null,
        month: row.month,
        verified: !!row.verified,
        payout_cleared: !!row.payout_cleared,
        goals: items(row.incentives).length,
        bonuses: items(row.bonuses).length,
      },
      header: `[Incentive plan · ${who} · ${month}]`,
      sections,
      sourceUpdatedAt: row.updated_at ?? undefined,
    };
  },
};
