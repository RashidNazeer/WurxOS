// Deterministic Firebase UID -> Supabase UUID mapper.
// UUIDv5 with a fixed namespace, so every step in this migration
// produces the same Supabase UUID for a given Firebase UID.
//
// Used by:
//   - Step 01: creating Supabase Auth accounts
//   - Step 02: profiles
//   - Step 03+: any column that holds a user reference (createdBy,
//     ownerId, assignedTo, senderId, etc.)

import { createHash } from 'node:crypto';

const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC 4122 DNS namespace
const NS_BYTES = Buffer.from(NS.replace(/-/g, ''), 'hex');

function v5(input) {
  if (!input || typeof input !== 'string') return null;
  const hash = createHash('sha1').update(NS_BYTES).update(input).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Used for Firebase Auth UIDs -> Supabase Auth UUIDs.
export const fbUidToUuid = v5;

// Used for any Firestore doc ID -> Supabase row UUID (brands, campaigns,
// kb_articles, attendance, tasks, etc.). Same algorithm; the function
// is exported under a different name for readability at call sites.
export const fbDocIdToUuid = v5;
