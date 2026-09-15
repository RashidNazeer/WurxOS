import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAssignableApcs, switchBrandApc, assignBrandApc, listBrandsForUsers } from '../../lib/brandsApi';
import { submitApcSwitchRequest } from '../../lib/brandSwitchApi';
import {
  permanentSameRole, swapPartner, assignReplaced, assignKept,
  assignOutcome, swapOutcome, SWITCH_ACTIONS,
} from '../../lib/brandSwitchRules';
import { useAuth } from '../../contexts/AuthContext';
import {
  XIcon, AlertIcon, CheckIcon, SearchIcon, RefreshIcon,
} from '../common/Icon';

/**
 * Modal for giving a brand to a different APC.
 *
 * Two independent choices:
 *
 *   ACTION — what moves (mig 360)
 *     * Assign only     → brand_assign_apc. This one brand moves; the new APC
 *                         keeps everything they already hold.
 *     * Swap portfolios → brand_switch_apc. Both APCs exchange their whole book.
 *
 *   MODE — who applies it
 *     * Boss → always applies directly.
 *     * OL   → defaults to direct but can flip to "Request from Boss", which
 *              writes a pending row carrying the chosen action.
 *
 * Assign is the default. A swap moves two people's entire portfolios; picking
 * it by accident is far costlier than picking Assign by accident, which moves
 * one brand and is undone by assigning it back.
 */
export default function SwitchApcModal({ brand, onClose, onDone }) {
  const { profile } = useAuth();
  const role = profile?.role;
  const canDirectSwitch = ['boss', 'ol', 'developer'].includes(role);
  const canRequest      = role === 'ol';        // OL is the only role that benefits from the toggle
  const [mode, setMode] = useState(canDirectSwitch ? 'direct' : 'request');
  const [action, setAction] = useState('assign');

  const [q, setQ] = useState('');
  const [pickedId, setPickedId] = useState('');
  const [note, setNote] = useState('');
  // Notifications are opt-in — the new APC + their TL only get a
  // heads-up when the caller explicitly ticks this box.
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ['assignable-apcs'],
    queryFn: () => listAssignableApcs(),
  });

  // Every row in brand_assignments is considered "currently assigned" —
  // the schema only lets APCs/IPCs be added there via the UI, and we'd
  // rather show an unknown role than silently hide a real assignee.
  const current = (brand.assignedUsers || []).filter(Boolean);
  const currentIds = new Set(current.map((u) => u.id));

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return candidates
      .filter((c) => !currentIds.has(c.id))  // don't offer who's already on this brand
      .filter((c) => {
        if (!qq) return true;
        return (
          (c.display_name || '').toLowerCase().includes(qq) ||
          (c.email || '').toLowerCase().includes(qq) ||
          (c.manager?.display_name || '').toLowerCase().includes(qq)
        );
      });
  }, [candidates, currentIds, q]);

  const picked = candidates.find((c) => c.id === pickedId) || null;

  // Computed by the SAME rules the database applies (lib/brandSwitchRules),
  // so what this previews is what will happen.
  const seat     = useMemo(() => permanentSameRole(current, picked), [current, picked]);
  const partner  = useMemo(() => swapPartner(current, picked), [current, picked]);
  const replaced = useMemo(() => assignReplaced(current, picked), [current, picked]);
  const kept     = useMemo(() => assignKept(current, picked), [current, picked]);

  // Brand lists for everyone whose portfolio can change: the target, and
  // every permanent same-role assignee (the swap partner is the first of
  // those; Assign replaces all of them).
  const involvedIds = useMemo(
    () => [pickedId, ...seat.map((u) => u.id)].filter(Boolean),
    [pickedId, seat],
  );
  const { data: brandsByUser = {}, isLoading: loadingLoads } = useQuery({
    queryKey: ['swap-brand-loads', ...involvedIds],
    queryFn: () => listBrandsForUsers(involvedIds),
    enabled: !!pickedId,
  });

  const thisBrand = { id: brand.id, brand_name: brand.brand_name };
  const outcome = picked
    ? (action === 'assign'
      ? assignOutcome({ brand: thisBrand, picked, replaced, brandsByUser })
      : swapOutcome({ brand: thisBrand, picked, partner, brandsByUser }))
    : null;

  async function confirm() {
    if (!pickedId) return setErr('Pick an APC to give the brand to.');
    setBusy(true); setErr('');
    try {
      if (mode === 'request') {
        await submitApcSwitchRequest({
          brandId: brand.id,
          toApcId: pickedId,
          reason: note.trim() || '',
          notify,
          mode: action,
        });
      } else if (action === 'assign') {
        await assignBrandApc(brand.id, pickedId, note.trim() || null, notify);
      } else {
        await switchBrandApc(brand.id, pickedId, note.trim() || null, notify);
      }
      onDone?.(mode);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const verb = action === 'assign' ? 'assign' : 'swap';

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Reassign APC — {brand.brand_name}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}>
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          {/* Mode toggle — only OL sees a choice. Boss is always direct,
              anyone else (shouldn't reach here) is always request. */}
          {canDirectSwitch && canRequest && (
            <div className="wx-seg" role="tablist" style={{ marginBottom: 12 }}>
              <button type="button" role="tab" aria-selected={mode === 'direct'}
                className={`wx-seg-btn ${mode === 'direct' ? 'is-active' : ''}`}
                onClick={() => setMode('direct')}>
                Apply directly
              </button>
              <button type="button" role="tab" aria-selected={mode === 'request'}
                className={`wx-seg-btn ${mode === 'request' ? 'is-active' : ''}`}
                onClick={() => setMode('request')}>
                Request from Boss
              </button>
            </div>
          )}

          {/* Action — what moves. Each option carries its one-line consequence
              so the difference is read before it is picked, not after. */}
          <div role="radiogroup" aria-label="What should happen"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            {Object.entries(SWITCH_ACTIONS).map(([key, a]) => {
              const on = action === key;
              return (
                <button key={key} type="button" role="radio" aria-checked={on}
                  onClick={() => setAction(key)}
                  style={{
                    textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
                    borderRadius: 'var(--radius-md)',
                    border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                    color: 'var(--text-primary)',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                    <span style={{
                      width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                      border: `2px solid ${on ? 'var(--accent)' : 'var(--border-strong, var(--border-default))'}`,
                      background: on ? 'var(--accent)' : 'transparent',
                    }} />
                    {a.label}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
                    {a.blurb}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Current assignees summary */}
          <div style={{
            padding: '10px 12px',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-md)',
            fontSize: 12.5,
            marginBottom: 12,
          }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Currently assigned
            </div>
            {current.length === 0 ? (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No APC assigned.</span>
            ) : current.map((u) => (
              <span key={u.id} style={{
                display: 'inline-block',
                marginRight: 8, marginBottom: 4, padding: '2px 8px',
                background: 'var(--surface-1)',
                borderRadius: 'var(--radius-pill)',
                fontWeight: 700,
              }}>
                {u.display_name}{' '}
                <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                  · {u.role}{u.expiresAt ? ' · temporary cover' : ''}
                </span>
              </span>
            ))}
            {brand.owner?.display_name && (
              <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11.5 }}>
                Team Lead: <strong style={{ color: 'var(--text-secondary)' }}>{brand.owner.display_name}</strong>
              </div>
            )}
          </div>

          {/* Search */}
          <div className="wx-search" style={{ marginBottom: 10 }}>
            <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
            <input className="wx-input" placeholder="Search APC by name, email, or TL…"
              value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>

          {/* Candidate list */}
          <div style={{
            maxHeight: 240, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 4,
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 6,
          }}>
            {isLoading ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)' }}>
                <span className="wx-spinner" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                No APCs match that search.
              </div>
            ) : filtered.map((c) => {
              const on = pickedId === c.id;
              return (
                <button key={c.id} type="button"
                  onClick={() => setPickedId(c.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '32px 1fr auto',
                    gap: 10, alignItems: 'center',
                    padding: '8px 10px',
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}>
                  <Avatar user={c} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{c.display_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {c.role.toUpperCase()} · reports to <strong style={{ color: 'var(--text-secondary)' }}>{c.manager?.display_name || '—'}</strong>
                    </div>
                  </div>
                  {on && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
                </button>
              );
            })}
          </div>

          {/* Outcome preview — each person's brands before and after. */}
          {picked && (
            <div style={{
              marginTop: 12, padding: '12px 14px',
              background: 'var(--accent-soft)',
              border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12.5,
              color: 'var(--text-primary)',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshIcon width="12" height="12" />
                {mode === 'request' ? 'If Boss approves:' : 'On confirm:'}
              </div>

              {loadingLoads || !outcome ? (
                <div style={{ color: 'var(--text-muted)' }}>
                  <span className="wx-spinner" /> Checking current brand lists…
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
                    <Portfolio who={outcome.target.user} before={outcome.target.before} after={outcome.target.after} highlight={brand.id} />
                    {action === 'assign'
                      ? outcome.losers.map((l) => (
                          <Portfolio key={l.user.id} who={l.user} before={l.before} after={l.after} highlight={brand.id} />
                        ))
                      : outcome.partner && (
                          <Portfolio who={outcome.partner.user} before={outcome.partner.before} after={outcome.partner.after} highlight={brand.id} />
                        )}
                  </div>

                  {action === 'assign' && outcome.losers.length === 0 && (
                    <Hint>Nobody currently holds this brand in that role, so it is simply added to {picked.display_name}.</Hint>
                  )}
                  {action === 'swap' && outcome.degenerate && (
                    <Hint>
                      No {picked.role.toUpperCase()} holds this brand right now, so there is nothing to swap
                      with — this behaves exactly like <strong>Assign only</strong>.
                    </Hint>
                  )}
                  {action === 'assign' && kept.length > 0 && (
                    <Hint>
                      Stays on the brand: {kept.map((u) => `${u.display_name} (${u.role}${u.expiresAt ? ', temporary' : ''})`).join(', ')}.
                    </Hint>
                  )}
                </>
              )}

              <div style={{
                marginTop: 10, paddingTop: 8,
                borderTop: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)',
                fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5,
              }}>
                {action === 'assign' ? (
                  <>Only <strong>{brand.brand_name}</strong> moves. Its TL becomes {picked.display_name}&apos;s TL, and its
                  open tasks, reports and resources move with it.</>
                ) : (
                  <>Every moved brand retargets its TL, and its open tasks, reports and resources move with it.
                  Each moved brand is given to a single person, so <strong>anyone else assigned to those brands —
                  IPCs, temporary cover — is removed</strong>.</>
                )}
                {mode === 'request' && ' Nothing changes until Boss approves.'}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="wx-label">
              {mode === 'request' ? 'Reason for Boss' : 'Note (optional)'}
            </label>
            <input className="wx-input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={mode === 'request'
                ? `Why are you proposing this ${verb}?`
                : `Reason for the ${verb} (kept in audit log)…`} />
          </div>

          {/* Notifications are opt-in. Scoped to the new APC + TL only. */}
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 12px', marginTop: 12,
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            background: notify ? 'var(--accent-soft)' : 'var(--surface-1)',
            cursor: 'pointer',
            transition: 'background var(--dur-fast)',
          }}>
            <input type="checkbox" checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              disabled={busy}
              style={{ marginTop: 2 }} />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              <strong>Notify the new APC and their Team Lead</strong>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                {mode === 'request'
                  ? 'When Boss approves this request, the new APC and their TL will get an in-app + push notification.'
                  : 'The new APC and their TL will get an in-app + push notification. Leave off for a silent change.'}
              </div>
            </span>
          </label>
        </div>
        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="wx-btn wx-btn-primary" onClick={confirm} disabled={busy || !pickedId}>
            {busy
              ? <><span className="wx-spinner" />{mode === 'request' ? ' Submitting…' : action === 'assign' ? ' Assigning…' : ' Swapping…'}</>
              : mode === 'request'
                ? <><CheckIcon width="14" height="14" /> Submit {verb} request</>
                : <><CheckIcon width="14" height="14" /> Confirm {verb}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Avatar({ user }) {
  const style = { width: 32, height: 32, borderRadius: '50%', overflow: 'hidden', background: 'var(--surface-2)', color: 'var(--text-secondary)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800 };
  if (user?.avatar_url) {
    return <div style={style}><img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>;
  }
  const init = String(user?.display_name || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return <div style={style}>{init}</div>;
}

const Hint = ({ children }) => (
  <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{children}</div>
);

// One person's brands, before → after. Brands gained are marked + and brands
// lost are struck through, so the effect of the action reads at a glance —
// which matters most for a swap, where the whole list changes hands.
function Portfolio({ who, before, after, highlight }) {
  if (!who) return null;
  const beforeIds = new Set((before || []).map((b) => b.id));
  const afterIds = new Set((after || []).map((b) => b.id));
  const lost = (before || []).filter((b) => !afterIds.has(b.id));
  return (
    <div style={{ background: 'var(--surface-1)', borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
      <div style={{
        fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 6,
      }}>
        {who.display_name}
        <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
          {' '}· {before.length} → {after.length} brand{after.length === 1 ? '' : 's'}
        </span>
      </div>
      {after.length === 0 && lost.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No brands</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, lineHeight: 1.5 }}>
          {after.map((b) => (
            <li key={b.id} style={{ fontWeight: b.id === highlight ? 800 : 500 }}>
              {!beforeIds.has(b.id) && <span style={{ color: 'var(--success)', fontWeight: 800 }}>+ </span>}
              {b.brand_name}
            </li>
          ))}
          {lost.map((b) => (
            <li key={`x-${b.id}`} style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>
              {b.brand_name}
            </li>
          ))}
        </ul>
      )}
      {after.length === 0 && lost.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>Left with no brands</div>
      )}
    </div>
  );
}
