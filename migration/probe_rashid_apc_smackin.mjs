// Complete the APC Rashid deletion: my Jun 2 script soft-deleted the
// profile but skipped admin.auth.admin.deleteUser. Without that step
// the user can still sign in with the apc credentials and reach a
// zombie state (profile.deleted_at set, but session valid).
import { sb } from './lib/supabase.js';

const APC = '3582f4f1-e018-507d-af98-8ae206320c5e';

// 1. Confirm pre-state
const { data: pre } = await sb.auth.admin.getUserById(APC);
console.log('Pre:', { email: pre.user?.email, deleted_at: pre.user?.deleted_at || '(active)' });

// 2. Soft-delete the auth user (shouldSoftDelete=true → keeps the row,
//    sets deleted_at, blocks sign-in)
const { error: delErr } = await sb.auth.admin.deleteUser(APC, true);
if (delErr) { console.error('deleteUser failed:', delErr); process.exit(1); }
console.log('  ✓ auth.users.deleted_at set');

// 3. Force-logout any open session by bumping profile updated_at
//    so the AuthContext realtime UPDATE listener (which checks
//    deleted_at/is_active on every UPDATE payload) fires and triggers
//    sessionInvalid → SessionExpiredModal in the active tab.
const { error: tErr } = await sb
  .from('profiles')
  .update({ updated_at: new Date().toISOString() })
  .eq('id', APC);
if (tErr) console.warn('profile touch warning:', tErr.message);
else console.log('  ✓ profile UPDATE fired (forces logout of active session)');

// 4. Confirm post-state
const { data: post } = await sb.auth.admin.getUserById(APC);
console.log('Post:', { email: post.user?.email, deleted_at: post.user?.deleted_at || '(active)' });
console.log(`\nCan log in? ${post.user?.deleted_at ? 'NO — properly soft-deleted' : 'YES — something failed'}`);
