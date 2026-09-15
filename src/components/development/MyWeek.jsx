// A developer's block: their open tasks in the running block with the
// acceptance check inline, any Dev reviews waiting on them, and the
// end-of-day update that posts one line to each task.
import { useState } from 'react';
import { sortWorkTasks, postEod, matchEodLines } from '../../lib/devTasksApi';
import TaskRow from './TaskRow';
import { Empty } from './Primitives';
import { currentBlock } from './devBlocks';
import { dateRange, isoToday, shortDate } from './devFormat';

export default function MyWeek({ data, me, onOpen, onRefresh }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const today = isoToday();
  const block = currentBlock(data.blocks, today);
  const featureById = Object.fromEntries(data.features.map((feature) => [feature.id, feature]));
  const blockById = Object.fromEntries(data.blocks.map((item) => [item.id, item]));

  // The running block, plus unfinished work carried over from a block that has
  // ended (the roadmap shows that in Now too).
  const inThisBlock = (feature) => {
    const planned = feature && blockById[feature.block_id];
    return Boolean(block && planned && (planned.id === block.id || planned.ends_on < block.starts_on));
  };

  const mine = sortWorkTasks(data.tasks.filter((task) => task.owner_id === me.id
    && task.status !== 'live'
    && inThisBlock(featureById[task.task_id])));
  const reviews = sortWorkTasks(data.tasks.filter((task) => task.status === 'dev_review'
    && task.reviewer_id === me.id
    && task.owner_id !== me.id));

  const examples = mine.slice(0, 2).map((task) => `${task.title}: what changed`);
  const placeholder = [...(examples.length ? examples : ['Task name: what changed']), 'Blocked: none'].join('\n');

  async function submit() {
    setBusy(true);
    setNotice(null);
    const { unmatched } = matchEodLines(message, mine);
    try {
      const count = await postEod(message, mine);
      setMessage('');
      setNotice({ error: false, text: `Posted to ${count} task${count === 1 ? '' : 's'}.`, unmatched });
      onRefresh();
    } catch (error) {
      setNotice({ error: true, text: error.message, unmatched: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="dev-week-heading">
        <div>
          <span>Now block</span>
          <h2>{block ? dateRange(block.starts_on, block.ends_on) : 'No block is running'}</h2>
        </div>
        <strong>{mine.length} open task{mine.length === 1 ? '' : 's'}</strong>
      </div>

      <div className="dev-week-grid">
        <div className="dev-week-work">
          {reviews.length > 0 && (
            <section className="dev-review-queue">
              <h3><i className="bi bi-code-slash" aria-hidden="true" /> Waiting on your Dev review <b>{reviews.length}</b></h3>
              {reviews.map((task) => (
                <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} viewerId={me.id} onOpen={onOpen} />
              ))}
            </section>
          )}

          <section>
            <h3>My work</h3>
            <div className="dev-task-list">
              {mine.map((task) => (
                <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} viewerId={me.id} onOpen={onOpen} />
              ))}
              {!mine.length && <Empty title="Your block is clear" body="Nothing is assigned to you in this block." />}
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
            placeholder={placeholder}
          />
          <small>
            One line per task, starting with its name. Each line posts to that task’s log, and the whole
            update goes to the dev broadcast, so no WhatsApp message is needed.
          </small>
          {notice && (
            <div className={`dev-eod-notice${notice.error ? ' is-error' : ''}`} role="status">
              {notice.text}
              {notice.unmatched.length > 0 && (
                <>
                  <span>Not matched to one task, so only in the broadcast:</span>
                  <ul>
                    {notice.unmatched.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
          <button type="button" className="wx-btn wx-btn-primary" disabled={busy || !message.trim()} onClick={submit}>
            {busy ? 'Posting…' : 'Post update'}
          </button>
        </aside>
      </div>
    </>
  );
}
