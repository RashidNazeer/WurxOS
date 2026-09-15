// The steps inside a task — the deepest level of the roadmap tree.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDev, WORKSPACE_KEY } from '../../pages/development/DevelopmentContext';
import { addChecklistItem, deleteChecklistItem, listChecklist, updateChecklistItem } from '../../lib/developmentApi';
import { ProgressBar, Spinner } from './ui';

export function useChecklist(taskId, enabled = true) {
  return useQuery({
    queryKey: ['development', 'checklist', taskId],
    queryFn: () => listChecklist(taskId),
    enabled: !!taskId && enabled,
    staleTime: 15_000,
  });
}

export function useChecklistActions(taskId) {
  const qc = useQueryClient();
  const { notify } = useDev();
  const key = ['development', 'checklist', taskId];
  const sync = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: WORKSPACE_KEY });
  };
  return {
    async toggle(item) {
      qc.setQueryData(key, (list) => (list || []).map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)));
      try {
        await updateChecklistItem(item.id, { done: !item.done });
      } catch (error) {
        notify(error.message, 'error');
      }
      sync();
    },
    async add(body, items) {
      const sortOrder = (items.at(-1)?.sort_order ?? 0) + 1;
      await addChecklistItem(taskId, body, sortOrder);
      sync();
    },
    async rename(item, body) {
      try {
        await updateChecklistItem(item.id, { body });
      } catch (error) {
        notify(error.message, 'error');
      }
      sync();
    },
    async remove(item) {
      try {
        await deleteChecklistItem(item.id);
      } catch (error) {
        notify(error.message, 'error');
      }
      sync();
    },
  };
}

export default function TaskChecklist({ task, editable }) {
  const { notify } = useDev();
  const checklist = useChecklist(task.id);
  const actions = useChecklistActions(task.id);
  const items = checklist.data || [];
  const done = items.filter((i) => i.done).length;
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  async function add(event) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try {
      await actions.add(body, items);
    } catch (error) {
      setDraft(body);
      notify(error.message, 'error');
    }
  }

  function finishEdit(item) {
    const body = editText.trim();
    setEditingId(null);
    if (body && body !== item.body) actions.rename(item, body);
  }

  return (
    <section className="dv-section" aria-label="Checklist">
      <div className="dv-section-head">
        <h3>Checklist</h3>
        {items.length > 0 && <span className="dv-count">{done}/{items.length}</span>}
      </div>
      {checklist.isLoading ? (
        <div className="dv-loading is-inline"><Spinner /></div>
      ) : (
        <>
          {items.length > 0 && <ProgressBar pct={(done / items.length) * 100} label="Checklist progress" />}
          {items.length > 0 && (
            <ul className="dv-checklist">
              {items.map((item) => (
                <li key={item.id} className={item.done ? 'is-done' : ''}>
                  <label className="dv-check">
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={!editable}
                      onChange={() => actions.toggle(item)}
                      aria-label={item.done ? `Reopen: ${item.body}` : `Tick: ${item.body}`}
                    />
                    <span aria-hidden="true"><i className="bi bi-check" /></span>
                  </label>
                  {editingId === item.id ? (
                    <input
                      className="dv-input dv-check-edit"
                      value={editText}
                      maxLength={200}
                      autoFocus
                      aria-label="Edit step"
                      onChange={(event) => setEditText(event.target.value)}
                      onBlur={() => finishEdit(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); finishEdit(item); }
                        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditingId(null); }
                      }}
                    />
                  ) : (
                    <span className="dv-check-text">{item.body}</span>
                  )}
                  {editable && editingId !== item.id && (
                    <span className="dv-check-actions">
                      <button
                        type="button"
                        className="dv-icon-btn is-sm"
                        aria-label={`Edit step: ${item.body}`}
                        onClick={() => { setEditingId(item.id); setEditText(item.body); }}
                      >
                        <i className="bi bi-pencil" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="dv-icon-btn is-sm"
                        aria-label={`Remove step: ${item.body}`}
                        onClick={() => actions.remove(item)}
                      >
                        <i className="bi bi-trash3" aria-hidden="true" />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable ? (
            <form className="dv-inline-add" onSubmit={add}>
              <i className="bi bi-plus-lg" aria-hidden="true" />
              <input
                value={draft}
                maxLength={200}
                placeholder="Add a step and press Enter"
                aria-label="New checklist step"
                onChange={(event) => setDraft(event.target.value)}
              />
            </form>
          ) : (
            !items.length && <p className="dv-muted">No steps yet.</p>
          )}
        </>
      )}
    </section>
  );
}
