// Company holidays API — Boss can manage, everyone can read.
// Holidays count as "covered" in attendance scoring and are excluded
// from leave-day counts (so a leave overlapping Eid doesn't burn quota).

import { supabase } from './supabase';

function _pad(n) { return String(n).padStart(2, '0'); }

function _normalize(row) {
  if (!row) return row;
  return {
    id:         row.id,
    startDate:  row.start_date,
    endDate:    row.end_date,
    label:      row.label,
    notes:      row.notes,
    createdBy:  row.created_by,
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
    // snake_case mirrors for code that reads either shape
    start_date: row.start_date,
    end_date:   row.end_date,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// All holidays, newest start first. Use for the Boss management page.
export async function listAllHolidays() {
  const { data, error } = await supabase
    .from('company_holidays')
    .select('*')
    .order('start_date', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normalize);
}

// Holidays that overlap a date range (inclusive). Use for leave-form
// previews where we need to know which holidays a candidate leave
// would intersect.
export async function listHolidaysInRange(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const { data, error } = await supabase
    .from('company_holidays')
    .select('*')
    .lte('start_date', endDate)
    .gte('end_date',   startDate)
    .order('start_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(_normalize);
}

// Returns a Set of YYYY-MM-DD strings for every Mon-Fri date inside
// `monthStr` (YYYY-MM) that falls within any holiday range. Used by
// the attendance / performance math to credit users for holidays
// without requiring a clock-in. Weekend dates inside a holiday range
// are NOT in the set — weekends are already off and don't need
// further accounting.
export async function listHolidayDatesForMonth(monthStr) {
  if (!monthStr) return new Set();
  const [y, m] = monthStr.split('-').map(Number);
  if (!y || !m) return new Set();
  const lastDay = new Date(y, m, 0).getDate();
  const mStart = `${y}-${_pad(m)}-01`;
  const mEnd   = `${y}-${_pad(m)}-${_pad(lastDay)}`;

  const rows = await listHolidaysInRange(mStart, mEnd);
  const out = new Set();
  rows.forEach((h) => {
    const a = new Date(h.startDate + 'T00:00:00').getTime();
    const b = new Date(h.endDate   + 'T00:00:00').getTime();
    for (let t = a; t <= b; t += 86400000) {
      const d = new Date(t);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue;
      const ds = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
      if (ds < mStart || ds > mEnd) continue;
      out.add(ds);
    }
  });
  return out;
}

// Boss-only mutations. RLS rejects non-Boss callers at the row level
// so the UI doesn't need to gate these — failed inserts surface as
// a Supabase error.
export async function createHoliday({ startDate, endDate, label, notes }) {
  const { data, error } = await supabase
    .from('company_holidays')
    .insert({
      start_date: startDate,
      end_date:   endDate,
      label:      label?.trim(),
      notes:      notes?.trim() || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function updateHoliday(id, { startDate, endDate, label, notes }) {
  const patch = {};
  if (startDate !== undefined) patch.start_date = startDate;
  if (endDate   !== undefined) patch.end_date   = endDate;
  if (label     !== undefined) patch.label      = label?.trim();
  if (notes     !== undefined) patch.notes      = notes?.trim() || null;
  const { data, error } = await supabase
    .from('company_holidays')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function deleteHoliday(id) {
  const { error } = await supabase
    .from('company_holidays')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// Helper for the leave-form preview. Given a candidate leave range
// and the list of overlapping holidays, returns the structured
// breakdown: raw days, weekend count, holiday count (with labels),
// and net charged days.
export function analyzeLeaveRange(startDate, endDate, holidays) {
  const out = {
    calendarDays: 0,
    weekendDays:  0,
    holidayDays:  0,
    holidayLabels: [],
    actualDays:   0,
  };
  if (!startDate || !endDate) return out;
  const a = new Date(startDate + 'T00:00:00').getTime();
  const b = new Date(endDate   + 'T00:00:00').getTime();
  if (b < a) return out;

  const holidaySet = new Set();
  const usedLabels = new Set();
  (holidays || []).forEach((h) => {
    const ha = new Date(h.startDate + 'T00:00:00').getTime();
    const hb = new Date(h.endDate   + 'T00:00:00').getTime();
    for (let t = ha; t <= hb; t += 86400000) {
      const d = new Date(t);
      const ds = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
      holidaySet.add(ds);
    }
  });

  for (let t = a; t <= b; t += 86400000) {
    out.calendarDays += 1;
    const d = new Date(t);
    const dow = d.getDay();
    const ds  = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
    if (dow === 0 || dow === 6) {
      out.weekendDays += 1;
      continue;
    }
    if (holidaySet.has(ds)) {
      out.holidayDays += 1;
      // Tag the matching holiday's label for display.
      (holidays || []).forEach((h) => {
        if (ds >= h.startDate && ds <= h.endDate) usedLabels.add(h.label);
      });
      continue;
    }
    out.actualDays += 1;
  }
  out.holidayLabels = [...usedLabels];
  return out;
}
