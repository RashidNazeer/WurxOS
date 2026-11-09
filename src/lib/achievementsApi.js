import { supabase } from './supabase';

// --------------------------------------------------------------
// Achievements — "APC of the Month", "TL of the Month", and whatever
// gets added to achievement_types next (migration 353).
//
// Every mutation is an RPC. The table carries SELECT policies and no
// insert/update/delete policies at all, because announcing moves money: it
// writes a bonus onto the winner's incentive plan, and the rules that make
// that safe (a winner and a message before announcing, an eligible role, the
// reward booked exactly once) are not expressible as row policies.
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
    // Left empty -> null -> the award's standard reward (mig 433); an explicit 0 stays 0.
    p_reward: reward === '' || reward == null ? null : Number(reward) || 0,
  });
  if (error) throw new Error(error.message);
  return data;
}

// The one message on the award (mig 354). Either the Boss or an OL writes it —
// whoever gets to it — and the winner sees it with no name attached, so there
// is no slot to pick and the last edit wins.
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

// The caller's own chance of APC / TL of the Month (mig 445). `incPct` is an optional
// what-if: the share of incentive goals completed (0-100). Null when the caller is not an
// APC/TL or the month is in the future.
export async function getAchievementOdds(month, incPct = null) {
  const { data, error } = await supabase.rpc('achievement_odds', {
    p_month: month, p_inc_pct: incPct == null ? null : incPct,
  });
  if (error) throw new Error(error.message);
  const r = data?.[0];
  if (!r) return null;
  return {
    pool: r.pool, eligible: r.eligible, reason: r.reason,
    score: r.score == null ? null : Number(r.score),
    probability: r.probability == null ? null : Number(r.probability),
    rank: r.rank, poolSize: r.pool_size, provisional: r.provisional,
    focusPillar: r.focus_pillar, focusGap: r.focus_gap == null ? null : Number(r.focus_gap),
  };
}

// The uplifting line shown right after clock-in (APC / TL). Tone follows how close the person
// is to the top; null when there is no chance to quote (not rated yet, too few people, ...).
export function oddsClockInMessage(odds) {
  if (!odds || !odds.eligible || odds.probability == null) return null;
  const title = odds.pool === 'tl' ? 'TL of the Month' : 'APC of the Month';
  const p = odds.probability;
  if (p >= 40) return `You're leading the race: ${p}% chance to become ${title}. Keep that streak going! 🏆`;
  if (p >= 20) return `${p}% chance to become ${title}. You're right in the mix, and today can move it! 🚀`;
  if (p >= 8) return `You have a ${p}% chance of becoming ${title}. Every goal you finish today pushes it higher! 💪`;
  return `You have a ${p}% chance of becoming ${title}, and the month is still open. Small wins today add up! 🌟`;
}
