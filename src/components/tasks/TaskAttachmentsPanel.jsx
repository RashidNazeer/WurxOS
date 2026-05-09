import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listTaskAttachments, uploadTaskAttachment, deleteTaskAttachment, attachmentUrl,
} from '../../lib/taskAttachmentsApi';
import { AlertIcon, XIcon, PlusIcon } from '../common/Icon';

export default function TaskAttachmentsPanel({ taskId }) {
  const { user, profile } = useAuth();
  const isBoss = profile?.role === 'boss';

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput             = useRef(null);

  async function load() {
    setLoading(true); setErr('');
    try { setRows(await listTaskAttachments(taskId)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [taskId]);

  async function onPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(''); setUploading(true);
    try {
      const row = await uploadTaskAttachment(taskId, file);
      setRows((r) => [row, ...r]);
    } catch (e) { setErr(e.message); }
    finally { setUploading(false); e.target.value = ''; }
  }

  async function open(row) {
    try {
      const url = await attachmentUrl(row.file_path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) { setErr(e.message); }
  }

  async function remove(row) {
    if (!confirm(`Delete "${row.file_name}"?`)) return;
    try { await deleteTaskAttachment(row); setRows((rs) => rs.filter((x) => x.id !== row.id)); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{
        fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>Attachments {rows.length > 0 && <span style={{ color: 'var(--text-secondary)' }}>· {rows.length}</span>}</span>
        <button type="button" className="wx-btn wx-btn-ghost"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          style={{ padding: '4px 10px', fontSize: 11.5 }}>
          {uploading ? <><span className="wx-spinner" /> Uploading…</> : <><PlusIcon width="12" height="12" /> Upload</>}
        </button>
        <input ref={fileInput} type="file" onChange={onPick} style={{ display: 'none' }} />
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border-default)', padding: '10px 12px',
          borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: 12.5,
          textAlign: 'center',
        }}>No attachments yet. Upload one (≤ 10 MB).</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1fr auto',
              gap: 10, alignItems: 'center',
              padding: '8px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}>
              <button type="button" onClick={() => open(r)}
                style={{ border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: 0, color: 'inherit' }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent)', wordBreak: 'break-word' }}>
                  {r.file_name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {fmtSize(r.file_size)} · by {r.uploader?.display_name || '—'} · {new Date(r.created_at).toLocaleDateString()}
                </div>
              </button>
              {(r.uploader_id === user?.id || isBoss) && (
                <button onClick={() => remove(r)} title="Delete"
                  style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                  <XIcon width="13" height="13" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
