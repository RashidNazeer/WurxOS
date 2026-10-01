import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const ToastContext = createContext(null);
const MAX = 4;
let seq = 0;

/**
 * Mount <ToastProvider> once near the app root, then:
 *   const toast = useToast();
 *   toast.success('Saved');  toast.error('Could not save', { title: 'Network' });
 *   const id = toast.show('Uploading…', { tone: 'info', duration: 0 }); toast.dismiss(id);
 * Options: { tone: 'success'|'danger'|'warning'|'info'|'neutral', title,
 *            duration (ms, 0 = sticky; default 4000, errors 7000),
 *            action: { label, onClick } }
 * Errors are announced assertively (role=alert); the rest politely.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const show = useCallback((message, opts = {}) => {
    const id = ++seq;
    const tone = opts.tone || 'neutral';
    const duration = opts.duration ?? (tone === 'danger' ? 7000 : 4000);
    setToasts((all) => [...all.slice(-(MAX - 1)), { id, message, tone, duration, title: opts.title, action: opts.action }]);
    return id;
  }, []);

  const api = useMemo(() => ({
    show,
    dismiss,
    success: (m, o) => show(m, { ...o, tone: 'success' }),
    error:   (m, o) => show(m, { ...o, tone: 'danger' }),
    warning: (m, o) => show(m, { ...o, tone: 'warning' }),
    info:    (m, o) => show(m, { ...o, tone: 'info' }),
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="ui-toast-region" aria-live="polite" aria-relevant="additions">
          {toasts.map((t) => <ToastItem key={t.id} toast={t} dismiss={dismiss} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, dismiss }) {
  const timer = useRef(null);
  const exitTimer = useRef(null);
  const [leaving, setLeaving] = useState(false);
  // Play the slide-down exit, then drop it from the queue.
  const onDismiss = useCallback(() => {
    clearTimeout(timer.current);
    setLeaving(true);
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-exit')) || 160;
    clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => dismiss(toast.id), ms);
  }, [dismiss, toast.id]);
  const start = useCallback(() => {
    if (!toast.duration) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(onDismiss, toast.duration);
  }, [toast.duration, onDismiss]);
  const pause = () => clearTimeout(timer.current);

  useEffect(() => { start(); return pause; }, [start]);
  useEffect(() => () => clearTimeout(exitTimer.current), []);

  return (
    <div
      className={`ui-toast ui-toast--${toast.tone}${leaving ? ' is-leaving' : ''}`}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <span className="ui-toast__rail" aria-hidden="true" />
      <div className="ui-toast__body">
        {toast.title && <div className="ui-toast__title">{toast.title}</div>}
        <div className="ui-toast__text">{toast.message}</div>
      </div>
      {toast.action && (
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => { toast.action.onClick?.(); onDismiss(); }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="ui-toast__close" onClick={onDismiss} aria-label="Dismiss notification">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

const noop = () => 0;
const FALLBACK = { show: noop, dismiss: noop, success: noop, error: noop, warning: noop, info: noop };

/** Outside a provider every call is a silent no-op, so callers never crash. */
export function useToast() {
  return useContext(ToastContext) || FALLBACK;
}
