import { useAuth } from '../../contexts/AuthContext';
import { PageHeader } from '../../components/ui';
import TodayStrip from './widgets/TodayStrip';
import ReportsDueCard from './widgets/ReportsDueCard';
import TasksCard from './widgets/TasksCard';
import NextMeetingCard from './widgets/NextMeetingCard';
import ApprovalsCard from './widgets/ApprovalsCard';
import TeamTodayCard from './widgets/TeamTodayCard';
import ComplianceGrid from './widgets/ComplianceGrid';
import { BossKpis, HeadcountRow } from './widgets/BossKpis';
import QuickLinksCard, { TikTokConnectCard } from './widgets/QuickLinksCard';
import '../../styles/today.css';

// /dashboard → role "Today" home (spec F1). Each card has its own query,
// skeleton and Retry, so one failing card never blanks the page. Phones get
// a single column in the order written below; ≥1100px uses two columns.
function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', hour: 'numeric', hour12: false }).format(new Date()));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

const LINKS = {
  apc: [
    { to: '/video-reviews', icon: 'bi-camera-video', label: 'Video reviews' },
    { to: '/agenda/tasks', icon: 'bi-list-check', label: 'Agenda tasks' },
  ],
  tl: [
    { to: '/creator-library', icon: 'bi-people', label: 'Creator Library', category: 'creator_library' },
    { to: '/agenda/checkpoint', icon: 'bi-clipboard-check', label: 'Weekly Checkpoint' },
  ],
  pctl: [
    { to: '/paid-collab/dashboard', icon: 'bi-megaphone', label: 'Paid Collab dashboard' },
    { to: '/pctl/ipcs', icon: 'bi-people', label: 'Your IPCs' },
    { to: '/creator-library', icon: 'bi-person-video3', label: 'Creator Library', category: 'creator_library' },
  ],
  ipc: [
    { to: '/creator-library', icon: 'bi-person-video3', label: 'Creator Library queue', category: 'creator_library' },
    { to: '/agenda/checkpoint', icon: 'bi-clipboard-check', label: 'Weekly Checkpoint' },
  ],
  ads_manager: [
    { to: '/gmv-max', icon: 'bi-graph-up-arrow', label: 'GMV Max' },
    { to: '/analytics/brands', icon: 'bi-bar-chart', label: 'Brand analytics' },
  ],
};

function Layout({ main, side }) {
  return (
    <div className="today-cols">
      <div className="today-col">{main}</div>
      <div className="today-col">{side}</div>
    </div>
  );
}

export default function TodayRouter({ profile: profileProp }) {
  const { user, profile: ctxProfile } = useAuth();
  const profile = profileProp || ctxProfile;
  const role = profile?.role;
  const uid = user?.id || profile?.id;
  const first = (profile?.display_name || '').split(' ')[0];

  let body;
  switch (role) {
    case 'apc':
      body = <Layout
        main={<><TodayStrip uid={uid} /><ReportsDueCard /><TasksCard uid={uid} /></>}
        side={<><NextMeetingCard /><QuickLinksCard links={LINKS.apc} /></>} />;
      break;
    case 'tl':
      body = <Layout
        main={<><TodayStrip uid={uid} /><ApprovalsCard role={role} kinds={['leave', 'attendance']} title="Team approvals" /><ApprovalsCard role={role} kinds={['reports']} title="Reports awaiting my review" linkTo="/approvals?kind=reports" /></>}
        side={<><TeamTodayCard uid={uid} /><NextMeetingCard checkpointBanner /><TasksCard uid={uid} /><QuickLinksCard links={LINKS.tl} /></>} />;
      break;
    case 'ol':
      body = <Layout
        main={<><TodayStrip uid={uid} /><ApprovalsCard role={role} /><ComplianceGrid /></>}
        side={<><NextMeetingCard /><TasksCard uid={uid} /></>} />;
      break;
    case 'boss':
      body = <>
        <BossKpis />
        <Layout
          main={<><ApprovalsCard role={role} /><ComplianceGrid /></>}
          side={<><HeadcountRow /><TasksCard uid={uid} /></>} />
      </>;
      break;
    case 'pctl':
      body = <Layout
        main={<><TodayStrip uid={uid} /><ApprovalsCard role={role} /><TeamTodayCard uid={uid} /></>}
        side={<><QuickLinksCard links={LINKS.pctl} /><NextMeetingCard /><TasksCard uid={uid} /></>} />;
      break;
    case 'ipc':
      body = <Layout
        main={<><TodayStrip uid={uid} /><TasksCard uid={uid} /></>}
        side={<><QuickLinksCard links={LINKS.ipc} /><NextMeetingCard checkpointBanner /></>} />;
      break;
    case 'ads_manager':
      body = <Layout
        main={<><TodayStrip uid={uid} /><TikTokConnectCard uid={uid} /><TasksCard uid={uid} /></>}
        side={<QuickLinksCard links={LINKS.ads_manager} />} />;
      break;
    default:
      body = <Layout main={<TasksCard uid={uid} />} side={<NextMeetingCard />} />;
  }

  return (
    <div className="today-page">
      <PageHeader title={`${greeting()}${first ? `, ${first}` : ''}`} subtitle="Here's what needs you today." />
      {body}
    </div>
  );
}
