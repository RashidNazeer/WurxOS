import { Suspense, useEffect, useState } from 'react';
import { lazyWithRetry as lazy } from '../../lib/lazyWithRetry';
import {
  getAiConfig, updateAiConfig, listDocs, saveDoc, deleteDoc,
  getSlackConfig, setSlackEnabled, listSlackRelayLog,
} from '../../lib/aiAssistantApi';
import {
  runIngestion, ingestStats, INGEST_SOURCES, getIngestSources, setIngestSources,
  listExcluded, addExcluded, removeExcluded, getBuddyConfig, setAllowedRoles,
  listModelCatalog, refreshModelList, getModelConfig, saveModelConfig,
} from '../../lib/buddyApi';
import {
  ALL_ROLES, BUDDY_GREETING, greetingIsDefault, nextAllowedRoles,
  FALLBACK_MAX, KEY_SLOT_LABEL, chainAdd, chainMove, chainRemove, creditsExhausted, fmtUsd, lastChecked,
  modelLabel, modelOptions, optionKey, parseOptionKey,
} from '../../lib/buddyLogic';
import { LoadError } from '../../components/buddy/BuddyThread';

// Buddy settings (ui-design.md §4). Run ingestion: Boss + Developer (the
// ai_run_ingestion RPC enforces it). Everything else: Boss only (RLS on the
// config / docs / exclusion tables enforces it; this page only hides it).

// Boss-only; its own chunk because it brings recharts.
const BuddyUsage = lazy(() => import('./BuddyUsage'));

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export default function BuddySettings({ role }) {
  const isBoss = role === 'boss';
  return (
    <div className="bd-settings">
      <IngestionCard />
      {isBoss && (
        <>
          <Suspense fallback={<div className="bd-card"><span className="wx-spinner" style={{ color: 'var(--accent)' }} /></div>}>
            <BuddyUsage />
          </Suspense>
          <ModelCard />
          <AllowedRolesCard />
          <SourcesCard />
          <ExcludedCard />
          <BehaviourCard />
          <KnowledgeCard />
        </>
      )}
    </div>
  );
}

function SkeletonLines({ n = 3 }) {
  return (
    <div className="bd-skeleton-list" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => <div key={i} className="bd-skel is-row" style={{ width: `${55 + ((i * 17) % 40)}%` }} />)}
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
      {statsErr && statsErr !== 'boss-only' && <LoadError what="the ingestion stats" onRetry={load} compact />}
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

// ── who may use Buddy ──────────────────────────────────────────────
// ai_assistant_config.allowed_roles: the assistant function and the UI gate
// both read it. Ticking a role changes nothing until Save.
function AllowedRolesCard() {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => {
    setLoadErr(false);
    getBuddyConfig().then((c) => {
      if (!Array.isArray(c.allowedRoles)) { setLoadErr(true); return; }
      const r = nextAllowedRoles(c.allowedRoles, 'boss', true);
      setSaved(r); setDraft(r);
    });
  };
  useEffect(load, []);

  const dirty = saved && draft && saved.join() !== draft.join();
  const save = async () => {
    setSaving(true); setMsg('');
    try { await setAllowedRoles(draft); setSaved(draft); setMsg('Saved. People see the change the next time they load WurxOS.'); }
    catch (e) { setMsg(`Couldn't save: ${e.message}`); }
    finally { setSaving(false); }
  };

  return (
    <Card icon="bi-people" title="Who can use Buddy" sub="The roles that see Buddy and can ask it questions. Boss is always included.">
      {loadErr && <LoadError what="the allowed roles" onRetry={load} compact />}
      {!draft && !loadErr && <SkeletonLines n={4} />}
      {draft && (
        <>
          <fieldset className="bd-roles">
            <legend className="visually-hidden">Roles allowed to use Buddy</legend>
            {ALL_ROLES.map(([r, label]) => (
              <div key={r} className="form-check">
                <input className="form-check-input" type="checkbox" id={`bd-role-${r}`} checked={draft.includes(r)}
                  disabled={r === 'boss' || saving} onChange={(e) => setDraft(nextAllowedRoles(draft, r, e.target.checked))} />
                <label className="form-check-label small" htmlFor={`bd-role-${r}`}>{label}{r === 'boss' ? ' (always)' : ''}</label>
              </div>
            ))}
          </fieldset>
          <div className="d-flex align-items-center gap-2 flex-wrap mt-2">
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={save}>
              {saving ? <span className="spinner-border spinner-border-sm" /> : 'Save roles'}
            </button>
            {dirty && <button type="button" className="btn btn-sm btn-link" onClick={() => setDraft(saved)}>Undo</button>}
            {msg && <span className="small" role="status">{msg}</span>}
          </div>
          <div className="bd-card-sub mt-1">Each role's answers follow that person's own permissions: Buddy never shows someone data the app wouldn't.</div>
        </>
      )}
    </Card>
  );
}

// ── sources ────────────────────────────────────────────────────────
function SourcesCard() {
  const [on, setOn] = useState(null);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = () => { setLoadErr(false); getIngestSources().then(setOn).catch(() => setLoadErr(true)); };
  useEffect(load, []);

  const toggle = async (type) => {
    const next = on.includes(type) ? on.filter((t) => t !== type) : [...on, type];
    setSaving(true); setErr('');
    try { await setIngestSources(next); setOn(next); } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Card icon="bi-toggles" title="Sources" sub="What Buddy reads. A source switched off is removed from Buddy's memory at the next ingestion run.">
      {err && <div className="bd-error" role="alert">{err}</div>}
      {loadErr && <LoadError what="the sources" onRetry={load} compact />}
      {!on ? !loadErr && <SkeletonLines n={6} /> : INGEST_SOURCES.map(([type, label]) => (
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
  const [loadErr, setLoadErr] = useState(false);
  const load = () => listExcluded().then((r) => { setRows(r); setLoadErr(false); }).catch(() => setLoadErr(true));
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
      {err && <div className="bd-error" role="alert">{err}</div>}
      {loadErr && <LoadError what="the excluded documents" onRetry={load} compact />}
      {!rows && !loadErr && <SkeletonLines n={2} />}
      {rows?.length === 0 && <div className="bd-card-sub mb-2">Nothing excluded.</div>}
      {rows?.map((r) => (
        <div key={`${r.source_type}:${r.source_id}`} className="bd-row-line">
          <code>{r.source_type}</code>
          <span className="text-truncate" title={r.source_id}>{r.source_id}</span>
          <span className="bd-card-sub text-truncate">{r.reason}</span>
          <button type="button" className="bd-act" onClick={() => drop(r)} aria-label={`Stop excluding ${r.source_type} ${r.source_id}`} title="Remove exclusion"><i className="bi bi-x-lg" aria-hidden="true" /></button>
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

// ── model and fallbacks (mig 397) ───────────────────────────────────
// Any model the Boss's keys can use. ai_model_catalog lists what each key
// (main = paid, fallback = free) can do, filled by "Refresh model list"; the
// database refuses a model that can't run Buddy (no tools / streaming).
function ModelCard() {
  const [catalog, setCatalog] = useState(null);
  const [saved, setSaved] = useState(null);   // { model, model_key_slot, fallback_models, fallback_enabled }
  const [draft, setDraft] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [refresh, setRefresh] = useState(null); // last refresh result
  const [refreshing, setRefreshing] = useState(null); // { started, n }
  const [elapsed, setElapsed] = useState(0);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [add, setAdd] = useState('');

  const load = () => {
    setLoadErr(false);
    Promise.all([listModelCatalog(), getModelConfig()]).then(([cat, cfg]) => {
      const c = {
        model: cfg.model || 'gpt-5.4-mini', model_key_slot: cfg.model_key_slot || 'primary',
        fallback_models: Array.isArray(cfg.fallback_models) ? cfg.fallback_models : [],
        fallback_enabled: cfg.fallback_enabled !== false,
      };
      setCatalog(cat); setSaved(c); setDraft(c);
    }).catch(() => setLoadErr(true));
  };
  useEffect(load, []);
  useEffect(() => {
    if (!refreshing) return undefined;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - refreshing.started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [refreshing]);

  const options = modelOptions(catalog || []);
  const usable = [...options.primary, ...options.fallback].filter((o) => o.usable);
  const current = draft && [...options.primary, ...options.fallback].find((o) => o.key_slot === draft.model_key_slot && o.model === draft.model);
  const dirty = saved && draft && JSON.stringify(saved) !== JSON.stringify(draft);
  const checkedAt = lastChecked(catalog);
  const noCredits = creditsExhausted(catalog || [], refresh);

  const doRefresh = async () => {
    setMsg(''); setElapsed(0);
    setRefreshing({ started: Date.now(), n: (catalog || []).length });
    try {
      const r = await refreshModelList();
      setRefresh(r);
      const s = r.slots || {};
      const parts = Object.entries(s).map(([slot, v]) => (v.error
        ? `${KEY_SLOT_LABEL[slot] || slot}: couldn't list models (${v.error})`
        : `${KEY_SLOT_LABEL[slot] || slot}: ${v.usable} of ${v.probed} usable${v.free?.length ? `, ${v.free.length} free` : ''}`));
      setMsg(`Checked. ${parts.join(' · ')}. The check cost about ${fmtUsd(r.probe_cost_usd_est || 0)}.`);
      setCatalog(await listModelCatalog());
    } catch (e) {
      setMsg(e?.status === 403 ? 'Only the Boss can refresh the model list.' : `Couldn't refresh: ${e.message || 'network error'}`);
    } finally { setRefreshing(null); }
  };

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await saveModelConfig(draft);
      setSaved(draft); setMsg('Saved. New questions use this from now on.');
    } catch (e) { setMsg(`Not saved: ${e.message}`); }
    finally { setSaving(false); }
  };

  const setChain = (fallback_models) => setDraft({ ...draft, fallback_models });

  return (
    <Card icon="bi-cpu" title="Model" sub="Which OpenAI model writes Buddy's answers, and what it falls back to.">
      {noCredits && (
        <div className="bd-banner" role="alert">
          <i className="bi bi-exclamation-triangle" aria-hidden="true" />
          <span>Main OpenAI key has no credits: Buddy is answering with the free fallback. Top up at platform.openai.com → Billing.</span>
        </div>
      )}
      {loadErr && <LoadError what="the model settings" onRetry={load} compact />}
      {!draft && !loadErr && <SkeletonLines n={4} />}
      {draft && (
        <>
          <label className="form-label small fw-semibold mb-1" htmlFor="bd-model">Model</label>
          <select id="bd-model" className="form-select form-select-sm bd-model-select" aria-describedby="bd-model-badges"
            value={optionKey(draft.model_key_slot, draft.model)}
            onChange={(e) => { const p = parseOptionKey(e.target.value); if (p) setDraft({ ...draft, model: p.model, model_key_slot: p.key_slot }); }}>
            {!current && <option value={optionKey(draft.model_key_slot, draft.model)}>{draft.model} (not in the list)</option>}
            {['primary', 'fallback'].map((slot) => options[slot].length > 0 && (
              <optgroup key={slot} label={KEY_SLOT_LABEL[slot]}>
                {options[slot].map((o) => (
                  <option key={o.model} value={optionKey(slot, o.model)} disabled={!o.usable}>
                    {o.label}{o.badges.length ? ` · ${o.badges.join(' · ')}` : ''}{!o.usable && o.reason ? ` (${o.reason})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <div id="bd-model-badges" className="bd-badges mt-1">
            <span className="bd-badge-chip">{KEY_SLOT_LABEL[draft.model_key_slot]}</span>
            {current?.badges.map((b) => <span key={b} className={`bd-badge-chip ${b === 'Not usable' || b === 'Needs credits' ? 'is-warn' : ''}`}>{b}</span>)}
          </div>

          <div className="d-flex align-items-center gap-2 flex-wrap mt-2">
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={doRefresh} disabled={!!refreshing}>
              {refreshing ? <><span className="spinner-border spinner-border-sm" aria-hidden="true" /> Checking {refreshing.n ? `${refreshing.n} models` : 'the models'}… {elapsed}s</> : <><i className="bi bi-arrow-clockwise" aria-hidden="true" /> Refresh model list</>}
            </button>
            <span className="bd-card-sub">{refreshing ? 'This takes about a minute.' : `Last checked: ${checkedAt ? new Date(checkedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never'}`}</span>
          </div>

          <h4 className="bd-subhead">Fallbacks</h4>
          <div className="form-check form-switch">
            <input className="form-check-input" type="checkbox" role="switch" id="bd-fb-on" checked={draft.fallback_enabled}
              onChange={(e) => setDraft({ ...draft, fallback_enabled: e.target.checked })} />
            <label className="form-check-label small" htmlFor="bd-fb-on">Use fallback models</label>
          </div>
          <ol className="bd-chain" aria-label="Fallback order">
            {draft.fallback_models.length === 0 && <li className="bd-card-sub">No fallbacks.</li>}
            {draft.fallback_models.map((f, i) => {
              const ok = usable.some((o) => o.key_slot === f.key_slot && o.model === f.model);
              return (
                <li key={`${f.key_slot}|${f.model}`} className={`bd-row-line ${draft.fallback_enabled ? '' : 'is-off'}`}>
                  <span className="bd-chain-n" aria-hidden="true">{i + 1}</span>
                  <span className="text-truncate">{modelLabel(f.model)}</span>
                  <span className="bd-badge-chip">{f.key_slot === 'primary' ? 'Main' : 'Fallback'}</span>
                  {!ok && catalog?.length > 0 && <span className="bd-badge-chip is-warn" title="Not usable right now; it will be skipped">Skipped</span>}
                  <button type="button" className="bd-act" disabled={i === 0} onClick={() => setChain(chainMove(draft.fallback_models, i, -1))} aria-label={`Move ${f.model} up`}><i className="bi bi-arrow-up" aria-hidden="true" /></button>
                  <button type="button" className="bd-act" disabled={i === draft.fallback_models.length - 1} onClick={() => setChain(chainMove(draft.fallback_models, i, 1))} aria-label={`Move ${f.model} down`}><i className="bi bi-arrow-down" aria-hidden="true" /></button>
                  <button type="button" className="bd-act is-danger" onClick={() => setChain(chainRemove(draft.fallback_models, i))} aria-label={`Remove ${f.model} from the fallbacks`}><i className="bi bi-x-lg" aria-hidden="true" /></button>
                </li>
              );
            })}
          </ol>
          {draft.fallback_models.length < FALLBACK_MAX && (
            <div className="bd-chain-add">
              <select className="form-select form-select-sm" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Model to add as a fallback">
                <option value="">Add a fallback…</option>
                {['primary', 'fallback'].map((slot) => {
                  const list = usable.filter((o) => o.key_slot === slot && !draft.fallback_models.some((f) => f.key_slot === slot && f.model === o.model));
                  return list.length > 0 && (
                    <optgroup key={slot} label={KEY_SLOT_LABEL[slot]}>
                      {list.map((o) => <option key={o.model} value={optionKey(slot, o.model)}>{o.label}{o.badges.includes('Free') ? ' · Free' : ''}</option>)}
                    </optgroup>
                  );
                })}
              </select>
              <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!add}
                onClick={() => { setChain(chainAdd(draft.fallback_models, parseOptionKey(add))); setAdd(''); }}>Add</button>
            </div>
          )}
          <div className="bd-card-sub mt-1">
            Used automatically when the main model fails because of credits or the key. Free models may share data with OpenAI; check the fallback project's data-sharing setting.
          </div>
          <div className="bd-card-sub mt-1">The Slack relay still runs on the older engine: it uses the chosen model only if it is gpt-5.4-mini or gpt-5.5, otherwise mini, and it has no fallbacks.</div>

          <div className="d-flex align-items-center gap-2 flex-wrap mt-3">
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={save}>
              {saving ? <span className="spinner-border spinner-border-sm" /> : 'Save model settings'}
            </button>
            {dirty && <button type="button" className="btn btn-sm btn-link" onClick={() => setDraft(saved)}>Undo</button>}
          </div>
        </>
      )}
      {msg && <div className="small mt-2" role="status">{msg}</div>}
    </Card>
  );
}

// ── behaviour (moved from the old Train tab) ────────────────────────

function BehaviourCard() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');
  const [loadErr, setLoadErr] = useState(false);
  // An empty or v1-default greeting shows as Buddy's text, the one users see anyway.
  const load = () => {
    setLoadErr(false);
    getAiConfig().then((c) => setCfg({ ...c, greeting: greetingIsDefault(c?.greeting) ? BUDDY_GREETING : c.greeting }))
      .catch(() => setLoadErr(true));
  };
  useEffect(load, []);

  const save = async () => {
    setSaving(true); setFlash('');
    try {
      await updateAiConfig({ persona: cfg.persona, greeting: cfg.greeting, enabled: cfg.enabled });
      setFlash('Saved.');
    } catch (e) { setFlash(`Error: ${e.message}`); }
    finally { setSaving(false); setTimeout(() => setFlash(''), 2500); }
  };

  if (!cfg) {
    return (
      <Card icon="bi-sliders" title="Persona and behaviour">
        {loadErr ? <LoadError what="Buddy's settings" onRetry={load} compact /> : <SkeletonLines n={4} />}
      </Card>
    );
  }
  // What reads each field: the assistant function (Buddy) reads persona,
  // model, enabled; the Slack relay (v1 ai-chat) reads the same three; the
  // greeting is only Buddy's empty-chat line.
  return (
    <Card icon="bi-sliders" title="Persona and behaviour" sub="Buddy's personality and greeting. Accuracy rules always outrank the persona.">
      <label className="form-label small fw-semibold mb-1" htmlFor="bd-persona">Persona / instructions</label>
      <textarea id="bd-persona" className="form-control form-control-sm mb-1" rows={6} value={cfg.persona || ''}
        aria-describedby="bd-persona-help" onChange={(e) => setCfg({ ...cfg, persona: e.target.value })} />
      <div id="bd-persona-help" className="bd-card-sub mb-2">Used by Buddy and by the Slack relay. Leave it blank for Buddy's built-in personality.</div>
      <label className="form-label small fw-semibold mb-1" htmlFor="bd-greeting">Greeting</label>
      <textarea id="bd-greeting" className="form-control form-control-sm mb-1" rows={2} value={cfg.greeting || ''}
        aria-describedby="bd-greeting-help" placeholder={BUDDY_GREETING} onChange={(e) => setCfg({ ...cfg, greeting: e.target.value })} />
      <div id="bd-greeting-help" className="bd-card-sub mb-2">Shown when a Buddy chat is empty. <code>{'{name}'}</code> becomes the person's first name; leave it blank for Buddy's default.</div>
      <div className="form-check form-switch mb-1">
        <input className="form-check-input" type="checkbox" role="switch" id="bd-enabled" checked={!!cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <label className="form-check-label small" htmlFor="bd-enabled">Buddy enabled</label>
      </div>
      <div className="bd-card-sub mb-3">Applies to Buddy and to the Slack relay. Switched off, both answer "turned off by an admin". The model is chosen in the Model section.</div>
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
  const [docs, setDocs] = useState(null);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState(false);
  const load = () => listDocs().then((d) => { setDocs(d); setLoadErr(false); }).catch(() => setLoadErr(true));
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
    <Card icon="bi-journal-text" title={`Knowledge docs${docs ? ` (${docs.length})` : ''}`}
      sub="Curated notes Buddy (and the Slack relay) answer from, e.g. “Applying for leave”. Buddy picks them up at the next ingestion run.">
      {err && <div className="bd-error" role="alert">{err}</div>}
      {loadErr && <LoadError what="the knowledge docs" onRetry={load} compact />}
      <button type="button" className="btn btn-sm btn-outline-secondary mb-2" onClick={() => setEditing({ title: '', content: '', is_active: true })}>
        <i className="bi bi-plus-lg" aria-hidden="true" /> Add knowledge
      </button>
      {!docs && !loadErr && <SkeletonLines n={3} />}
      {docs?.map((d) => (
        <div key={d.id} className="bd-row-line">
          <button type="button" className={`bd-link ${d.is_active ? '' : 'is-off'}`} onClick={() => setEditing(d)}>{d.title}</button>
          {!d.is_active && <span className="bd-tag">Off</span>}
          <button type="button" className="bd-act" onClick={() => toggle(d)} aria-pressed={!!d.is_active}
            aria-label={`${d.is_active ? 'Turn off' : 'Turn on'} “${d.title}”`} title={d.is_active ? 'Active: click to turn off' : 'Off: click to turn on'}>
            <i className={`bi ${d.is_active ? 'bi-toggle-on' : 'bi-toggle-off'}`} aria-hidden="true" />
          </button>
          <button type="button" className="bd-act is-danger" onClick={() => remove(d.id)} aria-label={`Delete “${d.title}”`} title="Delete">
            <i className="bi bi-trash3" aria-hidden="true" />
          </button>
        </div>
      ))}
      {editing && (
        <div className="wx-modal-backdrop bd-modal-backdrop" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}>
          <div className="bd-modal" role="dialog" aria-modal="true" aria-labelledby="bd-doc-title">
            <div id="bd-doc-title" className="fw-bold mb-3">{editing.id ? 'Edit knowledge' : 'Add knowledge'}</div>
            <label className="form-label small fw-semibold mb-1" htmlFor="bd-doc-t">Title</label>
            <input id="bd-doc-t" autoFocus className="form-control form-control-sm mb-2" placeholder="e.g. Applying for leave" value={editing.title}
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
        <span className="badge" style={{ background: cfg.enabled ? 'var(--success)' : 'var(--surface-3)', color: cfg.enabled ? 'var(--on-success)' : 'var(--text-secondary)', fontSize: '0.65rem' }}>{cfg.enabled ? 'ON' : 'OFF'}</span>
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
