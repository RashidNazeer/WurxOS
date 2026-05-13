// Check if "Solid Gold Pets" exists in v1 (Firebase) so we can confirm
// which environment the screenshot is from.

import { fbDb } from './lib/firebase.js';

const snap = await fbDb.collection('brands').where('brandName', '>=', 'Solid').where('brandName', '<', 'Solid~').get();
console.log(`v1 brands starting with "Solid": ${snap.size}`);
for (const d of snap.docs) {
  const b = d.data();
  console.log(`  "${b.brandName}"  status=${b.status}  apc=${b.assignedAPC || '—'}  tl=${b.ownerId || '—'}  id=${d.id}`);
}

// Also list any v1 user named Azan
const usersSnap = await fbDb.collection('users').where('firstName', '==', 'Azan').get();
console.log(`\nv1 users with firstName=Azan: ${usersSnap.size}`);
for (const d of usersSnap.docs) {
  const u = d.data();
  console.log(`  ${u.firstName} ${u.lastName}  ${u.email}  role=${u.role}  active=${u.isActive}  uid=${d.id}`);
}
