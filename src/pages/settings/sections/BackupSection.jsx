import { useEffect, useState } from 'react';
import { exportAllData, getLastBackupAt, downloadBackup } from '../../../lib/backupApi';
import {
  ShieldIcon, InstallIcon, CheckIcon, AlertIcon, FolderIcon, ClockIcon,
} from '../../../components/common/Icon';
import SectionShell from './SectionShell';

// Human "3 days ago" from an ISO string.
function relTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) {
    const hrs = Math.floor((Date.now() - then) / 3_600_000);
    if (hrs <= 0) return 'just now';
    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  }
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function BackupSection() {
  const [lastBackup, setLastBackup] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | running | done | error
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { filename, bytes, tables, rows }

  useEffect(() => {
    let alive = true;
    getLastBackupAt()
      .then((v) => { if (alive) setLastBackup(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function runBackup() {
    setError('');
    setResult(null);
    setPhase('running');
    try {
      const snapshot = await exportAllData();
      const stamp = (snapshot?.meta?.generated_at || new Date().toISOString()).slice(0, 10);
      const { filename, bytes } = downloadBackup(snapshot, stamp);
      setResult({
        filename,
        bytes,
        tables: snapshot?.meta?.tables?.length ?? 0,
        rows: snapshot?.meta?.total_rows ?? 0,
      });
      setLastBackup(snapshot?.meta?.generated_at || new Date().toISOString());
      setPhase('done');
    } catch (err) {
      setError(err.message || 'Backup failed. Please try again.');
      setPhase('error');
    }
  }

  // Progress popup is intentionally NON-dismissable while running: no close
  // button is rendered and no backdrop handler is wired (the global modal
  // guard also blocks backdrop clicks). This stops the Boss from closing or
  // navigating away mid-export and getting a partial/failed download.
  const rel = relTime(lastBackup);

  return (
    <SectionShell
      icon={ShieldIcon}
      title="Back up all data"
      subtitle="Download a complete snapshot of everything, then keep it safe on Google Drive."
    >
      <div
        style={{
          padding: 16,
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 36, height: 36, flex: '0 0 36px',
            borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center',
            background: 'color-mix(in srgb, var(--primary) 15%, transparent)',
            color: 'var(--primary)',
          }}>
            <ShieldIcon width="18" height="18" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14, marginBottom: 4 }}>
              Complete data backup
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Saves every report, brand, attendance record, incentive, leave request,
              performance entry, meeting, and all other business data into a single file.
              Each backup is a full snapshot — you always get everything, never a partial copy.
            </div>
          </div>
        </div>

        {rel && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 10,
            fontSize: 12.5, color: 'var(--text-muted)',
          }}>
            <ClockIcon width="13" height="13" />
            <span>Last backup: <strong style={{ color: 'var(--text-secondary)' }}>{rel}</strong></span>
          </div>
        )}
        {!rel && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 10,
            fontSize: 12.5, color: 'var(--warning)',
          }}>
            <AlertIcon width="13" height="13" />
            <span>You haven't taken a backup yet.</span>
          </div>
        )}

        <button
          type="button"
          className="wx-btn wx-btn-primary"
          style={{ fontWeight: 600, marginTop: 14 }}
          onClick={runBackup}
        >
          <InstallIcon width="14" height="14" /> Back up all data now
        </button>
      </div>

      {(phase === 'running' || phase === 'done' || phase === 'error') && (
        <div className="wx-modal-backdrop">
          <div
            className="wx-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 460 }}
          >
            <div className="wx-modal-header">
              <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  width: 32, height: 32, borderRadius: 'var(--radius-md)',
                  background: phase === 'error'
                    ? 'var(--danger-soft)'
                    : 'color-mix(in srgb, var(--primary) 15%, transparent)',
                  color: phase === 'error' ? 'var(--danger)' : 'var(--primary)',
                  display: 'grid', placeItems: 'center', flex: '0 0 auto',
                }}>
                  {phase === 'error'
                    ? <AlertIcon width="16" height="16" />
                    : phase === 'done'
                      ? <CheckIcon width="16" height="16" />
                      : <ShieldIcon width="16" height="16" />}
                </span>
                {phase === 'running' && 'Backing up your data…'}
                {phase === 'done' && 'Backup complete'}
                {phase === 'error' && 'Backup failed'}
              </div>
              {/* No close button while running — non-dismissable. */}
            </div>

            <div className="wx-modal-body">
              {phase === 'running' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
                  <span className="wx-spinner" style={{ width: 22, height: 22 }} />
                  <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Collecting a complete snapshot of all data. This may take a moment —
                    please don't close this window.
                  </div>
                </div>
              )}

              {phase === 'done' && (
                <>
                  <div className="wx-alert wx-alert-success" style={{ marginBottom: 12 }}>
                    <CheckIcon width="16" height="16" />
                    <span>Your data has been backed up successfully.</span>
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: 12, borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
                    marginBottom: 12,
                  }}>
                    <FolderIcon width="18" height="18" style={{ color: 'var(--primary)', flex: '0 0 auto', marginTop: 1 }} />
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.55 }}>
                      The file <strong>{result?.filename}</strong> was saved to your{' '}
                      <strong>Downloads</strong> folder.
                      <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
                        Next step: open your Downloads folder and{' '}
                        <strong style={{ color: 'var(--text-primary)' }}>upload this file to Google Drive</strong>{' '}
                        so it's safe off this computer.
                      </div>
                    </div>
                  </div>
                  {result && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {result.rows.toLocaleString()} records across {result.tables} tables · {fmtBytes(result.bytes)}
                    </div>
                  )}
                </>
              )}

              {phase === 'error' && (
                <div className="wx-alert wx-alert-danger">
                  <AlertIcon width="16" height="16" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {phase !== 'running' && (
              <div className="wx-modal-footer">
                {phase === 'error' && (
                  <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setPhase('idle')}>
                    Close
                  </button>
                )}
                {phase === 'error' && (
                  <button type="button" className="wx-btn wx-btn-primary" onClick={runBackup}>
                    Try again
                  </button>
                )}
                {phase === 'done' && (
                  <button type="button" className="wx-btn wx-btn-primary" onClick={() => setPhase('idle')}>
                    Done
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}
