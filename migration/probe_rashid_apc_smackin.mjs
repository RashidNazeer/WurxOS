// Quick check: is Mushammir's auth.users record soft-deleted (login blocked)?
import { sb } from './lib/supabase.js';

const UID = '15f3cb0e-39f5-5eea-97e5-8b87d1040db0';

const { data, error } = await sb.auth.admin.getUserById(UID);
if (error) { console.error(error); process.exit(1); }
const u = data?.user;
if (!u) { console.log('No auth.users row — user truly gone.'); process.exit(0); }

console.log('auth.users state:');
console.log(`  id:           ${u.id}`);
console.log(`  email:        ${u.email}`);
console.log(`  created_at:   ${u.created_at}`);
console.log(`  banned_until: ${u.banned_until || '(not banned)'}`);
console.log(`  deleted_at:   ${u.deleted_at || '(NOT DELETED)'}`);
console.log(`  last_sign_in: ${u.last_sign_in_at || '(never)'}`);
console.log(`\nCan log in? ${u.deleted_at ? 'NO — soft-deleted' : 'YES — still active'}`);
