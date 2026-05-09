import { useRef, useState } from 'react';
import { XIcon } from '../common/Icon';

/**
 * Logo picker: shows preview of current/staged logo, supports choosing
 * a local file (returns File + preview URL to the parent) and clearing.
 *
 * Props:
 *   currentUrl      — existing logo URL (for edit flow)
 *   file            — staged File (from this session) or null
 *   onFileChange    — (File|null) => void
 *   onClearExisting — () => void  (only when currentUrl is set and no staged file)
 *   disabled
 */
export default function LogoPicker({ currentUrl, file, onFileChange, onClearExisting, disabled }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');

  function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    if (f.size > 2 * 1024 * 1024)     { setError('Logo must be under 2MB.'); return; }
    setError('');
    const url = URL.createObjectURL(f);
    setPreview(url);
    onFileChange(f);
  }

  function clear() {
    setPreview(null);
    onFileChange(null);
    if (currentUrl && onClearExisting) onClearExisting();
  }

  const shownUrl = preview || (file ? null : currentUrl) || null;

  return (
    <div>
      <label className="wx-label">Logo <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 72,
            height: 72,
            flex: '0 0 72px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-2)',
            border: '1px dashed var(--border-default)',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            color: 'var(--text-muted)',
            fontSize: 11,
          }}
        >
          {shownUrl ? (
            <img src={shownUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span>No logo</span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={pick}
            disabled={disabled}
          />
          <button
            type="button"
            className="wx-btn wx-btn-ghost"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            style={{ padding: '7px 14px', fontSize: 13 }}
          >
            {shownUrl ? 'Replace' : 'Upload logo'}
          </button>
          {shownUrl && (
            <button
              type="button"
              onClick={clear}
              disabled={disabled}
              style={{
                background: 'transparent',
                border: 0,
                padding: 0,
                fontSize: 12,
                color: 'var(--danger)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <XIcon width="12" height="12" /> Remove
            </button>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>PNG/JPG · up to 2MB</div>
        </div>
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}
