import SectionShell from './SectionShell';
import { AlertIcon } from '../../../components/common/Icon';

export default function ComingSoonSection({ section }) {
  const Icon = section?.icon || AlertIcon;
  return (
    <SectionShell icon={Icon} title={section?.label || 'Coming soon'} subtitle={section?.sub || ''}>
      <div className="settings-coming-soon">
        <div className="settings-coming-soon-title">Coming soon</div>
        <div>{section?.comingSoon || 'This section will be available in a future milestone.'}</div>
      </div>
    </SectionShell>
  );
}
