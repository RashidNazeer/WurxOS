import React, { useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { moveApcToTl, moveIpcToPctl, moveBrand } from '../../lib/teamApi';

/**
 * Side panel for reassignment actions on the Team Hierarchy page.
 * 1:1 port of v1's HierarchyReassignPanel — UI verbatim. The only
 * change: reassignApcLead / applyBrandMoves are replaced by v2's
 * existing SECURITY DEFINER RPCs (team_move_apc_to_tl,
 * team_move_ipc_to_pctl, team_move_brand). Server-side cascades
 * are equivalent: profile reports_to, brand owner_id, brand
 * assignments, notifications, audit_log all updated atomically.
 *
 * Selection shapes (unchanged):
 *   { type: 'tl',     tl }                         — read-only summary
 *   { type: 'member', member, tl }                 — APC/IPC; offer "Move to TL"
 *   { type: 'brand',  brand,  tl }                 — offer "Move to TL" or "Assign to APC"
 */
export default function HierarchyReassignPanel({
  selection, tls, brands, teamUsers, isBoss, isOL, onClose, onSaved,
}) {
  const { user, profile } = useAuth();
  const actor = { uid: user?.id, name: profile?.display_name || user?.email || 'Manager' };

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(420px, 100vw)', zIndex: 1500, background: '#fff', boxShadow: '-8px 0 24px rgba(15,23,42,0.12)', display: 'flex', flexDirection: 'column' }}>
      <div className="d-flex align-items-center justify-content-between p-3 border-bottom" style={{ background: '#f8fafc' }}>
        <h6 className="fw-bold mb-0">
          {selection.type === 'tl' && <><i className="bi bi-person-badge me-2 text-success" />Team Lead</>}
          {selection.type === 'member' && <><i className="bi bi-person-circle me-2 text-primary" />Team Member</>}
          {selection.type === 'brand' && <><i className="bi bi-shop me-2 text-warning" />Brand</>}
        </h6>
        <button className="btn btn-sm btn-light rounded-circle" onClick={onClose} style={{ width: 32, height: 32 }}>
          <i className="bi bi-x-lg" />
        </button>
      </div>

      <div className="flex-grow-1 overflow-auto p-3">
        {selection.type === 'tl' && <TlPanel tl={selection.tl} />}
        {selection.type === 'member' && (
          <MemberPanel
            member={selection.member}
            currentTl={selection.tl}
            tls={tls}
            actor={actor}
            isBoss={isBoss}
            isOL={isOL}
            onSaved={onSaved}
          />
        )}
        {selection.type === 'brand' && (
          <BrandPanel
            brand={selection.brand}
            currentTl={selection.tl}
            tls={tls}
            teamUsers={teamUsers}
            actor={actor}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

// ── TL summary ─────────────────────────────────────────────────────────────

function TlPanel({ tl }) {
  return (
    <>
      <div className="mb-3">
        <div className="fw-bold" style={{ fontSize: '1rem', color: '#0f172a' }}>{tl.displayName || tl.email}</div>
        <div className="text-muted small">
          {tl.role === 'pctl' ? 'Paid Collab Team Lead' : 'Team Lead'} · {tl.email}
        </div>
      </div>

      <div className="rounded-3 p-3 mb-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
        <div className="d-flex justify-content-between mb-2 small">
          <span className="text-muted">Brands owned</span>
          <strong>{tl.brands.length}</strong>
        </div>
        <div className="d-flex justify-content-between small">
          <span className="text-muted">Team members</span>
          <strong>{tl.members.length}</strong>
        </div>
      </div>

      <p className="text-muted small">
        <i className="bi bi-info-circle me-1" />
        To reassign individual brands or members, click them on the card.
      </p>
    </>
  );
}

// ── APC/IPC: move to a different TL ────────────────────────────────────────

function MemberPanel({ member, currentTl, tls, actor: _actor, isBoss, isOL, onSaved }) {
  const [newTlId, setNewTlId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canEdit = isBoss || isOL;
  const isApc = (member.userType || 'apc') === 'apc';

  // PCTL can only own IPCs; TL can only own APCs. Filter dropdown so we
  // never end up with an APC under a PCTL or vice-versa. Same rule as v1.
  const eligibleTls = useMemo(() => {
    return tls.filter((t) => t.id !== currentTl.id && (
      isApc ? t.role === 'tl' : t.role === 'pctl'
    ));
  }, [tls, currentTl.id, isApc]);

  async function handleSave() {
    if (!newTlId) return;
    setError(''); setSaving(true);
    try {
      if (isApc) {
        await moveApcToTl(member.id, newTlId);
      } else {
        await moveIpcToPctl(member.id, newTlId);
      }
      onSaved({ kind: 'member' });
    } catch (err) {
      setError(err.message || 'Failed to reassign.');
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-3">
        <div className="fw-bold" style={{ fontSize: '1rem', color: '#0f172a' }}>
          {member.userName || member.email}
        </div>
        <div className="text-muted small">
          {(member.userType || 'apc').toUpperCase()} · currently under <strong>{currentTl.displayName || currentTl.email}</strong>
        </div>
      </div>

      <div className="rounded-3 p-3 mb-3" style={{ background: '#fefce8', border: '1px solid #fde68a', fontSize: '0.78rem', color: '#92400e' }}>
        <i className="bi bi-info-circle me-1" />
        Reassigning will move this {isApc ? 'APC' : 'IPC'} to a different team lead. <strong>{(member.assignedBrands || []).length} brand{(member.assignedBrands || []).length === 1 ? '' : 's'}</strong> currently with them will follow to the new TL. Tasks and attendance ownership update automatically. The APC, old TL, and new TL all get notified.
      </div>

      {!canEdit ? (
        <div className="alert alert-secondary py-2 small">You don't have permission to reassign team members.</div>
      ) : (
        <>
          <label className="small text-muted d-block mb-1" style={{ fontSize: '0.7rem', fontWeight: 600 }}>
            Move to {isApc ? 'Team Lead' : 'Paid Collab TL'}
          </label>
          <select className="form-select form-select-sm mb-3" value={newTlId} onChange={(e) => setNewTlId(e.target.value)} disabled={saving}>
            <option value="">— Select new lead —</option>
            {eligibleTls.map((t) => (
              <option key={t.id} value={t.id}>{t.displayName || t.email} {t.role === 'pctl' ? '(PCTL)' : ''}</option>
            ))}
          </select>

          {error && <div className="alert alert-danger py-2 small">{error}</div>}

          <button className="btn btn-sm btn-dark w-100"
            onClick={handleSave}
            disabled={saving || !newTlId}>
            {saving ? <><span className="spinner-border spinner-border-sm me-2" />Reassigning…</> : 'Reassign'}
          </button>
        </>
      )}
    </>
  );
}

// ── Brand: move to a different TL OR assign/reassign to a different APC ───

function BrandPanel({ brand, currentTl, tls, teamUsers, actor: _actor, onSaved }) {
  const [mode, setMode] = useState(brand.assignedUsers?.length ? 'apc' : 'tl');
  const [newTlId, setNewTlId] = useState('');
  const [newApcId, setNewApcId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const eligibleTls = useMemo(() => tls.filter((t) => t.id !== brand.ownerId), [tls, brand.ownerId]);
  const currentApcIds = (brand.assignedUsers || []).map((u) => u.id);
  const eligibleApcs = useMemo(
    () => teamUsers.filter((t) => !currentApcIds.includes(t.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamUsers, currentApcIds.join(',')],
  );

  async function handleSave() {
    setError(''); setSaving(true);
    try {
      if (mode === 'tl') {
        const newTl = tls.find((t) => t.id === newTlId);
        if (!newTl) throw new Error('Pick a new team lead.');
        // team_move_brand updates owner_id; assignments stay until we
        // also pick an APC. Match v1 (Move-to-TL leaves APCs unchanged).
        await moveBrand(brand.id, newTl.id, null);
      } else {
        if (!currentApcIds.length) {
          throw new Error('No APC currently assigned. Use Brand Switcher to add a brand to an APC for the first time.');
        }
        const newApc = teamUsers.find((t) => t.id === newApcId);
        if (!newApc) throw new Error('Pick a new APC.');
        // Pick the new APC's TL as the new owner so brand-owner stays in
        // sync with the assigned APC's lead chain. team_move_brand
        // accepts a new TL + an APC, and the v2 RPC re-points
        // brand_assignments to that APC.
        const newApcOwnerTl = tls.find((t) => t.id === newApc.ownerId);
        const targetTlId = newApcOwnerTl?.id || brand.ownerId;
        await moveBrand(brand.id, targetTlId, newApc.id);
      }
      onSaved({ kind: 'brand' });
    } catch (err) {
      setError(err.message || 'Failed to move brand.');
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-3">
        <div className="fw-bold" style={{ fontSize: '1rem', color: '#0f172a' }}>{brand.brandName}</div>
        <div className="text-muted small">
          Owner: <strong>{brand.ownerName || currentTl?.displayName || '—'}</strong>
          {currentApcIds.length > 0 && (
            <> · {currentApcIds.length} APC{currentApcIds.length === 1 ? '' : 's'} assigned</>
          )}
        </div>
      </div>

      {/* Mode toggle */}
      <div className="d-flex p-1 rounded-3 mb-3" style={{ background: '#f1f5f9', width: '100%' }}>
        <button type="button"
          onClick={() => setMode('tl')}
          className="btn btn-sm flex-grow-1"
          style={{
            background: mode === 'tl' ? '#fff' : 'transparent',
            color: mode === 'tl' ? '#0f172a' : '#64748b',
            border: 'none', borderRadius: 8,
            fontWeight: 600, fontSize: '0.78rem',
            boxShadow: mode === 'tl' ? '0 1px 3px rgba(15,23,42,0.08)' : 'none',
          }}>
          <i className="bi bi-person-badge me-1" />Move to TL
        </button>
        <button type="button"
          onClick={() => setMode('apc')}
          className="btn btn-sm flex-grow-1"
          style={{
            background: mode === 'apc' ? '#fff' : 'transparent',
            color: mode === 'apc' ? '#0f172a' : '#64748b',
            border: 'none', borderRadius: 8,
            fontWeight: 600, fontSize: '0.78rem',
            boxShadow: mode === 'apc' ? '0 1px 3px rgba(15,23,42,0.08)' : 'none',
          }}>
          <i className="bi bi-person-circle me-1" />Reassign APC
        </button>
      </div>

      {mode === 'tl' && (
        <>
          <div className="rounded-3 p-3 mb-3" style={{ background: '#fefce8', border: '1px solid #fde68a', fontSize: '0.78rem', color: '#92400e' }}>
            <i className="bi bi-info-circle me-1" />
            Brand owner moves from <strong>{brand.ownerName || currentTl?.displayName || '—'}</strong> to the new TL. Tasks and resources stay on the brand. Both TLs get notified.
          </div>
          <label className="small text-muted d-block mb-1" style={{ fontSize: '0.7rem', fontWeight: 600 }}>New owner TL</label>
          <select className="form-select form-select-sm mb-3" value={newTlId} onChange={(e) => setNewTlId(e.target.value)} disabled={saving}>
            <option value="">— Select TL —</option>
            {eligibleTls.map((t) => (
              <option key={t.id} value={t.id}>{t.displayName || t.email}{t.role === 'pctl' ? ' (PCTL)' : ''}</option>
            ))}
          </select>
        </>
      )}

      {mode === 'apc' && (
        <>
          <div className="rounded-3 p-3 mb-3" style={{ background: '#fefce8', border: '1px solid #fde68a', fontSize: '0.78rem', color: '#92400e' }}>
            <i className="bi bi-info-circle me-1" />
            Reassigns the brand from one APC to another. The brand's tasks transfer to the new APC, and brand ownership shifts to the new APC's TL. The new APC and their TL get notified.
          </div>
          <label className="small text-muted d-block mb-1" style={{ fontSize: '0.7rem', fontWeight: 600 }}>New APC / IPC</label>
          <select className="form-select form-select-sm mb-3" value={newApcId} onChange={(e) => setNewApcId(e.target.value)} disabled={saving}>
            <option value="">— Select team member —</option>
            {eligibleApcs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.userName || a.email} ({(a.userType || 'apc').toUpperCase()}, under {a.ownerName || '—'})
              </option>
            ))}
          </select>
        </>
      )}

      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <button className="btn btn-sm btn-dark w-100"
        onClick={handleSave}
        disabled={saving || (mode === 'tl' ? !newTlId : !newApcId)}>
        {saving ? <><span className="spinner-border spinner-border-sm me-2" />Saving…</> : 'Apply'}
      </button>
    </>
  );
}
