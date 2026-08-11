// APC GMV-on-clock-in gate (mig 311). Before an APC clocks in they enter each
// active brand's month-to-date GMV; it overwrites that brand's gmv_achieved in
// Brand Analytics for the current month. Server computes today/month in PKT.
import { supabase } from './supabase';

// Called at APC clock-in. Returns whether the GMV gate is required plus what to
// collect. Shape: { needs_entry, month_key, range_start, range_end,
//                    submitted_today, role, today, brands: [{id,name,currency}] }
export async function apcGmvStatus() {
  const { data, error } = await supabase.rpc('apc_gmv_status');
  if (error) throw new Error(error.message);
  return data || { needs_entry: false };
}

// Submit per-brand MTD GMV. Overwrites each active brand's gmv_achieved for the
// month and logs the submission (once per PKT day; re-submit updates in place).
// entries: [{ brand_id, gmv }] (gmv is a Number).
export async function submitApcGmv({ monthKey, rangeStart, rangeEnd, entries }) {
  const { error } = await supabase.rpc('apc_submit_gmv', {
    p_month_key: monthKey,
    p_range_start: rangeStart,
    p_range_end: rangeEnd,
    p_entries: entries,
  });
  if (error) throw new Error(error.message);
}
