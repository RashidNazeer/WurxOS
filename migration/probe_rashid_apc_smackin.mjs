import { sb } from './lib/supabase.js';

// Fetch all client_access links + show share_types and a probe of
// what the RPC actually returns to the portal for each one.
const { data: links } = await sb
  .from('client_access')
  .select('id, token, client_name, label, share_types, brand_ids, created_at')
  .order('created_at', { ascending: false });

console.log(`${(links || []).length} client_access link(s)\n`);

for (const l of links || []) {
  console.log(`══ ${l.client_name || l.label || '(unnamed)'} ══`);
  console.log(`  share_types: ${JSON.stringify(l.share_types)}`);
  console.log(`  brand_ids:   ${l.brand_ids?.length || 0}`);

  // Probe — what does the RPC actually return?
  const { data: probe, error } = await sb.rpc('get_client_access', { p_token: l.token });
  if (error) { console.log(`  RPC error: ${error.message}`); continue; }
  const reports = probe?.reports || [];
  const byType = reports.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});
  console.log(`  reports returned by RPC: ${reports.length}`);
  for (const [t, n] of Object.entries(byType)) console.log(`    ${t}: ${n}`);
  console.log('');
}
