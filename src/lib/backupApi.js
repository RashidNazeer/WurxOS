import { supabase } from './supabase';

// Boss-only. Calls the export_all_data() RPC (SECURITY DEFINER, Boss-gated)
// which returns a complete { meta, data } snapshot of every business table,
// bypassing RLS so nothing is silently filtered out. Also stamps
// app_config.last_backup_at server-side. See migration 219.
export async function exportAllData() {
  const { data, error } = await supabase.rpc('export_all_data');
  if (error) throw new Error(error.message || 'Failed to export data.');
  return data; // { meta: {...}, data: { table_name: [rows...] } }
}

// Reads the last-backup timestamp for the reminder line. Boss can SELECT
// app_config (RLS). Returns an ISO string or null if never backed up.
export async function getLastBackupAt() {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'last_backup_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value || null;
}

// Turn a snapshot object into a downloaded JSON file. Browsers cannot choose
// the folder, so it lands in the user's Downloads. Filename is date-stamped.
export function downloadBackup(snapshot, dateStamp) {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wurxos-backup-${dateStamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename: a.download, bytes: blob.size };
}
