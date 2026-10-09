import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyActiveMessage, acknowledge } from '../../lib/ackApi';
import { useAuth } from '../../contexts/AuthContext';

// The Boss's acknowledgement, in front of everything (mig 419).
//
// It must be unescapable, so this is not a normal modal:
//   * rendered OVER the whole shell, not inside a page;
//   * no close button, no backdrop click, Escape does nothing;
//   * focus is held inside it, so tabbing cannot reach the app behind;
//   * body scroll is locked.
// None of that is the real boundary — a determined person can delete a DOM
// node. The boundary is that the row stays `active` in the database until the
// Boss releases it, so the message is back on the next request either way.
//
// After acknowledging it STAYS (the Owner's rule): the button becomes a quiet
// "thank you" and the person still cannot pass. The line underneath says why,
// so nobody thinks the app has frozen.
export default function AckGate({ children }) {
  const { profile } = useAuth();
  const qc = useQueryClient();

  const { data: message } = useQuery({
    queryKey: ['ack', 'mine', profile?.id],
    queryFn: getMyActiveMessage,
    enabled: !!profile?.id,
    // The Boss releases it from another screen, so poll rather than make
    // someone sit there refreshing. One minute is responsive enough and costs
    // a single indexed row read.
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const [reply, setReply]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');
  const dialogRef = useRef(null);
  const acknowledged = !!message?.acknowledged_at;

  // Hold focus and kill scrolling while it is up.
  useEffect(() => {
    if (!message) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => {
      const target = dialogRef.current?.querySelector('input, button');
      target?.focus();
    }, 50);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey, true);
      clearTimeout(t);
    };
  }, [message?.id, message]);

  const submit = useCallback(async () => {
    if (!message || saving) return;
    setErr(''); setSaving(true);
    try {
      await acknowledge(message.id, message.require_reply ? reply : null);
      await qc.invalidateQueries({ queryKey: ['ack', 'mine'] });
    } catch (e) {
      setErr(e.message || 'Could not record that. Try again.');
    } finally {
      setSaving(false);
    }
  }, [message, reply, saving, qc]);

  if (!message) return children;

  const canSubmit = !saving && (!message.require_reply || reply.trim().length > 0);
  const sentAt = new Date(message.created_at).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });

  return (
    <>
      {children}
      <div className="ack-backdrop" role="presentation">
        <section
          className="ack-dialog"
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="ack-title"
          aria-describedby="ack-body"
        >
          <div className="ack-sender">
            <span className="ack-avatar" aria-hidden="true">RN</span>
            <div>
              <div className="ack-sender-name">Message from the Boss</div>
              <div className="ack-time">{sentAt}</div>
            </div>
          </div>

          {message.title && <h3 id="ack-title" className="ack-heading">{message.title}</h3>}
          <p id="ack-body" className="ack-message">{message.body}</p>

          {err && <div className="ack-error" role="alert">{err}</div>}

          {!acknowledged && message.require_reply && (
            <>
              <label className="ack-label" htmlFor="ack-reply">Your response</label>
              <input
                id="ack-reply"
                className="ack-input"
                value={reply}
                autoComplete="off"
                placeholder={message.reply_placeholder || 'Type your response…'}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
                disabled={saving}
              />
            </>
          )}

          {acknowledged ? (
            <>
              <div className="ack-done" role="status">Thanks — your acknowledgement was recorded.</div>
              <p className="ack-receipt">
                This stays on screen until the Boss closes it.
              </p>
            </>
          ) : (
            <>
              <button type="button" className="ack-button" onClick={submit} disabled={!canSubmit}>
                {saving ? 'Saving…' : 'I acknowledge'}
              </button>
              <p className="ack-receipt">
                {message.require_reply
                  ? 'Your response will be shared with the Boss.'
                  : 'Your acknowledgement will be shared with the Boss.'}
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
