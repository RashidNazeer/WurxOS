// The right-hand panel that opens a feature or a task.
//
// ── WHY THIS IS ONE COMPONENT ──────────────────────────────────────────────
// Both panels used to be written inline, and both painted their background
// with `--surface`, a token WurxOS does not define. An undefined custom
// property invalidates the whole declaration, so the panel was TRANSPARENT:
// the roadmap and the top bar showed straight through it and the panel header
// sat over the search box. One shell now owns the frame:
//
//   * a portal to the document root, so no parent stacking context can put
//     the panel underneath the top bar
//   * a real surface colour from the design tokens
//   * Escape closes it, and yields to a dialog opened from inside it
//   * focus moves into the panel, stays there on Tab, and returns on close
//   * the page behind does not scroll while it is open
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/development.css';

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export default function DevDrawer({ crumb, title, meta, footer, children, onClose, className = '' }) {
  const panel = useRef(null);

  // The effect below runs once per open. Reading onClose through a ref keeps a
  // fresh closure from the parent from tearing it down on every render.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus({ preventScroll: true });

    const onKey = (event) => {
      // A dialog opened from this panel owns the keyboard while it is open.
      if (document.querySelector('.wx-modal-backdrop')) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;

      const items = [...panel.current.querySelectorAll(FOCUSABLE)]
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      if (at === -1) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0]).focus();
      } else if (event.shiftKey && at === 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && at === items.length - 1) {
        event.preventDefault();
        items[0].focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <>
      <div className="dev-drawer-backdrop" onMouseDown={onClose} />
      <aside
        ref={panel}
        className={`dev-drawer ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dev-drawer-title"
        tabIndex={-1}
      >
        <header className="dev-drawer-head">
          <div className="dev-drawer-heading">
            {crumb && <span className="dev-drawer-crumb">{crumb}</span>}
            <h2 id="dev-drawer-title" className="dev-drawer-title">{title}</h2>
            {meta && <div className="dev-drawer-meta">{meta}</div>}
          </div>
          <button type="button" className="dev-drawer-close" onClick={onClose} aria-label="Close">
            <i className="bi bi-x-lg" />
          </button>
        </header>
        <div className="dev-drawer-body">{children}</div>
        {footer && <footer className="dev-drawer-foot">{footer}</footer>}
      </aside>
    </>,
    document.body,
  );
}
