// Development — the product roadmap, review queue and daily update for the
// Boss and the developers (spec: "WurxOS Development section v2").
//
// ── WHY THIS FILE IS SMALL NOW ─────────────────────────────────────────────
// It used to hold seventeen components, several written as single lines over
// four thousand characters long, which nobody could review or change safely.
// The pieces live in src/components/development/. This page loads the
// workspace, chooses what each role sees, and owns which panel is open.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { loadDevelopmentWorkspace, moveFeature } from '../../lib/devTasksApi';
import WaitingStrip from '../../components/development/WaitingStrip';
import Roadmap from '../../components/development/Roadmap';
import ListView from '../../components/development/ListView';
import DoneView from '../../components/development/DoneView';
import MyWeek from '../../components/development/MyWeek';
import FeatureDrawer from '../../components/development/FeatureDrawer';
import TaskDrawer from '../../components/development/TaskDrawer';
import FeatureModal from '../../components/development/FeatureModal';
import '../../styles/table.css';
import '../../styles/development.css';

const isShipped = (feature) => feature.subtask_total > 0 && feature.subtask_live === feature.subtask_total;

function Tabs({ tabs, active, onChange }) {
  return (
    <nav className="dev-tabs" role="tablist" aria-label="Development views">
      {tabs.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={active === value}
          className={active === value ? 'is-active' : ''}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export default function DevTasksPage() {
  const { profile } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const isBoss = profile?.role === 'boss';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(isBoss ? 'roadmap' : 'week');
  const [productId, setProductId] = useState(null);
  const [feature, setFeature] = useState(null);
  const [task, setTask] = useState(null);
  const [showFeatureModal, setShowFeatureModal] = useState(false);

  const developers = data?.people.filter((person) => person.role === 'developer') || [];

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await loadDevelopmentWorkspace();
      setData(result);
      // /dev-tasks/:id can name a task or a feature.
      if (id) {
        const directTask = result.tasks.find((item) => item.id === id);
        if (directTask) {
          setTask(directTask);
          setFeature(result.features.find((item) => item.id === directTask.task_id));
        } else {
          setFeature(result.features.find((item) => item.id === id) || null);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const openFeature = (item) => {
    setFeature(item);
    setTask(null);
    navigate(`/dev-tasks/${item.id}`, { replace: true });
  };

  const openTask = (item) => {
    setTask(item);
    setFeature(data.features.find((candidate) => candidate.id === item.task_id));
    navigate(`/dev-tasks/${item.id}`, { replace: true });
  };

  const closeDrawer = () => {
    setFeature(null);
    setTask(null);
    navigate('/dev-tasks', { replace: true });
  };

  async function plan(item, blockId) {
    setError('');
    try {
      await moveFeature(item.id, blockId);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) {
    return (
      <div className="dev-loading">
        <span className="wx-spinner" /> Loading development workspace…
      </div>
    );
  }
  if (!data) {
    return <div className="wx-alert wx-alert-danger">{error || 'Could not load Development.'}</div>;
  }

  const openFeatures = data.features.filter((item) => !isShipped(item));
  const openBugs = data.tasks.filter((item) => item.source === 'bug_report' && item.status !== 'live').length;
  const bugsTab = ['bugs', `Bugs · ${openBugs}`];
  // The senior developer triages bugs first thing each morning, so developers
  // get the Bugs tab too. Done is the Boss's changelog.
  const tabs = isBoss
    ? [['roadmap', 'Roadmap'], ['list', 'List'], bugsTab, ['done', 'Done']]
    : [['week', 'My week'], ['roadmap', 'Roadmap'], ['list', 'All tasks'], bugsTab];
  const pickedProduct = data.products.find((item) => item.id === productId);

  return (
    <div className="dev-page">
      <header className="dev-page-head">
        <div>
          <span className="dev-eyebrow">Product delivery</span>
          <h1>Development</h1>
          <p>
            {isBoss
              ? 'Three products, two developers, one queue.'
              : 'Your block, reviews and daily update in one place.'}
          </p>
        </div>
        <div className="dev-head-actions">
          {isBoss && (
            <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setTab('roadmap')}>
              <i className="bi bi-calendar2-range" aria-hidden="true" /> Plan next block
            </button>
          )}
          <button type="button" className="wx-btn wx-btn-primary" onClick={() => setShowFeatureModal(true)}>
            <i className="bi bi-plus-lg" aria-hidden="true" /> New feature
          </button>
        </div>
      </header>

      {error && (
        <div className="wx-alert wx-alert-danger dev-error" role="alert">
          {error}
          <button type="button" onClick={() => setError('')} aria-label="Dismiss">
            <i className="bi bi-x" />
          </button>
        </div>
      )}

      {isBoss && <WaitingStrip tasks={data.tasks} features={data.features} onOpen={openTask} />}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {pickedProduct && tab !== 'week' && (
        <div className="dev-filter-chip" role="status">
          <span className={`dev-product-dot is-${pickedProduct.colour}`} aria-hidden="true" />
          <span>Showing <b>{pickedProduct.name}</b> only</span>
          <button type="button" onClick={() => setProductId(null)}>Show all products</button>
        </div>
      )}

      <main className={`dev-surface${tab === 'week' ? ' dev-week-surface' : ''}`}>
        {tab === 'week' && !isBoss && (
          <MyWeek data={data} me={profile} onOpen={openTask} onRefresh={load} />
        )}
        {tab === 'roadmap' && (
          <Roadmap
            products={data.products}
            blocks={data.blocks}
            features={openFeatures}
            canPlan={isBoss}
            productId={productId}
            onPickProduct={setProductId}
            onOpen={openFeature}
            onMove={isBoss ? plan : () => {}}
          />
        )}
        {tab === 'list' && (
          <ListView
            tasks={data.tasks}
            features={data.features}
            viewerId={profile?.id}
            productId={productId}
            onOpen={openTask}
          />
        )}
        {tab === 'bugs' && (
          <ListView
            tasks={data.tasks}
            features={data.features}
            viewerId={profile?.id}
            productId={productId}
            source="bug_report"
            onOpen={openTask}
          />
        )}
        {tab === 'done' && isBoss && (
          <DoneView
            features={data.features}
            tasks={data.tasks}
            products={data.products}
            blocks={data.blocks}
            productId={productId}
            onOpen={openFeature}
          />
        )}
      </main>

      {feature && !task && (
        <FeatureDrawer
          feature={feature}
          tasks={data.tasksByFeature[feature.id] || []}
          blocks={data.blocks}
          developers={developers}
          viewerId={profile?.id}
          canEdit
          onClose={closeDrawer}
          onOpenTask={openTask}
          onRefresh={load}
        />
      )}

      {task && feature && (
        <TaskDrawer task={task} feature={feature} data={data} me={profile} onClose={closeDrawer} onRefresh={load} />
      )}

      {showFeatureModal && (
        <FeatureModal
          products={data.products}
          developers={developers}
          onClose={() => setShowFeatureModal(false)}
          onSaved={async () => { setShowFeatureModal(false); await load(); }}
        />
      )}
    </div>
  );
}
