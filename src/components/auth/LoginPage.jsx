import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import AuthShell from './AuthShell';
import {
  MailIcon, LockIcon, EyeIcon, EyeOffIcon, ArrowRightIcon, AlertIcon,
} from '../common/Icon';

export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from?.pathname || '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setSubmitting(true);
    try {
      await signIn({ email: email.trim(), password });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.message || 'Could not sign in. Check your credentials.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="auth-heading">Welcome back</h1>
      <p className="auth-subheading">Sign in to continue to your workspace.</p>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 16 }}>
          <AlertIcon width="16" height="16" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label className="wx-label" htmlFor="email">Email</label>
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
              autoComplete="current-password"
              className="wx-input"
              placeholder="••••••••"
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

        <div className="auth-row-between">
          <span />
          <button type="button" className="auth-link" disabled>Forgot password?</button>
        </div>

        <button
          type="submit"
          className="wx-btn wx-btn-primary wx-btn-block"
          disabled={submitting}
        >
          {submitting ? (
            <><span className="wx-spinner" /> Signing in…</>
          ) : (
            <>Sign in <ArrowRightIcon width="16" height="16" /></>
          )}
        </button>
      </form>

      <div className="auth-footer">
        Don't have an account?{' '}
        <Link to="/signup" className="auth-link" style={{ display: 'inline' }}>Create one</Link>
      </div>
    </AuthShell>
  );
}
