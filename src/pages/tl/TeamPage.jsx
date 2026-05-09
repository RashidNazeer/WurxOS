import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { listAPCsUnderTLWithLoad } from '../../lib/brandsApi';
import CreateUserModal from '../../components/boss/CreateUserModal';
import {
  PlusIcon, SearchIcon, MailIcon, StoreIcon, ShieldIcon, UsersIcon,
} from '../../components/common/Icon';

/**
 * A Team Lead's home for the APCs that report to them. When the Boss
 * has granted `canAddAPC`, an "Add APC" action appears; the edge
 * function re-authorizes the permission server-side and forces the
 * new APC's reports_to to this TL.
 */
export default function TeamPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  const canAddAPC = profile?.role === 'tl' && profile?.permissions?.canAddAPC === true;

  const { data: apcs = [], isLoading, error } = useQuery({
    queryKey: ['tl-team', profile?.id],
    queryFn: () => listAPCsUnderTLWithLoad(profile.id),
    enabled: !!profile?.id,
  });

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return apcs;
    return apcs.filter((a) =>
      (a.display_name || '').toLowerCase().includes(qq) ||
      (a.email || '').toLowerCase().includes(qq),
    );
  }, [apcs, q]);

  const withBrands = apcs.filter((a) => a.brand_count > 0).length;
  const idle       = apcs.length - withBrands;

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">My team</h1>
          <p className="page-subtitle">
            {apcs.length === 0
              ? 'You have no APCs reporting to you yet.'
              : `${apcs.length} APC${apcs.length === 1 ? '' : 's'} · ${withBrands} managing brands · ${idle} available`}
          </p>
        </div>
        {canAddAPC && (
          <button className="wx-btn wx-btn-primary" onClick={() => setAdding(true)}>
            <PlusIcon width="14" height="14" /> Add APC
          </button>
        )}
      </div>

      {/* Search */}
      {apcs.length > 0 && (
        <div className="wx-search" style={{ maxWidth: 360, marginBottom: 14 }}>
          <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
          <input className="wx-input"
            placeholder="Search by name or email…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <span>{error.message}</span>
        </div>
      )}

      {isLoading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : apcs.length === 0 ? (
        <EmptyState canAddAPC={canAddAPC} onAdd={() => setAdding(true)} />
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div className="wx-empty-title">No APCs match</div>
          <div>Try a different search.</div>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 10,
        }}>
          {filtered.map((a) => <ApcCard key={a.id} apc={a} />)}
        </div>
      )}

      {adding && (
        <CreateUserModal
          role="apc"
          title="APCs"
          lockedReportsTo={profile.id}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            qc.invalidateQueries({ queryKey: ['tl-team', profile.id] });
          }}
        />
      )}
    </>
  );
}

function ApcCard({ apc }) {
  const hasBrands = apc.brand_count > 0;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      gap: 12,
      padding: '14px 16px',
      background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)',
      transition: 'border-color var(--dur-fast), box-shadow var(--dur-fast)',
    }}>
      <Avatar user={apc} />
      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 14, fontWeight: 700, color: 'var(--text-primary)',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {apc.display_name}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 999,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>APC</span>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: 'var(--text-muted)', marginTop: 2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          <MailIcon width="11" height="11" /> {apc.email}
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          marginTop: 8,
          padding: '3px 9px',
          borderRadius: 999,
          fontSize: 11.5, fontWeight: 700,
          background: hasBrands
            ? 'color-mix(in srgb, var(--warning) 14%, transparent)'
            : 'color-mix(in srgb, var(--success) 14%, transparent)',
          color: hasBrands ? 'var(--warning)' : 'var(--success)',
        }}>
          <StoreIcon width="11" height="11" />
          {hasBrands
            ? `${apc.brand_count} brand${apc.brand_count === 1 ? '' : 's'}`
            : 'Available'}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ canAddAPC, onAdd }) {
  return (
    <div style={{
      padding: '40px 20px', textAlign: 'center',
      background: 'var(--surface-1)',
      border: '1px dashed var(--border-default)',
      borderRadius: 'var(--radius-lg)',
    }}>
      <div style={{
        width: 52, height: 52, margin: '0 auto 12px',
        borderRadius: '50%',
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'grid', placeItems: 'center',
      }}>
        <UsersIcon width="22" height="22" />
      </div>
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 4 }}>
        No APCs yet
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, maxWidth: 360, margin: '0 auto 14px' }}>
        {canAddAPC
          ? 'Onboard your first APC to start assigning brands and tasks.'
          : 'Ask the Boss to assign APCs to you, or to grant you permission to onboard them yourself.'}
      </div>
      {canAddAPC && (
        <button className="wx-btn wx-btn-primary" onClick={onAdd}>
          <PlusIcon width="14" height="14" /> Add your first APC
        </button>
      )}
      {!canAddAPC && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <ShieldIcon width="12" height="12" /> Add-APC permission not granted
        </div>
      )}
    </div>
  );
}

function Avatar({ user }) {
  const size = 44;
  const style = {
    width: size, height: size, borderRadius: '50%', overflow: 'hidden',
    background: 'var(--surface-2)', color: 'var(--text-secondary)',
    display: 'grid', placeItems: 'center',
    fontSize: 14, fontWeight: 800, flexShrink: 0,
  };
  if (user?.avatar_url) {
    return <div style={style}><img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>;
  }
  const init = String(user?.display_name || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return <div style={style}>{init}</div>;
}
