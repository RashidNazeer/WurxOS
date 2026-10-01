import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';
import Button from './Button';

/**
 * <ConfirmDialog open title message confirmLabel cancelLabel tone="primary|danger"
 *                busy onConfirm onCancel />
 * Danger confirms focus Cancel first so Enter can't destroy by accident.
 */
export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onCancel}
      title={title}
      size="sm"
      initialFocusRef={tone === 'danger' ? cancelRef : confirmRef}
      footer={(
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button ref={confirmRef} variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {typeof message === 'string' ? <p className="ui-confirm__text">{message}</p> : message}
    </Modal>
  );
}

const ConfirmContext = createContext(null);
let confirmSeq = 0;

/** Mount once near the app root; then `const confirm = useConfirm()`. */
export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const current = useRef(null);

  // One dialog at a time: a new confirm() cancels (resolves false) the
  // one still open, so no caller is left awaiting forever.
  const confirm = useCallback((opts) => new Promise((resolve) => {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    current.current?.resolve(false);
    const next = { ...o, resolve, id: ++confirmSeq };
    current.current = next;
    setReq(next);
  }), []);

  const settle = (value) => {
    const r = current.current;
    current.current = null;
    r?.resolve(value);
    setReq(null);
  };

  // Keep the last request's content while the dialog plays its exit.
  const last = useRef(null);
  if (req) last.current = req;
  const view = req || last.current;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        key={view?.id}
        open={!!req}
        title={view?.title}
        message={view?.message}
        confirmLabel={view?.confirmLabel}
        cancelLabel={view?.cancelLabel}
        tone={view?.tone}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * const confirm = useConfirm();
 * if (await confirm({ title: 'Delete brand?', message: '…', tone: 'danger', confirmLabel: 'Delete' })) …
 * Outside a provider it falls back to window.confirm so callers never break.
 */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (ctx) return ctx;
  return (opts) => {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    // eslint-disable-next-line no-alert
    return Promise.resolve(window.confirm([o.title, o.message].filter(Boolean).join('\n\n')));
  };
}
