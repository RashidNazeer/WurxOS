import { useState } from 'react';
import { createUser, generatePassword } from '../../lib/adminApi';
import { getRoleExtras, roleLabel } from '../../lib/roles';
import RoleExtraFields, { ResponsibilityTags } from './RoleExtraFields';
import {
  XIcon, MailIcon, LockIcon, UserIcon, EyeIcon, EyeOffIcon,
  RefreshIcon, CopyIcon, AlertIcon, CheckIcon,
} from '../common/Icon';

export default function CreateUserModal({ role, title, onClose, onCreated, lockedReportsTo = null }) {
  const extras = getRoleExtras(role);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState(() => generatePassword(12));
  const [showPw, setShowPw]           = useState(true);
  const [reportsTo, setReportsTo]         = useState(lockedReportsTo || '');
  const [permissions, setPermissions]     = useState({});
  const [responsibilities, setResponsibilities] = useState([]);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [copied, setCopied]           = useState(false);
  const [created, setCreated]         = useState(null); // populated after success

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!displayName.trim()) return setError('Please enter the user\'s name.');
    if (!email.trim())       return setError('Email is required.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    const effectiveReportsTo = lockedReportsTo || reportsTo;
    if (extras.reportsToRole && !effectiveReportsTo) {
      return setError(`Please select a ${roleLabel(extras.reportsToRole)} to assign this user to.`);
    }

    setSaving(true);
    try {
      const result = await createUser({
        email: email.trim().toLowerCase(),
        password,
        displayName: displayName.trim(),
        role,
        reportsTo: extras.reportsToRole ? effectiveReportsTo : null,
        // Locked (delegated) flows never carry self-granted permissions.
        permissions: lockedReportsTo ? {} : (extras.permissions.length ? permissions : {}),
        responsibilities,
      });
      setCreated(result);
    } catch (err) {
      setError(err.message || 'Failed to create user.');
    } finally {
      setSaving(false);
    }
  }

  async function copyCreds() {
    const text = `Email: ${email}\nPassword: ${password}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  // ---------- Success state ----------
  if (created) {
    return (
      <div className="wx-modal-backdrop" onClick={onClose}>
        <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">User created</div>
            <button className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px',
                background: 'var(--success-soft)',
                color: 'var(--success)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 16,
                fontSize: 13.5,
                fontWeight: 600,
              }}
            >
              <CheckIcon width="18" height="18" />
              <span>Account ready. Share the credentials below with {displayName}.</span>
            </div>

            <div
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '14px 16px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
                marginBottom: 14,
              }}
            >
              <Kv label="Email" value={email} />
              <Kv label="Password" value={password} mask={!showPw} />
              <Kv label="Role" value={title} />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="wx-btn wx-btn-ghost"
                onClick={() => setShowPw((v) => !v)}
                style={{ flex: 1 }}
              >
                {showPw ? <EyeOffIcon width="15" height="15" /> : <EyeIcon width="15" height="15" />}
                {showPw ? 'Hide' : 'Show'} password
              </button>
              <button className="wx-btn wx-btn-ghost" onClick={copyCreds} style={{ flex: 1 }}>
                {copied ? <CheckIcon width="15" height="15" /> : <CopyIcon width="15" height="15" />}
                {copied ? 'Copied' : 'Copy credentials'}
              </button>
            </div>
          </div>
          <div className="wx-modal-footer">
            <button className="wx-btn wx-btn-primary" onClick={onCreated}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Create form ----------
  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">Add {title.replace(/s$/, '')}</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            {error && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
                <AlertIcon width="16" height="16" />
                <span>{error}</span>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Full name</label>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><UserIcon /></span>
                <input
                  className="wx-input"
                  placeholder="Jane Doe"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Work email</label>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><MailIcon /></span>
                <input
                  type="email"
                  className="wx-input"
                  placeholder="jane@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div style={{ marginBottom: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label className="wx-label" style={{ margin: 0 }}>Password</label>
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => setPassword(generatePassword(12))}
                  disabled={saving}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <RefreshIcon width="12" height="12" /> Regenerate
                </button>
              </div>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><LockIcon /></span>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="wx-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saving}
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                />
                <button
                  type="button"
                  className="wx-input-group-action"
                  onClick={() => setShowPw((v) => !v)}
                  tabIndex={-1}
                >
                  {showPw ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                You'll share this password with the user. They can change it after signing in.
              </div>
            </div>

            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <RoleExtraFields
                role={role}
                reportsTo={reportsTo}
                onReportsTo={setReportsTo}
                permissions={permissions}
                onPermissions={setPermissions}
                disabled={saving}
                lockedReportsTo={lockedReportsTo}
              />
              <ResponsibilityTags
                value={responsibilities}
                onChange={setResponsibilities}
                disabled={saving}
              />
            </div>
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Creating…</> : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Kv({ label, value, mask }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0' }}>
      <div style={{ width: 80, color: 'var(--text-muted)', fontSize: 12 }}>{label}</div>
      <div style={{ color: 'var(--text-primary)', wordBreak: 'break-all', flex: 1 }}>
        {mask ? '•'.repeat(Math.min(value.length, 14)) : value}
      </div>
    </div>
  );
}
