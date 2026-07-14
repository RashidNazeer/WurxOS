import React, { useEffect, useMemo, useState } from 'react';
import {
  listAgendaGuestMembers, listAgendaPeople,
  addAgendaGuestMember, removeAgendaGuestMember,
} from '../../lib/agendaApi';

// Guest teams settings — who is on Paid Collab / Paid Media.
//
// Two kinds of membership sit side by side. Role members are derived: every
// PCTL and IPC is on Paid Collab automatically, and hiring another IPC adds
// them without anyone touching this screen — so those chips are not removable
// here (change the person's role instead). Named members are explicit, which
// is how Paid Media works: it isn't a role yet, so the OL picks the people.
//
// Being on a guest team grants nothing by itself. It only makes someone
// eligible to be ticked into a team's meeting under Schedules.

const ROLE_LABEL = {
  boss: 'Boss', ol: 'Operation Lead', tl: 'Team Lead', pctl: 'Paid Collab TL',
  apc: 'Affiliate Coordinator', ipc: 'Influencer Coordinator', developer: 'Developer',
};

export default function AgendaGuestTeamsTab() {
  const [teams, setTeams]     = useState([]);
  const [people, setPeople]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState('');
  const [error, setError]     = useState('');
  const [adding, setAdding]   = useState('');   // slug of the team whose picker is open

  async function reload() {
    const [gt, pp] = await Promise.all([listAgendaGuestMembers(), listAgendaPeople()]);
    setTeams(gt || []);
    setPeople(pp || []);
  }

  useEffect(() => {
    reload()
      .catch((e) => setError(e.message || 'Failed to load guest teams.'))
      .finally(() => setLoading(false));
  }, []);

  const [pick, setPick] = useState('');   // controlled — an uncontrolled select
                                          // can't be retried after a failed add
                                          // (re-choosing the same person fires
                                          // no change event).

  async function handleAdd(slug, userId) {
    if (!userId) return;
    setBusy(`add-${slug}`);
    setError('');
    try {
      await addAgendaGuestMember(slug, userId);
      await reload();
      setAdding('');
    } catch (e) {
      setError(e.message || 'Failed to add.');
    } finally {
      setBusy('');
      setPick('');
    }
  }

  async function handleRemove(slug, userId, name) {
    if (!window.confirm(`Remove ${name} from this guest team? They will stop seeing and being notified about the meetings it is invited to.`)) return;
    setBusy(`rm-${slug}-${userId}`);
    setError('');
    try {
      await removeAgendaGuestMember(slug, userId);
      await reload();
    } catch (e) {
      setError(e.message || 'Failed to remove.');
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading guest teams…</div>;
  }

  return (
    <div>
      <p className="text-muted small mb-3">
        Guest teams sit in on other teams’ agenda meetings. Membership here decides <em>who</em> a guest team is;
        the Schedules tab decides <em>which meetings</em> it joins.
      </p>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <div className="d-flex flex-column gap-3">
        {teams.map((t) => (
          <GuestTeamCard
            key={t.slug}
            team={t}
            people={people}
            busy={busy}
            pickerOpen={adding === t.slug}
            pick={pick}
            onPick={setPick}
            onOpenPicker={() => { setPick(''); setAdding(adding === t.slug ? '' : t.slug); }}
            onAdd={handleAdd}
            onRemove={handleRemove}
          />
        ))}
      </div>
    </div>
  );
}

function GuestTeamCard({ team, people, busy, pickerOpen, pick, onPick, onOpenPicker, onAdd, onRemove }) {
  const roleMembers     = team.roleMembers || [];
  const explicitMembers = team.explicitMembers || [];
  const total = roleMembers.length + explicitMembers.length;

  const roleNames = (team.member_roles || []).map((r) => ROLE_LABEL[r] || r);

  // Anyone not already on this team, by either rule.
  const candidates = useMemo(() => {
    const taken = new Set([...roleMembers, ...explicitMembers].map((p) => p.id));
    return people.filter((p) => !taken.has(p.id));
  }, [people, roleMembers, explicitMembers]);

  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between gap-2 mb-2 flex-wrap">
          <div>
            <div className="fw-semibold d-flex align-items-center gap-2" style={{ fontSize: '0.9rem' }}>
              <i className="bi bi-people-fill text-primary" />{team.label}
            </div>
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>
              {total} {total === 1 ? 'person' : 'people'}
              {roleNames.length > 0 && <> · every {roleNames.join(' and ')} joins automatically</>}
            </div>
          </div>
          <button className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.74rem' }}
            onClick={onOpenPicker}>
            <i className={`bi ${pickerOpen ? 'bi-x-lg' : 'bi-person-plus'}`} />
            {pickerOpen ? 'Cancel' : 'Add person'}
          </button>
        </div>

        {pickerOpen && (
          <div className="rounded-2 p-2 mb-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <label className="form-label small fw-semibold mb-1">Add someone to {team.label}</label>
            <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
              value={pick}
              disabled={busy === `add-${team.slug}`}
              onChange={(e) => { onPick(e.target.value); onAdd(team.slug, e.target.value); }}>
              <option value="">Choose a person…</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name || p.email} — {ROLE_LABEL[p.role] || p.role}
                </option>
              ))}
            </select>
            {candidates.length === 0 && (
              <div className="text-muted mt-1" style={{ fontSize: '0.7rem' }}>Everyone is already on this team.</div>
            )}
          </div>
        )}

        {total === 0 ? (
          <div className="text-muted small">Nobody on this team yet.</div>
        ) : (
          <div className="d-flex flex-wrap gap-2">
            {roleMembers.map((p) => (
              <span key={p.id} className="rounded-2 px-2 py-1 d-inline-flex align-items-center gap-2"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}
                title={`On this team because they are a ${ROLE_LABEL[p.role] || p.role}`}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {p.display_name || p.email}
                </span>
                <span className="text-muted d-inline-flex align-items-center gap-1" style={{ fontSize: '0.62rem', fontWeight: 700 }}>
                  <i className="bi bi-lock-fill" />BY ROLE
                </span>
              </span>
            ))}
            {explicitMembers.map((p) => (
              <span key={p.id} className="rounded-2 px-2 py-1 d-inline-flex align-items-center gap-2"
                style={{ background: 'var(--accent-soft)', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {p.display_name || p.email}
                </span>
                <span className="text-muted" style={{ fontSize: '0.66rem' }}>{ROLE_LABEL[p.role] || p.role}</span>
                <button className="btn btn-sm p-0 px-1 d-inline-flex align-items-center"
                  title="Remove from this guest team"
                  style={{ fontSize: '0.6rem', borderRadius: 5, background: 'var(--surface-1)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
                  disabled={busy === `rm-${team.slug}-${p.id}`}
                  onClick={() => onRemove(team.slug, p.id, p.display_name || p.email)}>
                  {busy === `rm-${team.slug}-${p.id}`
                    ? <span className="spinner-border spinner-border-sm" style={{ width: '0.6rem', height: '0.6rem' }} />
                    : <i className="bi bi-x-lg" />}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
