// ============================================================
// Monthly salary sheet for the OL: one CSV row per employee for a closed month.
//
// "Calculated salary" is the same figure the Incentives page calls payout:
// basic salary + incentives earned + bonuses earned (a line counts only once it
// is completed). It reads the plan stored for that month, so a salary change
// made later never rewrites a month that is already over. The Boss draws no
// salary and is never listed.
// ============================================================
import { supabase } from './supabase';
import { karachiMonth } from './serverTime';
import { listIncentivesMonth, calcBreakdown } from './incentivesApi';

const ROLES = ['apc', 'ipc', 'tl', 'pctl', 'ol', 'ads_manager'];
const ROLE_LABEL = {
  apc: 'APC', ipc: 'IPC', tl: 'Team Lead', pctl: 'Team Lead', ol: 'Operation Lead', ads_manager: 'Ads Manager',
};

/** 'YYYY-MM' of the month before `month` (default: the current Karachi month). */
export function previousMonth(month = karachiMonth()) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const money = (n) => (Number(n) || 0).toFixed(2);
const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const SALARY_CSV_HEADERS = [
  'Employee', 'Role', 'Email', 'Month', 'Basic Salary (PKR)', 'Incentives Earned (PKR)', 'Bonuses Earned (PKR)',
  'Total Salary (PKR)', 'Incentives Potential (PKR)', 'Bonuses Potential (PKR)', 'Verified by OL', 'Payout Cleared', 'Note',
];

/**
 * `people`  [{ id, name, role, email }]   everyone who should appear
 * `records` userId -> normalised incentives row for the month (may be missing)
 */
export function buildSalaryCsv({ month, people, records }) {
  const lines = [SALARY_CSV_HEADERS.join(',')];
  let tBasic = 0, tInc = 0, tBon = 0, tTotal = 0;
  const sorted = [...people].sort((a, b) =>
    (ROLES.indexOf(a.role) - ROLES.indexOf(b.role)) || String(a.name).localeCompare(String(b.name)));
  for (const p of sorted) {
    const r = records[p.id];
    const head = [p.name, ROLE_LABEL[p.role] || p.role, p.email, month];
    if (!r) {
      lines.push([...head, '', '', '', '', '', '', '', '', 'No incentive plan for this month'].map(cell).join(','));
      continue;
    }
    const b = calcBreakdown(r);
    tBasic += b.basic; tInc += b.incAchieved; tBon += b.bonAchieved; tTotal += b.total;
    lines.push([
      ...head, money(b.basic), money(b.incAchieved), money(b.bonAchieved), money(b.total),
      money(b.incTotal), money(b.bonTotal), r.verified ? 'Yes' : 'No', r.payoutCleared ? 'Yes' : 'No',
      r.verified ? '' : 'Not yet verified by OL',
    ].map(cell).join(','));
  }
  lines.push(['TOTAL', '', '', month, money(tBasic), money(tInc), money(tBon), money(tTotal), '', '', '', '', ''].map(cell).join(','));
  // BOM so Excel reads names and the PKR figures as UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Fetch the month's plans + roster and download the CSV. Returns the row count. */
export async function downloadSalaryCsv(month = previousMonth()) {
  const [{ data: profs, error }, recs] = await Promise.all([
    supabase.from('profiles').select('id, display_name, email, role')
      .in('role', ROLES).eq('is_active', true).is('deleted_at', null),
    listIncentivesMonth(month),
  ]);
  if (error) throw new Error(error.message);
  const records = {};
  for (const r of recs) if (r.userId && ROLES.includes(r.userRole)) records[r.userId] = r;
  if (!profs?.length) throw new Error('No employees were returned. You may not have permission to read the team list.');
  if (!recs.length) throw new Error(`There are no incentive plans for ${month}, so there are no salaries to calculate. Nothing was downloaded.`);
  const people = (profs || []).map((p) => ({ id: p.id, name: p.display_name, role: p.role, email: p.email }));
  const csv = buildSalaryCsv({ month, people, records });

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `Salaries ${month}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return people.length;
}
