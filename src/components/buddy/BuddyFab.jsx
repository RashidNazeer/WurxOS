import { Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { lazyWithRetry as lazy } from '../../lib/lazyWithRetry';
import { useBuddy } from '../../contexts/BuddyContext';
import BuddyMascot from './BuddyMascot';
import '../../styles/buddy.css';

// The floating Buddy, bottom-right on every page except the Buddy tab. The
// quick panel's code only downloads the first time it is opened, and stays
// mounted (hidden) afterwards so a half-typed question survives minimising.
const BuddyPanel = lazy(() => import('./BuddyPanel'));

export default function BuddyFab() {
  const buddy = useBuddy();
  const { pathname } = useLocation();
  const onTab = pathname === '/buddy' || pathname.startsWith('/buddy/');
  const modal = useModalOpen(!onTab && !!buddy?.allowed);
  const panelOpen = buddy?.state.panel === 'open';
  const [mounted, setMounted] = useState(false);
  const [bouncing, setBouncing] = useState(false);
  const bounce = buddy?.state.bounce ?? 0;
  const firstBounce = useRef(bounce);

  useEffect(() => { if (panelOpen) setMounted(true); }, [panelOpen]);
  // The tab shows the same conversations; a panel over it would be a duplicate.
  useEffect(() => { if (onTab && panelOpen) buddy.minimise(); }, [onTab, panelOpen, buddy]);
  useEffect(() => {
    if (bounce === firstBounce.current) return undefined;
    setBouncing(true);
    const t = setTimeout(() => setBouncing(false), 900);
    return () => clearTimeout(t);
  }, [bounce]);

  if (!buddy?.allowed) return null;
  const { mood, unreadCount, togglePanel } = buddy;
  const label = ['Ask Buddy',
    mood === 'thinking' ? 'Buddy is replying' : '',
    unreadCount ? `${unreadCount} unread ${unreadCount === 1 ? 'reply' : 'replies'}` : '',
  ].filter(Boolean).join(', ');

  return (
    <div data-buddy-root="">
      {mounted && (
        <Suspense fallback={null}>
          <BuddyPanel open={panelOpen && !onTab} />
        </Suspense>
      )}
      {!onTab && !modal && (
        <button
          type="button"
          className={`bd-fab is-${mood} ${bouncing ? 'is-bounce' : ''} ${panelOpen ? 'is-open' : ''}`}
          onClick={togglePanel}
          aria-label={label}
          aria-expanded={panelOpen}
          aria-controls="buddy-panel"
          data-tip="Ask Buddy"
        >
          <BuddyMascot clip={mood} size={52} />
          {unreadCount > 0 && <span className="bd-badge" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>
      )}
    </div>
  );
}

// Any dialog on screen hides the FAB. The app has several modal styles
// (Bootstrap, .wx-modal-backdrop, and many inline fixed overlays), so besides
// the known selectors we probe the centre of the viewport for a fixed
// full-screen layer. Buddy's own panel (a full-screen sheet on phones) doesn't count.
const MODAL_SELECTORS = '.modal.show, .wx-modal-backdrop, .modal-backdrop, [aria-modal="true"], .dv-drawer-backdrop';

function modalOnScreen() {
  for (const el of document.querySelectorAll(MODAL_SELECTORS)) {
    if (!el.closest('[data-buddy-root]')) return true;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let n = document.elementFromPoint(vw / 2, vh / 2);
  while (n && n !== document.body) {
    if (n.hasAttribute?.('data-buddy-root')) return false;
    const cs = getComputedStyle(n);
    if (cs.position === 'fixed' && n.offsetWidth >= vw * 0.9 && n.offsetHeight >= vh * 0.9) return true;
    n = n.parentElement;
  }
  return false;
}

// Cheap on purpose: off on the Buddy tab (the FAB is hidden there), mutations
// inside Buddy's own DOM (a streaming reply) and pure text changes are
// ignored, and the check runs at most every 300 ms.
const isOwn = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest?.('[data-buddy-root]');
const onlyText = (r) => r.type === 'childList'
  && [...r.addedNodes, ...r.removedNodes].every((n) => n.nodeType !== 1);

function useModalOpen(enabled) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) { setOpen(false); return undefined; }
    let t = null;
    const run = () => { t = null; setOpen(modalOnScreen()); };
    const schedule = () => { if (!t) t = setTimeout(run, 300); };
    const mo = new MutationObserver((records) => {
      if (records.some((r) => !isOwn(r.target) && !onlyText(r))) schedule();
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-modal'] });
    window.addEventListener('resize', schedule);
    run();
    return () => { mo.disconnect(); clearTimeout(t); window.removeEventListener('resize', schedule); };
  }, [enabled]);
  return open;
}
