import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  fetchTeamRoster, moveApcToTl, moveBrand, moveIpcToPctl,
  deactivateBrand, reactivateBrand,
} from '../../lib/teamApi';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  UsersIcon, StoreIcon, ChevronRightIcon, AlertIcon, CheckIcon, SearchIcon,
  PencilIcon, RefreshIcon,
} from '../../components/common/Icon';

/**
 * Team Management — Boss-only console for moving people and brands
 * across teams.
 *
 *   • TL roster: each TL → APCs underneath → brands they own.
 *     Per-row actions: move APC to a different TL, move brand to a
 *     different TL+APC, deactivate / reactivate the brand.
 *
 *   • PCTL roster: each PCTL → IPCs underneath. Per-row action: move
 *     IPC to a different PCTL.
 */
export default function TeamManagementPage() {
  const { profile } = useAuth();
  const role = profile?.role;
  const allowed = ['boss', 'ol', 'developer'].includes(role);

  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['team-roster'],
    queryFn: fetchTeamRoster,
    enabled: allowed,
  });

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('tls');                     // 'tls' | 'pctls'
  const [moveApcModal, setMoveApcModal] = useState(null);    // { apc }
  const [moveBrandModal, setMoveBrandModal] = useState(null); // { brand }
  const [moveIpcModal, setMoveIpcModal] = useState(null);    // { ipc }
  const [confirmDeact, setConfirmDeact] = useState(null);    // { brand }

  if (!allowed) {
    return (
      <div className="wx-card" style={{ padding: 36, textAlign: 'center', marginTop: 20 }}>
        <AlertIcon width="22" height="22" />
        <h6 style={{ fontWeight: 800, marginTop: 8 }}>Forbidden</h6>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Only Boss / OL / Developer can manage teams.
        </p>
      </div>
    );
  }

  const roster = useMemo(() => buildRoster(data, search), [data, search]);

  const onSuccess = () => {
    qc.invalidateQueries({ queryKey: ['team-roster'] });
    qc.invalidateQueries({ queryKey: ['brands'] });
    qc.invalidateQueries({ queryKey: ['brand'] });
    qc.invalidateQueries({ queryKey: ['profiles'] });
  };

  return (
    <div style={{ padding: '20px 24px 40px' }}>
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h4 style={{ fontWeight: 800, margin: '0 0 4px', color: 'var(--text-primary)', letterSpacing: '-0.02em', fontSize: 20, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <UsersIcon width="20" height="20" /> Team Management
          </h4>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
            Move APCs and brands between Team Leads, IPCs between Paid Collab TLs, and deactivate brands when needed.
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={() => refetch()}>
          <RefreshIcon width="14" height="14" /> Refresh
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          { key: 'tls',   label: `Operations (${roster?.tls.length || 0})` },
          { key: 'pctls', label: `Paid Collab (${roster?.pctls.length || 0})` },
        ].map((t) => (
          <button key={t.key} type="button"
            className={`wx-role-chip ${tab === t.key ? 'wx-role-chip-active' : ''}`}
            onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <div style={{ flex: 1, minWidth: 220, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--surface-2)', borderRadius: 8 }}>
          <SearchIcon width="13" height="13" />
          <input
            style={{ flex: 1, border: 0, background: 'transparent', outline: 'none', fontSize: 13, padding: '4px 0' }}
            placeholder="Search lead, APC, or brand…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {isLoading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading roster…</div>
      ) : error ? (
        <div className="wx-alert wx-alert-danger">{error.message}</div>
      ) : (
        <>
          {tab === 'tls' && (
            <TlRoster
              tls={roster.tls}
              onMoveApc={(apc) => setMoveApcModal({ apc })}
              onMoveBrand={(brand) => setMoveBrandModal({ brand })}
              onDeactivate={(brand) => setConfirmDeact({ brand })}
              onReactivate={async (brand) => {
                try { await reactivateBrand(brand.id); onSuccess(); }
                catch (e) { alert(e.message); }
              }} />
          )}
          {tab === 'pctls' && (
            <PctlRoster
              pctls={roster.pctls}
              onMoveIpc={(ipc) => setMoveIpcModal({ ipc })} />
          )}
        </>
      )}

      {moveApcModal && (
        <MoveApcModal
          apc={moveApcModal.apc}
          tls={roster?.tls || []}
          onClose={() => setMoveApcModal(null)}
          onDone={() => { setMoveApcModal(null); onSuccess(); }} />
      )}
      {moveBrandModal && (
        <MoveBrandModal
          brand={moveBrandModal.brand}
          tls={roster?.tls || []}
          allProfiles={data?.profiles || []}
          onClose={() => setMoveBrandModal(null)}
          onDone={() => { setMoveBrandModal(null); onSuccess(); }} />
      )}
      {moveIpcModal && (
        <MoveIpcModal
          ipc={moveIpcModal.ipc}
          pctls={roster?.pctls || []}
          onClose={() => setMoveIpcModal(null)}
          onDone={() => { setMoveIpcModal(null); onSuccess(); }} />
      )}
      {confirmDeact && (
        <ConfirmDeactivateModal
          brand={confirmDeact.brand}
          onClose={() => setConfirmDeact(null)}
          onDone={() => { setConfirmDeact(null); onSuccess(); }} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Roster building
// ─────────────────────────────────────────────────────────────────
function buildRoster(data, search) {
  if (!data) return { tls: [], pctls: [] };
  const { profiles, brands } = data;
  const byId = new Map(profiles.map((p) => [p.id, p]));

  const tls = profiles.filter((p) => p.role === 'tl');
  const pctls = profiles.filter((p) => p.role === 'pctl');

  const tlNodes = tls.map((tl) => {
    const apcs = profiles.filter((p) => p.role === 'apc' && p.reports_to === tl.id);
    const ownedBrands = brands.filter((b) => b.owner_id === tl.id);
    const apcsWithBrands = apcs.map((apc) => ({
      ...apc,
      brands: ownedBrands.filter((b) => b.assigneeIds.includes(apc.id)),
    }));
    const unassignedBrands = ownedBrands.filter((b) =>
      !b.assigneeIds.some((id) => apcs.some((a) => a.id === id))
    );
    return { tl, apcs: apcsWithBrands, unassignedBrands, ownedBrandsCount: ownedBrands.length };
  });

  const pctlNodes = pctls.map((pctl) => {
    const ipcs = profiles.filter((p) => p.role === 'ipc' && p.reports_to === pctl.id);
    return { pctl, ipcs };
  });

  if (!search.trim()) return { tls: tlNodes, pctls: pctlNodes };

  const q = search.toLowerCase();
  const matchesText = (s) => (s || '').toLowerCase().includes(q);

  return {
    tls: tlNodes.filter((n) =>
      matchesText(n.tl.display_name) ||
      n.apcs.some((a) =>
        matchesText(a.display_name) ||
        a.brands.some((b) => matchesText(b.brand_name))
      ) ||
      n.unassignedBrands.some((b) => matchesText(b.brand_name))
    ),
    pctls: pctlNodes.filter((n) =>
      matchesText(n.pctl.display_name) ||
      n.ipcs.some((i) => matchesText(i.display_name))
    ),
  };
}

// ─────────────────────────────────────────────────────────────────
// Op TL roster
// ─────────────────────────────────────────────────────────────────
function TlRoster({ tls, onMoveApc, onMoveBrand, onDeactivate, onReactivate }) {
  if (!tls.length) {
    return <EmptyState icon="👤" title="No matching Team Leads" />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {tls.map(({ tl, apcs, unassignedBrands, ownedBrandsCount }) => (
        <div key={tl.id} className="wx-card" style={{ padding: 16 }}>
          {/* TL header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar name={tl.display_name} tint="#0ea5e9" size={42} />
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{tl.display_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Team Lead · {apcs.length} APC{apcs.length === 1 ? '' : 's'} · {ownedBrandsCount} brand{ownedBrandsCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          </div>

          {/* APCs */}
          {apcs.length === 0 ? (
            <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: 12.5, fontStyle: 'italic', background: 'var(--surface-2)', borderRadius: 8 }}>
              No APCs report to this Team Lead.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {apcs.map((apc) => (
                <ApcRow key={apc.id} apc={apc}
                  onMoveApc={() => onMoveApc(apc)}
                  onMoveBrand={onMoveBrand}
                  onDeactivate={onDeactivate}
                  onReactivate={onReactivate} />
              ))}
            </div>
          )}

          {/* Unassigned brands */}
          {unassignedBrands.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'color-mix(in srgb, var(--warning) 8%, var(--surface-1))', border: '1px solid color-mix(in srgb, var(--warning) 26%, transparent)' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Unassigned brands ({unassignedBrands.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {unassignedBrands.map((b) => (
                  <BrandPill key={b.id} brand={b}
                    onMoveBrand={() => onMoveBrand(b)}
                    onDeactivate={() => onDeactivate(b)}
                    onReactivate={() => onReactivate(b)} />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ApcRow({ apc, onMoveApc, onMoveBrand, onDeactivate, onReactivate }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={apc.display_name} tint="#8b5cf6" size={30} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{apc.display_name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              APC · {apc.brands.length} brand{apc.brands.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <button className="wx-btn wx-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={onMoveApc}>
          <ChevronRightIcon width="12" height="12" /> Move APC
        </button>
      </div>
      {apc.brands.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {apc.brands.map((b) => (
            <BrandPill key={b.id} brand={b}
              onMoveBrand={() => onMoveBrand(b)}
              onDeactivate={() => onDeactivate(b)}
              onReactivate={() => onReactivate(b)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BrandPill({ brand, onMoveBrand, onDeactivate, onReactivate }) {
  const [open, setOpen] = useState(false);
  const isInactive = brand.status === 'inactive';
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 999,
          background: isInactive ? 'var(--surface-3, #e2e8f0)' : 'var(--surface-1)',
          border: `1px solid ${isInactive ? 'var(--border-strong)' : 'var(--border)'}`,
          fontSize: 12, fontWeight: 600,
          color: isInactive ? 'var(--text-muted)' : 'var(--text-primary)',
          cursor: 'pointer',
          textDecoration: isInactive ? 'line-through' : 'none',
        }}>
        <BrandAvatar brand={brand} size={18} radius={4} />
        <span>{brand.brand_name}</span>
        {isInactive && <span style={{ fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>inactive</span>}
        <ChevronRightIcon width="11" height="11" style={{ transform: 'rotate(90deg)' }} />
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="wx-card" style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 41,
            padding: 4, minWidth: 180, boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
          }}>
            <DropdownItem onClick={() => { setOpen(false); onMoveBrand(); }}>
              <PencilIcon width="12" height="12" /> Move brand…
            </DropdownItem>
            {isInactive ? (
              <DropdownItem onClick={() => { setOpen(false); onReactivate(); }}>
                <CheckIcon width="12" height="12" /> Reactivate
              </DropdownItem>
            ) : (
              <DropdownItem onClick={() => { setOpen(false); onDeactivate(); }} danger>
                <AlertIcon width="12" height="12" /> Deactivate
              </DropdownItem>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DropdownItem({ children, onClick, danger }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 10px', border: 0, background: 'transparent',
        textAlign: 'left', fontSize: 12.5, fontWeight: 600,
        color: danger ? 'var(--danger)' : 'var(--text-primary)',
        cursor: 'pointer', borderRadius: 6,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────
// PCTL roster
// ─────────────────────────────────────────────────────────────────
function PctlRoster({ pctls, onMoveIpc }) {
  if (!pctls.length) {
    return <EmptyState icon="🎬" title="No matching Paid Collab Team Leads" />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {pctls.map(({ pctl, ipcs }) => (
        <div key={pctl.id} className="wx-card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <Avatar name={pctl.display_name} tint="#f59e0b" size={42} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{pctl.display_name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Paid Collab TL · {ipcs.length} IPC{ipcs.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>
          {ipcs.length === 0 ? (
            <div style={{ padding: 14, color: 'var(--text-muted)', fontSize: 12.5, fontStyle: 'italic', background: 'var(--surface-2)', borderRadius: 8 }}>
              No IPCs report to this PCTL.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ipcs.map((ipc) => (
                <div key={ipc.id} style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar name={ipc.display_name} tint="#ec4899" size={30} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{ipc.display_name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>IPC</div>
                    </div>
                  </div>
                  <button className="wx-btn wx-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => onMoveIpc(ipc)}>
                    <ChevronRightIcon width="12" height="12" /> Move IPC
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Avatar / EmptyState helpers
// ─────────────────────────────────────────────────────────────────
function Avatar({ name, tint, size = 40 }) {
  const initials = (name || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: size / 4,
      background: `linear-gradient(135deg, ${tint}, color-mix(in srgb, ${tint} 70%, #000))`,
      color: '#fff', display: 'grid', placeItems: 'center',
      fontWeight: 800, fontSize: size * 0.36,
      boxShadow: `0 2px 8px color-mix(in srgb, ${tint} 30%, transparent)`,
    }}>{initials}</div>
  );
}

function EmptyState({ icon, title }) {
  return (
    <div style={{ textAlign: 'center', padding: 40, border: '2px dashed var(--border)', borderRadius: 14 }}>
      <div style={{ fontSize: 30, opacity: 0.5 }}>{icon}</div>
      <div style={{ fontWeight: 700, marginTop: 8, color: 'var(--text-secondary)' }}>{title}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// Modals
// ═════════════════════════════════════════════════════════════════
function ModalShell({ onClose, title, subtitle, children, footer }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)' }} onClick={onClose} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 560, padding: 0, borderRadius: 16, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--border)' }}>
          <h6 style={{ fontWeight: 800, margin: '0 0 4px', fontSize: 15 }}>{title}</h6>
          {subtitle && <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: 0 }}>{subtitle}</p>}
        </div>
        <div style={{ padding: '16px 22px', flexGrow: 1, overflowY: 'auto' }}>{children}</div>
        {footer && (
          <div style={{ padding: '12px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

function MoveApcModal({ apc, tls, onClose, onDone }) {
  // Allow moving APCs to any TL/PCTL — the API supports both.
  const allLeads = useMemo(() => tls.map((n) => n.tl), [tls]);
  const currentTl = apc.reports_to;
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function handleSave() {
    if (!target) { setErr('Pick a new Team Lead.'); return; }
    if (target === currentTl) { setErr('That is already their current Team Lead.'); return; }
    setBusy(true); setErr('');
    try { await moveApcToTl(apc.id, target); onDone(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <ModalShell
      title={`Move ${apc.display_name}`}
      subtitle="Pick a new Team Lead. The APC's current brand assignments stay with them."
      onClose={onClose}
      footer={<>
        <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="wx-btn wx-btn-primary" onClick={handleSave} disabled={busy || !target}>
          {busy ? <><span className="wx-spinner" /> Moving…</> : <><CheckIcon width="14" height="14" /> Move APC</>}
        </button>
      </>}>
      <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' }}>New Team Lead</label>
      <select className="wx-input" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Select a Team Lead…</option>
        {allLeads.map((tl) => (
          <option key={tl.id} value={tl.id} disabled={tl.id === currentTl}>
            {tl.display_name}{tl.id === currentTl ? ' (current)' : ''}
          </option>
        ))}
      </select>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
    </ModalShell>
  );
}

function MoveBrandModal({ brand, tls, allProfiles, onClose, onDone }) {
  const [newTlId, setNewTlId] = useState('');
  const [newApcId, setNewApcId] = useState(''); // '' = unassigned
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  // APCs that report to the chosen TL.
  const apcsForTl = useMemo(() => {
    if (!newTlId) return [];
    return allProfiles.filter((p) =>
      (p.role === 'apc' || p.role === 'ipc') &&
      p.is_active && !p.deleted_at &&
      p.reports_to === newTlId
    );
  }, [allProfiles, newTlId]);

  async function handleSave() {
    if (!newTlId) { setErr('Pick a new Team Lead.'); return; }
    setBusy(true); setErr('');
    try {
      await moveBrand(brand.id, newTlId, newApcId || null, note || null);
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const allLeads = useMemo(() => tls.map((n) => n.tl), [tls]);

  return (
    <ModalShell
      title={`Move "${brand.brand_name}"`}
      subtitle="Pick the destination Team Lead, then which APC under them will handle the brand. Choose Unassigned if the new TL should pick later."
      onClose={onClose}
      footer={<>
        <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="wx-btn wx-btn-primary" onClick={handleSave} disabled={busy || !newTlId}>
          {busy ? <><span className="wx-spinner" /> Moving…</> : <><CheckIcon width="14" height="14" /> Move brand</>}
        </button>
      </>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' }}>New Team Lead</label>
          <select className="wx-input" value={newTlId} onChange={(e) => { setNewTlId(e.target.value); setNewApcId(''); }}>
            <option value="">Select a Team Lead…</option>
            {allLeads.map((tl) => (
              <option key={tl.id} value={tl.id} disabled={tl.id === brand.owner_id}>
                {tl.display_name}{tl.id === brand.owner_id ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' }}>
            APC <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(under the new TL)</span>
          </label>
          <select className="wx-input" value={newApcId}
            onChange={(e) => setNewApcId(e.target.value)} disabled={!newTlId}>
            <option value="">— Unassigned (new TL will pick later) —</option>
            {apcsForTl.map((apc) => (
              <option key={apc.id} value={apc.id}>{apc.display_name}</option>
            ))}
          </select>
          {newTlId && apcsForTl.length === 0 && (
            <p style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 6 }}>
              That Team Lead has no APCs yet — the brand will go in unassigned. They can pick an APC later.
            </p>
          )}
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' }}>
            Note <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional, kept in audit log)</span>
          </label>
          <input className="wx-input" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Hassan is OOO this month, Ali will cover" />
        </div>
      </div>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
    </ModalShell>
  );
}

function MoveIpcModal({ ipc, pctls, onClose, onDone }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const allPctls = useMemo(() => pctls.map((n) => n.pctl), [pctls]);

  async function handleSave() {
    if (!target) { setErr('Pick a new Paid Collab TL.'); return; }
    if (target === ipc.reports_to) { setErr('That is already their current PCTL.'); return; }
    setBusy(true); setErr('');
    try { await moveIpcToPctl(ipc.id, target); onDone(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <ModalShell
      title={`Move ${ipc.display_name}`}
      subtitle="Pick a new Paid Collab Team Lead."
      onClose={onClose}
      footer={<>
        <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="wx-btn wx-btn-primary" onClick={handleSave} disabled={busy || !target}>
          {busy ? <><span className="wx-spinner" /> Moving…</> : <><CheckIcon width="14" height="14" /> Move IPC</>}
        </button>
      </>}>
      <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, display: 'block' }}>New PCTL</label>
      <select className="wx-input" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Select a PCTL…</option>
        {allPctls.map((p) => (
          <option key={p.id} value={p.id} disabled={p.id === ipc.reports_to}>
            {p.display_name}{p.id === ipc.reports_to ? ' (current)' : ''}
          </option>
        ))}
      </select>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
    </ModalShell>
  );
}

function ConfirmDeactivateModal({ brand, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function handleConfirm() {
    setBusy(true); setErr('');
    try { await deactivateBrand(brand.id); onDone(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  return (
    <ModalShell
      title={`Deactivate "${brand.brand_name}"?`}
      subtitle="The brand will be hidden from active dashboards and pickers. New tasks, campaigns, products, and reports will be blocked. Existing data stays — you can reactivate any time."
      onClose={onClose}
      footer={<>
        <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="wx-btn wx-btn-primary" style={{ background: '#dc2626' }} onClick={handleConfirm} disabled={busy}>
          {busy ? <><span className="wx-spinner" /> Deactivating…</> : <><AlertIcon width="14" height="14" /> Deactivate brand</>}
        </button>
      </>}>
      <div style={{ padding: 14, borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 10%, var(--surface-1))', border: '1px solid color-mix(in srgb, var(--warning) 26%, transparent)', fontSize: 13, color: 'var(--text-secondary)' }}>
        Soft deactivation. Brand assignments are kept on the row so reactivating restores the team automatically.
      </div>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginTop: 12 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
    </ModalShell>
  );
}
