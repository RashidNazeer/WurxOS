import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import {
  getMyAchievement, acknowledgeAchievement, monthLabel, roleLabel,
} from '../../lib/achievementsApi';
import '../../styles/celebration.css';

// Mounted once in AppShell. Nothing renders until the signed-in user actually
// has an announced award waiting, so the cost when there is none is one RPC on
// load plus a realtime subscription.
//
// The winner may well have been somewhere else entirely when this was
// announced — the notification is the reach, and this is what greets them the
// moment they come back. It cannot be dismissed: no backdrop click, no ESC, no
// close button. Acknowledging is what tells the Boss the award landed, and it
// is the only thing that stops the announcement being repeatable.
export default function AchievementCelebration() {
  const { user } = useAuth();
  const uid = user?.id;
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(() => {
    if (!uid) return;
    getMyAchievement()
      .then((r) => setPending(r?.pending || null))
      .catch(() => { /* never let a celebration break the app shell */ });
  }, [uid]);

  useEffect(() => { refresh(); }, [refresh]);

  // Announced while they happen to be looking at the app: show it immediately
  // rather than on their next navigation.
  useEffect(() => {
    if (!uid) return undefined;
    const ch = supabase
      .channel(`ach-${uid}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'achievements', filter: `winner_id=eq.${uid}` },
        refresh)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [uid, refresh]);

  if (!pending) return null;   // scroll lock lives in CelebrationView below

  async function close() {
    setSaving(true); setErr('');
    try {
      await acknowledgeAchievement(pending.id);
      setPending(null);
    } catch (e) {
      // Staying open on failure is the right call: silently vanishing would
      // leave the Boss's screen saying the award was never seen.
      setErr(e.message || 'Could not save that — check your connection and try again.');
      setSaving(false);
    }
  }

  return <CelebrationView data={pending} onClose={close} saving={saving} error={err} />;
}

// The celebration itself, with no opinion about where its data came from.
// Split out so the Achievements page can show a Boss or OL exactly what the
// winner will see BEFORE anything is announced — they can never be winners
// themselves, so without this the only way to check the design would be to
// announce for real, which notifies a person and books money.
export function CelebrationView({ data, onClose, saving = false, error = '', preview = false }) {
  const confetti = useMemo(() => makeConfetti(), []);

  // The page behind must not scroll while this is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const messages = [
    { who: data.boss_name, role: data.boss_role, text: data.boss_message },
    { who: data.ol_name,   role: data.ol_role,   text: data.ol_message },
  ].filter((m) => m.text);

  const pending = data;
  const first = String(pending.winner_name || '').trim().split(/\s+/)[0] || 'you';

  return (
    <div className="cel-root" role="dialog" aria-modal="true" aria-labelledby="cel-title">
      <div className="cel-scrim" />
      <div className="cel-card">
        <div className="cel-confetti" aria-hidden="true">
          {confetti.map((c, i) => <span key={i} className="cel-piece" style={c} />)}
        </div>

        <div className="cel-trophy">
          <TrophyIcon />
        </div>

        <div className="cel-eyebrow">A moment worth celebrating</div>
        <h1 className="cel-title" id="cel-title">
          Congratulations, <span className="cel-name">{first}!</span>
        </h1>
        <p className="cel-sub">
          {pending.blurb || 'You set the standard this month, and it did not go unnoticed.'}
        </p>

        <div className="cel-facts">
          <div className="cel-fact">
            <div className="cel-fact-k">Achievement</div>
            <div className="cel-fact-v">{pending.type_label}</div>
          </div>
          {Number(pending.reward_amount) > 0 && (
            <div className="cel-fact">
              <div className="cel-fact-k">Reward</div>
              <div className="cel-fact-v is-gold">
                {Number(pending.reward_amount).toLocaleString()} PKR
              </div>
            </div>
          )}
          <div className="cel-fact">
            <div className="cel-fact-k">Month</div>
            <div className="cel-fact-v">{monthLabel(pending.month)}</div>
          </div>
        </div>

        {messages.length > 0 && (
          <div className="cel-messages">
            <div className="cel-messages-k">Messages from the team</div>
            {messages.map((m, i) => (
              <div className="cel-msg" key={i}>
                <div className="cel-avatar">{initials(m.who)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="cel-msg-who">{m.who || 'Management'}</div>
                  <div className="cel-msg-role">{roleLabel(m.role)}</div>
                  <div className="cel-msg-text">&ldquo;{m.text}&rdquo;</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ marginBottom: 14, fontSize: '0.8rem', color: 'var(--cel-gold)' }}>{error}</div>
        )}

        <button type="button" className="cel-btn" onClick={onClose} disabled={saving}>
          {saving ? 'One moment…' : preview ? 'Close preview' : 'Thank you — I’ll keep it up'}
        </button>
        {preview ? (
          <div className="cel-foot">
            Preview only — nothing has been announced. Toggle your theme to see it the other way.
          </div>
        ) : Number(pending.reward_amount) > 0 && (
          <div className="cel-foot">Your reward has been added to this month’s incentives.</div>
        )}
      </div>
    </div>
  );
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '★';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// Fixed palette rather than theme tokens — confetti is confetti in both modes.
const CONFETTI_COLORS = ['#f0b429', '#5fd8a4', '#ef8ea6', '#8ab4f8', '#f7f3e8', '#c9a227'];
function makeConfetti() {
  return Array.from({ length: 42 }, () => ({
    left: `${Math.random() * 100}%`,
    background: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    animationDuration: `${3.4 + Math.random() * 3.2}s`,
    animationDelay: `${Math.random() * 2.2}s`,
    transform: `rotate(${Math.random() * 360}deg)`,
    width: `${5 + Math.random() * 5}px`,
    height: `${9 + Math.random() * 8}px`,
    borderRadius: Math.random() > 0.7 ? '50%' : '2px',
  }));
}

function TrophyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M17 5h2.5a1.5 1.5 0 0 1 0 5H17M7 5H4.5a1.5 1.5 0 0 0 0 5H7" />
    </svg>
  );
}
