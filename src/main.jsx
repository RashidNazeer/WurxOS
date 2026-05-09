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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
