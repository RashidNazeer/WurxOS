import { sb } from './lib/supabase.js';

const { data } = await sb
  .from('attendance_edit_requests')
  .select('id, user_id, status, field, requested, created_at, profiles:user_id(display_name, role, reports_to)')
  .eq('status', 'pending')
  .order('created_at', { ascending: false })
  .limit(20);
console.log(`${data?.length || 0} pending edit requests:`);
for (const r of (data || [])) {
  const p = r.profiles;
  const { data: tl } = p?.reports_to
    ? await sb.from('profiles').select('display_name, role').eq('id', p.reports_to).maybeSingle()
    : { data: null };
  console.log(`  ${r.created_at}  ${p?.display_name} (${p?.role}) → ${r.field}=${r.requested}`);
  console.log(`    reports_to=${tl?.display_name || p?.reports_to || '(none)'}`);
}
