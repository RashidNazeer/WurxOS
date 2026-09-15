// Asked whenever a task moves to Blocked: the reason is required.
import { useState } from 'react';
import { Field, Modal } from './Overlay';
import { taskCode } from './devModel';

export default function BlockedReasonModal({ task, onDone }) {
  const [reason, setReason] = useState(task.blocked_reason || '');
  return (
    <Modal
      title={`What’s blocking ${taskCode(task)}?`}
      onClose={() => onDone(null)}
      width={480}
      onSubmit={() => { if (reason.trim()) onDone(reason.trim()); }}
      footer={(
        <>
          <button type="button" className="dv-btn is-ghost" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="dv-btn is-danger" disabled={!reason.trim()}>
            <i className="bi bi-exclamation-triangle" aria-hidden="true" /> Mark as blocked
          </button>
        </>
      )}
    >
      <p className="dv-modal-lede is-small">{task.title}</p>
      <Field label="Reason" htmlFor="dv-blocked-reason" hint="The Boss and the task owner are told, and it shows on the roadmap card.">
        <textarea
          id="dv-blocked-reason"
          className="dv-input"
          data-autofocus=""
          rows={4}
          maxLength={1000}
          placeholder="Waiting for…"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
