import { useEffect, useState } from 'react';
import {
  getAiConfig, updateAiConfig, listDocs, saveDoc, deleteDoc,
  getSlackConfig, setSlackEnabled, listSlackRelayLog,
} from '../../lib/aiAssistantApi';
import {
  runIngestion, ingestStats, INGEST_SOURCES, getIngestSources, setIngestSources,
  listExcluded, addExcluded, removeExcluded,
} from '../../lib/buddyApi';
import { BUDDY_GREETING, greetingIsDefault } from '../../lib/buddyLogic';

// Buddy settings (ui-design.md §4). Run ingestion: Boss + Developer (the
// ai_run_ingestion RPC enforces it). Everything else: Boss only (RLS on the
// config / docs / exclusion tables enforces it; this page only hides it).

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export default function BuddySettings({ role }) {
  const isBoss = role === 'boss';
  return (
    <div className="bd-settings">
      <IngestionCard />
      {isBoss && (
        <>
          <SourcesCard />
          <ExcludedCard />
          <BehaviourCard />
          <KnowledgeCard />
        </>
      )}
    </div>
  );
}

function Card({ icon, title, sub, children }) {
  return (
    <section className="bd-card">
      <div className="bd-card-head">
        <i className={`bi ${icon}`} aria-hidden="true" />
        <div>
          <h3 className="bd-card-title">{title}</h3>
          {sub && <div className="bd-card-sub">{sub}</div>}
        </div>
      </div>
      {children}
    </section>
  );
}

// ── ingestion ───────────────────────────────────────────────────────
const RUN_MESSAGES = {
  swept: (r) => `Started. ${r.enqueued_total ?? 0} document${r.enqueued_total === 1 ? '' : 's'} queued; they are processed over the next few minutes.`,
  partial: (r) => `Started, but some sources failed to queue (${r.enqueued_total ?? 0} queued). Check the failed list.`,
  too_soon: (r) => `A run started less than 5 minutes ago. Try again after ${fmt(r.next_allowed_at)}.`,
  already_running: (r) => `A run is already in progress${r.queued ? ` (${r.queued} still queued)` : ''}.`,
};

function IngestionCard() {
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => {
    ingestStats().then((s) => { setStats(s); setStatsErr(''); })
      .catch((e) => setStatsErr(e.message === 'not allowed' ? 'boss-only' : e.message));
  };
  useEffect(load, []);

  const run = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await runIngestion();
      setMsg((RUN_MESSAGES[r?.status] || (() => 'Done.'))(r || {}));
      load();
    } catch (e) {
      setMsg(e.message === 'not allowed' ? "You don't have permission to run ingestion." : `Couldn't start: ${e.message}`);
    } finally { setBusy(false); }
  };

  const q = stats?.queue || {};
  const failed = Array.isArray(stats?.failed) ? stats.failed : [];
  return (
    <Card icon="bi-arrow-repeat" title="Knowledge ingestion" sub="Buddy re-reads new and changed documents every 12 hours. Run it now after publishing something important.">
      <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={run} disabled={busy}>
          {busy ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-play-fill" /> Run ingestion now</>}
        </button>
        {msg && <span className="small" role="status">{msg}</span>}
      </div>
      {statsErr === 'boss-only' && <div className="bd-card-sub">Run history and queue numbers are visible to the Boss only.</div>}
      {statsErr && statsErr !== 'boss-only' && <div className="bd-error">Couldn't load ingestion stats: {statsErr}</div>}
      {stats && (
        <div className="bd-stats">
          <Stat label="Last run" value={fmt(stats.last_sweep_at)} />
          <Stat label="Next due" value={fmt(stats.next_sweep_due_at)} />
          <Stat label="Queued" value={(q.pending || 0) + (q.processing || 0)} />
          <Stat label="Failed" value={q.failed || 0} warn={(q.failed || 0) > 0} />
        </div>
      )}
      {failed.length > 0 && (
        <details className="mt-2">
          <summary className="small">Failed items ({failed.length})</summary>
          {failed.slice(0, 20).map((f) => (
            <div key={f.id} className="bd-row-line">
              <code>{f.source_type}</code> <span className="text-truncate">{f.source_id}</span>
              <span className="bd-card-sub text-truncate" title={f.last_error}>{f.last_error}</span>
            </div>
          ))}
        </details>
      )}
    </Card>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className={`bd-stat ${warn ? 'is-warn' : ''}`}>
      <div className="bd-stat-label">{label}</div>
      <div className="bd-stat-value">{value}</div>
    </div>
  );
}

// ── sources ────────────────────────────────────────────────────────
function SourcesCard() {
  const [on, setOn] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { getIngestSources().then(setOn).catch((e) => setErr(e.message)); }, []);

  const toggle = async (type) => {
    const next = on.includes(type) ? on.filter((t) => t !== type) : [...on, type];
    setSaving(true); setErr('');
    try { await setIngestSources(next); setOn(next); } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Card icon="bi-toggles" title="Sources" sub="What Buddy reads. A source switched off is removed from Buddy's memory at the next ingestion run.">
      {err && <div className="bd-error">{err}</div>}
      {!on ? <div className="bd-card-sub">Loading…</div> : INGEST_SOURCES.map(([type, label]) => (
        <div key={type} className="form-check form-switch">
          <input className="form-check-input" type="checkbox" role="switch" id={`src-${type}`}
            checked={on.includes(type)} disabled={saving} onChange={() => toggle(type)} />
          <label className="form-check-label small" htmlFor={`src-${type}`}>{label}</label>
        </div>
      ))}
    </Card>
  );
}

// ── excluded documents ──────────────────────────────────────────────
function ExcludedCard() {
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState({ type: 'kb_article', id: '', reason: '' });
  const [err, setErr] = useState('');
  const load = () => listExcluded().then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    setErr('');
    try { await addExcluded(form.type, form.id, form.reason); setForm({ ...form, id: '', reason: '' }); load(); }
    catch (ex) { setErr(ex.message); }
  };
  const drop = async (r) => {
    if (!window.confirm('Let Buddy read this document again? It comes back at the next ingestion run.')) return;
    try { await removeExcluded(r.source_type, r.source_id); load(); } catch (ex) { setErr(ex.message); }
  };

  return (
    <Card icon="bi-eye-slash" title="Excluded documents" sub="Hidden from Buddy for everyone, the Boss included. Removed from its memory at the next ingestion run.">
      {err && <div className="bd-error">{err}</div>}
      {rows?.length === 0 && <div className="bd-card-sub mb-2">Nothing excluded.</div>}
      {rows?.map((r) => (
        <div key={`${r.source_type}:${r.source_id}`} className="bd-row-line">
          <code>{r.source_type}</code>
          <span className="text-truncate" title={r.source_id}>{r.source_id}</span>
          <span className="bd-card-sub text-truncate">{r.reason}</span>
          <button type="button" className="bd-act" onClick={() => drop(r)} aria-label="Remove exclusion"><i className="bi bi-x-lg" /></button>
        </div>
      ))}
      <form className="bd-exclude-form" onSubmit={add}>
        <select className="form-select form-select-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} aria-label="Source type">
          {INGEST_SOURCES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
        </select>
        <input className="form-control form-control-sm" placeholder="Document id" value={form.id} required
          onChange={(e) => setForm({ ...form, id: e.target.value })} aria-label="Document id" />
        <input className="form-control form-control-sm" placeholder="Reason (optional)" value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-label="Reason" />
        <button type="submit" className="btn btn-sm btn-outline-secondary" disabled={!form.id.trim()}>Exclude</button>
      </form>
    </Card>
  );
}

// ── behaviour (moved from the old Train tab) ────────────────────────
// Must match ALLOWED_MODELS in Assistant/supabase/functions/_shared/ai/llm/openai.ts:
// the server falls back to the default for anything else.
const MODEL_OPTIONS = [
  { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini (fast, economical)' },
  { id: 'gpt-5.5', label: 'gpt-5.5 (stronger reasoning, higher cost)' },
];

function BehaviourCard() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');
  // An empty or v1-default greeting shows as Buddy's text, the one users see anyway.
  useEffect(() => {
    getAiConfig().then((c) => setCfg({ ...c, greeting: greetingIsDefault(c?.greeting) ? BUDDY_GREETING : c.greeting }))
      .catch((e) => setFlash(e.message));
  }, []);

  const save = async () => {
    setSaving(true); setFlash('');
    try {
      await updateAiConfig({ persona: cfg.persona, greeting: cfg.greeting, enabled: cfg.enabled, model: cfg.model });
      setFlash('Saved.');
    } catch (e) { setFlash(`Error: ${e.message}`); }
    finally { setSaving(false); setTimeout(() => setFlash(''), 2500); }
  };

  if (!cfg) return <Card icon="bi-sliders" title="Persona and behaviour"><div className="bd-card-sub">{flash || 'Loading…'}</div></Card>;
  return (
    <Card icon="bi-sliders" title="Persona and behaviour" sub="Buddy's personality and model. Accuracy rules always outrank the persona.">
      <label className="form-label small fw-semibold mb-1" htmlFor="bd-persona">Persona / instructions</label>
      <textarea id="bd-persona" className="form-control form-control-sm mb-2" rows={6} value={cfg.persona || ''} onChange={(e) => setCfg({ ...cfg, persona: e.target.value })} />
      <label className="form-label small fw-semibold mb-1" htmlFor="bd-greeting">Greeting</label>
      <textarea id="bd-greeting" className="form-control form-control-sm mb-1" rows={2} value={cfg.greeting || ''}
        placeholder={BUDDY_GREETING} onChange={(e) => setCfg({ ...cfg, greeting: e.target.value })} />
      <div className="bd-card-sub mb-2">Shown when a chat is empty. <code>{'{name}'}</code> becomes the person's first name; leave it blank for Buddy's default.</div>
      <div className="d-flex align-items-end gap-3 flex-wrap mb-3">
        <div>
          <label className="form-label small fw-semibold mb-1 d-block" htmlFor="bd-model">Model</label>
          <select id="bd-model" className="form-select form-select-sm" style={{ minWidth: 260 }}
            value={MODEL_OPTIONS.some((m) => m.id === cfg.model) ? cfg.model : MODEL_OPTIONS[0].id}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}>
            {MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="form-check form-switch mb-1">
          <input className="form-check-input" type="checkbox" role="switch" id="bd-enabled" checked={!!cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          <label className="form-check-label small" htmlFor="bd-enabled">Buddy enabled</label>
        </div>
      </div>
      <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
        {saving ? <span className="spinner-border spinner-border-sm" /> : 'Save'}
      </button>
      {flash && <span className="ms-2 small text-muted" role="status">{flash}</span>}
      <SlackRelayPanel />
    </Card>
  );
}

// ── curated knowledge docs (moved from the old Train tab) ───────────
function KnowledgeCard() {
  const [docs, setDocs] = useState([]);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');
  const load = () => listDocs().then(setDocs).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const persist = async () => {
    try { await saveDoc(editing); setEditing(null); load(); } catch (e) { setErr(`Save failed: ${e.message}`); }
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this knowledge entry?')) return;
    try { await deleteDoc(id); load(); } catch (e) { setErr(e.message); }
  };
  const toggle = async (d) => {
    try { await saveDoc({ ...d, is_active: !d.is_active }); load(); } catch (e) { setErr(e.message); }
  };

  return (
    <Card icon="bi-journal-text" title={`Knowledge docs (${docs.length})`} sub="Curated notes Buddy answers from, e.g. “Applying for leave”. Picked up at the next ingestion run.">
      {err && <div className="bd-error">{err}</div>}
      <button type="button" className="btn btn-sm btn-outline-secondary mb-2" onClick={() => setEditing({ title: '', content: '', is_active: true })}>
        <i className="bi bi-plus-lg" /> Add knowledge
      </button>
      {docs.map((d) => (
        <div key={d.id} className="bd-row-line">
          <button type="button" className={`bd-link ${d.is_active ? '' : 'is-off'}`} onClick={() => setEditing(d)}>{d.title}</button>
          {!d.is_active && <span className="bd-tag">Off</span>}
          <button type="button" className="bd-act" onClick={() => toggle(d)} aria-label={d.is_active ? 'Turn off' : 'Turn on'} title={d.is_active ? 'Active: click to turn off' : 'Off: click to turn on'}>
            <i className={`bi ${d.is_active ? 'bi-toggle-on' : 'bi-toggle-off'}`} />
          </button>
          <button type="button" className="bd-act is-danger" onClick={() => remove(d.id)} aria-label="Delete"><i className="bi bi-trash3" /></button>
        </div>
      ))}
      {editing && (
        <div className="wx-modal-backdrop bd-modal-backdrop" role="presentation">
          <div className="bd-modal" role="dialog" aria-modal="true" aria-labelledby="bd-doc-title">
            <div id="bd-doc-title" className="fw-bold mb-3">{editing.id ? 'Edit knowledge' : 'Add knowledge'}</div>
            <label className="form-label small fw-semibold mb-1" htmlFor="bd-doc-t">Title</label>
            <input id="bd-doc-t" className="form-control form-control-sm mb-2" placeholder="e.g. Applying for leave" value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            <label className="form-label small fw-semibold mb-1" htmlFor="bd-doc-c">Content</label>
            <textarea id="bd-doc-c" className="form-control form-control-sm mb-3" rows={9} value={editing.content}
              placeholder="Explain the steps or policy clearly. Buddy answers from this."
              onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
            <div className="d-flex justify-content-end gap-2">
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!editing.title.trim() || !editing.content.trim()} onClick={persist}>Save</button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Slack relay switch (moved from the old Train tab, unchanged) ────
// Routing is set by migration 357 and shown read-only; the only decision here
// is on or off. Changing where answers land is a security decision.
function SlackRelayPanel() {
  const [cfg, setCfg] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    getSlackConfig().then(setCfg).catch((e) => setErr(e.message));
    listSlackRelayLog(8).then(setLog).catch(() => {});
  }, []);

  async function toggle(on) {
    setBusy(true); setErr('');
    try { await setSlackEnabled(on); setCfg((c) => ({ ...c, enabled: on })); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!cfg) return null;
  const ready = !!cfg.dest_channel_id && !!cfg.answer_as_user_id
    && (cfg.source_channel_ids || []).length > 0 && (cfg.watch_user_ids || []).length > 0;

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-slack" style={{ color: 'var(--accent)' }} />
        <span className="fw-semibold small">Slack relay</span>
        <span className={`badge ${cfg.enabled ? 'bg-success' : 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>{cfg.enabled ? 'ON' : 'OFF'}</span>
      </div>
      <div className="bd-card-sub mb-2">
        When someone tags a watched person in a watched channel, Buddy answers with real WurxOS data and posts it into
        the destination channel only, never back where it was asked.
      </div>
      <div className="bd-card-sub mb-2" style={{ fontFamily: 'var(--font-mono)' }}>
        watching {(cfg.source_channel_ids || []).length} channel(s) · {(cfg.watch_user_ids || []).length} tagged person(s) → answers to <code>{cfg.dest_channel_id || '—'}</code>
      </div>
      {!ready && <div className="small text-warning mb-2">Routing is incomplete, so the relay can't be switched on yet.</div>}
      <div className="form-check form-switch">
        <input className="form-check-input" type="checkbox" id="slack-relay" role="switch"
          disabled={busy || !ready} checked={!!cfg.enabled} onChange={(e) => toggle(e.target.checked)} />
        <label className="form-check-label small" htmlFor="slack-relay">Answer questions from Slack</label>
      </div>
      {err && <div className="small text-danger mt-1">{err}</div>}
      {log.length > 0 && (
        <div className="mt-3">
          <div className="bd-card-sub fw-semibold mb-1">Recent</div>
          {log.map((r) => (
            <div key={r.id} className="bd-row-line">
              <i className={`bi ${r.posted ? 'bi-check-circle text-success' : 'bi-exclamation-circle text-warning'}`} />
              <span className="text-truncate" title={r.question}>{r.question}</span>
              <span className="bd-card-sub">{new Date(r.created_at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
