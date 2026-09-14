// A developer's week: reviews waiting on them, their open work in the running
// block, and the end-of-day update that posts one line to each task.
import { useState } from 'react';
import { sortWorkTasks, postEod } from '../../lib/devTasksApi';
import TaskRow from './TaskRow';
import { Empty } from './Primitives';
import { isoToday, shortDate } from './devFormat';

export default function MyWeek({ data, me, onOpen, onRefresh }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const today = isoToday();
  const block = data.blocks.find((item) => item.starts_on <= today && item.ends_on >= today);
  const featureById = Object.fromEntries(data.features.map((feature) => [feature.id, feature]));

  const mine = sortWorkTasks(data.tasks.filter((task) => task.owner_id === me.id
    && featureById[task.task_id]?.block_id === block?.id
    && task.status !== 'live'));
  const reviews = sortWorkTasks(data.tasks.filter((task) => task.reviewer_id === me.id
    && task.owner_id !== me.id
    && task.status === 'dev_review'));

  async function submit() {
    setBusy(true);
    setNotice('');
    try {
      const count = await postEod(message, mine);
      setMessage('');
      setNotice(`Posted to ${count} task${count === 1 ? '' : 's'}.`);
      onRefresh();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="dev-week-heading">
        <div>
          <span>Now block</span>
          <h2>{block ? `${shortDate(block.starts_on)} – ${shortDate(block.ends_on)}` : 'Unscheduled'}</h2>
        </div>
        <strong>{mine.length} active task{mine.length === 1 ? '' : 's'}</strong>
      </div>

      <div className="dev-week-grid">
        <div className="dev-week-work">
          {reviews.length > 0 && (
            <section className="dev-review-queue">
              <h3><i className="bi bi-code-slash" aria-hidden="true" /> Ready for your review <b>{reviews.length}</b></h3>
              {reviews.map((task) => (
                <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} onOpen={onOpen} />
              ))}
            </section>
          )}

          <section>
            <h3>My work</h3>
            <div className="dev-task-list">
              {mine.map((task) => (
                <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} onOpen={onOpen} />
              ))}
              {!mine.length && <Empty title="Your block is clear" body="There is no open work assigned to you in this block." />}
            </div>
          </section>
        </div>

        <aside className="dev-eod">
          <span>End of day · {shortDate(today)}</span>
          <h3>What moved today?</h3>
          <textarea
            className="wx-input"
            rows={8}
            aria-label="End of day update"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={'Task name: what changed\nAnother task: waiting on review\nBlocked: none'}
          />
          <small>One line per task. This posts to each task’s activity and the development audience.</small>
          {notice && <div className="dev-eod-notice" role="status">{notice}</div>}
          <button type="button" className="wx-btn wx-btn-primary" disabled={busy || !message.trim()} onClick={submit}>
            {busy ? 'Posting…' : 'Post update'}
          </button>
        </aside>
      </div>
    </>
  );
}
