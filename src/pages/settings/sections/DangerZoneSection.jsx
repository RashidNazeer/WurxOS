import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { wipeAllOperationalData } from '../../../lib/adminApi';
import { AlertIcon, TrashIcon, XIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';

const CONFIRM_PHRASE = 'DELETE EVERYTHING';

const WIPED_TABLES = [
  'Brands & assignments', 'Tasks & comments', 'Reports', 'Resources',
  'Campaigns & product campaigns', 'Broadcasts', 'Attendance & leave',
  'Incentives', 'Performance ratings & warnings', 'Chat (channels & messages)',
  'Notifications', 'Bug reports', 'Suggestions', 'Changes',
  'Knowledge base', 'Reminders', 'Brand switch requests',
  'All user accounts (TLs, PCTLs, OLs, APCs, IPCs, Developers)',
];

const PRESERVED = [
  'Your own Boss account', 'Audit log',
  'System configuration',
];

export default function DangerZoneSection() {
  const [showModal, setShowModal] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [wiping, setWiping] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const qc = useQueryClient();

  function open() {
    setConfirm('');
    setError('');
    setResult(null);
    setShowModal(true);
  }

  function close() {
    if (wiping) return;
    setShowModal(false);
  }

  async function handleWipe() {
    setError('');
    if (confirm.trim() !== CONFIRM_PHRASE) {
      setError(`Type "${CONFIRM_PHRASE}" exactly to confirm.`);
      return;
    }
    setWiping(true);
    try {
      const response = await wipeAllOperationalData();
      setResult(response);
      // Blow away every cached query — the data they reference is gone.
      qc.clear();
    } catch (err) {
      setError(err.message || 'Failed to wipe data.');
    } finally {
      setWiping(false);
    }
  }

  return (
    <SectionShell
      icon={TrashIcon}
      title="Danger Zone"
      subtitle="Irreversible operations that affect the entire workspace."
    >
      <div
        style={{
          padding: 16,
          border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--danger-soft)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 36, height: 36, flex: '0 0 36px',
            borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center',
            background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
            color: 'var(--danger)',
          }}>
            <TrashIcon width="18" height="18" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--danger)', fontSize: 14, marginBottom: 4 }}>
              Wipe all operational data
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Permanently removes all brands, tasks, reports, resources, campaigns,
              broadcasts, chat history, and every other piece of operational data.
              User accounts and system configuration are preserved.
            </div>
          </div>
        </div>
        <button
          type="button"
          className="wx-btn"
          style={{
            background: 'var(--danger)', color: '#fff', border: 0,
            fontWeight: 600, marginTop: 12,
          }}
          onClick={open}
        >
          <TrashIcon width="14" height="14" /> Wipe all data…
        </button>
      </div>

      {showModal && (
        <div className="wx-modal-backdrop" onClick={close}>
          <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="wx-modal-header">
              <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  width: 32, height: 32, borderRadius: 'var(--radius-md)',
                  background: 'var(--danger-soft)', color: 'var(--danger)',
                  display: 'grid', placeItems: 'center', flex: '0 0 auto',
                }}>
                  <AlertIcon width="16" height="16" />
                </span>
                {result ? 'Wipe complete' : 'Wipe all operational data'}
              </div>
              <button type="button" className="shell-icon-btn" onClick={close} aria-label="Close">
                <XIcon width="16" height="16" />
              </button>
            </div>
            <div className="wx-modal-body">
              {error && (
                <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                  <AlertIcon width="16" height="16" /> <span>{error}</span>
                </div>
              )}

              {result ? (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 12 }}>
                    The workspace has been reset. Here's what was wiped:
                  </div>
                  <div style={{
                    border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
                    overflow: 'hidden', maxHeight: 280, overflowY: 'auto', marginBottom: 12,
                  }}>
                    {(result.summary || []).map((row) => (
                      <div
                        key={row.table_name}
                        style={{
                          display: 'flex', justifyContent: 'space-between',
                          padding: '8px 12px', fontSize: 13,
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                      >
                        <span style={{ color: 'var(--text-secondary)' }}>{row.table_name}</span>
                        <strong style={{ color: 'var(--text-primary)' }}>
                          {row.rows_before} {row.rows_before === 1 ? 'row' : 'rows'}
                        </strong>
                      </div>
                    ))}
                    {result.deletedUsers != null && (
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        padding: '8px 12px', fontSize: 13,
                        background: 'var(--surface-2)',
                      }}>
                        <span style={{ color: 'var(--text-secondary)' }}>User accounts deleted</span>
                        <strong style={{ color: 'var(--danger)' }}>
                          {result.deletedUsers} {result.deletedUsers === 1 ? 'user' : 'users'}
                        </strong>
                      </div>
                    )}
                  </div>
                  {result.userErrors && result.userErrors.length > 0 && (
                    <div className="wx-alert wx-alert-warning" style={{ marginBottom: 10, fontSize: 12 }}>
                      <AlertIcon width="14" height="14" />
                      <span>
                        {result.userErrors.length} user(s) couldn't be deleted —
                        check the Supabase auth dashboard to investigate.
                      </span>
                    </div>
                  )}
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                    Your Boss account, system config, and the audit log were preserved
                    so you can keep using the system.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 12, lineHeight: 1.5 }}>
                    This will <strong>permanently delete</strong> all operational data
                    in your workspace. This cannot be undone.
                  </div>

                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14,
                  }}>
                    <div style={{
                      padding: 12, borderRadius: 'var(--radius-md)',
                      background: 'var(--danger-soft)',
                      border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
                    }}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, color: 'var(--danger)',
                        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
                      }}>
                        Will be deleted
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
                        {WIPED_TABLES.map((t) => <li key={t}>{t}</li>)}
                      </ul>
                    </div>
                    <div style={{
                      padding: 12, borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-subtle)',
                    }}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
                        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
                      }}>
                        Preserved
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
                        {PRESERVED.map((t) => <li key={t}>{t}</li>)}
                      </ul>
                    </div>
                  </div>

                  <label className="wx-label" style={{ marginBottom: 6 }}>
                    Type <strong style={{ color: 'var(--danger)' }}>{CONFIRM_PHRASE}</strong> to confirm
                  </label>
                  <input
                    className="wx-input"
                    placeholder={CONFIRM_PHRASE}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    disabled={wiping}
                    autoFocus
                  />
                </>
              )}
            </div>
            <div className="wx-modal-footer">
              {result ? (
                <button type="button" className="wx-btn wx-btn-primary" onClick={close}>
                  Done
                </button>
              ) : (
                <>
                  <button type="button" className="wx-btn wx-btn-ghost" onClick={close} disabled={wiping}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="wx-btn"
                    style={{
                      background: confirm.trim() === CONFIRM_PHRASE && !wiping ? 'var(--danger)' : 'var(--surface-3)',
                      color: confirm.trim() === CONFIRM_PHRASE && !wiping ? '#fff' : 'var(--text-muted)',
                      border: 0, fontWeight: 600,
                      cursor: confirm.trim() === CONFIRM_PHRASE && !wiping ? 'pointer' : 'not-allowed',
                    }}
                    onClick={handleWipe}
                    disabled={confirm.trim() !== CONFIRM_PHRASE || wiping}
                  >
                    {wiping ? <><span className="wx-spinner" /> Wiping…</> : 'Wipe everything'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
}
