import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Bootstrap 5 + Bootstrap Icons. v1 (CRA) ships with these globally;
// v2 ports of v1 markup (Team Hierarchy, etc.) rely on `card`, `row`,
// `col-*`, `rounded-3`, `bi-*`, etc. Without these the ported markup
// renders as unstyled stacks of divs. v2's own design system (wx-*)
// lives in global.css below and is unaffected.
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles/global.css';
import { registerServiceWorker } from './lib/pwa';
import { startUpdatePolling } from './lib/appUpdate';
import { syncServerTime } from './lib/serverTime';
import { installModalGuard } from './lib/modalGuard';

// Dialogs must not close on an accidental click outside them — only via
// their close (×) / action buttons (and Esc). One capture-phase guard
// covers all .wx-modal-backdrop dialogs.
installModalGuard();

// Sync once at boot so the attendance live-elapsed timer stays correct on
// laptops with a wrong system clock. Re-sync hourly to absorb long-session drift.
syncServerTime();
setInterval(syncServerTime, 60 * 60 * 1000);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();

// Poll for new deployments so users see the calm "update available"
// banner before they ever hit a stale chunk (production only).
startUpdatePolling();
