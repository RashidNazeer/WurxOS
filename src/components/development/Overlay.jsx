// The side panel and the centred dialog used across Development.
//
// Both portal to <body> so no page stacking context can hide them, keep
// keyboard focus inside while open, return focus to what opened them, and
// close on Escape. When a dialog opens on top of the panel, only the top-most
// layer answers the keyboard. Clicking outside a dialog does NOT close it
// (the app-wide rule in lib/modalGuard.js: forms are easy to lose).
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(', ');

function useLayer(ref, onClose, { lockScroll }) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const layer = ref.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = 'hidden';
    const preferred = layer?.querySelector('[data-autofocus]');
    (preferred || layer)?.focus({ preventScroll: true });

    const onKey = (event) => {
      const layers = document.querySelectorAll('[data-dv-layer]');
      if (layers[layers.length - 1] !== layer) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !layer) return;
      const items = [...layer.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      if (event.shiftKey && at <= 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && (at === -1 || at === items.length - 1)) {
        event.preventDefault();
        items[0].focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (lockScroll) document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
    // Runs once per open; onClose is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function Drawer({ onClose, labelledBy, children, className = '' }) {
  const ref = useRef(null);
  useLayer(ref, onClose, { lockScroll: true });
  return createPortal(
    <>
      <div className="dv-drawer-backdrop" onMouseDown={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        data-dv-layer=""
        className={`dv-drawer ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </aside>
    </>,
    document.body,
  );
}

export function Modal({ title, eyebrow, onClose, children, footer, width = 540, onSubmit }) {
  const ref = useRef(null);
  const titleId = useId();
  useLayer(ref, onClose, { lockScroll: false });
  const Body = onSubmit ? 'form' : 'div';
  return createPortal(
    <div className="dv-modal-backdrop">
      <div
        ref={ref}
        data-dv-layer=""
        className="dv-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: width }}
      >
        <header className="dv-modal-head">
          <div>
            {eyebrow && <div className="dv-eyebrow">{eyebrow}</div>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="dv-icon-btn" onClick={onClose} aria-label="Close">
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </header>
        <Body
          className="dv-modal-form"
          onSubmit={onSubmit ? (event) => { event.preventDefault(); onSubmit(event); } : undefined}
          noValidate={onSubmit ? true : undefined}
        >
          <div className="dv-modal-body">{children}</div>
          {footer && <footer className="dv-modal-foot">{footer}</footer>}
        </Body>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={(
        <>
          <button type="button" className="dv-btn is-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`dv-btn ${danger ? 'is-danger' : 'is-primary'}`}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus=""
          >
            {confirmLabel}
          </button>
        </>
      )}
    >
      {body && <p className="dv-confirm-body">{body}</p>}
    </Modal>
  );
}

export function Field({ label, htmlFor, hint, error, children, className = '' }) {
  return (
    <div className={`dv-field ${className}`.trim()}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="dv-field-error" role="alert">{error}</p> : hint && <p className="dv-field-hint">{hint}</p>}
    </div>
  );
}
