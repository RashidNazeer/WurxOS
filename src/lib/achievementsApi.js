import { supabase } from './supabase';

// --------------------------------------------------------------
// Achievements — "APC of the Month", "TL of the Month", and whatever
// gets added to achievement_types next (migration 353).
//
// Every mutation is an RPC. The table carries SELECT policies and no
// insert/update/delete policies at all, because announcing moves money: it
// writes a bonus onto the winner's incentive plan, and the rules that make
// that safe (who may write which message, both messages required, the reward
// booked exactly once) are not expressible as row policies.
// --------------------------------------------------------------

export async function listAchievementTypes() {
  const { data, error } = await supabase
    .from('achievement_types')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw new Error(error.message);
  return data || [];
}

// Every award for one month, keyed by type so the page can render a card per
// achievement whether or not it has been started yet.
export async function listAchievements(month) {
  const { data, error } = await supabase
    .from('achievements')
    .select(`*,
      winner:winner_id(id, display_name, avatar_url, role),
      bossAuthor:boss_message_by(display_name, role),
      olAuthor:ol_message_by(display_name, role),
      announcer:announced_by(display_name)`)
    .eq('month', month);
  if (error) throw new Error(error.message);
  const byType = {};
  (data || []).forEach((r) => { byType[r.type_key] = r; });
  return byType;
}

// Eligible people ranked by their composite score for the month — a
// suggestion, not a decision. The Boss/OL can pick anyone eligible.
export async function listCandidates(typeKey, month) {
  const { data, error } = await supabase.rpc('achievement_candidates', {
    p_type_key: typeKey, p_month: month,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function saveAchievement({ typeKey, month, winnerId, reward }) {
  const { data, error } = await supabase.rpc('achievement_upsert', {
    p_type_key: typeKey, p_month: month,
    p_winner_id: winnerId || null,
    p_reward: Number(reward) || 0,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Writes the caller's OWN message — the server decides which slot from the
// caller's role, so there is no way to sign a line as someone else.
export async function saveAchievementMessage(id, message) {
  const { data, error } = await supabase.rpc('achievement_set_message', {
    p_id: id, p_message: message ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Fires the celebration. Safe to call again while the winner has not yet
// acknowledged (they may have missed the notification) — the reward is booked
// once and only once.
export async function announceAchievement(id) {
  const { data, error } = await supabase.rpc('achievement_announce', { p_id: id });
  if (error) throw new Error(error.message);
  return data;
}

export async function acknowledgeAchievement(id) {
  const { data, error } = await supabase.rpc('achievement_acknowledge', { p_id: id });
  if (error) throw new Error(error.message);
  return data;
}

// { pending, banner } for the signed-in user: the celebration they still owe an
// acknowledgement, and the lingering line for the clock-in widget.
export async function getMyAchievement() {
  const { data, error } = await supabase.rpc('achievement_for_me');
  if (error) throw new Error(error.message);
  return data || { pending: null, banner: null };
}

export function monthLabel(month) {
  if (!month) return '';
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

// "Boss" / "OL" rather than the raw role string, for the popup bylines.
export function roleLabel(role) {
  if (role === 'boss') return 'Founder';
  if (role === 'ol') return 'Operations Lead';
  if (role === 'developer') return 'Developer';
  if (role === 'tl') return 'Team Lead';
  return '';
}
