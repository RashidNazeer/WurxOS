import { useState } from 'react';
import { createPortal } from 'react-dom';
import { reportIssue } from '../../lib/devTasksApi';
import '../../styles/table.css';
import '../../styles/development.css';

export default function ReportIssueModal({ profile, onClose }) {
  const [happened, setHappened] = useState('');
  const [expected, setExpected] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const pageUrl = `${window.location.pathname}${window.location.search}`;

  function acceptFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose an image screenshot.'); return; }
    setError(''); setScreenshot(file);
  }

  async function send() {
    setBusy(true); setError('');
    try {
      await reportIssue({ pageUrl, happened, expected, screenshot });
      setSent(true);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return createPortal(
    <div className="wx-modal-backdrop" onMouseDown={onClose}>
      <div className="wx-modal" style={{ maxWidth: 520 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Report an issue</div>
          <button className="wx-btn wx-btn-ghost" onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button>
        </div>
        <div className="wx-modal-body">
          {sent ? (
            <div className="dev-issue-sent">
              <i className="bi bi-check-circle-fill" />
              <h3>Sent to Development</h3>
              <p>You’ll get a notification when the fix is live.</p>
            </div>
          ) : (
            <div className="dev-form" onPaste={(event) => {
              const file = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile();
              if (file) acceptFile(file);
            }}>
              {error && <div className="wx-alert wx-alert-danger">{error}</div>}
              <div className="dev-issue-prefill"><span><small>Page</small><b>{pageUrl}</b></span><span><small>Reported by</small><b>{profile?.display_name} · {profile?.role?.toUpperCase()}</b></span></div>
              <label>What happened<textarea className="wx-input" rows={4} autoFocus value={happened} onChange={(event) => setHappened(event.target.value)} placeholder="What did you click, and what happened next?" /></label>
              <label>What you expected<textarea className="wx-input" rows={2} value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="What should have happened?" /></label>
              <label>Screenshot <span>optional</span><span className="dev-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptFile(event.dataTransfer.files[0]); }}><i className="bi bi-image" />{screenshot ? screenshot.name : 'Drop image, paste, or choose a file'}<input type="file" accept="image/*" onChange={(event) => acceptFile(event.target.files[0])} /></span></label>
            </div>
          )}
        </div>
        <div className="wx-modal-footer">
          {sent ? <button className="wx-btn wx-btn-primary" onClick={onClose}>Done</button> : <><button className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button><button className="wx-btn wx-btn-primary" disabled={busy || !happened.trim()} onClick={send}>{busy ? 'Sending…' : 'Send issue'}</button></>}
        </div>
      </div>
    </div>, document.body,
  );
}
