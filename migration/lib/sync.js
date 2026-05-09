// Shared sync helpers for v1→v2 idempotent re-sync.
//
// Pattern each step follows:
//   1. Fetch v1 docs
//   2. Build rows with legacy_id = <firestore doc id>
//   3. upsertWithLegacy(table, rows) — writes both id (uuidv5) and legacy_id
//   4. deleteOrphans(table, currentLegacyIds) — drops v2 rows whose
//      legacy_id is set but no longer matches a current v1 doc.
//      Rows with legacy_id = NULL (v2-native) are never touched.

import { sb } from './supabase.js';

/**
 * Upsert rows that already include `legacy_id`, in chunks. Returns
 * total count written (or throws). Pass an existing logger.
 */
export async function upsertChunked(table, rows, log, { chunk = 100, onConflict = 'id' } = {}) {
  if (!rows.length) {
    log.info(`${table}: nothing to upsert.`);
    return 0;
  }
  let ok = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await sb.from(table).upsert(slice, { onConflict });
    if (error) {
      log.error(`${table} chunk ${i / chunk}: ${error.message}`);
      throw new Error(error.message);
    }
    ok += slice.length;
  }
  log.info(`${table}: upserted ${ok}.`);
  return ok;
}

/**
 * Delete rows in `table` whose legacy_id is set but no longer
 * appears in `currentV1Ids`. Rows with legacy_id = NULL (v2-native)
 * are NEVER touched. Returns count deleted.
 *
 * `currentV1Ids` is the set of Firestore doc IDs that currently
 * exist in v1 and should be preserved.
 */
export async function deleteOrphans(table, currentV1Ids, log) {
  // Pull every v2 row's (id, legacy_id) where legacy_id is set
  const { data: existing, error } = await sb
    .from(table)
    .select('id, legacy_id')
    .not('legacy_id', 'is', null);
  if (error) {
    log.error(`${table} orphan-scan failed: ${error.message}`);
    throw new Error(error.message);
  }

  const keepSet = new Set(currentV1Ids);
  const orphans = (existing || []).filter((r) => !keepSet.has(r.legacy_id));
  if (!orphans.length) {
    log.info(`${table}: no orphans to delete.`);
    return 0;
  }

  log.info(`${table}: deleting ${orphans.length} orphan(s) (in v2 with legacy_id, no longer in v1).`);
  // Delete in chunks to keep PostgREST URL length reasonable
  const ids = orphans.map((r) => r.id);
  let removed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const { error: de } = await sb.from(table).delete().in('id', slice);
    if (de) {
      log.error(`${table} delete chunk failed: ${de.message}`);
      throw new Error(de.message);
    }
    removed += slice.length;
  }
  log.info(`${table}: removed ${removed} orphan(s).`);
  return removed;
}

/** Convenience: combine upsert + orphan delete in one call. */
export async function syncTable(table, rows, currentV1Ids, log, opts = {}) {
  await upsertChunked(table, rows, log, opts);
  return deleteOrphans(table, currentV1Ids, log);
}
