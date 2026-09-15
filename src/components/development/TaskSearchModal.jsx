// Find any task by title or WRX number ("/" from any Development page).
import { useMemo, useState } from 'react';
import { useDev } from '../../pages/development/DevelopmentContext';
import { Modal } from './Overlay';
import { StatusPill, TypeIcon } from './ui';
import { taskCode } from './devModel';

export default function TaskSearchModal({ onClose }) {
  const { data, maps, openTask } = useDev();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const text = query.trim().toLowerCase();
    const digits = text.replace(/^wrx-?/, '');
    const recent = [...data.tasks].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    if (!text) return recent.slice(0, 8);
    return recent
      .filter((t) => (/^\d+$/.test(digits) && String(t.number).startsWith(digits)) || t.title.toLowerCase().includes(text))
      .slice(0, 12);
  }, [data.tasks, query]);

  function pick(task) {
    onClose();
    openTask(task.number);
  }

  return (
    <Modal title="Find a task" onClose={onClose} width={600}>
      <div className="dv-search">
        <i className="bi bi-search" aria-hidden="true" />
        <input
          className="dv-input"
          data-autofocus=""
          value={query}
          placeholder="Search by title or WRX number"
          aria-label="Search tasks"
          aria-controls="dv-search-results"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            if (event.key === 'Enter' && results[active]) { event.preventDefault(); pick(results[active]); }
          }}
        />
      </div>
      <p className="dv-search-caption">{query.trim() ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'Recently updated'}</p>
      {results.length === 0 ? (
        <p className="dv-muted">No tasks match “{query}”.</p>
      ) : (
        <ul id="dv-search-results" className="dv-search-results" role="listbox" aria-label="Tasks">
          {results.map((task, index) => (
            <li key={task.id} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={index === active ? 'is-active' : ''}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(task)}
              >
                <TypeIcon type={task.type} />
                <span className="dv-mono dv-search-code">{taskCode(task)}</span>
                <span className="dv-search-title">{task.title}</span>
                <span className="dv-search-project">{maps.projectById.get(task.project_id)?.name}</span>
                <StatusPill status={task.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
