import { sb } from './lib/supabase.js';

// READ-ONLY. Tally each user's clock-in office and propose a shift_start_time.
// bahria  -> 4pm-12am -> 16:00 ; lakecity -> 6pm-2am -> 18:00.
// wfh / legacy 'office' carry no office signal -> excluded from the vote.

const OFFICE_START = { bahria: '16:00', lakecity: '18:00' };

// ---- profiles ----
const { data: profiles, error: pErr } = await sb
  .from('profiles')
  .select('id, display_name, role, is_active, shift_start_time');
if (pErr) throw pErr;
const byId = new Map(profiles.map(p => [p.id, p]));

// ---- attendance (paginate; PostgREST caps a page at 1000) ----
const counts = new Map(); // uid -> { bahria, lakecity, wfh, office, other }
let from = 0;
const PAGE = 1000;
let total = 0;
for (;;) {
  const { data, error } = await sb
    .from('attendance')
    .select('user_id, location')
    .range(from, from + PAGE - 1);
  if (error) throw error;
  if (!data.length) break;
  for (const r of data) {
    const c = counts.get(r.user_id) || { bahria: 0, lakecity: 0, wfh: 0, office: 0, other: 0 };
    if (r.location === 'bahria') c.bahria++;
    else if (r.location === 'lakecity') c.lakecity++;
    else if (r.location === 'wfh') c.wfh++;
    else if (r.location === 'office') c.office++;
    else c.other++;
    counts.set(r.user_id, c);
  }
  total += data.length;
  if (data.length < PAGE) break;
  from += PAGE;
}

console.log(`Total attendance rows scanned: ${total}\n`);

const rows = [];
for (const [uid, c] of counts) {
  const p = byId.get(uid);
  if (!p) continue;                      // orphan attendance (deleted user)
  const officeVote = c.bahria + c.lakecity;
  let winner = null;
  if (officeVote > 0) winner = c.lakecity > c.bahria ? 'lakecity'
                            : c.bahria > c.lakecity ? 'bahria'
                            : 'TIE';
  rows.push({
    name: p.display_name || '(no name)',
    role: p.role,
    active: p.is_active,
    current: p.shift_start_time ? String(p.shift_start_time).slice(0, 5) : '—',
    bahria: c.bahria, lakecity: c.lakecity, wfh: c.wfh, office: c.office, other: c.other,
    winner,
    proposed: winner && winner !== 'TIE' ? OFFICE_START[winner] : '—',
    uid,
  });
}

rows.sort((a, b) => (a.role || '').localeCompare(b.role || '') || a.name.localeCompare(b.name));

const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('Name', 22), pad('Role', 12), pad('Act', 4),
  pad('Bah', 5), pad('Lake', 5), pad('WFH', 5), pad('Off', 5), pad('Oth', 5),
  pad('Winner', 9), pad('Cur', 6), 'Propose',
);
console.log('-'.repeat(110));
for (const r of rows) {
  console.log(
    pad(r.name, 22), pad(r.role, 12), pad(r.active ? 'y' : 'n', 4),
    pad(r.bahria, 5), pad(r.lakecity, 5), pad(r.wfh, 5), pad(r.office, 5), pad(r.other, 5),
    pad(r.winner || '—', 9), pad(r.current, 6), r.proposed,
  );
}

// Summary
const settable = rows.filter(r => r.proposed !== '—');
const ties = rows.filter(r => r.winner === 'TIE');
const noOffice = rows.filter(r => !r.winner);
console.log(`\nWould set: ${settable.length}   Ties (skip): ${ties.length}   No office record (skip): ${noOffice.length}`);
if (ties.length) console.log('TIES:', ties.map(r => `${r.name}(${r.bahria}/${r.lakecity})`).join(', '));
if (noOffice.length) console.log('NO OFFICE:', noOffice.map(r => `${r.name}[wfh${r.wfh}/off${r.office}]`).join(', '));
