import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { listTasks, deleteTask } from '../../lib/tasksApi';
import CreateTaskModal from '../../components/tasks/CreateTaskModal';
import GroupTaskModal from '../../components/tasks/GroupTaskModal';
import TaskRow from '../../components/tasks/TaskRow';
import TaskKanban from '../../components/tasks/TaskKanban';
import TaskDetailModal from '../../components/tasks/TaskDetailModal';
import {
  PlusIcon, SearchIcon, AlertIcon, RefreshIcon, UsersIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/tasks.css';

// Base tabs visible to everyone; the "Assigned by me" tab is added
// dynamically below for roles that can hand work off (TL/PCTL/OL/Boss/
// Developer always, IPC when canManageTasks=true).
const BASE_TABS = [
  { id: 'all',      label: 'All' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'personal', label: 'Personal' },
  // Tasks attached to a brand that is currently inactive. They are
  // frozen — no status changes, no deletes, no auto-reset until the
  // brand is reactivated. See migration 171.
  { id: 'inactive', label: 'Inactive' },
];

const STATUS_FILTERS = ['all', 'todo', 'in_progress', 'done'];

export default function TasksPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isTL = role === 'tl';
  // APC/IPC need explicit canManageTasks; others can always create. Everyone
  // can still create personal tasks (no brand + self-assigned) — the create
  // modal handles that path.
  const canCreateBrandTask =
    ['boss', 'ol', 'developer', 'tl', 'pctl'].includes(role)
    || (['apc', 'ipc'].includes(role) && profile?.permissions?.canManageTasks === true);

  // "Assigned by me" tab — visible to anyone who can fan tasks out. Same
  // gate as canCreateBrandTask, since that's the criterion for being able
  // to assign tasks to someone other than yourself.
  const canSeeAssignedByMe = canCreateBrandTask;
  const TABS = useMemo(() => (
    canSeeAssignedByMe
      ? [...BASE_TABS, { id: 'by_me', label: 'Assigned by me' }]
      : BASE_TABS
  ), [canSeeAssignedByMe]);

  const [tab, setTab]               = useState('all');
  const [statusFilter, setStatus]   = useState('all');
  const [search, setSearch]         = useState('');
  const [brandFilter, setBrandFilter]       = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [dueFilter, setDueFilter]           = useState('all'); // all | overdue | today | week | none
  const [localError, setLocalError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showGroup, setShowGroup]   = useState(false);
  const [editTask, setEditTask]     = useState(null);
  const [viewTask, setViewTask]     = useState(null);
  const [view, setView]             = useState('list'); // 'list' | 'kanban'
  const [selected, setSelected]     = useState(new Set());
  const [bulkBusy, setBulkBusy]     = useState(false);

  const qc = useQueryClient();
  const queryKey = useMemo(() => ['tasks', { tab }], [tab]);

  const {
    data: rows = [],
    isLoading,
    isFetching,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () => listTasks({
      assigneeMe:   tab === 'assigned',
      personalOnly: tab === 'personal',
      createdByMe:  tab === 'by_me',
    }),
  });

  const loading = isLoading; // only the first-ever load shows the spinner
  const error = localError || queryError?.message || '';

  // Apply a local patch to the current cache bucket (used by the status-pill
  // in TaskRow to avoid a full reload).
  const patchRow = useCallback((updated) => {
    qc.setQueryData(queryKey, (old = []) =>
      old.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
  }, [qc, queryKey]);

  // Live updates — subscribe to tasks table changes so status flips,
  // reassignments and new tasks reflect instantly without a reload.
  useEffect(() => {
    const channel = supabase
      .channel('tasks-live')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'tasks' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            qc.setQueriesData({ queryKey: ['tasks'] }, (old = []) =>
              old.filter((r) => r.id !== payload.old.id));
            return;
          }
          if (payload.eventType === 'UPDATE') {
            qc.setQueriesData({ queryKey: ['tasks'] }, (old = []) =>
              old.map((r) => (r.id === payload.new.id ? { ...r, ...payload.new } : r)));
            return;
          }
          if (payload.eventType === 'INSERT') {
            // Realtime rows lack joins; invalidate so the fresh list is fetched.
            qc.invalidateQueries({ queryKey: ['tasks'] });
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  const toggleSelected = useCallback((id) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Filter out tasks attached to inactive brands — they're frozen
  // server-side (mig 171) and including them in a bulk action would
  // make the whole batch fail. Better to silently skip + tell the user
  // how many were skipped so they can reactivate the brand if needed.
  function partitionFrozen(ids) {
    const frozen = [];
    const active = [];
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const r = rowsById.get(id);
      if (r?.brand?.status === 'inactive') frozen.push(id);
      else active.push(id);
    }
    return { active, frozen };
  }

  async function bulkSetStatus(newStatus) {
    if (selected.size === 0) return;
    setBulkBusy(true); setLocalError('');
    try {
      const { active, frozen } = partitionFrozen(Array.from(selected));
      if (active.length === 0) {
        setLocalError('All selected tasks belong to inactive brands and are frozen.');
        return;
      }
      const { error } = await supabase.from('tasks').update({ status: newStatus }).in('id', active);
      if (error) throw error;
      const activeSet = new Set(active);
      qc.setQueriesData({ queryKey: ['tasks'] }, (old = []) =>
        old.map((r) => (activeSet.has(r.id) ? { ...r, status: newStatus } : r)));
      clearSelection();
      if (frozen.length > 0) {
        setLocalError(`${frozen.length} frozen task(s) skipped (brand inactive).`);
      }
    } catch (e) { setLocalError(e.message); }
    finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    const { active, frozen } = partitionFrozen(Array.from(selected));
    if (active.length === 0) {
      setLocalError('All selected tasks belong to inactive brands and are frozen.');
      return;
    }
    if (!confirm(`Delete ${active.length} task(s)? This cannot be undone.${frozen.length ? ` (${frozen.length} frozen task(s) will be skipped.)` : ''}`)) return;
    setBulkBusy(true); setLocalError('');
    try {
      const { error } = await supabase.from('tasks').delete().in('id', active);
      if (error) throw error;
      const activeSet = new Set(active);
      qc.setQueriesData({ queryKey: ['tasks'] }, (old = []) =>
        old.filter((r) => !activeSet.has(r.id)));
      clearSelection();
      if (frozen.length > 0) {
        setLocalError(`${frozen.length} frozen task(s) skipped (brand inactive).`);
      }
    } catch (e) { setLocalError(e.message); }
    finally { setBulkBusy(false); }
  }

  // Apply the brand-active gate first. Tasks attached to a brand whose
  // status='inactive' (mig 171) live in the dedicated 'inactive' tab
  // only; every other tab filters them out so the active task buckets
  // stay clean. Personal tasks (no brand) are unaffected.
  const tabFiltered = useMemo(() => {
    if (tab === 'inactive') {
      return rows.filter((r) => r.brand?.status === 'inactive');
    }
    return rows.filter((r) => r.brand?.status !== 'inactive');
  }, [rows, tab]);

  // Apply search next so status counts are search-aware
  const searchFiltered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return tabFiltered;
    return tabFiltered.filter((r) =>
      (r.title || '').toLowerCase().includes(s) ||
      (r.description || '').toLowerCase().includes(s) ||
      (r.brand?.brand_name || '').toLowerCase().includes(s) ||
      (r.assignee?.display_name || '').toLowerCase().includes(s) ||
      (r.priority || '').toLowerCase().includes(s) ||
      (r.category || '').toLowerCase().includes(s),
    );
  }, [tabFiltered, search]);

  // Derive dropdown options from the current row set (post-search) so
  // users only see options that have at least one task behind them.
  // Sorted by label for predictability.
  const brandOptions = useMemo(() => {
    const m = new Map();
    for (const r of searchFiltered) {
      if (r.brand?.id) m.set(r.brand.id, r.brand.brand_name || '(unnamed)');
    }
    return [...m.entries()]
      .map(([id, name]) => ({ value: id, label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [searchFiltered]);

  const assigneeOptions = useMemo(() => {
    const m = new Map();
    for (const r of searchFiltered) {
      if (r.assignee?.id) m.set(r.assignee.id, r.assignee.display_name || r.assignee.email || '(unknown)');
    }
    return [...m.entries()]
      .map(([id, name]) => ({ value: id, label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [searchFiltered]);

  const priorityOptions = useMemo(() => {
    const set = new Set();
    for (const r of searchFiltered) if (r.priority) set.add(r.priority);
    // Stable ordering high→low when present.
    const order = ['urgent', 'high', 'medium', 'low'];
    return order
      .filter((p) => set.has(p))
      .map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
  }, [searchFiltered]);

  const categoryOptions = useMemo(() => {
    const set = new Set();
    for (const r of searchFiltered) if (r.category) set.add(r.category);
    return [...set]
      .sort()
      .map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }));
  }, [searchFiltered]);

  // Compute due-date buckets in PKT-anchored "today" so APC in Pakistan
  // sees the same "overdue/today/this week" as their TL.
  const matchesDue = useCallback((r) => {
    if (dueFilter === 'all') return true;
    if (!r.due_date) return dueFilter === 'none';
    if (dueFilter === 'none') return false;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const endToday = new Date(start); endToday.setDate(endToday.getDate() + 1);
    const endWeek  = new Date(start); endWeek.setDate(endWeek.getDate() + 7);
    const d = new Date(r.due_date);
    if (dueFilter === 'overdue') return d < start;
    if (dueFilter === 'today')   return d >= start && d < endToday;
    if (dueFilter === 'week')    return d >= start && d < endWeek;
    return true;
  }, [dueFilter]);

  // Apply the new filters before status so the status counts at the
  // bottom reflect what the user is currently narrowing down.
  const fieldFiltered = useMemo(() => {
    return searchFiltered.filter((r) => {
      if (brandFilter    !== 'all' && r.brand?.id    !== brandFilter)    return false;
      if (assigneeFilter !== 'all' && r.assignee?.id !== assigneeFilter) return false;
      if (priorityFilter !== 'all' && r.priority     !== priorityFilter) return false;
      if (categoryFilter !== 'all' && r.category     !== categoryFilter) return false;
      if (!matchesDue(r)) return false;
      return true;
    });
  }, [searchFiltered, brandFilter, assigneeFilter, priorityFilter, categoryFilter, matchesDue]);

  const statusCounts = useMemo(() => {
    const c = { all: fieldFiltered.length, todo: 0, in_progress: 0, done: 0 };
    for (const r of fieldFiltered) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [fieldFiltered]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return fieldFiltered;
    return fieldFiltered.filter((r) => r.status === statusFilter);
  }, [fieldFiltered, statusFilter]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (brandFilter    !== 'all') n++;
    if (assigneeFilter !== 'all') n++;
    if (priorityFilter !== 'all') n++;
    if (categoryFilter !== 'all') n++;
    if (dueFilter      !== 'all') n++;
    return n;
  }, [brandFilter, assigneeFilter, priorityFilter, categoryFilter, dueFilter]);

  const clearAllFilters = useCallback(() => {
    setBrandFilter('all'); setAssigneeFilter('all');
    setPriorityFilter('all'); setCategoryFilter('all'); setDueFilter('all');
  }, []);

  // Who can edit a task? Admin, creator, or brand owner TL.
  // (Assignee can still change STATUS via the row pill — that's a separate capability.)
  const canEditRow = useCallback((r) => {
    const uid = user?.id;
    if (!uid) return false;
    if (['boss', 'ol', 'developer'].includes(role)) return true;
    if (r.created_by === uid) return true;
    if (r.brand && r.brand.owner_id === uid) return true; // TL who owns this brand
    return false;
  }, [role, user?.id]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-subtitle">
            {loading ? '' : `${filtered.length} of ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isTL && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setShowGroup(true)}>
              <UsersIcon width="16" height="16" /> Group task
            </button>
          )}
          <button className="wx-btn wx-btn-primary" onClick={() => setShowCreate(true)}>
            <PlusIcon width="16" height="16" /> Add task
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="task-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`task-tab ${tab === t.id ? 'task-tab-active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 14px', marginBottom: 12,
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-md)',
        }}>
          <span style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13 }}>
            {selected.size} selected
          </span>
          <button className="wx-btn wx-btn-ghost" disabled={bulkBusy} onClick={() => bulkSetStatus('todo')} style={{ padding: '5px 10px', fontSize: 12 }}>
            Mark to-do
          </button>
          <button className="wx-btn wx-btn-ghost" disabled={bulkBusy} onClick={() => bulkSetStatus('in_progress')} style={{ padding: '5px 10px', fontSize: 12 }}>
            Mark in progress
          </button>
          <button className="wx-btn wx-btn-ghost" disabled={bulkBusy} onClick={() => bulkSetStatus('done')} style={{ padding: '5px 10px', fontSize: 12 }}>
            Mark done
          </button>
          <button className="wx-btn wx-btn-ghost" disabled={bulkBusy} onClick={bulkDelete} style={{ padding: '5px 10px', fontSize: 12, color: 'var(--danger)' }}>
            Delete
          </button>
          <button className="wx-btn wx-btn-ghost" disabled={bulkBusy} onClick={clearSelection} style={{ padding: '5px 10px', fontSize: 12, marginLeft: 'auto' }}>
            Clear
          </button>
        </div>
      )}

      <div className="wx-toolbar">
        <div className="wx-search">
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search by title, brand, assignee, priority or category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="task-tabs">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`task-tab ${statusFilter === s ? 'task-tab-active' : ''}`}
              style={{ textTransform: 'capitalize' }}
            >
              {s.replace('_', ' ')}
              <span className="task-tab-count">{statusCounts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="task-tabs">
          <button type="button" onClick={() => setView('list')}
            className={`task-tab ${view === 'list' ? 'task-tab-active' : ''}`}>List</button>
          <button type="button" onClick={() => setView('kanban')}
            className={`task-tab ${view === 'kanban' ? 'task-tab-active' : ''}`}>Kanban</button>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={() => refetch()} disabled={isFetching} title="Refresh">
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      <div className="task-filter-row">
        {assigneeOptions.length > 1 && (
          <FilterSelect label="Assignee" value={assigneeFilter} onChange={setAssigneeFilter} options={assigneeOptions} />
        )}
        {brandOptions.length > 1 && (
          <FilterSelect label="Brand" value={brandFilter} onChange={setBrandFilter} options={brandOptions} />
        )}
        {priorityOptions.length > 1 && (
          <FilterSelect label="Priority" value={priorityFilter} onChange={setPriorityFilter} options={priorityOptions} />
        )}
        {categoryOptions.length > 1 && (
          <FilterSelect label="Category" value={categoryFilter} onChange={setCategoryFilter} options={categoryOptions} />
        )}
        <FilterSelect label="Due" value={dueFilter} onChange={setDueFilter} options={[
          { value: 'overdue', label: 'Overdue' },
          { value: 'today',   label: 'Due today' },
          { value: 'week',    label: 'Due this week' },
          { value: 'none',    label: 'No due date' },
        ]} />
        {activeFilterCount > 0 && (
          <button type="button" className="task-filter-clear" onClick={clearAllFilters}>
            Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}

      {view === 'kanban' ? (
        loading ? (
          <div className="wx-empty">
            <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading tasks…
          </div>
        ) : (
          <TaskKanban
            rows={filtered}
            canEditRow={canEditRow}
            currentUserId={user?.id}
            onEdit={setEditTask}
            onView={setViewTask}
            onLocalPatch={patchRow}
          />
        )
      ) : (
        <div className="wx-list">
          {loading ? (
            <div className="wx-empty">
              <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading tasks…
            </div>
          ) : filtered.length === 0 ? (
            <div className="wx-empty">
              <div className="wx-empty-title">No tasks here</div>
              <div>
                {tab === 'personal' && 'Create a personal task to track your own to-dos.'}
                {tab === 'assigned' && 'Nothing is assigned to you right now.'}
                {tab === 'all' && 'No tasks match the current filters.'}
              </div>
            </div>
          ) : (
            filtered.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                canEdit={canEditRow(t)}
                currentUserId={user?.id}
                onEdit={() => setEditTask(t)}
                onView={(task) => setViewTask(task)}
                onChanged={patchRow}
                selected={selected.has(t.id)}
                onToggleSelect={canEditRow(t) ? () => toggleSelected(t.id) : null}
              />
            ))
          )}
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          task={null}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['tasks'] }); }}
        />
      )}
      {editTask && (
        <CreateTaskModal
          task={editTask}
          onClose={() => setEditTask(null)}
          onSaved={() => { setEditTask(null); qc.invalidateQueries({ queryKey: ['tasks'] }); }}
        />
      )}
      {showGroup && (
        <GroupTaskModal
          onClose={() => setShowGroup(false)}
          onCreated={() => { setShowGroup(false); qc.invalidateQueries({ queryKey: ['tasks'] }); }}
        />
      )}
      {viewTask && (
        <TaskDetailModal
          task={viewTask}
          canEdit={canEditRow(viewTask)}
          onClose={() => setViewTask(null)}
          onEdit={() => { setEditTask(viewTask); setViewTask(null); }}
        />
      )}
    </>
  );
}

// Compact labelled select used in the task filter row.
function FilterSelect({ label, value, onChange, options }) {
  const isActive = value !== 'all';
  return (
    <label className={`task-filter ${isActive ? 'is-active' : ''}`}>
      <span className="task-filter-label">{label}</span>
      <select
        className="task-filter-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}>
        <option value="all">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
