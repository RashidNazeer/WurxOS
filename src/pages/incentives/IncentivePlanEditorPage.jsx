import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  currentMonth, getIncentives, upsertIncentives, recomputeCompletion,
} from '../../lib/incentivesApi';
import {
  AlertIcon, PlusIcon, XIcon, CheckIcon, ChevronLeftIcon,
  StarIcon, TargetIcon,
} from '../../components/common/Icon';

// ---------- helpers ----------
function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function initialsOf(name) { return (name || '?').slice(0, 2).toUpperCase(); }
function roleLabel(r) {
  return ({ apc: 'APC', ipc: 'IPC', tl: 'Team Lead', pctl: 'Product TL', ol: 'Operation Lead', boss: 'Boss', developer: 'Developer' })[r] || r;
}

// ---------- main page ----------
export default function IncentivePlanEditorPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { userId: routeUserId } = useParams();
  const [search] = useSearchParams();
  const month = search.get('month') || currentMonth();
  const isNew = !routeUserId;

  const { profile } = useAuth();
  const role = profile?.role;
  const isBoss  = role === 'boss' || role === 'developer';
  const isOL    = role === 'ol';
  const isAdmin = isBoss || isOL;

  // Boss can pick anyone except boss; OL can pick APCs/IPCs only.
  const userPickerRoles = isOL ? ['apc', 'ipc'] : ['apc', 'ipc', 'tl', 'pctl', 'ol'];

  const [targetUserId, setTargetUserId] = useState(routeUserId || '');
  const [basic, setBasic]   = useState('');
  const [inc, setInc]       = useState([]);
  const [bon, setBon]       = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const [savedDialog, setSavedDialog] = useState(false); // success modal after save

  // Pickable users (admin, new plan only).
  const pickableQ = useQuery({
    queryKey: ['incentives', 'pickusers', role],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, role')
        .eq('is_active', true)
        .is('deleted_at', null)
        .in('role', userPickerRoles)
        .order('display_name');
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: isAdmin && isNew,
  });

  // Target user details + existing record for the month.
  const targetUserQ = useQuery({
    queryKey: ['profiles', 'one', targetUserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, role')
        .eq('id', targetUserId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: !!targetUserId,
  });

  const existingQ = useQuery({
    queryKey: ['incentives', 'mine', targetUserId, month],
    queryFn: () => getIncentives(targetUserId, month),
    enabled: !!targetUserId,
  });

  // Hydrate form when existing record loads.
  useEffect(() => {
    const r = existingQ.data;
    if (r) {
      setBasic(r.basic_salary ? String(r.basic_salary) : '');
      setInc((r.incentives || []).map(normalizeItem));
      setBon((r.bonuses    || []).map(normalizeItem));
    } else if (existingQ.isFetched) {
      // No existing record — start blank.
      setBasic('');
      setInc([]);
      setBon([]);
    }
  }, [existingQ.data, existingQ.isFetched]);

  const targetUser = targetUserQ.data;
  const incTotal   = inc.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal   = bon.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const grandTotal = (Number(basic) || 0) + incTotal + bonTotal;

  async function save() {
    setSaving(true); setErr('');
    try {
      if (!targetUserId) { setErr('Pick the user this plan belongs to.'); return; }
      const patch = {
        incentives: recomputeCompletion(inc),
        bonuses:    recomputeCompletion(bon),
      };
      if (isAdmin) patch.basic_salary = Number(basic) || 0;
      await upsertIncentives(targetUserId, month, patch);
      // Invalidate the cache so the list page refetches when we return —
      // the realtime channel only fires for clients already mounted on
      // /incentives, so the editor must do this directly.
      qc.invalidateQueries({ queryKey: ['incentives'] });
      // Show the success dialog. The user dismisses it (or it auto-redirects)
      // to land on the incentives list with the freshly-saved plan.
      setSavedDialog(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Where to land after saving — pick the tab that contains the user we
  // just edited. Boss tabs: apc/tl/ol; OL tabs: my/apc/ipc. Falls back
  // to the OL "my" tab or the Boss "apc" tab if the role doesn't map.
  function landingUrl() {
    const role = targetUser?.role;
    let tab = role;
    if (role === 'pctl') tab = 'tl';     // Boss groups PCTLs under TLs tab.
    if (!tab) tab = isOL ? 'my' : 'apc';
    return `/incentives?tab=${tab}`;
  }

  // Auto-redirect to the incentives list 1.5s after the success dialog opens.
  useEffect(() => {
    if (!savedDialog) return;
    const t = setTimeout(() => navigate(landingUrl()), 1500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedDialog, navigate, targetUser?.role]);

  // Non-admin shouldn't reach this page — bounce them back.
  if (!isAdmin) {
    return (
      <div className="wx-alert wx-alert-danger">
        <AlertIcon width="14" height="14" />
        <span>Only Boss and Operation Leads can edit incentive plans.</span>
      </div>
    );
  }

  const headerName = targetUser?.display_name || (isNew ? 'New plan' : '—');
  const headerRole = targetUser?.role;

  return (
    <div style={{ maxWidth: 760 }}>
      {/* Back link */}
      <Link to="/incentives" style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 12.5, color: 'var(--text-muted)',
        textDecoration: 'none', marginBottom: 14,
      }}>
        <ChevronLeftIcon width="14" height="14" /> Back to Incentives
      </Link>

      {/* Identity banner */}
      <div style={{
        padding: '16px 18px', marginBottom: 18, borderRadius: 'var(--radius-lg)',
        background: 'linear-gradient(135deg, var(--surface-3), var(--surface-2))',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: 'var(--accent)', color: 'var(--on-accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 16, flexShrink: 0,
        }}>{initialsOf(headerName)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            {isNew && !targetUser ? 'New incentive plan' : headerName}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {headerRole ? `${roleLabel(headerRole)} · ` : ''}{monthLabel(month)}
          </div>
        </div>
        {existingQ.data && (
          <Pill kind={existingQ.data.verified ? 'success' : 'warning'}>
            {existingQ.data.verified ? 'Verified' : 'Unverified'}
          </Pill>
        )}
      </div>

      {/* Errors */}
      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {/* Success dialog — confirms the save and redirects to /incentives */}
      {savedDialog && (
        <SavedDialog
          name={targetUser?.display_name || 'the user'}
          month={monthLabel(month)}
          onGo={() => navigate(landingUrl())}
        />
      )}

      {/* Assign-to picker (new plan only) */}
      {isNew && (
        <SectionCard
          icon={<UserPickerIcon />}
          title="Assign to"
          subtitle="Choose the user this plan belongs to."
        >
          <select
            className="wx-input"
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
          >
            <option value="">— pick a user —</option>
            {(pickableQ.data || []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name} · {roleLabel(u.role)}
              </option>
            ))}
          </select>
        </SectionCard>
      )}

      {/* Basic salary */}
      <SectionCard
        icon={<WalletIcon />}
        title="Basic / fixed salary"
        subtitle="Paid every month regardless of incentive completion."
      >
        <div style={{ display: 'flex', alignItems: 'stretch', maxWidth: 280 }}>
          <input className="wx-input" type="number" min="0"
            placeholder="e.g. 60000"
            value={basic} onChange={(e) => setBasic(e.target.value)}
            style={{ borderRadius: 'var(--radius-md) 0 0 var(--radius-md)' }} />
          <span style={{
            display: 'inline-flex', alignItems: 'center', padding: '0 14px',
            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
            borderLeft: 0, borderRadius: '0 var(--radius-md) var(--radius-md) 0',
            fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)',
          }}>PKR</span>
        </div>
      </SectionCard>

      {/* Incentives */}
      <ItemSection
        title="Incentives"
        subtitle="Performance-based — earned when target is hit."
        accentColor="var(--success)"
        icon={<TargetIcon width="14" height="14" />}
        items={inc} setItems={setInc}
        addLabel="Add incentive"
        descPlaceholder="e.g. 250 affiliates with 3+ videos"
        emptyText="No incentives added yet."
      />

      {/* Bonuses */}
      <ItemSection
        title="Bonuses"
        subtitle="Special rewards — typically one-off."
        accentColor="var(--info)"
        icon={<StarIcon width="14" height="14" />}
        items={bon} setItems={setBon}
        addLabel="Add bonus"
        descPlaceholder="e.g. Top performer of the month"
        emptyText="No bonuses added yet."
      />

      {/* Summary */}
      <SectionCard
        icon={<SummaryIcon />}
        title="Summary"
        subtitle="Total payable when every item is achieved."
        tone="muted"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <SummaryRow label="Basic salary" value={`${(Number(basic) || 0).toLocaleString()} PKR`} />
          <SummaryRow
            label={`Total incentives (${inc.length})`}
            value={`+${incTotal.toLocaleString()} PKR`}
            valueColor="var(--success)"
          />
          <SummaryRow
            label={`Total bonuses (${bon.length})`}
            value={`+${bonTotal.toLocaleString()} PKR`}
            valueColor="var(--info)"
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontWeight: 800, fontSize: 14,
            paddingTop: 8, marginTop: 4, borderTop: '1.5px solid var(--border-subtle)',
          }}>
            <span>Total potential salary</span>
            <span>{grandTotal.toLocaleString()} PKR</span>
          </div>
        </div>
      </SectionCard>

      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 18 }}>
        The user fills in their achieved values from the Incentives page. Items
        auto-complete when achieved ≥ 90% of target.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving || !targetUserId}>
          {saving
            ? <><span className="wx-spinner" /> Saving…</>
            : <><CheckIcon width="14" height="14" /> Save plan</>}
        </button>
        <button className="wx-btn wx-btn-ghost" onClick={() => navigate('/incentives')} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------- helpers ----------
function normalizeItem(it) {
  return {
    id: it.id || crypto.randomUUID(),
    text: it.text || '',
    amount: Number(it.amount) || 0,
    targetValue: Number(it.targetValue) || 0,
    achievedValue: Number(it.achievedValue) || 0,
    suffix: it.suffix || '',
    completed: !!it.completed,
  };
}

// ============================================================
// SectionCard — header tile + optional subtitle + body
// ============================================================
function SectionCard({ icon, title, subtitle, tone, children, headerExtra }) {
  return (
    <div style={{
      background: tone === 'muted' ? 'var(--surface-2)' : 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: 16, marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {icon && (
            <div style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>{icon}</div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{subtitle}</div>
            )}
          </div>
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function SummaryRow({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor || 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

function Pill({ kind = 'muted', children }) {
  const styles = {
    success: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    info:    { bg: 'var(--info-soft)',    fg: 'var(--info)' },
    muted:   { bg: 'var(--surface-2)',    fg: 'var(--text-secondary)' },
  }[kind];
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 999,
      background: styles.bg, color: styles.fg,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// ============================================================
// ItemSection — Incentives / Bonuses block
// ============================================================
function ItemSection({
  title, subtitle, accentColor, icon, items, setItems,
  addLabel, descPlaceholder, emptyText,
}) {
  function update(i, patch) {
    setItems(items.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  }
  function add() {
    setItems([...items, {
      id: crypto.randomUUID(), text: '', amount: 0,
      targetValue: 0, achievedValue: 0, suffix: '', completed: false,
    }]);
  }
  function remove(i) { setItems(items.filter((_, idx) => idx !== i)); }

  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: 16, marginBottom: 14,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: `color-mix(in srgb, ${accentColor} 14%, transparent)`,
            color: accentColor,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>{icon}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{subtitle}</div>
            )}
          </div>
        </div>
        {total > 0 && (
          <span style={{ fontWeight: 800, fontSize: 13.5, color: accentColor, whiteSpace: 'nowrap' }}>
            +{total.toLocaleString()} PKR
          </span>
        )}
      </div>

      {/* Lines */}
      {items.length === 0 ? (
        <div style={{
          padding: '16px 12px', textAlign: 'center', fontSize: 12.5,
          color: 'var(--text-muted)', background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
        }}>
          {emptyText}
        </div>
      ) : items.map((it, i) => (
        <ItemRowCard
          key={it.id} item={it} index={i}
          accentColor={accentColor}
          descPlaceholder={descPlaceholder}
          onChange={update}
          onRemove={remove}
        />
      ))}

      <button type="button" className="wx-btn wx-btn-ghost"
        onClick={add}
        style={{ marginTop: items.length ? 6 : 12, fontSize: 12 }}>
        <PlusIcon width="12" height="12" /> {addLabel}
      </button>
    </div>
  );
}

// One labeled row-card. Admin-only — no Achieved field (the user
// fills that in themselves from the Incentives page).
function ItemRowCard({ item, index, accentColor, descPlaceholder, onChange, onRemove }) {
  return (
    <div style={{
      padding: 12, marginBottom: 8,
      background: 'var(--surface-2)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
    }}>
      {/* Row 1: description + remove */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
        <input
          className="wx-input"
          placeholder={descPlaceholder}
          value={item.text || ''}
          onChange={(e) => onChange(index, { text: e.target.value })}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={() => onRemove(index)} title="Remove"
          style={{
            border: 0, background: 'transparent', color: 'var(--danger)',
            cursor: 'pointer', padding: 8, display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
          <XIcon width="14" height="14" />
        </button>
      </div>

      {/* Row 2: target + compensation */}
      <div className="incentive-item-row-grid-2" style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 200px)',
        gap: 12,
      }}>
        {/* Target with optional suffix */}
        <div>
          <label style={labelStyle}>
            Target value <span style={hintStyle}>(suffix optional — e.g. %, $, pts)</span>
          </label>
          <div style={{ display: 'flex' }}>
            <input
              className="wx-input"
              type="number" min="0" placeholder="e.g. 250"
              value={item.targetValue || ''}
              onChange={(e) => onChange(index, { targetValue: Number(e.target.value) || 0 })}
              style={{ borderRadius: 'var(--radius-md) 0 0 var(--radius-md)', flex: 1, minWidth: 0 }}
            />
            <input
              className="wx-input"
              type="text" placeholder="—" maxLength={6}
              value={item.suffix || ''}
              onChange={(e) => onChange(index, { suffix: e.target.value })}
              title="Optional unit (e.g. %, $, pts)"
              style={{
                borderRadius: '0 var(--radius-md) var(--radius-md) 0',
                borderLeft: 0, width: 60, textAlign: 'center', fontWeight: 700,
              }}
            />
          </div>
        </div>

        {/* Compensation */}
        <div>
          <label style={labelStyle}>Compensation if achieved</label>
          <div style={{ display: 'flex' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '0 10px',
              background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
              borderRight: 0, borderRadius: 'var(--radius-md) 0 0 var(--radius-md)',
              fontSize: 13, fontWeight: 800, color: accentColor,
            }}>+</span>
            <input
              className="wx-input"
              type="number" min="0" placeholder="Amount"
              value={item.amount || ''}
              onChange={(e) => onChange(index, { amount: Number(e.target.value) || 0 })}
              style={{ borderRadius: 0, flex: 1, minWidth: 0, borderLeft: 0, borderRight: 0 }}
            />
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '0 12px',
              background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
              borderRadius: '0 var(--radius-md) var(--radius-md) 0',
              fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
            }}>PKR</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const labelStyle = {
  display: 'block',
  fontSize: 11, fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: 4, letterSpacing: '0.01em',
};
const hintStyle = {
  fontWeight: 400, color: 'var(--text-muted)',
};

// Inline icons — keep this page self-contained for the editor-only icons.
function WalletIcon(p) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3" />
      <path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-3" />
      <path d="M21 12h-5a2 2 0 1 0 0 4h5z" />
    </svg>
  );
}
function UserPickerIcon(p) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0" />
      <path d="M19 8v6M16 11h6" />
    </svg>
  );
}
function SummaryIcon(p) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-6" />
    </svg>
  );
}

// ============================================================
// Saved confirmation modal — shown on successful save, then auto
// redirects back to /incentives after 1.5s. The user can also click
// "Go to incentives" to skip the wait.
// ============================================================
function SavedDialog({ name, month, onGo }) {
  return (
    <div className="wx-modal-backdrop" onClick={onGo}>
      <div className="wx-modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-body" style={{ textAlign: 'center', padding: '28px 24px' }}>
          <div style={{
            width: 56, height: 56, margin: '0 auto 14px', borderRadius: '50%',
            background: 'var(--success-soft)', color: 'var(--success)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <CheckIcon width="26" height="26" />
          </div>
          <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>
            Plan saved
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {name}'s incentives for {month} have been updated.
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 14 }}>
            Redirecting to Incentives…
          </div>
        </div>
        <div className="wx-modal-footer" style={{ justifyContent: 'center' }}>
          <button className="wx-btn wx-btn-primary" onClick={onGo}>
            Go to incentives
          </button>
        </div>
      </div>
    </div>
  );
}
