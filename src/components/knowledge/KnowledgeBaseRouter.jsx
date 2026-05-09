import { useAuth } from '../../contexts/AuthContext';
import BossKnowledgeBasePage from './BossKnowledgeBasePage';
import KnowledgeBasePage from './KnowledgeBasePage';

/**
 * Single /kb entry point. v1 had separate boss vs user KB pages with
 * very different UI; this router picks the right one per role:
 *   boss / developer → BossKnowledgeBasePage  (manage, approve, reads, comments)
 *   everyone else    → KnowledgeBasePage       (read, ack, comment, propose if TL/OL)
 *
 * RLS already gates which articles each role sees, so the simple page
 * choice here is purely a UI affordance — Boss page exposes management
 * actions, user page is read+propose only.
 */
export default function KnowledgeBaseRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss' || role === 'developer') return <BossKnowledgeBasePage />;
  return <KnowledgeBasePage />;
}
