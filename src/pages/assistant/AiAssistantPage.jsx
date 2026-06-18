import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  aiSend, listConversations, getMessages, deleteConversation,
  getAiConfig, updateAiConfig, listDocs, saveDoc, deleteDoc,
} from '../../lib/aiAssistantApi';

export default function AiAssistantPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'boss' || profile?.role === 'developer';
  const [tab, setTab] = useState('chat');

  return (
    <div style={{ padding: '24px 24px 8px', height: 'calc(100vh - var(--topbar-h, 64px))', display: 'flex', flexDirection: 'column' }}>
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
      {tab === 'chat' ? <ChatView /> : <TrainView />}
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
    setMessages((m) => [...m, { role: 'user', content: msg }]);
    setSending(true);
    try {
      const res = await aiSend({ conversationId: activeId, message: msg });
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
      if (!activeId && res.conversationId) {
        setActiveId(res.conversationId);
        listConversations().then(setConvos).catch(() => {});
      }
    } catch (e) {
      setErr(e.message || 'Failed to get a response.');
      setMessages((m) => [...m, { role: 'assistant', content: '⚠️ ' + (e.message || 'Something went wrong. Please try again.') }]);
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
    <div className="d-flex gap-3" style={{ flex: 1, minHeight: 0 }}>
      {/* Conversations */}
      <div className="d-none d-md-flex flex-column" style={{ width: 240, flexShrink: 0 }}>
        <button className="btn btn-sm btn-primary w-100 mb-2 d-inline-flex align-items-center justify-content-center gap-2" style={{ borderRadius: 9 }} onClick={newChat}>
          <i className="bi bi-plus-lg" /> New chat
        </button>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {convos.map((c) => (
            <div key={c.id} onClick={() => openConvo(c.id)}
              className="d-flex align-items-center gap-2 px-2 py-2 rounded-2 mb-1"
              style={{ cursor: 'pointer', background: activeId === c.id ? 'var(--accent-soft)' : 'transparent' }}>
              <i className="bi bi-chat-left-text" style={{ fontSize: '0.8rem', color: activeId === c.id ? 'var(--accent)' : 'var(--text-muted)' }} />
              <span className="text-truncate flex-grow-1" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{c.title || 'Conversation'}</span>
              <button className="btn btn-sm p-0 border-0" style={{ color: 'var(--text-muted)', background: 'transparent' }} onClick={(e) => removeConvo(c.id, e)} title="Delete">
                <i className="bi bi-trash3" style={{ fontSize: '0.72rem' }} />
              </button>
            </div>
          ))}
          {convos.length === 0 && <div className="text-muted small px-2">No conversations yet.</div>}
        </div>
      </div>

      {/* Thread */}
      <div className="d-flex flex-column flex-grow-1" style={{ minWidth: 0, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 18px 4px' }}>
          {messages.length === 0 && (
            <div className="d-flex flex-column align-items-center justify-content-center text-center h-100 py-5">
              <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 56, height: 56, background: 'var(--accent-soft)' }}>
                <i className="bi bi-robot" style={{ fontSize: '1.5rem', color: 'var(--accent)' }} />
              </div>
              <p className="mb-1 fw-semibold" style={{ color: 'var(--text-primary)' }}>{greeting || 'How can I help you with WurxOS today?'}</p>
              <p className="text-muted small mb-0">e.g. “How do I apply for leave?” · “How do I submit my weekly report?”</p>
            </div>
          )}
          {messages.map((m, i) => <Bubble key={i} role={m.role} content={m.content} />)}
          {sending && <Bubble role="assistant" content="" typing />}
        </div>
        {err && <div className="px-3 pb-1"><div className="alert alert-danger py-1 px-2 small mb-1">{err}</div></div>}
        <div className="d-flex align-items-end gap-2 p-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <textarea className="form-control" rows={1} placeholder="Ask the WurxOS assistant…" value={input}
            style={{ resize: 'none', borderRadius: 10, maxHeight: 120 }}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary d-inline-flex align-items-center justify-content-center" style={{ borderRadius: 10, width: 42, height: 38, flexShrink: 0 }}
            disabled={sending || !input.trim()} onClick={send} title="Send">
            {sending ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-send" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, content, typing }) {
  const isUser = role === 'user';
  return (
    <div className="d-flex mb-3" style={{ justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      {!isUser && (
        <div className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0 me-2" style={{ width: 30, height: 30, background: 'var(--accent-soft)', marginTop: 2 }}>
          <i className="bi bi-robot" style={{ fontSize: '0.85rem', color: 'var(--accent)' }} />
        </div>
      )}
      <div style={{
        maxWidth: '76%', padding: '10px 14px', borderRadius: 12, fontSize: '0.86rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: isUser ? 'var(--accent)' : 'var(--surface-2)',
        color: isUser ? 'var(--on-accent)' : 'var(--text-primary)',
        borderTopRightRadius: isUser ? 4 : 12, borderTopLeftRadius: isUser ? 12 : 4,
      }}>
        {typing ? <span className="text-muted">…thinking</span> : content}
      </div>
    </div>
  );
}

// ── Train (Boss) ───────────────────────────────────────────────────
function TrainView() {
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
    try { await updateAiConfig({ persona: cfg.persona, greeting: cfg.greeting, model: cfg.model, enabled: cfg.enabled }); setFlash('Saved.'); }
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
      <div className="row g-3">
        {/* Behaviour */}
        <div className="col-12 col-lg-5">
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 18 }}>
            <div className="fw-bold mb-2" style={{ fontSize: '0.92rem' }}><i className="bi bi-sliders me-2" />Behaviour</div>
            <label className="form-label small fw-semibold mb-1">Persona / instructions</label>
            <textarea className="form-control form-control-sm mb-2" rows={7} value={cfg.persona} onChange={(e) => setCfg({ ...cfg, persona: e.target.value })} style={{ borderRadius: 9 }} />
            <label className="form-label small fw-semibold mb-1">Greeting</label>
            <textarea className="form-control form-control-sm mb-2" rows={2} value={cfg.greeting} onChange={(e) => setCfg({ ...cfg, greeting: e.target.value })} style={{ borderRadius: 9 }} />
            <div className="d-flex align-items-center gap-3 mb-3 flex-wrap">
              <div>
                <label className="form-label small fw-semibold mb-1 d-block">Model</label>
                <select className="form-select form-select-sm" style={{ width: 'auto', borderRadius: 9 }} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })}>
                  {['openai/gpt-4o-mini', 'openai/gpt-4.1-mini', 'openai/gpt-4o', 'openai/gpt-4.1', 'openai/gpt-5-mini'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="form-check mt-3">
                <input className="form-check-input" type="checkbox" id="ai-enabled" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
                <label className="form-check-label small" htmlFor="ai-enabled">Assistant enabled</label>
              </div>
            </div>
            <button className="btn btn-sm btn-primary" style={{ borderRadius: 9 }} disabled={savingCfg} onClick={saveConfig}>
              {savingCfg ? <span className="spinner-border spinner-border-sm" /> : 'Save behaviour'}
            </button>
            {flash && <span className="ms-2 small text-muted">{flash}</span>}
          </div>
        </div>

        {/* Knowledge */}
        <div className="col-12 col-lg-7">
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: 18 }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="fw-bold" style={{ fontSize: '0.92rem' }}><i className="bi bi-journal-text me-2" />Knowledge ({docs.length})</div>
              <button className="btn btn-sm btn-outline-primary" style={{ borderRadius: 9 }} onClick={() => setEditing({ title: '', content: '', is_active: true })}>
                <i className="bi bi-plus-lg me-1" />Add knowledge
              </button>
            </div>
            <div className="text-muted small mb-2">What you add here is what the assistant answers from (e.g. “Applying for leave”, “Submitting a weekly report”).</div>
            {docs.length === 0 && <div className="text-muted small py-3">No knowledge yet — add your first entry so the assistant can answer.</div>}
            {docs.map((d) => (
              <div key={d.id} className="d-flex align-items-start gap-2 px-2 py-2 rounded-2 mb-1" style={{ background: 'var(--surface-2)' }}>
                <div className="flex-grow-1 min-w-0">
                  <div className="fw-semibold text-truncate" style={{ fontSize: '0.82rem', color: d.is_active ? 'var(--text-primary)' : 'var(--text-muted)' }}>{d.title}</div>
                  <div className="text-muted text-truncate" style={{ fontSize: '0.7rem' }}>{d.content}</div>
                </div>
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
