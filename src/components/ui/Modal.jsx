import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

// Open dialogs, topmost last: only the top one handles Escape / Tab.
const stack = [];
let scrollLocks = 0;
let prevOverflow = '';

/**
 * <Modal open onClose title description footer size="sm|md|lg"
 *        dirty closeOnBackdrop initialFocusRef onDirtyAttempt hideClose>
 *
 * - role="dialog" aria-modal, labelled by the title.
 * - Escape closes; Tab is trapped; focus returns to the opener on close.
 * - The backdrop only closes when closeOnBackdrop is set (app rule:
 *   dialogs don't close on a stray click), and never while `dirty`.
 *   While dirty, Escape and backdrop clicks call onDirtyAttempt instead
 *   (e.g. to show a "discard changes?" confirm). The × button always
 *   calls onClose.
 * - At <= 576px it becomes a full-screen sheet.
 */
export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dirty = false,
  closeOnBackdrop = false,
  onDirtyAttempt,
  initialFocusRef,
  hideClose = false,
  className = '',
}) {
  const dialogRef = useRef(null);
  const downOnBackdrop = useRef(false);
  const token = useRef({});
  const titleId = useId();
  const descId = useId();
  // Latest values for the document listeners without re-subscribing.
  const live = useRef({});
  live.current = { onClose, dirty, onDirtyAttempt };

  // Stay mounted for the exit animation after open turns false. Focus,
  // scroll lock and key handling are released immediately on close.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const closing = shown && !open;
  useEffect(() => {
    if (!closing) return undefined;
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-exit')) || 160;
    const t = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(t);
  }, [closing]);

  const requestClose = () => {
    const { dirty: d, onDirtyAttempt: attempt, onClose: close } = live.current;
    if (d) attempt?.();
    else close?.();
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    const me = token.current;
    stack.push(me);
    const opener = document.activeElement;
    if (scrollLocks++ === 0) {
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    const el = dialogRef.current;
    const target = initialFocusRef?.current || el?.querySelector(FOCUSABLE) || el;
    target?.focus({ preventScroll: true });

    return () => {
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (--scrollLocks === 0) document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const me = token.current;
    const onKey = (e) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = dialogRef.current;
      if (!el) return;
      const items = Array.from(el.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) { e.preventDefault(); el.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (!el.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
      }
    };
    // Window capture phase: runs before any document/React keydown handler
    // (GlobalSearch, flyouts, legacy dialogs), and only the top modal acts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;

  // Only a press that both starts and ends on the backdrop counts, so a
  // text selection dragged out of the dialog never closes it.
  const onMouseDown = (e) => { downOnBackdrop.current = e.target === e.currentTarget; };
  const onBackdropClick = (e) => {
    if (!downOnBackdrop.current || e.target !== e.currentTarget) return;
    if (dirty) onDirtyAttempt?.();
    else if (closeOnBackdrop) onClose?.();
  };

  return createPortal(
    <div
      className={`ui-modal-backdrop${closing ? ' is-closing' : ''}`}
      onMouseDown={closing ? undefined : onMouseDown}
      onClick={closing ? undefined : onBackdropClick}
      inert={closing || undefined}
    >
      <div
        ref={dialogRef}
        className={`ui-modal ui-modal--${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        {(title || !hideClose) && (
          <div className="ui-modal__head">
            <div className="ui-modal__titles">
              {title && <h2 id={titleId} className="ui-modal__title">{title}</h2>}
              {description && <p id={descId} className="ui-modal__desc">{description}</p>}
            </div>
            {!hideClose && (
              <button type="button" className="ui-modal__close" onClick={() => onClose?.()} aria-label="Close dialog">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="ui-modal__body">{children}</div>
        {footer && <div className="ui-modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
