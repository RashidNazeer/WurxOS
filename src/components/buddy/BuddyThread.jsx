import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { renderAssistantHtml } from '../../lib/assistantMarkdown';
import { slotLabel, modelSourceLabel, canRegenerateMsg, citeHtml, isStuck, orderSources, questionBefore, sourceLabel, sourceLink } from '../../lib/buddyLogic';
import { getMessageById } from '../../lib/buddyApi';
import { useBuddy } from '../../contexts/BuddyContext';
import BuddyMascot, { BUDDY_STILL } from './BuddyMascot';
import '../../styles/assistant.css'; // .ai-md: the rendered-markdown rules

// The conversation view shared by the quick panel and the Buddy tab.

const CITE_TEXT = /\s?\[(?:[SD]\d{1,3})(?:\s*[,;]\s*[SD]\d{1,3})*\]/g;

export function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

export default function BuddyThread({ convKey, surface, pageContext, empty, onCite, activeSourceMsg }) {
  const { state, send, stop, regenerate, retry, loadThread } = useBuddy();
  const thread = convKey ? state.threads[convKey] : null;
  const messages = thread?.messages || [];
  const inflight = convKey ? state.inflight[convKey] : null;
  const scrollRef = useRef(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, inflight?.status]);
  useEffect(() => { stick.current = true; }, [convKey]);

  const last = messages[messages.length - 1];
  const orphanStatus = inflight && (!last || last.role === 'user');
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf('assistant');
  const loadError = !!thread?.error && !inflight;
  const loading = convKey && !thread && !inflight;

  return (
    <div className="bd-thread">
      <div ref={scrollRef} className="bd-scroll" onScroll={onScroll}>
        {loading && <div className="bd-center" aria-busy="true"><span className="wx-spinner" style={{ color: 'var(--accent)' }} aria-label="Loading chat" /></div>}
        {loadError && (
          <LoadError what="this chat" onRetry={() => loadThread(convKey, true)} />
        )}
        {!loading && !loadError && messages.length === 0 && !inflight && empty}
        <div className="bd-col">
          {messages.map((m, i) => (
            <Message
              key={m.id || `${i}-${m.created_at}`}
              m={m}
              status={inflight && i === messages.length - 1 ? inflight.status : null}
              surface={surface}
              canRegenerate={surface === 'full' && i === lastAssistantIdx && !inflight && canRegenerateMsg(m)}
              onRegenerate={() => regenerate(convKey, surface)}
              inflight={!!inflight && i === messages.length - 1}
              // The last reply is retried in place (Regenerate); an older one by asking again.
              onRetry={inflight ? null : i === lastAssistantIdx && canRegenerateMsg(m)
                ? () => regenerate(convKey, surface)
                : () => retry(convKey, questionBefore(messages, i), surface)}
              onCite={onCite}
              active={activeSourceMsg === m}
            />
          ))}
          {orphanStatus && <StatusLine status={inflight.status} />}
        </div>
      </div>
      <Composer
        busy={!!inflight}
        onSend={(text) => send({ key: convKey, text, surface, pageContext })}
        onStop={() => stop(convKey)}
        surface={surface}
      />
    </div>
  );
}

// A table read failed: say so kindly, offer Retry. Shared by the thread,
// history, usage and settings.
export function LoadError({ what, onRetry, compact }) {
  const online = useOnline();
  return (
    <div className={`bd-load-error ${compact ? 'is-compact' : ''}`} role="alert">
      <i className={`bi ${online ? 'bi-cloud-slash' : 'bi-wifi-off'}`} aria-hidden="true" />
      <span>{online ? `Couldn't load ${what}.` : `You're offline, so ${what} can't load right now.`}</span>
      {onRetry && <button type="button" className="bd-act is-primary" onClick={onRetry}><i className="bi bi-arrow-repeat" aria-hidden="true" /> Retry</button>}
    </div>
  );
}

export function StatusLine({ status }) {
  return (
    <div className="bd-row is-bot">
      <BuddyMascot clip="thinking" size={30} className="bd-avatar-clip" />
      <div className="bd-status" role="status" aria-live="polite">{status || 'On it…'}</div>
    </div>
  );
}

function Message({ m, status, surface, canRegenerate, onRegenerate, onRetry, inflight, onCite, active }) {
  const navigate = useNavigate();
  const { serverNow, role } = useBuddy();
  if (m.role === 'user') {
    return (
      <div className="bd-row is-user">
        <div className="bd-bubble is-user">{m.content}</div>
      </div>
    );
  }
  // A generating row nobody is following any more (older than STUCK_MS on the
  // server's clock) is lost.
  const lost = !inflight && !m.pending && !m.stopped && isStuck(m, serverNow());
  const pending = !lost && (m.pending || m.status === 'generating');
  const error = m.error || (lost ? 'Buddy lost this reply.' : null);
  // Regenerating: the old answer stays, faded, until the new one starts.
  const fading = pending && !m.content && m.regenerating && !!m.oldContent;
  const shown = fading ? m.oldContent : m.content;
  const html = shown ? citeHtml(renderAssistantHtml(shown), fading ? m.oldSources : m.sources) : '';
  const onClick = (e) => {
    const cite = e.target.closest?.('button.bd-cite');
    if (cite) { onCite?.(cite.getAttribute('data-cite'), m); return; }
    const a = e.target.closest?.('a[data-nav]');
    const to = a?.getAttribute('data-nav');
    if (to && to.startsWith('/')) { e.preventDefault(); navigate(to); }
  };
  return (
    <div className={`bd-row is-bot ${active ? 'is-active' : ''}`}>
      <img src={BUDDY_STILL} alt="" aria-hidden="true" className="bd-avatar" />
      <div className="bd-msg">
        {pending && !shown
          ? <div className="bd-status" role="status" aria-live="polite">
              <BuddyMascot clip="thinking" size={22} className="bd-inline-clip" />{status || 'On it…'}
            </div>
          : shown && (
            <div className={`bd-bubble is-bot ${fading ? 'is-fading' : ''}`} aria-live="polite" aria-busy={pending ? 'true' : 'false'}>
              <div className="ai-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
              {pending && status && <div className="bd-status is-inline" role="status">{status}</div>}
            </div>
          )}
        {error && (
          <div className="bd-error" role="alert">
            <i className="bi bi-exclamation-circle" aria-hidden="true" /> {error}
            {onRetry && <button type="button" className="bd-act is-primary" onClick={onRetry}><i className="bi bi-arrow-repeat" aria-hidden="true" /> Retry</button>}
          </div>
        )}
        {m.stopped && !pending && (
          <div className="bd-note">
            <i className="bi bi-stop-circle" aria-hidden="true" /> Stopped.
            {onRetry && <button type="button" className="bd-act" onClick={onRetry}><i className="bi bi-arrow-repeat" aria-hidden="true" /> Ask again</button>}
          </div>
        )}
        {m.notice && !pending && <div className="bd-note" role="status"><i className="bi bi-info-circle" aria-hidden="true" /> {m.notice}</div>}
        {!pending && (error || m.stopped) && (m.previous || m.supersedes) && <PreviousAnswer m={m} />}
        {!pending && <SourceChips sources={m.sources} compact={surface === 'quick'} onCite={(id) => onCite?.(id, m)} />}
        {!pending && m.content && !error && (
          <Actions m={m} canRegenerate={canRegenerate} onRegenerate={onRegenerate} />
        )}
        {!pending && <ModelLine m={m} showModel={(role === 'boss' || role === 'developer') && surface === 'full'} />}
      </div>
    </div>
  );
}

// Which model wrote the answer (meta.model / key_slot / fallback_used, mig 397).
// Everyone sees when a backup answered; the Boss and developers see the model
// (and, when present, where the choice came from: role / global / economy) on
// every answer in the full tab.
function ModelLine({ m, showModel }) {
  if (!m.model) return null;
  const source = showModel && modelSourceLabel(m.modelSource);
  if (m.fallbackUsed) {
    return (
      <div className="bd-model-line" title={showModel && m.fallbackUsed.reason ? `Main model unavailable: ${m.fallbackUsed.reason}` : undefined}>
        <i className="bi bi-arrow-left-right" aria-hidden="true" /> Answered by {m.model} (backup){source ? ` · ${source}` : ''}
      </div>
    );
  }
  if (!showModel) return null;
  return (
    <div className="bd-model-line">
      <i className="bi bi-cpu" aria-hidden="true" /> {m.model} · {slotLabel(m.keySlot || 'primary')}{source ? ` · ${source}` : ''}
    </div>
  );
}

// A Regenerate that failed or was stopped leaves the old answer superseded
// (mig 389); this shows it on request. In-session it is kept locally
// (m.previous); after a reload it is fetched by meta.supersedes.
function PreviousAnswer({ m }) {
  const [open, setOpen] = useState(false);
  const [prev, setPrev] = useState(m.previous || null);
  const [err, setErr] = useState(false);
  const fetchPrev = async () => {
    setErr(false);
    try { setPrev(await getMessageById(m.supersedes)); } catch { setErr(true); }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !prev && m.supersedes) fetchPrev();
  };
  return (
    <div className="bd-previous">
      <button type="button" className="bd-act" aria-expanded={open} onClick={toggle}>
        <i className={`bi ${open ? 'bi-chevron-up' : 'bi-clock-history'}`} aria-hidden="true" /> {open ? 'Hide previous answer' : 'Show previous answer'}
      </button>
      {open && (err
        ? <LoadError what="the previous answer" onRetry={fetchPrev} compact />
        : prev
          ? <div className="bd-bubble is-bot is-fading"><div className="ai-md" dangerouslySetInnerHTML={{ __html: citeHtml(renderAssistantHtml(prev.content), prev.sources) }} /></div>
          : <span className="wx-spinner" style={{ color: 'var(--accent)' }} aria-label="Loading previous answer" />)}
    </div>
  );
}

export function SourceChips({ sources, compact, onCite }) {
  const list = orderSources(sources).filter((s) => s.cited !== false);
  if (!list.length) return null;
  const shown = compact ? list.slice(0, 4) : list;
  return (
    <div className="bd-sources" aria-label="Sources">
      {shown.map((s) => <SourceChip key={s.id} s={s} onCite={onCite} />)}
      {compact && list.length > shown.length && <span className="bd-chip is-more">+{list.length - shown.length}</span>}
    </div>
  );
}

export function SourceChip({ s, onCite, block }) {
  const navigate = useNavigate();
  const link = sourceLink(s);
  const label = (
    <>
      <span className="bd-chip-n">{s.n}</span>
      <span className="bd-chip-type">{sourceLabel(s.source_type)}</span>
      <span className="bd-chip-title">{s.title || 'Untitled'}{s.period ? ` · ${s.period}` : ''}</span>
      {link?.kind === 'ext' && <i className="bi bi-box-arrow-up-right" aria-hidden="true" />}
    </>
  );
  const cls = `bd-chip ${block ? 'is-block' : ''}`;
  if (link?.kind === 'ext') {
    return <a className={cls} href={link.href} target="_blank" rel="noopener noreferrer" title={s.title}>{label}</a>;
  }
  if (link?.kind === 'app') {
    return <button type="button" className={cls} onClick={() => navigate(link.to)} title={s.title}>{label}</button>;
  }
  return <button type="button" className={`${cls} is-plain`} onClick={() => onCite?.(s.id)} title={s.title}>{label}</button>;
}

function Actions({ m, canRegenerate, onRegenerate }) {
  const { feedback } = useBuddy();
  const [rating, setRating] = useState(0);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');

  const rate = async (r, withNote) => {
    setErr('');
    try {
      await feedback(m.requestId, r, withNote);
      setRating(r);
    } catch { setErr("Couldn't save that, please try again."); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content.replace(CITE_TEXT, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className="bd-actions">
      {m.requestId && (
        <>
          <button type="button" className={`bd-act ${rating === 1 ? 'is-on' : ''}`} aria-pressed={rating === 1}
            aria-label="Helpful" title="Helpful" onClick={() => rate(1)}><i className="bi bi-hand-thumbs-up" /></button>
          <button type="button" className={`bd-act ${rating === -1 ? 'is-on' : ''}`} aria-pressed={rating === -1}
            aria-label="Not helpful" title="Not helpful" onClick={() => { rate(-1); setNoteOpen(true); }}><i className="bi bi-hand-thumbs-down" /></button>
        </>
      )}
      <button type="button" className="bd-act" onClick={copy} aria-label="Copy answer" title="Copy">
        <i className={`bi ${copied ? 'bi-check2' : 'bi-copy'}`} />{copied ? ' Copied' : ''}
      </button>
      {canRegenerate && (
        <button type="button" className="bd-act" onClick={onRegenerate} aria-label="Regenerate answer" title="Regenerate">
          <i className="bi bi-arrow-repeat" /> Regenerate
        </button>
      )}
      {noteOpen && (
        <form className="bd-note-form" onSubmit={(e) => { e.preventDefault(); rate(-1, note.trim()); setNoteOpen(false); }}>
          <input className="bd-note-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
            placeholder="What was wrong? (optional)" aria-label="What was wrong with this answer (optional)" autoFocus />
          <button type="submit" className="bd-act is-primary">Send</button>
          <button type="button" className="bd-act" onClick={() => setNoteOpen(false)}>Skip</button>
        </form>
      )}
      {err && <span className="bd-error-inline">{err}</span>}
    </div>
  );
}

export function Composer({ busy, onSend, onStop, surface, inputRef }) {
  const [text, setText] = useState('');
  const online = useOnline();
  const own = useRef(null);
  const ref = inputRef || own;
  const grow = (el) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, surface === 'quick' ? 120 : 180) + 'px'; };
  const submit = () => {
    const t = text.trim();
    if (!t || busy || !online) return;
    onSend(t);
    setText('');
    if (ref.current) { ref.current.style.height = 'auto'; }
  };
  useEffect(() => { if (surface === 'quick') ref.current?.focus(); }, [surface, ref]);
  return (
    <div className="bd-composer">
      {!online && <div className="bd-offline" role="status"><i className="bi bi-wifi-off" /> You're offline. Buddy will be here when you're back.</div>}
      <div className="bd-input-wrap">
        <textarea
          ref={ref}
          className="bd-input"
          rows={1}
          value={text}
          placeholder="Ask Buddy anything…"
          aria-label="Message Buddy"
          onChange={(e) => { setText(e.target.value); grow(e.target); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        />
        {busy
          ? <button type="button" className="bd-send is-stop" onClick={onStop} aria-label="Stop generating" title="Stop"><i className="bi bi-stop-fill" /></button>
          : <button type="button" className="bd-send" onClick={submit} disabled={!text.trim() || !online} aria-label="Send" title="Send"><i className="bi bi-send-fill" /></button>}
      </div>
      <div className="bd-hint">
        {surface === 'quick' ? 'Enter to send · Shift+Enter for a new line' : 'Buddy can make mistakes. Check the sources.'}
      </div>
    </div>
  );
}
