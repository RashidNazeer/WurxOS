import { fmtPktStamp } from '../../utils/pktTime';

// Tells the OL (and anyone reading) which Team Lead verified which APC's report, so the report that
// reaches the OL for approval always says who already vetted it.
export default function ReportVerifiedBanner({ report }) {
  if (!report || report.status !== 'verified') return null;
  const tl = report.verifiedByName || 'The Team Lead';
  const apc = report.createdByName || 'the APC';
  const when = report.verifiedAt ? fmtPktStamp(report.verifiedAt) : '';
  return (
    <div className="alert d-flex align-items-start gap-2 mb-3 py-2"
      style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', borderRadius: 'var(--radius-md)', color: 'var(--info-text)' }}>
      <i className="bi bi-patch-check-fill flex-shrink-0 mt-1" />
      <div style={{ fontSize: '0.8rem' }}>
        <span className="fw-bold">{tl}</span> (Team Lead) verified <span className="fw-bold">{apc}</span>&apos;s report
        {when ? ` on ${when}` : ''}. It is ready for your approval.
      </div>
    </div>
  );
}
