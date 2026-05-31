// One-off: apply user-confirmed hire-date matches that needed manual
// disambiguation. Hard-coded list per chat confirmation 2026-05-31.

import { sb } from './lib/supabase.js';

// Look up Azan Khan (not in the review file's top-3 candidates)
const { data: azan } = await sb
  .from('profiles')
  .select('id, display_name, role')
  .ilike('display_name', 'Azan Khan')
  .is('deleted_at', null)
  .maybeSingle();
if (!azan) { console.error('Azan Khan not found'); process.exit(1); }

const APPLY = [
  // Rashid Nazeer — developer account (the real one)
  { uid: '87f3419d-5c90-537e-b41e-e4097330d670', name: 'Rashid Nazeer (developer)',  date: '2025-02-10' },
  // Muhammad Azan Jahangir = Azan Khan (apc)
  { uid: azan.id,                                 name: `Azan Khan (${azan.role})`,    date: '2025-02-01' },
  // Muhammad Fahad Bin Tariq = Muhammd Fahad (ol)
  { uid: 'f9c7bfb1-cf20-505d-afec-d4a459354216', name: 'Muhammd Fahad (ol)',          date: '2025-07-01' },
  // Arslan Sabir = Muhammad Arslan (ol)
  { uid: '8896792c-42fd-59e7-bdc8-db20ac482ddc', name: 'Muhammad Arslan (ol)',        date: '2023-11-01' },
];

let ok = 0, err = 0;
for (const r of APPLY) {
  const { error } = await sb.rpc('set_user_hire_date', {
    p_uid: r.uid,
    p_hire_date: r.date,
  });
  if (error) { console.error(`  ✗ ${r.name}: ${error.message}`); err++; }
  else { console.log(`  ✓ ${r.name.padEnd(32)} ${r.date}`); ok++; }
}
console.log(`\nApplied: ${ok}  Errors: ${err}`);
