// A centred dialog for the Development workspace, built on the shared
// .wx-modal shell.
//
// ── IT MUST SIT ABOVE THE DRAWER ───────────────────────────────────────────
// "Add task", "Edit" and "Send back" open from inside a feature or task
// drawer. The shared modal backdrop is z-index 1000 and the drawer is 1041, so
// these dialogs used to open BEHIND the panel that launched them.
// `dev-modal-layer` lifts this backdrop above the drawer.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/table.css';
import '../../styles/development.css';

export default function DevModal({ title, children, onClose, footer, wide = false }) {
  // Read through a ref so a new onClose on every parent render does not
  // re-register the listener.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div className="wx-modal-backdrop dev-modal-layer" onMouseDown={onClose}>
      <div
        className="wx-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={{ maxWidth: wide ? 680 : 540 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="wx-modal-header">
          <div className="wx-modal-title">{title}</div>
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} aria-label="Close">
            <i className="bi bi-x-lg" />
          </button>
        </div>
        <div className="wx-modal-body">{children}</div>
        {footer && <div className="wx-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
