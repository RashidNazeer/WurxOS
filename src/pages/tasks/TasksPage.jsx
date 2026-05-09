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

  async function bulkSetStatus(newStatus) {
    if (selected.size === 0) return;
    setBulkBusy(true); setLocalError('');
    try {
      const ids = Array.from(selected);
      const { error } = await supabase.from('tasks').update({ status: newStatus }).in('id', ids);
      if (error) throw error;
      qc.setQueriesData({ queryKey: ['tasks'] }, (old = []) =>
        old.map((r) => (selected.has(r.id) ? { ...r, status: newStatus } : r)));
      clearSelection();
    } catch (e) { setLocalError(e.message); }
    finally { setBulkBusy(false); }
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} task(s)? This cannot be undone.`)) return;
    setBulkBusy(true); setLocalError('');
    try {
      const ids = Array.from(selected);
      const { error } = await supabase.from('tasks').delete().in('id', ids);
      if (error) throw error;
      qc.setQueriesData({ queryKey: ['tasks'] }, (old = []) =>
        old.filter((r) => !selected.has(r.id)));
      clearSelection();
    } catch (e) { setLocalError(e.message); }
    finally { setBulkBusy(false); }
  }

  // Apply search first so status counts are search-aware
  const searchFiltered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) =>
      (r.title || '').toLowerCase().includes(s) ||
      (r.description || '').toLowerCase().includes(s) ||
      (r.brand?.brand_name || '').toLowerCase().includes(s) ||
      (r.assignee?.display_name || '').toLowerCase().includes(s),
    );
  }, [rows, search]);

  const statusCounts = useMemo(() => {
    const c = { all: searchFiltered.length, todo: 0, in_progress: 0, done: 0 };
    for (const r of searchFiltered) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [searchFiltered]);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return searchFiltered;
    return searchFiltered.filter((r) => r.status === statusFilter);
  }, [searchFiltered, statusFilter]);

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
            placeholder="Search tasks…"
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
