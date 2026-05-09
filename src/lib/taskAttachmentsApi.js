import { supabase } from './supabase';

const BUCKET = 'task-attachments';
const MAX_MB = 10;

export async function listTaskAttachments(taskId) {
  const { data, error } = await supabase
    .from('task_attachments')
    .select('*, uploader:uploader_id(display_name)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function uploadTaskAttachment(taskId, file) {
  if (file.size > MAX_MB * 1024 * 1024) throw new Error(`File must be ≤ ${MAX_MB} MB.`);
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in.');

  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
  const path = `${taskId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const up = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600', contentType: file.type || 'application/octet-stream',
  });
  if (up.error) throw new Error(up.error.message);

  const { data, error } = await supabase
    .from('task_attachments')
    .insert({
      task_id: taskId,
      uploader_id: uid,
      file_name: file.name,
      file_path: path,
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
    })
    .select('*, uploader:uploader_id(display_name)')
    .single();
  if (error) {
    // Roll back the orphaned blob if DB insert fails
    await supabase.storage.from(BUCKET).remove([path]);
    throw new Error(error.message);
  }
  return data;
}

export async function deleteTaskAttachment(row) {
  // Delete the DB row first; if it fails we don't orphan the blob.
  const { error } = await supabase.from('task_attachments').delete().eq('id', row.id);
  if (error) throw new Error(error.message);
  await supabase.storage.from(BUCKET).remove([row.file_path]);
}

export async function attachmentUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
