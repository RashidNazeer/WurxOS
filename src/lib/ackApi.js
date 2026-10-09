// Boss acknowledgements (mig 419): a message the Boss puts in front of one
// person, which blocks WurxOS until they acknowledge AND the Boss releases it.
//
// Every rule lives in the database (RLS + ack_acknowledge). Nothing here is a
// security boundary — this file only shapes what the screens need.
import { supabase } from './supabase';

const COLS = 'id, recipient_id, title, body, require_reply, reply_placeholder, active, '
  + 'created_at, acknowledged_at, reply_text, released_at';

/** The one message blocking me right now, or null. */
export async function getMyActiveMessage() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('ack_messages')
    .select(COLS)
    .eq('recipient_id', user.id)
    .eq('active', true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/** Record that I have read it. The message keeps blocking until the Boss releases it. */
export async function acknowledge(id, reply) {
  const { data, error } = await supabase.rpc('ack_acknowledge', {
    p_id: id,
    p_reply: reply ?? null,
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : data;
}

/** Everything the Boss has sent, newest first, with the recipient's name. */
export async function listMessages() {
  const { data, error } = await supabase
    .from('ack_messages')
    .select(`${COLS}, recipient:recipient_id(id, display_name, role)`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Send one. The database refuses a second ACTIVE message for the same person
 * (one unique index), so turn the old one off first and say so plainly.
 */
export async function sendMessage({ recipientId, title, body, requireReply, replyPlaceholder }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('ack_messages')
    .insert({
      recipient_id: recipientId,
      title: title?.trim() || null,
      body: body.trim(),
      require_reply: !!requireReply,
      reply_placeholder: requireReply ? (replyPlaceholder?.trim() || null) : null,
      created_by: user?.id ?? null,
    })
    .select(COLS)
    .single();
  if (error) {
    if (/ack_one_active_per_person/i.test(error.message)) {
      throw new Error('That person already has a message on screen. Turn it off first, then send a new one.');
    }
    throw new Error(error.message);
  }
  return data;
}

/** Let them back into WurxOS (active = false), or put the message back up. */
export async function setActive(id, active) {
  const patch = active
    ? { active: true, released_at: null, released_by: null }
    : { active: false, released_at: new Date().toISOString() };
  if (!active) {
    const { data: { user } } = await supabase.auth.getUser();
    patch.released_by = user?.id ?? null;
  }
  const { error } = await supabase.from('ack_messages').update(patch).eq('id', id);
  if (error) {
    if (/ack_one_active_per_person/i.test(error.message)) {
      throw new Error('That person already has another message on screen.');
    }
    throw new Error(error.message);
  }
}

/** How many people cannot use WurxOS right now. */
export async function lockedOutCount() {
  const { data, error } = await supabase.rpc('ack_locked_out');
  if (error) return 0;
  return data ?? 0;
}

/** People the Boss can send to — everyone active except the Boss. */
export async function listRecipients() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role')
    .eq('is_active', true)
    .is('deleted_at', null)
    .neq('role', 'boss')
    .order('display_name');
  if (error) throw new Error(error.message);
  return data || [];
}
