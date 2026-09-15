// The frame every Development page renders inside.
//
// It owns the one workspace query (projects, releases, tasks, people, card
// counts), keeps it live through Supabase realtime, and hosts everything that
// can open on top of any page: the task panel (?task=127), the forms, the
// blocked-reason prompt, confirmations, task search and toasts.
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { loadWorkspace, subscribeWorkspace, updateTask } from '../../lib/developmentApi';
import { DevContext, WORKSPACE_KEY } from './DevelopmentContext';
import { canEditTask, isBoss as isBossProfile } from '../../components/development/devModel';
import { ConfirmModal } from '../../components/development/Overlay';
import { EmptyState, Spinner } from '../../components/development/ui';
import TaskPanel from '../../components/development/TaskPanel';
import TaskFormModal from '../../components/development/TaskFormModal';
import ProjectFormModal from '../../components/development/ProjectFormModal';
import ReleaseFormModal from '../../components/development/ReleaseFormModal';
import BlockedReasonModal from '../../components/development/BlockedReasonModal';
import TaskSearchModal from '../../components/development/TaskSearchModal';
import '../../styles/development.css';

const EMPTY = { projects: [], releases: [], tasks: [], people: [], statsByTask: {} };

export default function DevelopmentLayout() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const workspace = useQuery({
    queryKey: WORKSPACE_KEY,
    queryFn: loadWorkspace,
    staleTime: 30_000,
    refetchOnMount: 'always',
  });

  const [toasts, setToasts] = useState([]);
  const [taskForm, setTaskForm] = useState(null);
  const [projectForm, setProjectForm] = useState(null);
  const [releaseForm, setReleaseForm] = useState(null);
  const [blockedAsk, setBlockedAsk] = useState(null);
  const [confirmAsk, setConfirmAsk] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);

  // Live updates: any change anywhere in Development refreshes what is on
  // screen. Bursts (a task and its history row) collapse into one refresh.
  useEffect(() => {
    let timer = null;
    const stop = subscribeWorkspace(() => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries({ queryKey: ['development'] }), 250);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [qc]);

  // "/" opens task search (Ctrl/⌘ K already belongs to the app-wide search).
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[data-dv-layer]')) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const notify = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 6500 : 3200);
  }, []);

  const data = workspace.data || EMPTY;

  const maps = useMemo(() => ({
    projectById: new Map(data.projects.map((p) => [p.id, p])),
    projectByKey: new Map(data.projects.map((p) => [p.key, p])),
    releaseById: new Map(data.releases.map((r) => [r.id, r])),
    personById: new Map(data.people.map((p) => [p.id, p])),
    taskByNumber: new Map(data.tasks.map((t) => [Number(t.number), t])),
    taskById: new Map(data.tasks.map((t) => [t.id, t])),
  }), [data]);

  const activeProjects = useMemo(
    () => data.projects
      .filter((p) => !p.archived_at)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at))),
    [data],
  );

  const isBoss = isBossProfile(profile);
  const canEdit = useCallback((task) => canEditTask(profile, task), [profile]);

  // Inline changes feel instant: the list updates first, then the server's
  // answer replaces it, or the change is undone with the reason shown.
  const patchTask = useCallback(async (task, patch) => {
    const previous = qc.getQueryData(WORKSPACE_KEY);
    qc.setQueryData(WORKSPACE_KEY, (old) => old && {
      ...old,
      tasks: old.tasks.map((t) => (t.id === task.id ? { ...t, ...patch } : t)),
    });
    try {
      const row = await updateTask(task.id, patch);
      qc.setQueryData(WORKSPACE_KEY, (old) => old && {
        ...old,
        tasks: old.tasks.map((t) => (t.id === row.id ? { ...t, ...row } : t)),
      });
      qc.setQueryData(['development', 'task', task.id], (old) => (old ? { ...old, ...row } : row));
      return true;
    } catch (error) {
      if (previous) qc.setQueryData(WORKSPACE_KEY, previous);
      notify(error.message, 'error');
      return false;
    }
  }, [qc, notify]);

  const askBlockedReason = useCallback(
    (task) => new Promise((resolve) => setBlockedAsk({ task, resolve })),
    [],
  );

  const confirm = useCallback(
    (options) => new Promise((resolve) => setConfirmAsk({ ...options, resolve })),
    [],
  );

  const moveTask = useCallback(async (task, status) => {
    if (!task || task.status === status) return false;
    if (status === 'blocked') {
      const reason = await askBlockedReason(task);
      if (!reason) return false;
      return patchTask(task, { status, blocked_reason: reason });
    }
    return patchTask(task, { status });
  }, [askBlockedReason, patchTask]);

  const openTask = useCallback((number, { comment } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('task', String(number));
      if (comment) next.set('comment', comment); else next.delete('comment');
      return next;
    });
  }, [setParams]);

  const closeTask = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('task');
      next.delete('comment');
      return next;
    }, { replace: true });
  }, [setParams]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['development'] }), [qc]);

  const value = useMemo(() => ({
    profile,
    isBoss,
    data,
    maps,
    activeProjects,
    canEdit,
    patchTask,
    moveTask,
    openTask,
    closeTask,
    refresh,
    notify,
    confirm,
    askBlockedReason,
    openNewTask: (defaults = {}) => setTaskForm(defaults),
    openProjectForm: (project = null) => setProjectForm({ project }),
    openReleaseForm: ({ projectId = null, release = null } = {}) => setReleaseForm({ projectId, release }),
    openSearch: () => setSearchOpen(true),
  }), [profile, isBoss, data, maps, activeProjects, canEdit, patchTask, moveTask, openTask, closeTask, refresh, notify, confirm, askBlockedReason]);

  const taskParam = params.get('task');

  let content;
  if (workspace.isLoading) {
    content = <div className="dv-loading"><Spinner /> Loading Development…</div>;
  } else if (workspace.isError) {
    content = (
      <EmptyState
        icon="bi-wifi-off"
        title="Development didn’t load"
        action={<button type="button" className="dv-btn" onClick={() => workspace.refetch()}>Try again</button>}
      >
        {workspace.error?.message}
      </EmptyState>
    );
  } else {
    content = (
      <Suspense fallback={<div className="dv-loading"><Spinner /></div>}>
        <Outlet />
      </Suspense>
    );
  }

  return (
    <DevContext.Provider value={value}>
      <div className="dv-root">{content}</div>

      {workspace.data && taskParam && (
        <TaskPanel
          key={taskParam}
          number={Number(taskParam)}
          commentId={params.get('comment')}
          onClose={closeTask}
        />
      )}
      {taskForm && <TaskFormModal defaults={taskForm} onClose={() => setTaskForm(null)} />}
      {projectForm && <ProjectFormModal project={projectForm.project} onClose={() => setProjectForm(null)} />}
      {releaseForm && (
        <ReleaseFormModal
          projectId={releaseForm.projectId}
          release={releaseForm.release}
          onClose={() => setReleaseForm(null)}
        />
      )}
      {blockedAsk && (
        <BlockedReasonModal
          task={blockedAsk.task}
          onDone={(reason) => { blockedAsk.resolve(reason); setBlockedAsk(null); }}
        />
      )}
      {confirmAsk && (
        <ConfirmModal
          title={confirmAsk.title}
          body={confirmAsk.body}
          confirmLabel={confirmAsk.confirmLabel}
          danger={confirmAsk.danger}
          onConfirm={() => { confirmAsk.resolve(true); setConfirmAsk(null); }}
          onClose={() => { confirmAsk.resolve(false); setConfirmAsk(null); }}
        />
      )}
      {searchOpen && workspace.data && <TaskSearchModal onClose={() => setSearchOpen(false)} />}

      <div className="dv-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`dv-toast is-${toast.tone}`}>
            <i className={`bi ${toast.tone === 'error' ? 'bi-exclamation-circle' : 'bi-check2-circle'}`} aria-hidden="true" />
            {toast.message}
          </div>
        ))}
      </div>
    </DevContext.Provider>
  );
}
