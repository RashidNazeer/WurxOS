import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { updateUserProfile } from '../../../lib/adminApi';
import { roleLabel } from '../../../lib/roles';
import {
  UserIcon, AlertIcon, CheckIcon, LockIcon, EyeIcon, EyeOffIcon, XIcon,
} from '../../../components/common/Icon';
import SectionShell from './SectionShell';
import AvatarEditorModal from '../../../components/account/AvatarEditorModal';

export default function AccountSection() {
  const { user, profile, refreshProfile } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.display_name || '');
  const [savingName, setSavingName]   = useState(false);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw]         = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw]       = useState(false);
  const [savingPw, setSavingPw]   = useState(false);

  const [uploading, setUploading] = useState(false);
  // Holds the raw file the user picked. When set, the AvatarEditorModal
  // opens so they can drag/zoom to position the photo inside a circle
  // before it's uploaded. The modal returns a 512×512 PNG blob.
  const [editingFile, setEditingFile] = useState(null);

  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  function onAvatarPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Photo must be ≤ 5 MB before editing. Pick a smaller source image.');
      e.target.value = '';
      return;
    }
    setError('');
    setEditingFile(file);
    e.target.value = '';
  }

  async function uploadEditedAvatar({ blob }) {
    setError(''); setUploading(true);
    try {
      const path = `${user.id}/${Date.now()}.png`;
      const up = await supabase.storage.from('avatars').upload(path, blob, {
        cacheControl: '3600', contentType: 'image/png', upsert: true,
      });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
      await updateUserProfile(user.id, { avatar_url: pub.publicUrl });
      await refreshProfile();
      setSuccess('Avatar updated.');
      setEditingFile(null);
      setTimeout(() => setSuccess(''), 2500);
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    setError(''); setUploading(true);
    try {
      await updateUserProfile(user.id, { avatar_url: null });
      await refreshProfile();
      setSuccess('Avatar removed.');
      setTimeout(() => setSuccess(''), 2500);
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  }

  useEffect(() => {
    setDisplayName(profile?.display_name || '');
  }, [profile?.display_name]);

  async function saveName() {
    setError(''); setSuccess('');
    if (!displayName.trim()) { setError('Name cannot be empty.'); return; }
    try {
      setSavingName(true);
      await updateUserProfile(user.id, { display_name: displayName.trim() });
      await refreshProfile();
      setSuccess('Name updated.');
      setTimeout(() => setSuccess(''), 2500);
    } catch (err) {
      setError(err.message || 'Failed to update name.');
    } finally { setSavingName(false); }
  }

  async function savePassword(e) {
    e.preventDefault();
    setError(''); setSuccess('');

    if (newPw.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (newPw !== confirmPw) { setError('New password and confirmation do not match.'); return; }
    if (!currentPw) { setError('Enter your current password.'); return; }

    try {
      setSavingPw(true);
      // Re-auth with current password to verify identity before changing
      const { error: reErr } = await supabase.auth.signInWithPassword({
        email: user.email, password: currentPw,
      });
      if (reErr) { setError('Current password is incorrect.'); setSavingPw(false); return; }

      const { error: upErr } = await supabase.auth.updateUser({ password: newPw });
      if (upErr) throw upErr;

      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      setSuccess('Password changed successfully.');
      setTimeout(() => setSuccess(''), 2500);
    } catch (err) {
      setError(err.message || 'Failed to change password.');
    } finally { setSavingPw(false); }
  }

  return (
    <>
      <SectionShell
        icon={UserIcon}
        title="Profile"
        subtitle="Your name and role."
      >
        {error && (
          <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
            <AlertIcon width="14" height="14" /> <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}>
            <CheckIcon width="14" height="14" /> <span>{success}</span>
          </div>
        )}

        <div className="settings-row">
          <div>
            <div className="settings-row-label-title">Profile photo</div>
            <div className="settings-row-label-sub">PNG / JPG up to 5 MB. After picking, drag and zoom to frame the photo inside a circle.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="Avatar"
                style={{ width: 42, height: 42, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border-subtle)' }} />
            ) : (
              <div style={{
                width: 42, height: 42, borderRadius: '50%',
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'grid', placeItems: 'center', fontWeight: 700,
              }}>
                {(profile?.display_name || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase()}
              </div>
            )}
            <label className="wx-btn wx-btn-ghost" style={{ cursor: 'pointer' }}>
              <input type="file" accept="image/*" onChange={onAvatarPick} style={{ display: 'none' }} disabled={uploading} />
              {uploading ? <><span className="wx-spinner" /> Uploading…</> : 'Change'}
            </label>
            {profile?.avatar_url && (
              <button className="wx-btn wx-btn-ghost" onClick={removeAvatar} disabled={uploading}>
                <XIcon width="13" height="13" /> Remove
              </button>
            )}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row-label-title">Display name</div>
            <div className="settings-row-label-sub">What your teammates see on brands, tasks and reports.</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="wx-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={savingName}
              style={{ minWidth: 220 }}
            />
            <button
              className="wx-btn wx-btn-primary"
              onClick={saveName}
              disabled={savingName || displayName.trim() === (profile?.display_name || '').trim()}
            >
              {savingName ? <><span className="wx-spinner" /> Saving…</> : 'Save'}
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row-label-title">Email</div>
            <div className="settings-row-label-sub">Used to sign in. Contact your administrator to change.</div>
          </div>
          <input className="wx-input" value={user?.email || ''} disabled style={{ minWidth: 260 }} />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row-label-title">Role</div>
            <div className="settings-row-label-sub">Granted by your administrator.</div>
          </div>
          <span className="wx-badge wx-badge-muted" style={{ textTransform: 'none' }}>
            {profile?.role ? roleLabel(profile.role) : '—'}
          </span>
        </div>
      </SectionShell>

      <SectionShell
        icon={LockIcon}
        title="Change password"
        subtitle="We'll verify your current password before setting a new one."
      >
        <form onSubmit={savePassword} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="wx-label">Current password</label>
            <div className="wx-input-group">
              <span className="wx-input-group-icon"><LockIcon /></span>
              <input
                type={showPw ? 'text' : 'password'}
                className="wx-input"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                autoComplete="current-password"
                disabled={savingPw}
              />
              <button
                type="button" className="wx-input-group-action"
                onClick={() => setShowPw((v) => !v)} tabIndex={-1}
              >
                {showPw ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="wx-label">New password</label>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><LockIcon /></span>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="wx-input"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                  disabled={savingPw}
                  placeholder="At least 8 characters"
                />
              </div>
            </div>
            <div>
              <label className="wx-label">Confirm new</label>
              <div className="wx-input-group">
                <span className="wx-input-group-icon"><LockIcon /></span>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="wx-input"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                  disabled={savingPw}
                  placeholder="Re-enter new password"
                />
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={savingPw}>
              {savingPw ? <><span className="wx-spinner" /> Updating…</> : 'Change password'}
            </button>
          </div>
        </form>
      </SectionShell>

      {editingFile && (
        <AvatarEditorModal
          file={editingFile}
          saving={uploading}
          onCancel={() => { if (!uploading) setEditingFile(null); }}
          onSave={uploadEditedAvatar}
        />
      )}
    </>
  );
}
