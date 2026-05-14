import ThemeToggle from '../common/ThemeToggle';
import '../../styles/auth.css';

export default function AuthShell({ children }) {
  return (
    <div className="auth-page">
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-theme-toggle">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-mark">
            <img src="/Logo.png" alt="WurxOS" />
          </div>
          <div>
            <div className="auth-brand-name">WurxOS</div>
            <div className="auth-brand-sub">Operations & Reporting · by Wurx Media</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
