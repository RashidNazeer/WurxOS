import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  ClockIcon, PaletteIcon, UserIcon, MegaphoneIcon, BoxIcon, StarIcon,
  BookmarkIcon, BellIcon, ReportIcon, HomeIcon, ShieldIcon, SearchIcon,
  ChevronLeftIcon, TrashIcon, DiagramIcon,
} from '../../components/common/Icon';
import TimeShiftSection      from './sections/TimeShiftSection';
import ReportFieldsSection   from './sections/ReportFieldsSection';
import AppearanceSection     from './sections/AppearanceSection';
import AccountSection        from './sections/AccountSection';
import NotificationsSection  from './sections/NotificationsSection';
import NotificationPrefsSection from './sections/NotificationPrefsSection';
import CampaignExpirySection from './sections/CampaignExpirySection';
import TierNotificationsSection from './sections/TierNotificationsSection';
import LeaveDefaultsSection  from './sections/LeaveDefaultsSection';
import BackupSection         from './sections/BackupSection';
import AmazonHaloSection     from './sections/AmazonHaloSection';
import CreatorLibrarySection from './sections/CreatorLibrarySection';
import OlIncentiveBrandsSection from './sections/OlIncentiveBrandsSection';
import PaidCollabCheckpointBrandsSection from './sections/PaidCollabCheckpointBrandsSection';
import DangerZoneSection     from './sections/DangerZoneSection';
import ComingSoonSection     from './sections/ComingSoonSection';
import MenuLayoutSection     from './sections/MenuLayoutSection';
import '../../styles/settings.css';

// Grouped registry — each group has its own icon (shown on the
// group header) and a list of sections that render without icons.
// Matches the reference SaaS pattern.
const GROUPS = [
  {
    id: 'general',
    label: 'General Settings',
    icon: HomeIcon,
    sections: [
      { id: 'time',        label: 'Time & Shift',   sub: 'Recurring task reset schedule',
        icon: ClockIcon,   component: TimeShiftSection },
      { id: 'reports',     label: 'Report Fields',  sub: 'Your custom report sections',
        icon: ReportIcon,  component: ReportFieldsSection,
        roles: ['boss','ol','tl','apc','developer'] },
      { id: 'menu',        label: 'Menu Layout',    sub: 'Pin & order sidebar items',
        icon: BookmarkIcon, component: MenuLayoutSection },
      { id: 'appearance',  label: 'Appearance',     sub: 'Theme & density',
        icon: PaletteIcon, component: AppearanceSection },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: BellIcon,
    sections: [
      { id: 'notifications', label: 'System Popups',  sub: 'Permission & browser push',
        icon: BellIcon, component: NotificationsSection },
      { id: 'notifPrefs',    label: 'Category Push',  sub: 'Which categories also push',
        icon: BellIcon, component: NotificationPrefsSection },
      { id: 'campaigns',     label: 'Campaigns',      sub: 'Expiry reminder lead times',
        icon: MegaphoneIcon, component: CampaignExpirySection,
        kind: 'campaigns',
        roles: ['boss','ol','tl','apc','ipc','pctl','developer'] },
      { id: 'tier',          label: 'Tier Notifications', sub: 'Month-end tier reminders',
        icon: StarIcon, component: TierNotificationsSection,
        roles: ['boss','ol','tl','pctl','apc','ipc'] },
      { id: 'product',       label: 'Product Campaigns', sub: 'Per-promo expiry reminders',
        icon: BoxIcon, component: CampaignExpirySection,
        kind: 'product_campaigns',
        roles: ['boss','ol','tl','apc','ipc','pctl','developer'] },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    icon: ShieldIcon,
    sections: [
      { id: 'leaveDefaults', label: 'Leave Defaults', sub: 'Starting quota for new hires',
        icon: ClockIcon, component: LeaveDefaultsSection,
        roles: ['boss'] },
      { id: 'backup', label: 'Data Backup', sub: 'Download a full snapshot of all data',
        icon: ShieldIcon, component: BackupSection,
        roles: ['boss'] },
      { id: 'amazonHalo', label: 'Amazon Halo', sub: 'Enable brands & client links',
        icon: DiagramIcon, component: AmazonHaloSection,
        roles: ['boss', 'ol', 'tl'] },
      { id: 'creatorLibrary', label: 'Creator Library', sub: 'Published creator sheet URL',
        icon: BoxIcon, component: CreatorLibrarySection,
        roles: ['boss', 'ol'] },
      { id: 'olIncentiveBrands', label: 'My Incentive Brands', sub: 'Brands that count toward your incentive',
        icon: StarIcon, component: OlIncentiveBrandsSection,
        roles: ['ol'] },
      { id: 'dangerZone', label: 'Danger Zone', sub: 'Wipe all operational data',
        icon: TrashIcon, component: DangerZoneSection,
        roles: ['boss'] },
    ],
  },
  {
    id: 'paidCollab',
    label: 'Paid Collab',
    icon: BoxIcon,
    sections: [
      { id: 'pcCheckpointBrands', label: 'Paid Collab Brands', sub: 'Brands your team fills the weekly Paid Collab section for',
        icon: BoxIcon, component: PaidCollabCheckpointBrandsSection,
        roles: ['pctl', 'ipc', 'boss', 'ol'] },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    icon: UserIcon,
    sections: [
      { id: 'account',       label: 'Profile & Password', sub: 'Your account details',
        icon: UserIcon, component: AccountSection },
    ],
  },
];

export default function SettingsPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const role = profile?.role;

  const [query, setQuery] = useState('');

  // Filter by role, then by search string. Drop groups that end up empty.
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GROUPS.map((g) => {
      const sections = g.sections
        .filter((s) => !s.roles || s.roles.includes(role))
        .filter((s) => !q || s.label.toLowerCase().includes(q) || (s.sub || '').toLowerCase().includes(q));
      return { ...g, sections };
    }).filter((g) => g.sections.length > 0);
  }, [role, query]);

  const flatSections = useMemo(
    () => visibleGroups.flatMap((g) => g.sections),
    [visibleGroups],
  );

  const [activeId, setActiveId] = useState(() => {
    const requested = searchParams.get('section');
    if (requested && flatSections.some((s) => s.id === requested && !s.disabled)) return requested;
    const firstEnabled = flatSections.find((s) => !s.disabled);
    return firstEnabled?.id || flatSections[0]?.id;
  });

  // Deep-link ?section=<id> — apply once the requested section becomes visible
  // (roles may load after first render), without fighting later manual nav.
  const appliedDeepLink = useRef(false);
  useEffect(() => {
    if (appliedDeepLink.current) return;
    const requested = searchParams.get('section');
    if (requested && flatSections.some((s) => s.id === requested && !s.disabled)) {
      setActiveId(requested);
      appliedDeepLink.current = true;
    }
  }, [searchParams, flatSections]);

  // If search whittles the list and the current active id is no longer
  // visible, fall back to the first visible enabled section.
  const activeVisible = flatSections.some((s) => s.id === activeId);
  const effectiveActiveId = activeVisible
    ? activeId
    : (flatSections.find((s) => !s.disabled)?.id || flatSections[0]?.id);

  const active = flatSections.find((s) => s.id === effectiveActiveId);
  const ActiveComponent = active?.component || ComingSoonSection;

  return (
    <div className="settings-layout">
      <nav className="settings-panel-nav" aria-label="Settings sections">
        <div className="settings-panel-header">
          <button
            type="button"
            className="settings-panel-back"
            onClick={() => navigate(-1)}
            title="Back"
            aria-label="Back"
          >
            <ChevronLeftIcon width="16" height="16" />
          </button>
          <div className="settings-panel-title">Settings</div>
        </div>

        <div className="settings-search">
          <span className="settings-search-icon">
            <SearchIcon width="14" height="14" />
          </span>
          <input
            type="text"
            placeholder="Type to search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {visibleGroups.map((g) => (
          <div key={g.id} className="settings-nav-group">
            <div className="settings-nav-group-label">{g.label}</div>
            {g.sections.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="settings-nav-btn"
                  data-active={effectiveActiveId === s.id}
                  disabled={s.disabled}
                  onClick={() => !s.disabled && setActiveId(s.id)}
                  title={s.disabled ? 'Coming soon' : s.label}
                >
                  <span className="settings-nav-btn-icon">
                    <Icon width="16" height="16" />
                  </span>
                  <span className="settings-nav-label">{s.label}</span>
                  {s.disabled && <span className="settings-soon-badge">Soon</span>}
                </button>
              );
            })}
          </div>
        ))}

        {visibleGroups.length === 0 && (
          <div style={{ padding: '12px 14px', color: 'var(--text-muted)', fontSize: 13 }}>
            No matches for "{query}"
          </div>
        )}
      </nav>

      <div className="settings-content">
        {active && (
          <div className="settings-content-header">
            <div className="settings-content-title">{active.label}</div>
            {active.sub && <div className="settings-content-subtitle">{active.sub}</div>}
          </div>
        )}
        <ActiveComponent section={active} />
      </div>
    </div>
  );
}
