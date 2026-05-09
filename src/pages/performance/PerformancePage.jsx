import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  METRICS, LEVEL_META, PILLARS, currentMonth, getMyRating, upsertRating,
  listFlags, addFlag, deleteFlag, listWarnings, addWarning,
  getCompositeFor, getOverview, getConfig, updateConfig,
} from '../../lib/performanceApi';
import {
  AlertIcon, RefreshIcon, PlusIcon, XIcon, CheckIcon, StarIcon, ShieldIcon, SettingsIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

const ROLE_TABS = [
  { key: 'all',       label: 'All' },
  { key: 'ol',        label: 'Operation Leads' },
  { key: 'tl',        label: 'Team Leads' },
  { key: 'pctl',      label: 'PCTLs' },
  { key: 'apc',       label: 'APCs' },
  { key: 'ipc',       label: 'IPCs' },
  { key: 'developer', label: 'Developers' },
];

const LEVEL_FILTERS = ['all', 'promotion', 'good', 'warning', 'termination', 'not_rated'];

export default function PerformancePage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isManager = ['boss', 'ol', 'developer', 'tl', 'pctl'].includes(role);
  const isBoss    = role === 'boss';

  const [month, setMonth] = useState(currentMonth());
  const [rateUser, setRateUser] = useState(null);
  const [flagUser, setFlagUser] = useState(null);
  const [showConfig, setShowConfig] = useState(false);

  const [roleTab, setRoleTab]     = useState('all');
  const [levelFilter, setLevel]   = useState('all');
  const [q, setQ]                 = useState('');

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['perf', 'composite', user?.id, month], queryFn: () => getCompositeFor(user.id, month), enabled: !!user?.id && !isBoss },
      { queryKey: ['perf', 'rating',    user?.id, month], queryFn: () => getMyRating(user.id, month),     enabled: !!user?.id && !isBoss },
      { queryKey: ['perf', 'warnings',  user?.id],         queryFn: () => listWarnings(user.id),          enabled: !!user?.id && !isBoss },
      { queryKey: ['perf', 'overview',  month],            queryFn: () => getOverview(month),             enabled: !!user?.id && isManager },
    ],
  });
  const [compositeQ, ratingQ, warningsQ, overviewQ] = results;
  const myComposite = compositeQ.data || null;
  const myRating    = ratingQ.data || null;
  const myWarnings  = warningsQ.data || [];
  const overview    = overviewQ.data || [];
  // Use isLoading (= isPending && fetchStatus === 'fetching') instead of
  // isPending: in React Query v5 a *disabled* query stays in isPending=true
  // forever, which previously stuck the Boss view on "Loading…" because
  // compositeQ is disabled for Boss (`enabled: !isBoss`).
  const loading     = (compositeQ.isLoading && !isBoss) || (isManager && overviewQ.isLoading);
  const err         = results.find((r) => r.error)?.error?.message || '';

  const reloadAll = () => qc.invalidateQueries({ queryKey: ['perf'] });

  const filteredOverview = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return (overview || []).filter((r) => {
      if (roleTab !== 'all' && r.role !== roleTab) return false;
      if (levelFilter !== 'all' && r.level !== levelFilter) return false;
      if (qq && !(r.display_name || '').toLowerCase().includes(qq)) return false;
      return true;
    });
  }, [overview, roleTab, levelFilter, q]);

  const myWarningCount = myWarnings.length;

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Performance</h1>
          <p className="page-subtitle">4-pillar composite score, flags &amp; warnings.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="month" className="wx-input" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 160 }} />
          <button className="wx-btn wx-btn-ghost" onClick={reloadAll} title="Refresh"><RefreshIcon width="15" height="15" /></button>
          {isBoss && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setShowConfig(true)} title="Scoring config">
              <SettingsIcon width="15" height="15" /> Config
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {!isBoss && myWarningCount >= 3 && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <ShieldIcon width="16" height="16" /> <span><strong>Termination risk:</strong> you have {myWarningCount} formal warnings on record.</span>
        </div>
      )}

      {/* My composite — hidden for Boss (not rated; only rates others) */}
      {!isBoss && (
        <MyCompositeCard composite={myComposite} rating={myRating} month={month} />
      )}

      {/* Team overview */}
      {isManager && (
        <div className="wx-card" style={{ padding: 0, marginTop: 16 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Team — {month}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="wx-input" placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
              <select className="wx-input" value={levelFilter} onChange={(e) => setLevel(e.target.value)} style={{ width: 150 }}>
                {LEVEL_FILTERS.map((l) => <option key={l} value={l}>{l === 'all' ? 'All levels' : LEVEL_META[l]?.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{ padding: '8px 12px', display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border-subtle)' }}>
            {ROLE_TABS.map((t) => (
              <button key={t.key} type="button"
                onClick={() => setRoleTab(t.key)}
                className={`wx-role-chip ${roleTab === t.key ? 'wx-role-chip-active' : ''}`}>
                {t.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
          ) : filteredOverview.length === 0 ? (
            <div className="wx-empty">No users match this filter.</div>
          ) : (
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
              gap: 12, padding: 14,
            }}>
              {filteredOverview.map((r) => (
                <TeamCard key={r.user_id} row={r}
                  onRate={() => setRateUser({ id: r.user_id, display_name: r.display_name, role: r.role })}
                  onFlags={() => setFlagUser({ id: r.user_id, display_name: r.display_name, role: r.role })} />
              ))}
            </div>
          )}
        </div>
      )}

      {rateUser && (
        <RateModal user={rateUser} month={month} onClose={() => setRateUser(null)} onSaved={() => { setRateUser(null); reloadAll(); }} />
      )}
      {flagUser && (
        <FlagsModal user={flagUser} onClose={() => { setFlagUser(null); reloadAll(); }} />
      )}
      {showConfig && (
        <ConfigModal onClose={() => setShowConfig(false)} onSaved={() => { setShowConfig(false); reloadAll(); }} />
      )}
    </>
  );
}

// ============================================================
function LevelBadge({ level }) {
  const meta = LEVEL_META[level] || LEVEL_META.not_rated;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700,
      background: `color-mix(in srgb, ${meta.color} 15%, transparent)`,
      color: meta.color,
      border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
    }}>
      {meta.label}
    </span>
  );
}

function PillarBar({ label, value, weight }) {
  const v = value == null ? 0 : Number(value);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span>{label}{weight != null && <span style={{ marginLeft: 5, opacity: 0.7 }}>· {weight}%</span>}</span>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{value == null ? '—' : v.toFixed(1)}</span>
      </div>
      <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, marginTop: 4 }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, v))}%`, background: 'var(--accent)', borderRadius: 999 }} />
      </div>
    </div>
  );
}

function MyCompositeCard({ composite, rating, month }) {
  const [cfg, setCfg] = useState(null);
  useEffect(() => { getConfig().then(setCfg).catch(() => {}); }, []);

  const composite_score = composite?.composite_score;
  const level = composite?.level || 'not_rated';
  const warnings = Number(composite?.warning_count || 0);

  return (
    <div className="wx-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Your composite · {month}
          </div>
          {composite_score == null ? (
            // Not Rated Yet — shows when the OL/TL hasn't recorded a
            // performance rating for this user/month. Auto-calc pillars
            // below still render so the user can watch trends, but the
            // composite + level pill collapse to a neutral state to
            // avoid implying an evaluation has happened.
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 999,
                background: 'var(--surface-2)', color: 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
                fontWeight: 700, fontSize: 13,
              }}>
                ⏳ Not Rated Yet
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Performance is rated at the end of {month}
              </span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <div style={{ fontSize: 34, fontWeight: 800 }}>
                  {Number(composite_score).toFixed(1)}
                  <span style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 500 }}> / 100</span>
                </div>
                <LevelBadge level={level} />
              </div>
              {rating?.evaluator?.display_name && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
                  Rated by {rating.evaluator.display_name} · {new Date(rating.updated_at).toLocaleDateString()}
                </div>
              )}
            </>
          )}
        </div>
        {/* Warning strike indicator */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          background: warnings >= 3 ? 'var(--danger)' : warnings > 0 ? 'color-mix(in srgb, var(--warning) 16%, transparent)' : 'var(--surface-2)',
          color:      warnings >= 3 ? '#fff' : warnings > 0 ? 'var(--warning)' : 'var(--text-muted)',
        }}>
          <ShieldIcon width="16" height="16" />
          <div style={{ fontSize: 12 }}>
            <div style={{ fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 10 }}>
              Warnings
            </div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{warnings} / 3</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginTop: 16 }}>
        {PILLARS.map((p) => (
          <PillarBar key={p.key} label={p.label} value={composite?.[p.key]} weight={cfg?.[p.weightKey]} />
        ))}
      </div>

      {rating?.metrics && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
            Metric breakdown (performance pillar)
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 10 }}>
            {METRICS.map((m) => {
              const v10 = Number(rating.metrics?.[m.key] || 0);
              return (
                <div key={m.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-muted)' }}>
                    <span>{m.label}</span><span>{v10.toFixed(1)}/10</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, marginTop: 4 }}>
                    <div style={{ height: '100%', width: `${Math.min(100, v10 * 10)}%`, background: 'var(--accent)', borderRadius: 999 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function TeamCard({ row, onRate, onFlags }) {
  const isRated = row.composite_score != null;
  return (
    <div style={{
      padding: 14, background: 'var(--surface-1)', borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.display_name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {row.role}
          </div>
        </div>
        {isRated && <LevelBadge level={row.level} />}
      </div>

      {isRated ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10 }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>
            {Number(row.composite_score).toFixed(1)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>/ 100</div>
        </div>
      ) : (
        // Auto-calc pillars below still render — managers can watch
        // attendance / incentives / flags trends. Only the composite
        // is hidden until OL records a rating.
        <div style={{ marginTop: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'var(--surface-2)', color: 'var(--text-secondary)',
            border: '1px solid var(--border-subtle)',
            fontSize: 11.5, fontWeight: 700,
          }}>
            ⏳ Not Rated Yet
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
        <PillarBar label="Performance" value={row.performance_score} />
        <PillarBar label="Incentives"  value={row.incentives_score} />
        <PillarBar label="Attendance"  value={row.attendance_score} />
        <PillarBar label="Flags"       value={row.flags_score} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--success)' }}>●</span> {row.green_flags} green
        <span style={{ color: 'var(--danger)', marginLeft: 8 }}>●</span> {row.red_flags} red
        {row.warning_count > 0 && (
          <span style={{ color: 'var(--danger)', marginLeft: 8, fontWeight: 700 }}>
            ⚠ {row.warning_count} warning{row.warning_count === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button className="wx-btn wx-btn-ghost" onClick={onRate} style={{ padding: '5px 10px', fontSize: 12, flex: 1 }}>
          <StarIcon width="12" height="12" /> Rate
        </button>
        <button className="wx-btn wx-btn-ghost" onClick={onFlags} style={{ padding: '5px 10px', fontSize: 12, flex: 1 }}>
          Flags &amp; warnings
        </button>
      </div>
    </div>
  );
}

// ============================================================
function RateModal({ user, month, onClose, onSaved }) {
  const [metrics, setMetrics] = useState(() => Object.fromEntries(METRICS.map((m) => [m.key, 7])));
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  useEffect(() => {
    (async () => {
      const existing = await getMyRating(user.id, month);
      if (existing) setMetrics((cur) => ({ ...cur, ...(existing.metrics || {}) }));
    })();
  }, [user.id, month]);

  const avg = useMemo(() => {
    const vals = METRICS.map((m) => Number(metrics[m.key] || 0));
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [metrics]);

  async function save() {
    setSaving(true); setErr('');
    try { await upsertRating(user.id, month, metrics); onSaved(); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Rate {user.display_name} · {month}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
          <div style={{ marginBottom: 14, padding: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Average (performance pillar)</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{avg.toFixed(1)}<span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}> / 10 · ({(avg * 10).toFixed(0)} / 100)</span></div>
          </div>
          {METRICS.map((m) => (
            <div key={m.key} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <label className="wx-label" style={{ margin: 0 }}>{m.label}</label>
                <span style={{ fontWeight: 700 }}>{metrics[m.key]}</span>
              </div>
              <input type="range" min={0} max={10} step={0.5}
                value={metrics[m.key]}
                onChange={(e) => setMetrics({ ...metrics, [m.key]: Number(e.target.value) })}
                disabled={saving}
                style={{ width: '100%' }} />
            </div>
          ))}
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
            {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save rating</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
function FlagsModal({ user, onClose }) {
  const { profile } = useAuth();
  const isBoss = profile?.role === 'boss' || profile?.role === 'developer';

  const [flags, setFlags]       = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [newFlag, setNewFlag]   = useState({ type: 'red', severity: 'medium', reason: '' });
  const [newWarn, setNewWarn]   = useState({ severity: 'medium', reason: '' });
  const [err, setErr]           = useState('');

  async function reload() {
    try {
      setFlags(await listFlags(user.id));
      setWarnings(await listWarnings(user.id));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { reload(); }, [user.id]);

  async function add() {
    if (!newFlag.reason.trim()) return;
    try { await addFlag(user.id, newFlag); setNewFlag({ type: 'red', severity: 'medium', reason: '' }); reload(); }
    catch (e) { setErr(e.message); }
  }
  async function remove(id) {
    try { await deleteFlag(id); reload(); } catch (e) { setErr(e.message); }
  }
  async function addWarn() {
    if (!newWarn.reason.trim()) return;
    try { await addWarning(user.id, newWarn); setNewWarn({ severity: 'medium', reason: '' }); reload(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Flags &amp; warnings — {user.display_name}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Flags ({flags.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            {flags.map((f) => (
              <div key={f.id} className="perf-flag-row" style={{
                display: 'grid', gridTemplateColumns: '70px 80px 1fr auto',
                gap: 8, alignItems: 'center', fontSize: 12.5,
                padding: '6px 8px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
              }}>
                <span style={{
                  fontWeight: 700, color: f.type === 'green' ? 'var(--success)' : 'var(--danger)',
                  textTransform: 'capitalize',
                }}>{f.type}</span>
                <span style={{ color: 'var(--text-muted)' }}>{f.severity}</span>
                <span>{f.reason}</span>
                <button onClick={() => remove(f.id)} style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  <XIcon width="12" height="12" />
                </button>
              </div>
            ))}
          </div>
          <div className="perf-flag-add" style={{ display: 'grid', gridTemplateColumns: '80px 90px 1fr auto', gap: 6, marginBottom: 16 }}>
            <select className="wx-input" value={newFlag.type} onChange={(e) => setNewFlag({ ...newFlag, type: e.target.value })}>
              <option value="green">green</option><option value="red">red</option>
            </select>
            <select className="wx-input" value={newFlag.severity} onChange={(e) => setNewFlag({ ...newFlag, severity: e.target.value })}>
              <option>low</option><option>medium</option><option>high</option><option>critical</option>
            </select>
            <input className="wx-input" placeholder="Reason" value={newFlag.reason} onChange={(e) => setNewFlag({ ...newFlag, reason: e.target.value })} />
            <button className="wx-btn wx-btn-primary" onClick={add}><PlusIcon width="12" height="12" /></button>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Warnings ({warnings.length} / 3)</span>
            {warnings.length >= 3 && (
              <span style={{
                padding: '2px 7px', borderRadius: 999, background: 'var(--danger)', color: '#fff',
                fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
              }}>TERMINATION RISK</span>
            )}
            {!isBoss && (
              <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 'auto', fontWeight: 500 }}>
                Boss-only
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            {warnings.map((w) => (
              <div key={w.id} style={{
                padding: '6px 8px', background: 'var(--danger-soft)', borderRadius: 'var(--radius-sm)',
                fontSize: 12.5, color: 'var(--danger)',
              }}>
                <strong>[{w.severity}]</strong> {w.reason} · {new Date(w.created_at).toLocaleDateString()}
              </div>
            ))}
          </div>
          {isBoss && (
            <div className="perf-warn-add" style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 6 }}>
              <select className="wx-input" value={newWarn.severity} onChange={(e) => setNewWarn({ ...newWarn, severity: e.target.value })}>
                <option>low</option><option>medium</option><option>high</option><option>critical</option>
              </select>
              <input className="wx-input" placeholder="Formal warning reason" value={newWarn.reason} onChange={(e) => setNewWarn({ ...newWarn, reason: e.target.value })} />
              <button className="wx-btn wx-btn-ghost" onClick={addWarn} style={{ color: 'var(--danger)' }}><PlusIcon width="12" height="12" /></button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
function ConfigModal({ onClose, onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { getConfig().then(setCfg).catch((e) => setErr(e.message)); }, []);

  const weightSum = cfg
    ? Number(cfg.weight_performance) + Number(cfg.weight_incentives)
      + Number(cfg.weight_attendance) + Number(cfg.weight_flags)
    : 0;

  async function save() {
    setSaving(true); setErr('');
    try { await updateConfig(cfg); onSaved(); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  if (!cfg) return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wx-empty"><span className="wx-spinner" /> Loading config…</div>
      </div>
    </div>
  );

  const patch = (k, v) => setCfg({ ...cfg, [k]: v });

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Performance scoring config</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Pillar weights (must sum to 100)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 6 }}>
            <NumField label="Performance %"  value={cfg.weight_performance} onChange={(v) => patch('weight_performance', v)} />
            <NumField label="Incentives %"   value={cfg.weight_incentives}  onChange={(v) => patch('weight_incentives', v)} />
            <NumField label="Attendance %"   value={cfg.weight_attendance}  onChange={(v) => patch('weight_attendance', v)} />
            <NumField label="Flags %"        value={cfg.weight_flags}       onChange={(v) => patch('weight_flags', v)} />
          </div>
          <div style={{ fontSize: 12, color: Math.abs(weightSum - 100) < 0.01 ? 'var(--success)' : 'var(--danger)', marginBottom: 14 }}>
            Total: {weightSum.toFixed(1)}%
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Attendance baseline
          </div>
          <NumField label="Minimum attendance days / month" value={cfg.min_attendance_days} onChange={(v) => patch('min_attendance_days', v)} />
          <div style={{ marginBottom: 14 }} />

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Level thresholds (composite 0-100)
          </div>
          <div className="perf-cfg-3col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
            <NumField label="Promotion ≥" value={cfg.threshold_promotion} onChange={(v) => patch('threshold_promotion', v)} />
            <NumField label="Good ≥"      value={cfg.threshold_good}      onChange={(v) => patch('threshold_good', v)} />
            <NumField label="Warning ≥"   value={cfg.threshold_warning}   onChange={(v) => patch('threshold_warning', v)} />
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Flag point values (added for green / subtracted for red)
          </div>
          <div className="perf-cfg-4col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <NumField label="Low"      value={cfg.flag_pts_low}      onChange={(v) => patch('flag_pts_low', v)} />
            <NumField label="Medium"   value={cfg.flag_pts_medium}   onChange={(v) => patch('flag_pts_medium', v)} />
            <NumField label="High"     value={cfg.flag_pts_high}     onChange={(v) => patch('flag_pts_high', v)} />
            <NumField label="Critical" value={cfg.flag_pts_critical} onChange={(v) => patch('flag_pts_critical', v)} />
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving || Math.abs(weightSum - 100) > 0.01}>
            {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }) {
  return (
    <div>
      <label className="wx-label">{label}</label>
      <input className="wx-input" type="number" step="0.1" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
