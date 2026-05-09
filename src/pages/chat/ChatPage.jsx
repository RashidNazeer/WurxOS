import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  PlusIcon, AlertIcon, SearchIcon, XIcon, CheckIcon, CopyIcon,
  UsersIcon, MessageIcon, MoreIcon, TrashIcon, LogoutIcon,
} from '../../components/common/Icon';
import '../../styles/chat.css';

// 5 minutes — messages within this window from the same author cluster.
const CLUSTER_WINDOW_MS = 5 * 60 * 1000;

export default function ChatPage() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const isBoss = profile?.role === 'boss';

  const [activeId, setActiveId] = useState(null);
  const [showPeople, setShowPeople] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [err, setErr] = useState('');

  const qc = useQueryClient();

  // --- Channel list ---
  const { data: channels = [], refetch: refetchChannels } = useQuery({
    queryKey: ['chat', 'channels', uid],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('chat_list_my_channels');
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: !!uid,
  });

  // Auto-pick the first channel on first load.
  useEffect(() => {
    if (!activeId && channels.length > 0) setActiveId(channels[0].channel_id);
  }, [channels, activeId]);

  // --- Messages for the active channel ---
  const { data: messages = [], refetch: refetchMessages } = useQuery({
    queryKey: ['chat', 'messages', activeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('*, author:author_id(id, display_name, avatar_url, role)')
        .eq('channel_id', activeId)
        .order('created_at', { ascending: true })
        .limit(300);
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: !!activeId,
  });

  const endRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
    return () => clearTimeout(t);
  }, [messages.length, activeId]);

  // Mark active channel as read whenever it changes or new messages arrive.
  useEffect(() => {
    if (!activeId || !uid) return;
    supabase.rpc('chat_mark_read', { p_channel: activeId })
      .then(() => qc.invalidateQueries({ queryKey: ['chat', 'channels'] }));
  }, [activeId, uid, messages.length, qc]);

  // Realtime: any insert / delete updates the channel list (last message + unread)
  // and refreshes the active thread when relevant.
  useEffect(() => {
    if (!uid) return;
    const ch = supabase
      .channel(`chat-live-${uid}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        (payload) => {
          qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
          if (payload.new.channel_id === activeId) refetchMessages();
        })
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'chat_messages' },
        () => { refetchMessages(); qc.invalidateQueries({ queryKey: ['chat', 'channels'] }); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [uid, activeId, qc, refetchMessages]);

  const activeChannel = channels.find((c) => c.channel_id === activeId) || null;

  async function leaveChannel(channelId) {
    setErr('');
    try {
      const { error } = await supabase
        .from('chat_members')
        .delete()
        .eq('channel_id', channelId)
        .eq('user_id', uid);
      if (error) throw error;
      setActiveId(null);
      qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
    } catch (e) { setErr(e.message); }
  }

  async function destroyChannel(channelId) {
    setErr('');
    try {
      const { error } = await supabase.from('chat_channels').delete().eq('id', channelId);
      if (error) throw error;
      setActiveId(null);
      qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
    } catch (e) { setErr(e.message); }
  }

  const filteredChannels = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => titleFor(c, uid).toLowerCase().includes(q));
  }, [channels, filterText, uid]);

  const dms    = filteredChannels.filter((c) => c.kind === 'dm');
  const groups = filteredChannels.filter((c) => c.kind === 'group');

  return (
    <>
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <div className="chat-shell">
        <aside className="chat-rail">
          <div className="chat-rail-header">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <div className="chat-rail-title">Conversations</div>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{channels.length}</span>
            </div>
            <button
              type="button"
              className="chat-rail-head-btn"
              onClick={() => setShowPeople(true)}
              title="New chat"
              aria-label="New chat"
            >
              <PlusIcon width="15" height="15" />
            </button>
          </div>
          <div className="chat-rail-search">
            <div className="wx-search">
              <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
              <input className="wx-input" placeholder="Search chats…"
                value={filterText} onChange={(e) => setFilterText(e.target.value)} />
            </div>
          </div>
          <div className="chat-rail-list">
            {channels.length === 0 ? (
              <div className="chat-empty" style={{ padding: 20 }}>
                <div>
                  <div className="chat-empty-illustration" style={{ width: 44, height: 44 }}>
                    <MessageIcon width="20" height="20" />
                  </div>
                  <div className="chat-empty-title" style={{ fontSize: 13 }}>No chats yet</div>
                  <div style={{ fontSize: 12 }}>Start one with "New chat" above.</div>
                </div>
              </div>
            ) : (
              <>
                {dms.length > 0 && <div className="chat-section-header">Direct</div>}
                {dms.map((c) => (
                  <ChannelRow key={c.channel_id} channel={c} uid={uid}
                    active={c.channel_id === activeId}
                    onClick={() => setActiveId(c.channel_id)} />
                ))}
                {groups.length > 0 && <div className="chat-section-header">Groups</div>}
                {groups.map((c) => (
                  <ChannelRow key={c.channel_id} channel={c} uid={uid}
                    active={c.channel_id === activeId}
                    onClick={() => setActiveId(c.channel_id)} />
                ))}
              </>
            )}
          </div>
        </aside>

        <section className="chat-thread">
          {activeChannel ? (
            <Thread channel={activeChannel} messages={messages} uid={uid}
              isBoss={isBoss}
              endRef={endRef}
              onError={setErr}
              onAfterAction={() => { refetchMessages(); refetchChannels(); }}
              onLeave={() => leaveChannel(activeChannel.channel_id)}
              onDestroy={() => destroyChannel(activeChannel.channel_id)} />
          ) : (
            <div className="chat-empty">
              <div>
                <div className="chat-empty-illustration">
                  <MessageIcon width="28" height="28" />
                </div>
                <div className="chat-empty-title">Pick a conversation</div>
                <div>Or start a new one with the button above.</div>
              </div>
            </div>
          )}
        </section>
      </div>

      {showPeople && (
        <NewChatModal uid={uid}
          onClose={() => setShowPeople(false)}
          onDone={(id) => {
            setShowPeople(false);
            qc.invalidateQueries({ queryKey: ['chat', 'channels'] });
            setActiveId(id);
          }} />
      )}
    </>
  );
}

// ============================================================
// Channel row
// ============================================================
function ChannelRow({ channel, uid, active, onClick }) {
  const others = (channel.members || []).filter((m) => m.id !== uid);
  const last = channel.last_message;
  const preview = last
    ? `${last.author_id === uid ? 'You: ' : ''}${last.body || ''}`
    : 'No messages yet';
  return (
    <button type="button" onClick={onClick}
      className={`chat-channel-row ${active ? 'is-active' : ''}`}>
      <ChannelAvatar channel={channel} others={others} />
      <div className="chat-channel-meta">
        <div className="chat-channel-name">{titleFor(channel, uid)}</div>
        <div className="chat-channel-preview">{truncate(preview, 60)}</div>
      </div>
      <div className="chat-channel-side">
        <div className="chat-channel-time">{relativeTime(last?.created_at || channel.created_at)}</div>
        {channel.unread_count > 0 && (
          <span className="chat-unread">{channel.unread_count > 99 ? '99+' : channel.unread_count}</span>
        )}
      </div>
    </button>
  );
}

function ChannelAvatar({ channel, others }) {
  if (channel.kind === 'group') {
    const slice = others.slice(0, 2);
    return (
      <div className="chat-avatar-stack">
        {slice.map((m) => <Avatar key={m.id} user={m} />)}
      </div>
    );
  }
  if (others.length === 0) {
    // Orphan DM — render a neutral muted avatar instead of "?" initials.
    return (
      <div className="chat-avatar" style={{ background: '#e2e8f0', color: '#94a3b8' }}>
        <LogoutIcon width="14" height="14" />
      </div>
    );
  }
  return <Avatar user={others[0]} />;
}

function Avatar({ user, size = null }) {
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.36) } : undefined;
  if (user?.avatar_url) {
    return (
      <div className="chat-avatar" style={style}>
        <img src={user.avatar_url} alt={user.display_name || ''} />
      </div>
    );
  }
  return (
    <div className="chat-avatar" style={style}>
      {initialsOf(user?.display_name)}
    </div>
  );
}

// ============================================================
// Thread
// ============================================================
function Thread({ channel, messages, uid, isBoss, endRef, onError, onAfterAction, onLeave, onDestroy }) {
  const [body, setBody]         = useState('');
  const [sending, setSending]   = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const composeRef = useRef(null);
  const menuRef    = useRef(null);

  const others = (channel.members || []).filter((m) => m.id !== uid);
  const title  = titleFor(channel, uid);
  const isCreator = channel.created_by === uid;
  const isDM = channel.kind === 'dm';
  const canDestroy = isCreator || isBoss;

  // If the other DM member is gone, we still render the thread but
  // mark it as orphaned so the header doesn't say "?" like before.
  const dmOrphan = isDM && others.length === 0;

  const subtitle = channel.kind === 'group'
    ? `${(channel.members || []).length} members`
    : dmOrphan ? 'Left the chat' : (others[0]?.role || '—');

  // Close the kebab menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  function confirmLeave() {
    setMenuOpen(false);
    if (!confirm(`Leave this group? You won't receive new messages here. Other members will still see the group.`)) return;
    onLeave();
  }
  function confirmDestroy() {
    setMenuOpen(false);
    const label = channel.kind === 'group' ? `the group "${title}"` : `this conversation`;
    if (!confirm(`Delete ${label} for everyone? All messages will be permanently removed. This cannot be undone.`)) return;
    onDestroy();
  }
  // DMs collapse to a single "Delete chat" action. Under the hood it
  // just removes your chat_members row; the auto-delete trigger then
  // tears down the channel since it drops below 2 members.
  function confirmDeleteDM() {
    setMenuOpen(false);
    if (!confirm(`Delete this chat? All messages will be permanently removed for both of you. This cannot be undone.`)) return;
    onLeave();
  }

  // Auto-grow textarea
  useEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [body]);

  async function send(e) {
    e?.preventDefault?.();
    const text = body.trim();
    if (!text || !channel.channel_id) return;
    setSending(true);
    try {
      const { error } = await supabase.from('chat_messages').insert({
        channel_id: channel.channel_id, author_id: uid, body: text,
      });
      if (error) throw error;
      setBody('');
      onAfterAction();
    } catch (e) { onError(e.message); }
    finally { setSending(false); }
  }
  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function deleteMsg(id) {
    if (!confirm('Delete this message?')) return;
    try {
      const { error } = await supabase.from('chat_messages').delete().eq('id', id);
      if (error) throw error;
      onAfterAction();
    } catch (e) { onError(e.message); }
  }
  function copyMsg(text) {
    try { navigator.clipboard?.writeText(text || ''); } catch {}
  }

  const clusters = useMemo(() => buildClusters(messages), [messages]);
  const isFresh  = messages.length === 0;

  return (
    <>
      <div className="chat-thread-header">
        <ChannelAvatar channel={channel} others={others} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="chat-thread-title">{title}</div>
          <div className="chat-thread-sub">{subtitle}</div>
        </div>
        <button type="button" className="chat-thread-menu-btn"
          onClick={() => setMenuOpen((v) => !v)} title="Conversation options">
          <MoreIcon width="16" height="16" />
        </button>
        {menuOpen && (
          <div className="chat-thread-menu" ref={menuRef}>
            {isDM ? (
              <button type="button" className="chat-thread-menu-item is-danger" onClick={confirmDeleteDM}>
                <TrashIcon width="14" height="14" />
                <span>Delete chat</span>
              </button>
            ) : (
              <>
                <button type="button" className="chat-thread-menu-item" onClick={confirmLeave}>
                  <LogoutIcon width="14" height="14" />
                  <span>Leave group</span>
                </button>
                {canDestroy && (
                  <>
                    <div className="chat-thread-menu-divider" />
                    <button type="button" className="chat-thread-menu-item is-danger" onClick={confirmDestroy}>
                      <TrashIcon width="14" height="14" />
                      <span>Delete for everyone</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="chat-thread-body">
        {isFresh ? (
          <div className="chat-empty">
            <div>
              <div className="chat-empty-illustration"><MessageIcon width="28" height="28" /></div>
              <div className="chat-empty-title">
                {channel.kind === 'group'
                  ? `Welcome to ${title}`
                  : `Say hi to ${others[0]?.display_name || 'them'}`}
              </div>
              <div>This is the beginning of your conversation.</div>
            </div>
          </div>
        ) : (
          clusters.map((node) => {
            if (node.type === 'date') {
              return <div key={node.key} className="chat-date-sep">{node.label}</div>;
            }
            const mine = node.author_id === uid;
            return (
              <div key={node.key} className={`chat-cluster ${mine ? 'is-mine' : ''}`}>
                {/* Avatar shown only for other people — mine-side
                    bubbles right-align in full width for max reading space. */}
                {!mine && <Avatar user={node.author} />}
                <div className="chat-cluster-bubbles">
                  {!mine && (
                    <div className="chat-cluster-author">
                      <span>{node.author?.display_name || '—'}</span>
                      <span className="chat-cluster-author-time">
                        {formatTime(node.firstAt)}
                      </span>
                    </div>
                  )}
                  {node.messages.map((m) => (
                    <div key={m.id} className="chat-bubble">
                      <span className="chat-bubble-actions">
                        <button type="button" className="chat-bubble-action"
                          onClick={() => copyMsg(m.body)} title="Copy">
                          <CopyIcon width="11" height="11" />
                        </button>
                        {mine && (
                          <button type="button" className="chat-bubble-action"
                            onClick={() => deleteMsg(m.id)} title="Delete">
                            <XIcon width="11" height="11" />
                          </button>
                        )}
                      </span>
                      <div>{m.body}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <form className="chat-compose" onSubmit={send}>
        <div className="chat-compose-row">
          <textarea
            ref={composeRef}
            placeholder={`Message ${title}…`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            rows={1}
          />
          <button type="submit" className="wx-btn wx-btn-primary chat-send-btn"
            disabled={!body.trim() || sending}>
            {sending ? <span className="wx-spinner" /> : 'Send'}
          </button>
        </div>
        <div className="chat-compose-hint">
          <strong>Enter</strong> to send · <strong>Shift + Enter</strong> for a newline
        </div>
      </form>
    </>
  );
}

// ============================================================
// New chat modal — single click to DM, multi-select → group
// ============================================================
function NewChatModal({ uid, onClose, onDone }) {
  const [q, setQ]                 = useState('');
  const [users, setUsers]         = useState([]);
  const [selected, setSelected]   = useState([]);
  const [groupName, setGroupName] = useState('');
  const [err, setErr]             = useState('');
  const [busy, setBusy]           = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('profiles').select('id, display_name, email, role, avatar_url')
        .eq('is_active', true).neq('id', uid).order('display_name');
      setUsers(data || []);
    })();
  }, [uid]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return users;
    return users.filter((u) =>
      (u.display_name || '').toLowerCase().includes(qq) ||
      (u.email        || '').toLowerCase().includes(qq) ||
      (u.role         || '').toLowerCase().includes(qq),
    );
  }, [users, q]);

  function toggle(id) {
    setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }

  async function startDM(otherId) {
    setBusy(true); setErr('');
    try {
      const { data, error } = await supabase.rpc('chat_open_dm', { p_other: otherId });
      if (error) throw error;
      onDone(data);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function createGroup() {
    if (selected.length < 2) return setErr('Pick at least 2 people for a group.');
    setBusy(true); setErr('');
    try {
      const { data, error } = await supabase.rpc('chat_create_group', {
        p_name: groupName.trim() || 'Group',
        p_members: selected,
      });
      if (error) throw error;
      onDone(data);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const groupMode = selected.length >= 2;

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">{groupMode ? 'New group chat' : 'Start a chat'}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}>
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}
          <div className="wx-search" style={{ marginBottom: 10 }}>
            <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
            <input className="wx-input" placeholder="Search people by name, email, role…"
              value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>

          {groupMode && (
            <div style={{ marginBottom: 10 }}>
              <label className="wx-label">Group name (optional)</label>
              <input className="wx-input" value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={`e.g. "Brand X war room"`} />
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            {groupMode
              ? <>Tap to add or remove people. Click <strong>Create group</strong> below.</>
              : <>Click anyone to start a 1-on-1 chat, or pick 2+ to make a group.</>}
          </div>

          <div className="chat-people-list">
            {filtered.length === 0 ? (
              <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: 12.5, textAlign: 'center' }}>
                No people match that search.
              </div>
            ) : filtered.map((u) => {
              const on = selected.includes(u.id);
              return (
                <div key={u.id}
                  className={`chat-person-row ${on ? 'is-selected' : ''}`}
                  onClick={() => groupMode || on ? toggle(u.id) : startDM(u.id)}>
                  <Avatar user={u} />
                  <div style={{ minWidth: 0 }}>
                    <div className="chat-person-name">{u.display_name}</div>
                    <div className="chat-person-meta">{u.role} · {u.email}</div>
                  </div>
                  <div className="chat-person-check" onClick={(e) => { e.stopPropagation(); toggle(u.id); }}>
                    {on && <CheckIcon width="12" height="12" />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {groupMode && (
            <button className="wx-btn wx-btn-primary" onClick={createGroup} disabled={busy}>
              {busy
                ? <><span className="wx-spinner" /> Creating…</>
                : <><UsersIcon width="14" height="14" /> Create group ({selected.length})</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================
function titleFor(channel, uid) {
  if (channel.kind === 'group') return channel.name || 'Group';
  const others = (channel.members || []).filter((m) => m.id !== uid);
  // Orphan DM — the other participant left or their account was
  // deleted. Migration 073's trigger should prevent this, but we
  // still label it clearly instead of falling back to "Direct message".
  if (others.length === 0) return 'Left the chat';
  return others[0]?.display_name || 'Direct message';
}

function initialsOf(name) {
  if (!name) return '?';
  return String(name).split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relativeTime(d) {
  if (!d) return '';
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60)        return 'now';
  if (s < 3600)      return `${Math.floor(s / 60)}m`;
  if (s < 86400)     return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 6) return `${Math.floor(s / 86400)}d`;
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateLabel(d) {
  const today = new Date(); today.setHours(0,0,0,0);
  const day = new Date(d);  day.setHours(0,0,0,0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7)   return new Date(d).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: today.getFullYear() === day.getFullYear() ? undefined : 'numeric',
  });
}

// Walks the chronologically ordered message list and produces nodes:
// { type: 'date', label } and { type: 'cluster', author, messages[] }.
function buildClusters(messages) {
  const out = [];
  let lastDateKey = null;
  let cluster = null;
  for (const m of messages) {
    const dt = new Date(m.created_at);
    const dayKey = dt.toISOString().slice(0, 10);
    if (dayKey !== lastDateKey) {
      out.push({ type: 'date', key: 'date-' + dayKey, label: dateLabel(m.created_at) });
      lastDateKey = dayKey;
      cluster = null;
    }
    const sameAuthor = cluster && cluster.author_id === m.author_id;
    const tooOld     = cluster && (dt.getTime() - cluster.lastAtMs) > CLUSTER_WINDOW_MS;
    if (!sameAuthor || tooOld) {
      cluster = {
        type: 'cluster',
        key: 'c-' + m.id,
        author_id: m.author_id,
        author: m.author,
        firstAt: m.created_at,
        lastAtMs: dt.getTime(),
        messages: [],
      };
      out.push(cluster);
    } else {
      cluster.lastAtMs = dt.getTime();
    }
    cluster.messages.push(m);
  }
  return out;
}
