import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAchievementTypes, listAchievements, listCandidates,
  saveAchievement, saveAchievementMessage, announceAchievement,
  monthLabel,
} from '../../lib/achievementsApi';
import { AlertIcon, CheckIcon, StarIcon } from '../../components/common/Icon';
import { CelebrationView } from '../../components/achievements/AchievementCelebration';

const MAX_MSG = 100;

// Award months run behind the calendar: you crown August's winner in
// September. So the page opens on LAST month, which is the one that actually
// needs doing.
function karachiMonth(offset = 0) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
}

export default function AchievementsPage() {
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => karachiMonth(-1));

  const { data: types = [], isLoading: typesLoading } = useQuery({
    queryKey: ['achievement-types'],
    queryFn: listAchievementTypes,
    staleTime: 5 * 60_000,
  });
  const { data: byType = {}, isLoading, error } = useQuery({
    queryKey: ['achievements', month],
    queryFn: () => listAchievements(month),
  });

  const reload = () => qc.invalidateQueries({ queryKey: ['achievements', month] });
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => karachiMonth(-i)),
    [],
  );

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Achievements</h1>
          <p className="page-subtitle">
            Pick each month&rsquo;s winners, write them a line, set the reward, then announce.
            The winner gets a full-screen celebration they have to acknowledge — and the
            reward is added to their incentives for this month.
          </p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Award month</span>
          <select className="wx-input" value={month} onChange={(e) => setMonth(e.target.value)}
            style={{ minWidth: 170 }}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error.message}</span>
        </div>
      )}

      {(isLoading || typesLoading) ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
          {types.map((t) => (
            <AchievementCard
              key={t.key}
              type={t}
              month={month}
              record={byType[t.key] || null}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </>
  );
}

function AchievementCard({ type, month, record, onChanged }) {
  const announced = record?.status === 'announced';
  const seen = record?.status === 'acknowledged';
  const locked = announced || seen;

  const [winnerId, setWinnerId] = useState(record?.winner_id || '');
  const [reward, setReward] = useState(record?.reward_amount ?? '');
  const [msg, setMsg] = useState(record?.message || '');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // A different month (or the other manager's save) replaces the record
  // underneath us; the form must follow it rather than keep stale text.
  useEffect(() => {
    setWinnerId(record?.winner_id || '');
    setReward(record?.reward_amount ?? '');
    setMsg(record?.message || '');
    setErr('');
  }, [record?.id, record?.status, record?.winner_id, record?.reward_amount, record?.message]);

  const { data: candidates = [] } = useQuery({
    queryKey: ['achievement-candidates', type.key, month],
    queryFn: () => listCandidates(type.key, month),
    enabled: !locked,
    staleTime: 60_000,
  });
  const top = candidates[0];

  async function run(label, fn) {
    setBusy(label); setErr('');
    try { await fn(); onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  }

  const saveWinner = (id, amount) => run('winner', () =>
    saveAchievement({ typeKey: type.key, month, winnerId: id, reward: amount }));

  const canAnnounce = !!record?.winner_id && !!record?.message;

  // Exactly what the winner will see, from whatever has been filled in so far.
  // Neither a Boss nor an OL can ever win an award themselves, so without this
  // the only way to check the celebration would be to announce it for real.
  const [previewing, setPreviewing] = useState(false);
  const previewData = record && {
    ...record,
    type_label:   type.label,
    blurb:        type.blurb,
    winner_name:  record.winner?.display_name || 'Your winner',
  };

  return (
    <div className="wx-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'color-mix(in srgb, var(--warning) 15%, transparent)', color: 'var(--warning)' }}>
          <StarIcon width="17" height="17" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{type.label}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{monthLabel(month)}</div>
        </div>
        <StatusPill record={record} />
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ margin: 0 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {/* ── Winner ─────────────────────────────────────────────────── */}
      <div>
        <FieldLabel>Winner</FieldLabel>
        {locked ? (
          <div style={{ fontWeight: 700, fontSize: 14 }}>{record?.winner?.display_name || '—'}</div>
        ) : (
          <>
            <select className="wx-input" value={winnerId} disabled={busy === 'winner'}
              onChange={(e) => { setWinnerId(e.target.value); saveWinner(e.target.value || null, reward); }}
              style={{ width: '100%' }}>
              <option value="">Nobody chosen yet</option>
              {candidates.map((c) => (
                <option key={c.user_id} value={c.user_id}>
                  {c.display_name}{c.composite_score != null ? ` · ${Math.round(c.composite_score)}` : ' · not rated'}
                </option>
              ))}
            </select>
            {/* A suggestion, never a decision — the Boss's words. */}
            {top && !winnerId && top.composite_score != null && (
              <button type="button" className="wx-btn wx-btn-ghost"
                style={{ marginTop: 6, fontSize: 12 }}
                onClick={() => { setWinnerId(top.user_id); saveWinner(top.user_id, reward); }}>
                Top scorer this month: {top.display_name} ({Math.round(top.composite_score)}) — use this
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Reward ─────────────────────────────────────────────────── */}
      <div>
        <FieldLabel>Reward (PKR)</FieldLabel>
        {locked ? (
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            {Number(record?.reward_amount || 0).toLocaleString()}
            {record?.incentive_month && (
              <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 8 }}>
                added to {monthLabel(record.incentive_month)} incentives
              </span>
            )}
          </div>
        ) : (
          <input type="number" min="0" step="500" className="wx-input" style={{ width: '100%' }}
            value={reward} placeholder="e.g. 10000"
            onChange={(e) => setReward(e.target.value)}
            onBlur={() => saveWinner(winnerId || null, reward)}
            disabled={busy === 'winner'} />
        )}
      </div>

      {/* ── The message — one line, either of you, shown unattributed ── */}
      <div>
        <FieldLabel>
          Message to the winner
          {!locked && (
            <span style={{ float: 'right', fontWeight: 400, color: msg.length > MAX_MSG ? 'var(--danger)' : 'var(--text-muted)' }}>
              {msg.length}/{MAX_MSG}
            </span>
          )}
        </FieldLabel>
        {locked ? (
          <Quote text={record?.message} />
        ) : (
          <>
            <textarea className="wx-input" rows={2} maxLength={MAX_MSG} value={msg}
              placeholder="Say what they did, in one line."
              onChange={(e) => setMsg(e.target.value)}
              disabled={!record?.id || busy === 'msg'}
              style={{ width: '100%', resize: 'vertical' }} />
            <button type="button" className="wx-btn wx-btn-ghost" style={{ marginTop: 6, fontSize: 12 }}
              disabled={!record?.id || busy === 'msg' || msg === (record?.message || '')}
              onClick={() => run('msg', () => saveAchievementMessage(record.id, msg))}>
              {busy === 'msg' ? 'Saving…' : 'Save message'}
            </button>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
              {record?.id
                ? 'The Boss or an OL can write this — whoever gets to it. The winner sees it without a name attached.'
                : 'Pick a winner first.'}
            </div>
          </>
        )}
      </div>

      {previewing && previewData && (
        <CelebrationView data={previewData} preview onClose={() => setPreviewing(false)} />
      )}

      {/* ── Announce ───────────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
        {record?.winner_id && (
          <button type="button" className="wx-btn wx-btn-ghost"
            style={{ width: '100%', marginBottom: 8 }}
            onClick={() => setPreviewing(true)}>
            Preview what the winner sees
          </button>
        )}
        {seen ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--success)' }}>
            <CheckIcon width="14" height="14" />
            <span>
              Seen by {record?.winner?.display_name?.split(' ')[0] || 'the winner'} on{' '}
              {new Date(record.acknowledged_at).toLocaleDateString()} — this one is done.
            </span>
          </div>
        ) : (
          <>
            <button className="wx-btn wx-btn-primary" style={{ width: '100%' }}
              disabled={!canAnnounce || busy === 'ann'}
              onClick={() => run('ann', () => announceAchievement(record.id))}>
              {busy === 'ann' ? 'Announcing…' : announced ? 'Announce again' : 'Announce'}
            </button>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, textAlign: 'center' }}>
              {announced
                ? `Announced — waiting for ${record?.winner?.display_name?.split(' ')[0] || 'them'} to open it. Announcing again just re-sends the notification; the reward is only ever paid once.`
                : canAnnounce
                  ? 'Fires the celebration and adds the reward to this month’s incentives.'
                  : 'Needs a winner and a message.'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ record }) {
  const map = {
    announced:    { t: 'Announced', c: 'var(--warning)' },
    acknowledged: { t: 'Seen',      c: 'var(--success)' },
  };
  const s = map[record?.status] || { t: record?.winner_id ? 'Draft' : 'Not started', c: 'var(--text-muted)' };
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap',
      color: s.c,
      background: `color-mix(in srgb, ${s.c} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${s.c} 30%, transparent)`,
    }}>{s.t}</span>
  );
}

function FieldLabel({ children }) {
  return (
    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase',
      letterSpacing: '0.06em', fontWeight: 700, marginBottom: 5 }}>
      {children}
    </div>
  );
}

function Quote({ text, who }) {
  if (!text) return <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>—</div>;
  return (
    <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--text-secondary)',
      borderLeft: '2px solid var(--border-default)', paddingLeft: 10 }}>
      &ldquo;{text}&rdquo;
      {who && <div style={{ fontStyle: 'normal', fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>— {who}</div>}
    </div>
  );
}
