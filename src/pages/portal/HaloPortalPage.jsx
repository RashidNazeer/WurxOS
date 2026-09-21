import { fetchSharedHalo, fetchSharedHaloRows } from '../../lib/haloShareApi';
import { AmazonHaloPortal } from './HaloV2PortalPage';

// /portal/halo/:token — links minted by the ORIGINAL Halo tool (halo_shares).
//
// That tool was retired on 2026-09-21, but clients still hold its links, and a
// retired tool must not turn a link a client was given into a dead page. So
// these tokens resolve exactly as before, through the original RPCs, and render
// the one remaining Amazon Halo view.
export default function HaloPortalPage() {
  return <AmazonHaloPortal fetchShared={fetchSharedHalo} fetchRows={fetchSharedHaloRows} />;
}
