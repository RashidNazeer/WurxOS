import { useEffect, useMemo, useState } from 'react';
import {
  listMessages, listRecipients, sendMessage, setActive,
} from '../../../lib/ackApi';
import { AlertIcon, CheckIcon, ShieldIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

const ROLE_LABEL = {
  boss: 'Boss', ol: 'Operations Lead', tl: 'Team Lead', apc: 'APC',
  ipc: 'IPC', pctl: 'PCTL', ads_manager: 'Ads Manager', developer: 'Developer',
};

const LABEL = { fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 };
const CHIP = {
  fontSize: 11.5, color: 'var(--text-muted)', border: '1px solid var(--border-color)',
  borderRadius: 6, padding: '2px 7px',
};

const when = (iso) => (iso
  ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  : '');

// Boss only (mig 419). Sending one STOPS that person using WurxOS until it is
// switched off here — including clocking in — so the count of who is currently
// locked out sits at the top where it cannot be forgotten.
export default function AcknowledgementsSection() {
  const [people, setPeople]   = useState([]);
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const [ok, setOk]           = useState('');

  const [recipientId, setRecipientId] = useState('');
  const [title, setTitle]             = useState('');
  const [body, setBody]               = useState('');
  const [requireReply, setRequireReply]   = useState(false);
  const [placeholder, setPlaceholder]     = useState('Type your response…');

  async function refresh() {
    const [list, who] = await Promise.all([listMessages(), listRecipients()]);
    setRows(list);
    setPeople(who);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([listMessages(), listRecipients()])
      .then(([list, who]) => { if (!cancelled) { setRows(list); setPeople(who); } })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const lockedOut = useMemo(() => rows.filter((r) => r.active), [rows]);
  const lockedIds = useMemo(() => new Set(lockedOut.map((r) => r.recipient_id)), [lockedOut]);

  async function send(e) {
    e.preventDefault();
    setErr(''); setOk('');
    if (!recipientId) { setErr('Choose who this is for.'); return; }
    if (!body.trim())  { setErr('Write the message first.'); return; }
    setBusy(true);
    try {
      await sendMessage({ recipientId, title, body, requireReply, replyPlaceholder: placeholder });
      const name = people.find((p) => p.id === recipientId)?.display_name || 'them';
      setOk(`Sent. ${name} cannot use WurxOS until you switch it off below.`);
      setTitle(''); setBody('');
      await refresh();
      setTimeout(() => setOk(''), 6000);
    } catch (e2) { setErr(e2.message || 'Could not send.'); }
    finally { setBusy(false); }
  }

  async function toggle(row) {
    setErr(''); setOk(''); setBusy(true);
    try {
      await setActive(row.id, !row.active);
      await refresh();
    } catch (e2) { setErr(e2.message || 'Could not change that.'); }
    finally { setBusy(false); }
  }

  return (
    <SectionShell
      icon={ShieldIcon}
      title="Acknowledgements"
      subtitle="Put a message in front of one person. They cannot use WurxOS until they acknowledge it — and it stays on their screen until you switch it off here."
    >
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}
      {ok && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}>
          <CheckIcon width="14" height="14" /> <span>{ok}</span>
        </div>
      )}

      {lockedOut.length > 0 && (
        <div className="ack-locked-banner">
          <AlertIcon width="14" height="14" />
          <span>
            <strong>{lockedOut.length} {lockedOut.length === 1 ? 'person is' : 'people are'} locked out of WurxOS right now.</strong>
            {' '}They cannot clock in or submit anything until you switch their message off.
          </span>
        </div>
      )}

      <form onSubmit={send}>
        <div>
          <div style={LABEL}>Send to</div>
          <select
            id="ack-to"
            className="wx-input"
            value={recipientId}
            onChange={(e) => setRecipientId(e.target.value)}
            disabled={busy || loading}
          >
            <option value="">Choose a person…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name} — {ROLE_LABEL[p.role] || p.role}
                {lockedIds.has(p.id) ? ' (already has one)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={LABEL}>Title (optional)</div>
          <input
            id="ack-title"
            className="wx-input"
            value={title}
            maxLength={120}
            placeholder="e.g. Updated handover process"
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={LABEL}>Message</div>
          <textarea
            id="ack-body"
            className="wx-input"
            rows={6}
            value={body}
            placeholder="What do they need to confirm they've read?"
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            style={{ resize: 'vertical', lineHeight: 1.7 }}
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={requireReply}
            onChange={(e) => setRequireReply(e.target.checked)}
            disabled={busy}
          />
          Ask for a written reply before they can acknowledge
        </label>

        {requireReply && (
          <div style={{ marginTop: 10 }}>
            <div style={LABEL}>Placeholder shown to them</div>
            <input
              id="ack-ph"
              className="wx-input"
              value={placeholder}
              maxLength={120}
              onChange={(e) => setPlaceholder(e.target.value)}
              disabled={busy}
            />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              Their reply is saved and shown to you in the list below.
            </div>
          </div>
        )}

        <div className="settings-footer-actions">
          <button type="submit" className="wx-btn wx-btn-primary" disabled={busy || loading}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
      </form>

      <div style={{ marginTop: 26, borderTop: '1px solid var(--border-color)', paddingTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>Sent messages</strong>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {rows.length} total · {lockedOut.length} showing now
          </span>
        </div>

        {loading && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}><span className="wx-spinner" /> Loading…</div>}
        {!loading && rows.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
            Nothing sent yet.
          </div>
        )}

        {rows.map((r) => (
          <div className="ack-row" key={r.id}>
            <div className="ack-row-main">
              <div className="ack-row-who">
                <span className="ack-row-name">{r.recipient?.display_name || 'Unknown'}</span>
                <span style={CHIP}>{ROLE_LABEL[r.recipient?.role] || r.recipient?.role}</span>
                {r.acknowledged_at ? (
                  <span className="ack-status is-ack"><CheckIcon width="12" height="12" /> Acknowledged · {when(r.acknowledged_at)}</span>
                ) : (
                  <span className="ack-status is-wait"><span className="ack-dot" /> Not yet read</span>
                )}
              </div>
              {r.title && <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{r.title}</div>}
              <p className="ack-row-msg">{r.body}</p>
              {r.reply_text && <p className="ack-row-reply"><strong>Their reply:</strong> {r.reply_text}</p>}
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Sent {when(r.created_at)}
                {!r.active && r.released_at ? ` · switched off ${when(r.released_at)}` : ''}
              </div>
            </div>
            <button
              type="button"
              className={r.active ? 'wx-btn wx-btn-primary wx-btn-sm' : 'wx-btn wx-btn-ghost wx-btn-sm'}
              onClick={() => toggle(r)}
              disabled={busy}
              title={r.active ? 'Let them back into WurxOS' : 'Show this message again'}
            >
              {r.active ? 'Switch off' : 'Show again'}
            </button>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
