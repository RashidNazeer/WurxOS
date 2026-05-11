import { sb } from './lib/supabase.js';

const { data, error } = await sb
  .from('app_events')
  .select('created_at, kind, detail, route, user_id, profiles:user_id(display_name, role)')
  .order('created_at', { ascending: false })
  .limit(80);

if (error) { console.error(error); process.exit(1); }

if (!data?.length) {
  console.log('No app_events rows yet.');
  process.exit(0);
}

const fmt = (d) => new Date(d).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', hour12: false });
for (const r of data) {
  const who = r.profiles?.display_name || r.user_id?.slice(0, 8) || '?';
  const role = r.profiles?.role || '';
  console.log(`${fmt(r.created_at)}  ${who.padEnd(28)} ${role.padEnd(5)} ${r.kind.padEnd(28)} ${r.route || ''}  ${JSON.stringify(r.detail)}`);
}
