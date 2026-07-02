import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  aiSendStream, listConversations, getMessages, deleteConversation,
  getAiConfig, updateAiConfig, listDocs, saveDoc, deleteDoc,
} from '../../lib/aiAssistantApi';
import { renderAssistantHtml } from '../../lib/assistantMarkdown';
import '../../styles/assistant.css';

export default function AiAssistantPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'boss'; // training is Boss-only
  const [tab, setTab] = useState('chat');

  return (
    <div style={{ height: 'calc(100vh - 110px)', minHeight: 480, display: 'flex', flexDirection: 'column' }}>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-robot" style={{ color: 'var(--accent)' }} /> WurxOS Assistant
          </h5>
          <div className="text-muted" style={{ fontSize: '0.74rem' }}>Ask anything about using WurxOS — leave, attendance, reporting, and more.</div>
        </div>
        {isAdmin && (
          <div className="d-inline-flex align-items-center gap-1 p-1 rounded-3" style={{ background: 'var(--surface-2)' }}>
            {[['chat', 'Chat', 'bi-chat-dots'], ['train', 'Train', 'bi-mortarboard']].map(([k, label, icon]) => (
              <button key={k} type="button" className="btn btn-sm border-0 d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 7, fontSize: '0.8rem', fontWeight: 600, padding: '4px 14px',
                  background: tab === k ? 'var(--surface-1)' : 'transparent',
                  color: tab === k ? 'var(--accent)' : 'var(--text-secondary)',
                  boxShadow: tab === k ? 'var(--shadow-sm)' : 'none' }}
                onClick={() => setTab(k)}><i className={`bi ${icon}`} />{label}</button>
            ))}
          </div>
        )}
      </div>
      {tab === 'chat' ? <ChatView /> : <TrainView onBack={() => setTab('chat')} />}
    </div>
  );
}

// ── Chat ──────────────────────────────────────────────────────────
function ChatView() {
  const [convos, setConvos] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [greeting, setGreeting] = useState('');
  const [err, setErr] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    listConversations().then(setConvos).catch(() => {});
    getAiConfig().then((c) => setGreeting(c?.greeting || '')).catch(() => {});
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  async function openConvo(id) {
    setActiveId(id); setErr('');
    try { setMessages(await getMessages(id)); } catch (e) { setErr(e.message); }
  }
  function newChat() { setActiveId(null); setMessages([]); setErr(''); setInput(''); }

  async function send() {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput(''); setErr('');
    // Add the user turn + an empty assistant bubble we grow as tokens arrive.
    const now = new Date().toISOString();
    setMessages((m) => [...m, { role: 'user', content: msg, created_at: now }, { role: 'assistant', content: '', streaming: true, created_at: now }]);
    setSending(true);
    // Append a delta to the last (assistant) message.
    const appendDelta = (chunk) => {
      setMessages((m) => {
        const next = m.slice();
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + chunk, streaming: true };
        return next;
      });
    };
    try {
      const res = await aiSendStream({ conversationId: activeId, message: msg, onDelta: appendDelta });
      // mark the assistant bubble as finished streaming
      setMessages((m) => {
        const next = m.slice();
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, streaming: false };
        return next;
      });
      if (!activeId && res.conversationId) {
        setActiveId(res.conversationId);
        listConversations().then(setConvos).catch(() => {});
      }
    } catch (e) {
      setErr(e.message || 'Failed to get a response.');
      // Replace the (empty) streaming bubble with the error.
      setMessages((m) => {
        const next = m.slice();
        const last = next[next.length - 1];
        const errText = '⚠️ ' + (e.message || 'Something went wrong. Please try again.');
        if (last && last.role === 'assistant') next[next.length - 1] = { role: 'assistant', content: errText };
        else next.push({ role: 'assistant', content: errText });
        return next;
      });
    } finally {
      setSending(false);
    }
  }

  async function removeConvo(id, e) {
    e.stopPropagation();
    if (!window.confirm('Delete this conversation?')) return;
    try {
      await deleteConversation(id);
      setConvos((c) => c.filter((x) => x.id !== id));
      if (activeId === id) newChat();
    } catch (ex) { setErr(ex.message); }
  }

  return (
    <div className="wxai d-flex" style={{ flex: 1, minHeight: 0, gap: 16 }}>
      {/* Conversations sidebar */}
      <div className="wxai-sidebar d-none d-md-flex flex-column">
        <div className="d-flex align-items-center justify-content-between px-1 mb-2">
          <span className="wxai-sidebar-title">Chats</span>
          <button className="wxai-newchat" onClick={newChat} title="Start a new chat">
            <i className="bi bi-plus-lg" /> New
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, margin: '0 -4px', padding: '0 4px' }}>
          {convos.map((c) => (
            <div key={c.id} onClick={() => openConvo(c.id)}
              className={`wxai-convo ${activeId === c.id ? 'is-active' : ''}`}>
              <i className="bi bi-chat-left-text wxai-convo-icon" />
              <span className="text-truncate flex-grow-1">{c.title || 'Conversation'}</span>
              <button className="wxai-convo-del" onClick={(e) => removeConvo(c.id, e)} title="Delete">
                <i className="bi bi-trash3" />
              </button>
            </div>
          ))}
          {convos.length === 0 && <div className="text-muted small px-2 py-2">No conversations yet.</div>}
        </div>
      </div>

      {/* Thread */}
      <div className="wxai-thread d-flex flex-column flex-grow-1">
        <div ref={scrollRef} className="wxai-scroll">
          {messages.length === 0 && (
            <div className="d-flex flex-column align-items-center justify-content-center text-center h-100 py-5">
              <div className="wxai-hero-icon mb-3">
                <i className="bi bi-robot" />
              </div>
              <p className="mb-1 fw-semibold" style={{ color: 'var(--text-primary)', fontSize: '1rem' }}>{greeting || 'How can I help you with WurxOS today?'}</p>
              <p className="text-muted small mb-0">e.g. “How do I apply for leave?” · “Which week had my brand’s highest GMV?”</p>
            </div>
          )}
          {messages.map((m, i) => <Bubble key={i} role={m.role} content={m.content} streaming={m.streaming} at={m.created_at} />)}
        </div>
        {err && <div className="px-3 pb-1"><div className="alert alert-danger py-1 px-2 small mb-1">{err}</div></div>}
        <div className="wxai-composer">
          <div className="wxai-input-wrap">
            <textarea className="wxai-input" rows={1} placeholder="Ask the WurxOS assistant anything…" value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // auto-grow
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <button className="wxai-send" disabled={sending || !input.trim()} onClick={send} title="Send" aria-label="Send">
              {sending ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-send-fill" />}
            </button>
          </div>
          <div className="wxai-hint">Enter to send · Shift+Enter for a new line</div>
        </div>
      </div>
    </div>
  );
}

function fmtMsgTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

function Bubble({ role, content, streaming, at }) {
  const isUser = role === 'user';
  const navigate = useNavigate();
  const waiting = streaming && !content; // streaming started but no text yet

  // Intercept clicks on in-app links the assistant rendered ([Leave](/leave))
  // so navigation stays inside the SPA instead of a full page reload.
  const onContentClick = (e) => {
    const a = e.target.closest?.('a[data-nav]');
    if (!a) return;
    const to = a.getAttribute('data-nav');
    if (to && to.startsWith('/')) { e.preventDefault(); navigate(to); }
  };

  const time = fmtMsgTime(at);

  return (
    <div className={`wxai-row ${isUser ? 'is-user' : 'is-bot'}`}>
      {!isUser && (
        <div className="wxai-avatar">
          <i className="bi bi-robot" />
        </div>
      )}
      <div className="wxai-bubble-wrap">
        <div className={`wxai-bubble ${isUser ? 'is-user' : 'is-bot'}`}>
          {waiting
            ? <span className="ai-typing text-muted">Thinking<span className="ai-dots" /></span>
            : isUser
              ? content
              : <div className="ai-md" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: renderAssistantHtml(content) }} />}
        </div>
        {time && !waiting && <div className="wxai-time">{time}</div>}
      </div>
    </div>
  );
}

// ── Train (Boss) ───────────────────────────────────────────────────
function TrainView({ onBack }) {
  const [cfg, setCfg] = useState(null);
  const [docs, setDocs] = useState([]);
  const [editing, setEditing] = useState(null); // doc being edited / new
  const [savingCfg, setSavingCfg] = useState(false);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    getAiConfig().then(setCfg).catch(() => {});
    listDocs().then(setDocs).catch(() => {});
  }, []);

  async function saveConfig() {
    setSavingCfg(true); setFlash('');
    // NOTE: `model` is intentionally NOT saved here — it is locked server-side
    // (the ai-chat function pins gpt-5.4-mini) so the Boss can't change or break it.
    try { await updateAiConfig({ persona: cfg.persona, greeting: cfg.greeting, enabled: cfg.enabled, use_kb: cfg.use_kb !== false }); setFlash('Saved.'); }
    catch (e) { setFlash('Error: ' + e.message); }
    finally { setSavingCfg(false); setTimeout(() => setFlash(''), 2500); }
  }
  async function persistDoc() {
    try { await saveDoc(editing); setEditing(null); setDocs(await listDocs()); }
    catch (e) { alert('Save failed: ' + e.message); }
  }
  async function removeDoc(id) {
    if (!window.confirm('Delete this knowledge entry?')) return;
    try { await deleteDoc(id); setDocs(await listDocs()); } catch (e) { alert(e.message); }
  }
  async function toggleActive(d) {
    try { await saveDoc({ ...d, is_active: !d.is_active }); setDocs(await listDocs()); } catch (e) { alert(e.message); }
  }

  if (!cfg) return <div className="text-muted small">Loading…</div>;

  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      <button type="button" className="btn btn-sm btn-link text-decoration-none px-0 mb-2" onClick={onBack}>
        <i className="bi bi-arrow-left me-1" /> Back to chat
      </button>
      <div className="row g-3">
        {/* Settings */}
        <div className="col-12 order-2">
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 18 }}>
            <div className="fw-bold mb-2" style={{ fontSize: '0.92rem' }}><i className="bi bi-sliders me-2" />Assistant settings (persona &amp; greeting)</div>
            <label className="form-label small fw-semibold mb-1">Persona / instructions</label>
            <textarea className="form-control form-control-sm mb-2" rows={5} value={cfg.persona} onChange={(e) => setCfg({ ...cfg, persona: e.target.value })} style={{ borderRadius: 9 }} />
            <label className="form-label small fw-semibold mb-1">Greeting</label>
            <textarea className="form-control form-control-sm mb-2" rows={2} value={cfg.greeting} onChange={(e) => setCfg({ ...cfg, greeting: e.target.value })} style={{ borderRadius: 9 }} />
            <div className="d-flex align-items-center gap-3 mb-3 flex-wrap">
              <div>
                <label className="form-label small fw-semibold mb-1 d-block">Model</label>
                <div className="d-flex align-items-center gap-2">
                  <span className="badge rounded-pill" style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)', fontWeight: 600, padding: '6px 12px', fontSize: '0.8rem' }}>
                    <i className="bi bi-lock-fill me-1" style={{ fontSize: '0.72rem' }} />gpt-5.4-mini
                  </span>
                  <span className="text-muted" style={{ fontSize: '0.72rem' }}>set by the developer</span>
                </div>
              </div>
              <div className="form-check mt-3">
                <input className="form-check-input" type="checkbox" id="ai-enabled" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
                <label className="form-check-label small" htmlFor="ai-enabled">Assistant enabled</label>
              </div>
              <div className="form-check mt-3">
                <input className="form-check-input" type="checkbox" id="ai-usekb" checked={cfg.use_kb !== false} onChange={(e) => setCfg({ ...cfg, use_kb: e.target.checked })} />
                <label className="form-check-label small" htmlFor="ai-usekb" title="Also answer from the company Knowledge Base (each user only sees articles they're allowed to)">Use Knowledge Base</label>
              </div>
            </div>
            <button className="btn btn-sm btn-primary" style={{ borderRadius: 9 }} disabled={savingCfg} onClick={saveConfig}>
              {savingCfg ? <span className="spinner-border spinner-border-sm" /> : 'Save behaviour'}
            </button>
            {flash && <span className="ms-2 small text-muted">{flash}</span>}
          </div>
        </div>

        {/* Knowledge (shown first) */}
        <div className="col-12 order-1">
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 18 }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="fw-bold" style={{ fontSize: '0.92rem' }}><i className="bi bi-journal-text me-2" />Knowledge ({docs.length})</div>
              <button className="btn btn-sm btn-primary" style={{ borderRadius: 9 }} onClick={() => setEditing({ title: '', content: '', is_active: true })}>
                <i className="bi bi-plus-lg me-1" />Add knowledge
              </button>
            </div>
            <div className="text-muted small mb-2">What you add here is what the assistant answers from (e.g. “Applying for leave”, “Submitting a weekly report”).</div>
            {docs.length === 0 && <div className="text-muted small py-3">No knowledge yet — add your first entry so the assistant can answer.</div>}
            {docs.map((d) => (
              <div key={d.id} className="d-flex align-items-center gap-2 px-3 py-2 rounded-2 mb-1" style={{ background: 'var(--surface-2)' }}>
                <i className="bi bi-file-text flex-shrink-0" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }} />
                <span className="flex-grow-1 text-truncate fw-semibold" style={{ minWidth: 0, fontSize: '0.82rem', cursor: 'pointer', color: d.is_active ? 'var(--text-primary)' : 'var(--text-muted)' }} onClick={() => setEditing(d)} title="Open to view or edit">{d.title}</span>
                {!d.is_active && <span className="badge flex-shrink-0" style={{ background: 'var(--surface-3, #e5e7eb)', color: 'var(--text-muted)', fontSize: '0.6rem', fontWeight: 600 }}>OFF</span>}
                <button className="btn btn-sm p-1 border-0" title={d.is_active ? 'Active — click to disable' : 'Disabled — click to enable'} style={{ background: 'transparent', color: d.is_active ? 'var(--success)' : 'var(--text-muted)' }} onClick={() => toggleActive(d)}>
                  <i className={`bi ${d.is_active ? 'bi-toggle-on' : 'bi-toggle-off'}`} />
                </button>
                <button className="btn btn-sm p-1 border-0" title="Edit" style={{ background: 'transparent', color: 'var(--text-secondary)' }} onClick={() => setEditing(d)}><i className="bi bi-pencil" /></button>
                <button className="btn btn-sm p-1 border-0" title="Delete" style={{ background: 'transparent', color: 'var(--danger)' }} onClick={() => removeDoc(d.id)}><i className="bi bi-trash3" /></button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Editor modal */}
      {editing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1080, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-default)', borderRadius: 14, width: 600, maxWidth: '100%', padding: 20 }}>
            <div className="fw-bold mb-3" style={{ fontSize: '1rem' }}>{editing.id ? 'Edit knowledge' : 'Add knowledge'}</div>
            <label className="form-label small fw-semibold mb-1">Title</label>
            <input className="form-control form-control-sm mb-2" style={{ borderRadius: 9 }} placeholder="e.g. Applying for leave" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            <label className="form-label small fw-semibold mb-1">Content</label>
            <textarea className="form-control form-control-sm mb-3" rows={9} style={{ borderRadius: 9 }} placeholder="Explain the steps / policy clearly. The assistant answers from this." value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
            <div className="d-flex justify-content-end gap-2">
              <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 9 }} onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-sm btn-primary" style={{ borderRadius: 9 }} disabled={!editing.title.trim() || !editing.content.trim()} onClick={persistDoc}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
