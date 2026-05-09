import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import AuthShell from './AuthShell';
import {
  MailIcon, LockIcon, UserIcon, EyeIcon, EyeOffIcon,
  ArrowRightIcon, AlertIcon, CheckIcon,
} from '../common/Icon';

export default function SignupPage() {
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [bossExists, setBossExists] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('boss_exists');
      if (cancelled) return;
      if (error) {
        console.warn('[signup] boss_exists check failed:', error.message);
        setBossExists(false);
      } else {
        setBossExists(Boolean(data));
      }
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!displayName.trim()) return setError('Please enter your name.');
    if (!email.trim()) return setError('Email is required.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');

    setSubmitting(true);
    try {
      const data = await signUp({
        email: email.trim(),
        password,
        displayName: displayName.trim(),
      });
      if (data.session) {
        navigate('/dashboard', { replace: true });
      } else {
        setSuccess('Account created. Please check your email to confirm before signing in.');
      }
    } catch (err) {
      setError(err.message || 'Could not create your account.');
    } finally {
      setSubmitting(false);
    }
  }

  // --- Render states -----------------------------------------------------
  if (checking) {
    return (
      <AuthShell>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          color: 'var(--text-muted)', fontSize: 14, padding: '16px 0',
        }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
          Checking workspace status…
        </div>
      </AuthShell>
    );
  }

  if (bossExists) {
    return (
      <AuthShell>
        <h1 className="auth-heading">Signups are disabled</h1>
        <p className="auth-subheading">
          This workspace has already been set up. New accounts are created by
          your administrator from the admin panel.
        </p>
        <div className="wx-alert wx-alert-info" style={{ marginBottom: 18 }}>
          <AlertIcon width="16" height="16" />
          <span>
            If you're expecting an account, ask your Boss or Operation Lead
            to invite you.
          </span>
        </div>
        <Link to="/login" className="wx-btn wx-btn-primary wx-btn-block" style={{ textDecoration: 'none' }}>
          Go to sign in <ArrowRightIcon width="16" height="16" />
        </Link>
      </AuthShell>
    );
  }

  // --- Boss bootstrap form ----------------------------------------------
  return (
    <AuthShell>
      <h1 className="auth-heading">Set up your workspace</h1>
      <p className="auth-subheading">
        You're creating the <strong style={{ color: 'var(--accent)' }}>Boss</strong> account.
        This is a one-time setup — you'll invite your team from the admin panel afterwards.
      </p>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 16 }}>
          <AlertIcon width="16" height="16" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="wx-alert wx-alert-success" style={{ marginBottom: 16 }}>
          <CheckIcon width="16" height="16" />
          <span>{success}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label className="wx-label" htmlFor="name">Full name</label>
          <div className="wx-input-group">
            <span className="wx-input-group-icon"><UserIcon /></span>
            <input
              id="name"
              type="text"
              autoComplete="name"
              className="wx-input"
              placeholder="Your name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        <div className="auth-field">
          <label className="wx-label" htmlFor="email">Work email</label>
          <div className="wx-input-group">
            <span className="wx-input-group-icon"><MailIcon /></span>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="wx-input"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        <div className="auth-field">
          <label className="wx-label" htmlFor="password">Password</label>
          <div className="wx-input-group">
            <span className="wx-input-group-icon"><LockIcon /></span>
            <input
              id="password"
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              className="wx-input"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            <button
              type="button"
              className="wx-input-group-action"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPw ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          className="wx-btn wx-btn-primary wx-btn-block"
          disabled={submitting}
          style={{ marginTop: 8 }}
        >
          {submitting ? (
            <><span className="wx-spinner" /> Creating your workspace…</>
          ) : (
            <>Create Boss account <ArrowRightIcon width="16" height="16" /></>
          )}
        </button>
      </form>

      <div className="auth-footer">
        Already have an account?{' '}
        <Link to="/login" className="auth-link" style={{ display: 'inline' }}>Sign in</Link>
      </div>
    </AuthShell>
  );
}
