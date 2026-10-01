import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal, Button, useConfirm, useToast } from '../ui';

// Drop-in replacements for window.confirm / window.prompt / alert in page code.
//   const { ask, askText, notify } = useDialogs();
//   if (!(await ask('Delete this report?', { danger: true }))) return;
//   const note = await askText('Reason for returning to APC (required):');  // null on cancel, like prompt()
//   notify.error('Failed: ' + err.message);
// <TextPromptProvider> is mounted once in App.jsx (inside ConfirmProvider).

const TextPromptContext = createContext(null);

export function TextPromptProvider({ children }) {
  const [req, setReq] = useState(null);
  const [value, setValue] = useState('');
  const resolver = useRef(null);
  const fieldRef = useRef(null);

  const askText = useCallback((label, initial = '', { title, multiline = true, confirmLabel = 'OK' } = {}) => new Promise((resolve) => {
    resolver.current?.(null);
    resolver.current = resolve;
    setValue(initial ?? '');
    setReq({ label, title, multiline, confirmLabel });
  }), []);

  const settle = (v) => {
    const r = resolver.current;
    resolver.current = null;
    setReq(null);
    r?.(v);
  };

  return (
    <TextPromptContext.Provider value={askText}>
      {children}
      <Modal
        open={!!req}
        onClose={() => settle(null)}
        title={req?.title || 'Add a note'}
        size="sm"
        initialFocusRef={fieldRef}
        footer={(
          <>
            <Button variant="secondary" onClick={() => settle(null)}>Cancel</Button>
            <Button onClick={() => settle(value)}>{req?.confirmLabel || 'OK'}</Button>
          </>
        )}
      >
        <label htmlFor="wx-text-prompt" className="d-block mb-2"
          style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-line' }}>
          {req?.label}
        </label>
        {req?.multiline ? (
          <textarea ref={fieldRef} id="wx-text-prompt" className="form-control" rows={4}
            value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') settle(value); }} />
        ) : (
          <input ref={fieldRef} id="wx-text-prompt" className="form-control"
            value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') settle(value); }} />
        )}
      </Modal>
    </TextPromptContext.Provider>
  );
}

export function useDialogs() {
  const confirm = useConfirm();
  const toast = useToast();
  const promptCtx = useContext(TextPromptContext);

  const ask = useCallback((message, { title, confirmLabel, danger = false } = {}) => confirm({
    title: title || (danger ? 'Are you sure?' : 'Please confirm'),
    message: <p className="ui-confirm__text" style={{ whiteSpace: 'pre-line' }}>{message}</p>,
    confirmLabel: confirmLabel || (danger ? 'Delete' : 'Confirm'),
    tone: danger ? 'danger' : 'primary',
  }), [confirm]);

  // eslint-disable-next-line no-alert
  const askText = promptCtx || ((label, initial = '') => Promise.resolve(window.prompt(label, initial)));

  return useMemo(() => ({ ask, askText, notify: toast }), [ask, askText, toast]);
}
