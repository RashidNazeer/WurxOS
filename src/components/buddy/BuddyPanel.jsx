import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useBuddy } from '../../contexts/BuddyContext';
import { useBrands } from '../../contexts/BrandsContext';
import { pageChips, pageContextFor } from '../../lib/buddyLogic';
import BuddyMascot from './BuddyMascot';
import BuddyThread from './BuddyThread';

// The quick-chat window (400×600, a full-screen sheet on phones). Minimise and
// close only hide it: the reply keeps generating in BuddyProvider.
export default function BuddyPanel({ open }) {
  const { state, greeting, mood, minimise, closePanel, newQuickChat, send, selectPage } = useBuddy();
  const navigate = useNavigate();
  const location = useLocation();
  const { getBrandById } = useBrands();
  const ref = useRef(null);
  const key = state.quickKey;
  const conv = key ? state.convs.find((c) => c.id === key) : null;

  const ctx = pageContextFor(location.pathname, location.search);
  const brand = ctx.brand_id ? getBrandById?.(ctx.brand_id) : null;
  const chips = pageChips(location.pathname, brand?.brandName || brand?.name);

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.querySelector('textarea')?.focus(), 30);
  }, [open, key]);

  const toFab = () => setTimeout(() => document.querySelector('.bd-fab')?.focus(), 0);
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); minimise(); toFab(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the panel while focus is in it.
    const items = [...ref.current.querySelectorAll('button:not([disabled]), a[href], textarea, input, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  };

  const openInTab = () => {
    selectPage(key);
    minimise();
    navigate('/buddy');
  };

  const empty = (
    <div className="bd-quick-empty">
      <div className="bd-row is-bot">
        <BuddyMascot clip="idle" size={30} className="bd-avatar-clip" />
        <div className="bd-bubble is-bot">{greeting}</div>
      </div>
      <div className="bd-chips" aria-label="Suggestions">
        {chips.map((c) => (
          <button key={c} type="button" className="bd-suggest"
            onClick={() => send({ key: null, text: c, surface: 'quick', pageContext: ctx })}>{c}</button>
        ))}
      </div>
    </div>
  );

  return (
    <section
      id="buddy-panel"
      ref={ref}
      className="bd-panel"
      role="dialog"
      aria-label="Wurx Buddy quick chat"
      hidden={!open}
      onKeyDown={onKeyDown}
    >
      <header className="bd-panel-head">
        <BuddyMascot clip={mood === 'thinking' ? 'thinking' : 'idle'} size={34} />
        <div className="bd-panel-title">
          <div className="bd-panel-name">Wurx Buddy</div>
          <div className="bd-panel-sub text-truncate">{conv?.title || 'Here to help, explore and grow'}</div>
        </div>
        <button type="button" className="bd-icon-btn" onClick={newQuickChat} aria-label="New chat" title="New chat"><i className="bi bi-plus-lg" /></button>
        <button type="button" className="bd-icon-btn" onClick={openInTab} aria-label="Open in Buddy tab" title="Open in Buddy"><i className="bi bi-box-arrow-up-right" /></button>
        <button type="button" className="bd-icon-btn" onClick={() => { minimise(); toFab(); }} aria-label="Minimise" title="Minimise"><i className="bi bi-dash-lg" /></button>
        <button type="button" className="bd-icon-btn" onClick={() => { closePanel(); toFab(); }} aria-label="Close" title="Close"><i className="bi bi-x-lg" /></button>
      </header>
      {state.denied
        ? <ComingSoon />
        : <BuddyThread convKey={key} surface="quick" pageContext={ctx} empty={empty} />}
    </section>
  );
}

export function ComingSoon() {
  return (
    <div className="bd-coming-soon">
      <BuddyMascot clip="idle" size={120} />
      <div className="bd-coming-title">Buddy is coming to your role soon</div>
      <div className="bd-coming-sub">We're opening Wurx Buddy to the team step by step. You'll be able to chat here as soon as it's switched on for you. 🐾</div>
    </div>
  );
}
