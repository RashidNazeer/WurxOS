import { supabase } from './supabase';

export async function listTaskComments(taskId) {
  const { data, error } = await supabase
    .from('task_comments')
    .select('*, author:author_id(id, display_name, role)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addTaskComment(taskId, body) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('task_comments')
    .insert({ task_id: taskId, author_id: me?.user?.id, body: body.trim() })
    .select('*, author:author_id(id, display_name, role)')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteTaskComment(id) {
  const { error } = await supabase.from('task_comments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export function subscribeToTaskComments(taskId, onChange) {
  const channel = supabase
    .channel(`task-comments-${taskId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'task_comments', filter: `task_id=eq.${taskId}` },
      onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
