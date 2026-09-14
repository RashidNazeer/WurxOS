import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  STATUS_META, PRIORITY_META, ROLLUP_META, DEV_PRIORITIES,
  loadDevelopmentWorkspace, listTaskActivity, createFeature,
  moveFeature, createWorkTask, updateWorkTask, transitionWorkTask,
  addActivity, postEod, markBugDuplicate, issueScreenshotUrl,
  allowedTaskActions, sortWorkTasks, waitingLabel,
} from '../../lib/devTasksApi';
import '../../styles/table.css';
import '../../styles/development.css';

const isoToday = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }))
  .toISOString().slice(0, 10);

function shortDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short',
  });
}

function age(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function initials(person) {
  return String(person?.display_name || '?').split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
}

function Avatar({ person, alert = false }) {
  return (
    <span className={`dev-avatar${alert ? ' is-alert' : ''}`} title={person?.display_name || 'Unassigned'}>
      {person?.avatar_url ? <img src={person.avatar_url} alt="" /> : initials(person)}
    </span>
  );
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.backlog;
  return <span className={`dev-pill is-${meta.tone}`}><i className={`bi ${meta.icon}`} />{meta.label}</span>;
}

function PriorityPill({ priority }) {
  const meta = PRIORITY_META[priority] || PRIORITY_META.normal;
  return <span className={`dev-priority is-${meta.tone}`}>{meta.label}</span>;
}

function Empty({ icon = 'bi-inbox', title, body }) {
  return (
    <div className="dev-empty">
      <i className={`bi ${icon}`} />
      <strong>{title}</strong>
      {body && <span>{body}</span>}
    </div>
  );
}

function WaitingStrip({ tasks, features, onOpen }) {
  const featureById = Object.fromEntries(features.map((feature) => [feature.id, feature]));
  const waiting = tasks.filter((task) => task.status === 'your_review'
      || task.status === 'blocked' && (!featureById[task.task_id]?.block_id || /usman/i.test(task.blocked_reason || '')))
    .sort((a, b) => new Date(a.status_changed_at) - new Date(b.status_changed_at));
  if (!waiting.length) return null;
  return (
    <section className="dev-waiting">
      <div className="dev-waiting-title"><i className="bi bi-hourglass-split" /> Waiting on you <b>{waiting.length}</b></div>
      <div className="dev-waiting-list">
        {waiting.map((task) => {
          const feature = featureById[task.task_id];
          const late = Date.now() - new Date(task.status_changed_at).getTime() >= 48 * 3600000;
          return (
            <button type="button" className="dev-waiting-row" key={task.id} onClick={() => onOpen(task)}>
              <span className="dev-waiting-copy">
                <strong>{task.title}</strong>
                <small>{feature?.project_name} › {feature?.title} · owner {task.owner?.display_name || 'unassigned'}{task.blocked_reason ? ` · “${task.blocked_reason}”` : ''}</small>
              </span>
              <StatusPill status={task.status} />
              <PriorityPill priority={task.priority} />
              <span className={`dev-age${late ? ' is-late' : ''}`}>{age(task.status_changed_at)}</span>
              <i className="bi bi-chevron-right" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function FeatureCard({ feature, tasks, now, draggable, overload, onOpen, onDragStart }) {
  const rollup = ROLLUP_META[feature.rollup_status] || ROLLUP_META.backlog;
  return (
    <button type="button" draggable={draggable} onDragStart={(event) => onDragStart?.(event, feature)}
      onClick={() => onOpen(feature)} className={`dev-feature is-${rollup.tone}${now ? ' in-now' : ''}`}>
      <span className="dev-feature-main">
        <strong>{feature.title}</strong>
        <span><PriorityPill priority={feature.priority} />{feature.scope_added > 0 && <em>+{feature.scope_added} since planning</em>}</span>
      </span>
      <Avatar person={feature.owner} alert={overload} />
      <span className="dev-feature-progress">{feature.subtask_done}/{feature.subtask_total}</span>
      {Number(feature.status_counts?.blocked || 0) > 0 && <span className="dev-feature-blocked">{feature.status_counts.blocked} blocked</span>}
    </button>
  );
}

function Roadmap({ products, blocks, features, tasksByFeature, canPlan, onOpen, onMove }) {
  const [over, setOver] = useState(null);
  const today = isoToday();
  const current = blocks.find((block) => block.starts_on <= today && block.ends_on >= today);
  const columns = [...blocks, { id: 'later', starts_on: null, ends_on: null }];
  const nowCounts = {};
  features.filter((feature) => feature.block_id === current?.id).forEach((feature) => {
    if (feature.owner_id) nowCounts[feature.owner_id] = (nowCounts[feature.owner_id] || 0) + 1;
  });

  function drop(event, block) {
    event.preventDefault();
    setOver(null);
    const featureId = event.dataTransfer.getData('text/dev-feature');
    const feature = features.find((item) => item.id === featureId);
    if (!feature) return;
    if (block?.id === current?.id && block.starts_on < today && feature.block_id !== current.id) {
      if (!window.confirm('This block is already running. Move anyway?')) return;
    }
    onMove(feature, block?.id === 'later' ? null : block?.id);
  }

  return (
    <div className="dev-roadmap-scroll">
      <div className="dev-roadmap" style={{ '--dev-cols': columns.length }}>
        <div className="dev-roadmap-head product">Product</div>
        {columns.map((block, index) => {
          const isNow = block.id === current?.id;
          return (
            <div key={block.id} className={`dev-roadmap-head${isNow ? ' is-now' : ''}`}>
              <b>{block.id === 'later' ? 'Later' : isNow ? 'Now' : index === blocks.indexOf(current) + 1 ? 'Next' : 'After'}</b>
              <small>{block.id === 'later' ? 'unscheduled' : `${shortDate(block.starts_on)} – ${shortDate(block.ends_on)}`}</small>
            </div>
          );
        })}
        {products.map((product) => (
          <div className="dev-roadmap-product-row" key={product.id}>
            <div className="dev-product">
              <span className={`dev-product-dot is-${product.colour}`} />
              <strong>{product.name}</strong>
              <small>{product.stage === 'live' ? 'live' : 'pre-launch'}</small>
            </div>
            {columns.map((block) => {
              const isLater = block.id === 'later';
              const isNow = block.id === current?.id;
              const cellFeatures = features.filter((feature) => feature.project_id === product.id
                && (isLater ? !feature.block_id : feature.block_id === block.id));
              return (
                <div key={block.id} className={`dev-roadmap-cell${isNow ? ' is-now' : ''}${over === `${product.id}:${block.id}` ? ' is-over' : ''}`}
                  onDragOver={(event) => { if (canPlan) { event.preventDefault(); setOver(`${product.id}:${block.id}`); } }}
                  onDragLeave={() => setOver(null)} onDrop={(event) => drop(event, block)}>
                  {cellFeatures.map((feature) => <FeatureCard key={feature.id} feature={feature}
                    tasks={tasksByFeature[feature.id] || []} now={isNow} draggable={canPlan}
                    overload={isNow && nowCounts[feature.owner_id] > 3} onOpen={onOpen}
                    onDragStart={(event) => { event.dataTransfer.setData('text/dev-feature', feature.id); event.dataTransfer.effectAllowed = 'move'; }} />)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="dev-legend">
        {Object.entries(ROLLUP_META).map(([key, meta]) => <span key={key}><i className={`is-${meta.tone}`} />{meta.label}</span>)}
      </div>
    </div>
  );
}

function TaskRow({ task, feature, onOpen }) {
  return (
    <button type="button" className="dev-task-row" onClick={() => onOpen(task)}>
      <StatusPill status={task.status} />
      <span className="dev-task-copy"><strong>{task.title}</strong><small>{task.acceptance_check || 'Acceptance check not added yet.'}</small></span>
      <span className="dev-task-context">{feature?.project_name}<small>{feature?.title}</small></span>
      <PriorityPill priority={task.priority} />
      <span className="dev-task-due">{task.due_date ? `due ${shortDate(task.due_date)}` : 'no due date'}</span>
      <Avatar person={task.owner} />
      <i className="bi bi-chevron-right" />
    </button>
  );
}

function ListView({ tasks, features, onOpen, source = null }) {
  const [status, setStatus] = useState('open');
  const featureById = Object.fromEntries(features.map((feature) => [feature.id, feature]));
  const rows = sortWorkTasks(tasks.filter((task) => (!source || task.source === source)
    && (status === 'all' || status === 'open' && task.status !== 'live' || task.status === status)));
  return (
    <>
      <div className="dev-list-toolbar">
        <select className="wx-input" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="open">Open work</option><option value="all">Every status</option>
          {Object.entries(STATUS_META).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}
        </select>
        <span>{rows.length} task{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div className="dev-task-list">
        {rows.map((task) => <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} onOpen={onOpen} />)}
        {!rows.length && <Empty title="Nothing here" body="Change the filter or add a task to a feature." />}
      </div>
    </>
  );
}

function DoneView({ features, products, blocks, onOpen }) {
  const done = features.filter((feature) => feature.subtask_total > 0 && feature.subtask_live === feature.subtask_total);
  if (!done.length) return <Empty icon="bi-check2-circle" title="No shipped features yet" body="Features appear here when every task is Live." />;
  const groups = [...blocks, { id: 'later', starts_on: null }].map((block) => ({
    block, features: done.filter((feature) => block.id === 'later' ? !feature.block_id : feature.block_id === block.id),
  })).filter((group) => group.features.length).reverse();
  return <div className="dev-done-groups">{groups.map(({ block, features: items }) => (
    <section key={block.id}><h3>{block.id === 'later' ? 'Unscheduled' : `Shipped · ${shortDate(block.starts_on)}`}</h3>
      {items.map((feature) => <button type="button" key={feature.id} className="dev-done-row" onClick={() => onOpen(feature)}>
        <i className="bi bi-check-circle-fill" /><span><strong>{feature.title}</strong><small>{products.find((p) => p.id === feature.project_id)?.name}</small></span><Avatar person={feature.owner} /><i className="bi bi-chevron-right" />
      </button>)}
    </section>
  ))}</div>;
}

function MyWeek({ data, me, onOpen, onRefresh }) {
  const today = isoToday();
  const block = data.blocks.find((item) => item.starts_on <= today && item.ends_on >= today);
  const featureById = Object.fromEntries(data.features.map((feature) => [feature.id, feature]));
  const mine = sortWorkTasks(data.tasks.filter((task) => task.owner_id === me.id
    && featureById[task.task_id]?.block_id === block?.id && task.status !== 'live'));
  const reviews = sortWorkTasks(data.tasks.filter((task) => task.reviewer_id === me.id && task.owner_id !== me.id && task.status === 'dev_review'));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function submit() {
    setBusy(true); setNotice('');
    try { const count = await postEod(message, mine); setMessage(''); setNotice(`Posted to ${count} task${count === 1 ? '' : 's'}.`); onRefresh(); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  return (
    <>
      <div className="dev-week-heading"><div><span>Now block</span><h2>{block ? `${shortDate(block.starts_on)} – ${shortDate(block.ends_on)}` : 'Unscheduled'}</h2></div><strong>{mine.length} active task{mine.length === 1 ? '' : 's'}</strong></div>
      <div className="dev-week-grid">
        <div className="dev-week-work">
          {reviews.length > 0 && <section className="dev-review-queue"><h3><i className="bi bi-code-slash" /> Ready for your review <b>{reviews.length}</b></h3>{reviews.map((task) => <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} onOpen={onOpen} />)}</section>}
          <section><h3>My work</h3><div className="dev-task-list">{mine.map((task) => <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} onOpen={onOpen} />)}{!mine.length && <Empty title="Your block is clear" body="There is no open work assigned to you in this block." />}</div></section>
        </div>
        <aside className="dev-eod"><span>End of day · {shortDate(today)}</span><h3>What moved today?</h3><textarea className="wx-input" rows={8} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={'Task name: what changed\nAnother task: waiting on review\nBlocked: none'} /><small>One line per task. This posts to each task’s activity and the development audience.</small>{notice && <div className="dev-eod-notice">{notice}</div>}<button className="wx-btn wx-btn-primary" disabled={busy || !message.trim()} onClick={submit}>{busy ? 'Posting…' : 'Post update'}</button></aside>
      </div>
    </>
  );
}

function Modal({ title, children, onClose, footer, wide = false }) {
  return createPortal(<div className="wx-modal-backdrop" onMouseDown={onClose}><div className="wx-modal" style={{ maxWidth: wide ? 680 : 540 }} onMouseDown={(event) => event.stopPropagation()}>
    <div className="wx-modal-header"><div className="wx-modal-title">{title}</div><button className="wx-btn wx-btn-ghost" onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button></div>
    <div className="wx-modal-body">{children}</div>{footer && <div className="wx-modal-footer">{footer}</div>}
  </div></div>, document.body);
}

function FeatureModal({ products, developers, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', description: '', productId: products[0]?.id || '', ownerId: developers[0]?.id || '', priority: 'normal' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  async function save() { setBusy(true); setError(''); try { if (!form.name.trim()) throw new Error('Feature name is required.'); await createFeature(form); onSaved(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <Modal title="New feature" onClose={onClose} footer={<><button className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button><button className="wx-btn wx-btn-primary" disabled={busy} onClick={save}>{busy ? 'Creating…' : 'Create in Later'}</button></>}>
    <div className="dev-form">{error && <div className="wx-alert wx-alert-danger">{error}</div>}<label>Feature name<input className="wx-input" autoFocus maxLength={40} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Landing page" /></label><label>Description<textarea className="wx-input" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} /></label><div className="dev-form-pair"><label>Product<select className="wx-input" value={form.productId} onChange={(e) => set('productId', e.target.value)}>{products.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label>Owner<select className="wx-input" value={form.ownerId} onChange={(e) => set('ownerId', e.target.value)}>{developers.map((p) => <option value={p.id} key={p.id}>{p.display_name}</option>)}</select></label></div><label>Priority<select className="wx-input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>{DEV_PRIORITIES.map((p) => <option value={p} key={p}>{PRIORITY_META[p].label}</option>)}</select></label>
    </div>
  </Modal>;
}

function WorkTaskModal({ feature, developers, task = null, onClose, onSaved }) {
  const [form, setForm] = useState({ title: task?.title || '', acceptance: task?.acceptance_check || '', ownerId: task?.owner_id || feature.owner_id || developers[0]?.id || '', priority: task?.priority || feature.priority || 'normal', due: task?.due_date || feature.block_ends_on || '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  async function save() { setBusy(true); setError(''); try { if (!form.title.trim()) throw new Error('Task title is required.'); if (task) await updateWorkTask(task.id, { title: form.title.trim(), acceptance_check: form.acceptance.trim() || null, owner_id: form.ownerId, priority: form.priority, due_date: form.due || null }); else await createWorkTask(feature, form); onSaved(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <Modal title={task ? 'Edit task' : `Add task · ${feature.title}`} onClose={onClose} footer={<><button className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button><button className="wx-btn wx-btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save task'}</button></>}>
    <div className="dev-form">{error && <div className="wx-alert wx-alert-danger">{error}</div>}<label>Task title<input className="wx-input" autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Fix landing CTA link" /></label><label>Acceptance check <span>required before planning</span><textarea className="wx-input dev-acceptance-input" rows={4} value={form.acceptance} onChange={(e) => set('acceptance', e.target.value)} placeholder="What should be true when this is done?" /></label><div className="dev-form-pair"><label>Owner<select className="wx-input" value={form.ownerId} onChange={(e) => set('ownerId', e.target.value)}>{developers.map((p) => <option value={p.id} key={p.id}>{p.display_name}</option>)}</select></label><label>Priority<select className="wx-input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>{DEV_PRIORITIES.map((p) => <option value={p} key={p}>{PRIORITY_META[p].label}</option>)}</select></label></div><label>Due date<input className="wx-input" type="date" value={form.due} onChange={(e) => set('due', e.target.value)} /></label></div>
  </Modal>;
}

function FeatureDrawer({ feature, tasks, developers, canEdit, onClose, onOpenTask, onRefresh }) {
  const [adding, setAdding] = useState(false);
  return <><div className="dev-drawer-backdrop" onMouseDown={onClose} /><aside className="dev-drawer"><header><button onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button><span>{feature.project_name} › feature</span><h2>{feature.title}</h2><div><PriorityPill priority={feature.priority} /><span className={`dev-rollup is-${ROLLUP_META[feature.rollup_status]?.tone}`}>{ROLLUP_META[feature.rollup_status]?.label}</span></div></header><div className="dev-drawer-body"><div className="dev-feature-summary"><span><small>Owner</small><b><Avatar person={feature.owner} />{feature.owner?.display_name || 'Unassigned'}</b></span><span><small>Progress</small><b>{feature.subtask_done}/{feature.subtask_total} tested</b></span></div>{feature.description && <p className="dev-feature-description">{feature.description}</p>}<div className="dev-drawer-section-head"><h3>Tasks</h3>{canEdit && <button className="wx-btn wx-btn-primary" onClick={() => setAdding(true)}><i className="bi bi-plus-lg" /> Add task</button>}</div><div className="dev-task-list compact">{sortWorkTasks(tasks).map((task) => <TaskRow key={task.id} task={task} feature={feature} onOpen={onOpenTask} />)}{!tasks.length && <Empty title="No tasks yet" body="Break this feature into testable pieces." />}</div></div></aside>{adding && <WorkTaskModal feature={feature} developers={developers} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onRefresh(); }} />}</>;
}

function TaskDrawer({ task, feature, data, me, onClose, onRefresh }) {
  const [activity, setActivity] = useState([]); const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false); const [note, setNote] = useState('');
  const [action, setAction] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [screenshot, setScreenshot] = useState(null); const [duplicate, setDuplicate] = useState('');
  const teamMember = data.team.find((member) => member.user_id === me.id);
  const actions = allowedTaskActions(task, me.id, data.team);
  useEffect(() => { let live = true; setLoading(true); listTaskActivity(feature.id).then((rows) => { if (live) setActivity(rows.filter((item) => !item.subtask_id || item.subtask_id === task.id)); }).catch((e) => setError(e.message)).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [feature.id, task.id]);
  useEffect(() => { if (!task.screenshot_path) return; issueScreenshotUrl(task.screenshot_path).then(setScreenshot).catch(() => {}); }, [task.screenshot_path]);
  async function run(item) { setError(''); if (item.note) { setNote(''); setAction(item); return; } setBusy(true); try { await transitionWorkTask(task.id, item.to); await onRefresh(); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function confirmAction() { setBusy(true); setError(''); try { await transitionWorkTask(task.id, action.to, { note, blockedReason: action.note === 'blocked' ? note : '' }); setAction(null); await onRefresh(); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function postNote() { if (!note.trim()) return; setBusy(true); try { await addActivity(feature.id, task.id, note); setNote(''); const rows = await listTaskActivity(feature.id); setActivity(rows.filter((item) => !item.subtask_id || item.subtask_id === task.id)); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function closeDuplicate() { if (!duplicate) return; setBusy(true); try { await markBugDuplicate(task.id, duplicate); await onRefresh(); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const otherBugs = data.tasks.filter((item) => item.source === 'bug_report' && item.id !== task.id);
  return <><div className="dev-drawer-backdrop" onMouseDown={onClose} /><aside className="dev-drawer task-panel"><header><button onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button><span>{feature.project_name} › {feature.title} › task</span><h2>{task.title}</h2><div><StatusPill status={task.status} /><PriorityPill priority={task.priority} />{feature.block_starts_on && <em>{shortDate(feature.block_starts_on)} – {shortDate(feature.block_ends_on)}</em>}</div></header><div className="dev-drawer-body">{error && <div className="wx-alert wx-alert-danger">{error}</div>}<section className="dev-acceptance"><small>Acceptance check</small><p>{task.acceptance_check || 'Not added yet. This task cannot be scheduled without one.'}</p></section>{task.blocked_reason && <section className="dev-block-reason"><small>Blocked because</small><p>{task.blocked_reason}</p></section>}<dl className="dev-task-facts"><dt>Owner</dt><dd><Avatar person={task.owner} />{task.owner?.display_name || 'Unassigned'}</dd><dt>Reviewer</dt><dd>{task.reviewer?.display_name || '—'}</dd><dt>Final review</dt><dd>{task.finalReviewer?.display_name || 'Usman'}</dd><dt>Due</dt><dd>{shortDate(task.due_date)}</dd><dt>Source</dt><dd>{task.source === 'bug_report' ? `Reported by ${task.reporter?.display_name || 'employee'}` : 'Manual'}</dd>{task.page_url && <><dt>Page</dt><dd className="break">{task.page_url}</dd></>}</dl>{task.expected && <section className="dev-expected"><small>Reporter expected</small><p>{task.expected}</p></section>}{screenshot && <a className="dev-screenshot" href={screenshot} target="_blank" rel="noreferrer"><img src={screenshot} alt="Issue screenshot" /></a>}<div className="dev-drawer-section-head"><h3>Activity</h3>{me.id === task.owner_id || me.id === task.reviewer_id || me.id === task.final_reviewer_id ? <button className="wx-btn wx-btn-ghost" onClick={() => setEditing(true)}><i className="bi bi-pencil" /> Edit</button> : null}</div><div className="dev-activity">{loading ? <span>Loading…</span> : activity.map((item) => <div key={item.id}><time>{new Date(item.created_at).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time><p><b>{item.author?.display_name || 'System'}</b>{item.status_to && <> moved <StatusPill status={item.status_to} /></>}{item.body && <> {item.body}</>}</p></div>)}{!loading && !activity.length && <span>No activity yet.</span>}</div><div className="dev-note-box"><textarea className="wx-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" /><button className="wx-btn wx-btn-ghost" disabled={busy || !note.trim()} onClick={postNote}>Post</button></div>{task.source === 'bug_report' && teamMember?.level === 'senior' && task.status !== 'live' && <div className="dev-duplicate"><select className="wx-input" value={duplicate} onChange={(e) => setDuplicate(e.target.value)}><option value="">Duplicate of…</option>{otherBugs.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button className="wx-btn wx-btn-ghost" disabled={!duplicate || busy} onClick={closeDuplicate}>Close duplicate</button></div>}</div><footer>{actions.length ? actions.map((item) => <button key={item.to + item.label} className={`wx-btn ${item.primary ? 'wx-btn-primary' : 'wx-btn-ghost'}`} disabled={busy} onClick={() => run(item)}>{item.label}</button>) : <span>Waiting on {waitingLabel(task)}.</span>}</footer></aside>{editing && <WorkTaskModal feature={feature} developers={data.people.filter((p) => p.role === 'developer')} task={task} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await onRefresh(); onClose(); }} />}{action && <Modal title={action.note === 'blocked' ? 'What is blocking this?' : 'Send back with a note'} onClose={() => setAction(null)} footer={<><button className="wx-btn wx-btn-ghost" onClick={() => setAction(null)}>Cancel</button><button className="wx-btn wx-btn-primary" disabled={busy || !note.trim()} onClick={confirmAction}>Confirm</button></>}><label className="dev-modal-note">Note<textarea className="wx-input" autoFocus rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder={action.note === 'blocked' ? 'Who or what is holding this up?' : 'What needs to change?'} /></label></Modal>}</>;
}

export default function DevTasksPage() {
  const { profile } = useAuth(); const { id } = useParams(); const navigate = useNavigate();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [tab, setTab] = useState(profile?.role === 'boss' ? 'roadmap' : 'week'); const [feature, setFeature] = useState(null); const [task, setTask] = useState(null); const [showFeatureModal, setShowFeatureModal] = useState(false);
  const isBoss = profile?.role === 'boss'; const developers = data?.people.filter((person) => person.role === 'developer') || [];
  const load = useCallback(async () => { setError(''); try { const result = await loadDevelopmentWorkspace(); setData(result); if (id) { const directTask = result.tasks.find((item) => item.id === id); if (directTask) { setTask(directTask); setFeature(result.features.find((item) => item.id === directTask.task_id)); } else { setFeature(result.features.find((item) => item.id === id) || null); } } } catch (e) { setError(e.message); } finally { setLoading(false); } }, [id]);
  useEffect(() => { load(); }, [load]);
  const openFeature = (item) => { setFeature(item); setTask(null); navigate(`/dev-tasks/${item.id}`, { replace: true }); };
  const openTask = (item) => { setTask(item); setFeature(data.features.find((f) => f.id === item.task_id)); navigate(`/dev-tasks/${item.id}`, { replace: true }); };
  const closeDrawer = () => { setFeature(null); setTask(null); navigate('/dev-tasks', { replace: true }); };
  async function plan(item, blockId) { setError(''); try { await moveFeature(item.id, blockId); await load(); } catch (e) { setError(e.message); } }
  if (loading) return <div className="dev-loading"><span className="wx-spinner" /> Loading development workspace…</div>;
  if (!data) return <div className="wx-alert wx-alert-danger">{error || 'Could not load Development.'}</div>;
  const openFeatures = data.features.filter((item) => !(item.subtask_total > 0 && item.subtask_live === item.subtask_total));
  return <div className="dev-page"><header className="dev-page-head"><div><span className="dev-eyebrow">Product delivery</span><h1>Development</h1><p>{isBoss ? 'Three products, two developers, one queue.' : 'Your block, reviews and daily update in one place.'}</p></div><div className="dev-head-actions">{isBoss && <button className="wx-btn wx-btn-ghost" onClick={() => setTab('roadmap')}><i className="bi bi-calendar2-range" /> Plan next block</button>}<button className="wx-btn wx-btn-primary" onClick={() => setShowFeatureModal(true)}><i className="bi bi-plus-lg" /> New feature</button></div></header>{error && <div className="wx-alert wx-alert-danger dev-error">{error}<button onClick={() => setError('')}><i className="bi bi-x" /></button></div>}{isBoss ? <><WaitingStrip tasks={data.tasks} features={data.features} onOpen={openTask} /><nav className="dev-tabs">{[['roadmap', 'Roadmap'], ['list', 'List'], ['bugs', `Bugs · ${data.tasks.filter((item) => item.source === 'bug_report' && item.status !== 'live').length}`], ['done', 'Done']].map(([value, label]) => <button className={tab === value ? 'is-active' : ''} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav><main className="dev-surface">{tab === 'roadmap' && <Roadmap products={data.products} blocks={data.blocks} features={openFeatures} tasksByFeature={data.tasksByFeature} canPlan onOpen={openFeature} onMove={plan} />}{tab === 'list' && <ListView tasks={data.tasks} features={data.features} onOpen={openTask} />}{tab === 'bugs' && <ListView tasks={data.tasks} features={data.features} source="bug_report" onOpen={openTask} />}{tab === 'done' && <DoneView features={data.features} products={data.products} blocks={data.blocks} onOpen={openFeature} />}</main></> : <><nav className="dev-tabs">{[['week', 'My week'], ['roadmap', 'Roadmap'], ['list', 'All tasks']].map(([value, label]) => <button className={tab === value ? 'is-active' : ''} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav><main className={`dev-surface${tab === 'week' ? ' dev-week-surface' : ''}`}>{tab === 'week' && <MyWeek data={data} me={profile} onOpen={openTask} onRefresh={load} />}{tab === 'roadmap' && <Roadmap products={data.products} blocks={data.blocks} features={openFeatures} tasksByFeature={data.tasksByFeature} canPlan={false} onOpen={openFeature} onMove={() => {}} />}{tab === 'list' && <ListView tasks={data.tasks} features={data.features} onOpen={openTask} />}</main></>}{feature && !task && <FeatureDrawer feature={feature} tasks={data.tasksByFeature[feature.id] || []} developers={developers} canEdit onClose={closeDrawer} onOpenTask={openTask} onRefresh={load} />}{task && feature && <TaskDrawer task={task} feature={feature} data={data} me={profile} onClose={closeDrawer} onRefresh={load} />}{showFeatureModal && <FeatureModal products={data.products} developers={developers} onClose={() => setShowFeatureModal(false)} onSaved={async () => { setShowFeatureModal(false); await load(); }} />}</div>;
}
